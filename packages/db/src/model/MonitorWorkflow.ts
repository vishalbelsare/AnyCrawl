import { randomUUID } from "node:crypto";
import { and, eq, gt, lte, or, asc, sql, inArray } from "drizzle-orm";
import { schemas } from "../db/index.js";
import { withDatabaseTransaction, type DatabaseSteps } from "../transaction.js";

export const ACTIVE_MONITOR_CHECK_STATES = ["pending", "ready", "processing"];
const PENDING_NOTIFICATION_STATES = ["pending", "processing", "retrying", "queued"];

export class MonitorBusyError extends Error {
    constructor() { super("A monitor check is already in progress"); this.name = "MonitorBusyError"; }
}

/** Must be part of the scheduled execution transaction; the partial unique
 * index enforces single-flight across processes, including manual requests. */
export function* createMonitorCheckSteps(tx: any, input: {
    monitor: any; executionUuid: string; sequenceNumber: number; now: Date;
}): DatabaseSteps<void> {
    const rows = yield tx.insert(schemas.monitorChecks).values({
        uuid: input.executionUuid,
        monitorUuid: input.monitor.uuid,
        sequenceNumber: input.sequenceNumber,
        monitorRevision: input.monitor.revision ?? 1,
        configSnapshot: input.monitor,
        state: "pending",
        nextAttemptAt: input.now,
        createdAt: input.now,
    }).onConflictDoNothing().returning({ uuid: schemas.monitorChecks.uuid });
    if (!rows.length) throw new MonitorBusyError();
}

export async function listDueMonitorChecks(db: any, limit = 20, now = new Date()): Promise<any[]> {
    return db.select().from(schemas.monitorChecks).where(or(
        and(eq(schemas.monitorChecks.state, "ready"), lte(schemas.monitorChecks.nextAttemptAt, now)),
        and(eq(schemas.monitorChecks.state, "processing"), lte(schemas.monitorChecks.leaseExpiresAt, now)),
    )).orderBy(asc(schemas.monitorChecks.nextAttemptAt)).limit(limit);
}

export async function claimMonitorCheck(db: any, uuid: string, leaseMs: number, now = new Date()): Promise<any | null> {
    const rows = await db.update(schemas.monitorChecks).set({
        state: "processing", leaseToken: randomUUID(), leaseExpiresAt: new Date(now.getTime() + leaseMs),
        attempts: sql`${schemas.monitorChecks.attempts} + 1`,
    }).where(and(eq(schemas.monitorChecks.uuid, uuid), or(
        and(eq(schemas.monitorChecks.state, "ready"), lte(schemas.monitorChecks.nextAttemptAt, now)),
        and(eq(schemas.monitorChecks.state, "processing"), lte(schemas.monitorChecks.leaseExpiresAt, now)),
    ))).returning();
    return rows[0] ?? null;
}

export async function renewMonitorCheckLease(db: any, check: any, leaseMs: number): Promise<void> {
    await db.update(schemas.monitorChecks).set({ leaseExpiresAt: new Date(Date.now() + leaseMs) })
        .where(and(eq(schemas.monitorChecks.uuid, check.uuid), eq(schemas.monitorChecks.state, "processing"), eq(schemas.monitorChecks.leaseToken, check.leaseToken)));
}

export async function retryMonitorCheck(db: any, check: any, error: string, retryMs: number): Promise<void> {
    await db.update(schemas.monitorChecks).set({
        state: "ready", lastError: error, nextAttemptAt: new Date(Date.now() + retryMs), leaseToken: null, leaseExpiresAt: null,
    }).where(and(eq(schemas.monitorChecks.uuid, check.uuid), eq(schemas.monitorChecks.state, "processing"), eq(schemas.monitorChecks.leaseToken, check.leaseToken)));
}

export interface MonitorCheckOutcome {
    snapshot: Record<string, any>;
    change?: Record<string, any>;
    notifications: Array<Record<string, any>>;
    error?: string;
}

/** Snapshot, change, notification intents and completion become visible together.
 * A stale processor cannot publish after its lease has been replaced/expired. */
export async function commitMonitorCheck(db: any, check: any, outcome: MonitorCheckOutcome): Promise<boolean> {
    return withDatabaseTransaction(db, function* (tx): DatabaseSteps<boolean> {
        const [owned] = yield tx.select({ taskUuid: schemas.monitors.scheduledTaskUuid }).from(schemas.monitors)
            .where(eq(schemas.monitors.uuid, check.monitorUuid)).limit(1);
        if (!owned) return false;
        yield tx.update(schemas.scheduledTasks).set({ updatedAt: sql`${schemas.scheduledTasks.updatedAt}` })
            .where(eq(schemas.scheduledTasks.uuid, owned.taskUuid));
        const [monitor] = yield tx.update(schemas.monitors).set({ revision: sql`${schemas.monitors.revision}` })
            .where(eq(schemas.monitors.uuid, check.monitorUuid)).returning();
        if (!monitor) return false;
        const now = new Date();
        const claimed = yield tx.update(schemas.monitorChecks).set({
            state: outcome.error ? "failed" : "completed", processedAt: now, lastError: outcome.error ?? null,
            leaseToken: null, leaseExpiresAt: null,
        }).where(and(eq(schemas.monitorChecks.uuid, check.uuid), eq(schemas.monitorChecks.state, "processing"),
            eq(schemas.monitorChecks.leaseToken, check.leaseToken), gt(schemas.monitorChecks.leaseExpiresAt, now))).returning({ uuid: schemas.monitorChecks.uuid });
        if (!claimed.length) return false;
        const currentRevision = monitor.revision === check.monitorRevision;
        const newer = yield tx.select({ uuid: schemas.monitorSnapshots.uuid }).from(schemas.monitorSnapshots)
            .where(and(eq(schemas.monitorSnapshots.monitorUuid, check.monitorUuid),
                eq(schemas.monitorSnapshots.monitorRevision, check.monitorRevision),
                gt(schemas.monitorSnapshots.sequenceNumber, check.sequenceNumber))).limit(1);
        if (newer.length) {
            yield tx.update(schemas.monitorChecks).set({ lastError: "Superseded by a newer check; baseline was not changed" }).where(eq(schemas.monitorChecks.uuid, check.uuid));
            return true;
        }
        yield tx.insert(schemas.monitorSnapshots).values({
            ...outcome.snapshot, monitorUuid: check.monitorUuid, taskExecutionUuid: check.uuid,
            checkUuid: check.uuid, monitorRevision: check.monitorRevision, sequenceNumber: check.sequenceNumber,
            ...(!currentRevision && !outcome.error ? { status: "new" } : {}),
        });
        if (!currentRevision) {
            yield tx.update(schemas.monitorChecks).set({ lastError: "Configuration changed during the check; result retained under its original revision without alerts" }).where(eq(schemas.monitorChecks.uuid, check.uuid));
            return true;
        }
        const notifications = monitor.isActive ? outcome.notifications : [];
        if (outcome.change) {
            const changeNotifications = notifications.filter(row => row.changeUuid === outcome.change!.uuid);
            yield tx.insert(schemas.monitorChanges).values({
                ...outcome.change, monitorUuid: check.monitorUuid, checkUuid: check.uuid, notified: false,
                notificationStatus: !monitor.isActive ? "skipped" : changeNotifications.length ? "pending" : "none",
            });
        }
        for (const notification of notifications) {
            yield tx.insert(schemas.monitorNotifications).values({
                ...notification, monitorUuid: check.monitorUuid, checkUuid: check.uuid,
                status: "pending", attempts: 0, createdAt: now, nextAttemptAt: now,
            }).onConflictDoNothing();
        }
        return true;
    });
}

export async function listDueMonitorNotifications(db: any, limit = 30, now = new Date()): Promise<any[]> {
    return db.select().from(schemas.monitorNotifications).where(or(
        and(inArray(schemas.monitorNotifications.status, ["pending", "retrying"]), lte(schemas.monitorNotifications.nextAttemptAt, now)),
        and(eq(schemas.monitorNotifications.status, "processing"), lte(schemas.monitorNotifications.leaseExpiresAt, now)),
    )).orderBy(asc(schemas.monitorNotifications.nextAttemptAt)).limit(limit);
}

export async function claimMonitorNotification(db: any, uuid: string, leaseMs: number, now = new Date()): Promise<any | null> {
    const rows = await db.update(schemas.monitorNotifications).set({
        status: "processing", attempts: sql`${schemas.monitorNotifications.attempts} + 1`,
        leaseToken: randomUUID(), leaseExpiresAt: new Date(now.getTime() + leaseMs),
    }).where(and(eq(schemas.monitorNotifications.uuid, uuid), or(
        and(inArray(schemas.monitorNotifications.status, ["pending", "retrying"]), lte(schemas.monitorNotifications.nextAttemptAt, now)),
        and(eq(schemas.monitorNotifications.status, "processing"), lte(schemas.monitorNotifications.leaseExpiresAt, now)),
    ))).returning();
    return rows[0] ?? null;
}

export async function renewMonitorNotificationLease(db: any, notification: any, leaseMs: number): Promise<void> {
    await db.update(schemas.monitorNotifications).set({ leaseExpiresAt: new Date(Date.now() + leaseMs) })
        .where(and(eq(schemas.monitorNotifications.uuid, notification.uuid), eq(schemas.monitorNotifications.status, "processing"), eq(schemas.monitorNotifications.leaseToken, notification.leaseToken)));
}

function* refreshChangeNotificationSteps(tx: any, changeUuid: string | null): DatabaseSteps<void> {
    if (!changeUuid) return;
    // Serialize aggregates from different email/subscription transactions.
    yield tx.update(schemas.monitorChanges).set({ notificationStatus: sql`${schemas.monitorChanges.notificationStatus}` })
        .where(eq(schemas.monitorChanges.uuid, changeUuid));
    const rows = yield tx.select({ status: schemas.monitorNotifications.status }).from(schemas.monitorNotifications)
        .where(eq(schemas.monitorNotifications.changeUuid, changeUuid));
    const statuses = rows.map((row: any) => row.status);
    const delivered = statuses.includes("delivered");
    const status = delivered ? "delivered"
        : statuses.some((s: string) => PENDING_NOTIFICATION_STATES.includes(s)) ? (statuses.includes("queued") ? "queued" : "pending")
        : statuses.includes("failed") ? "failed" : statuses.length ? "skipped" : "none";
    yield tx.update(schemas.monitorChanges).set({ notified: delivered, notificationStatus: status }).where(eq(schemas.monitorChanges.uuid, changeUuid));
}

export async function finishMonitorNotification(db: any, notification: any, patch: {
    status: string; lastError?: string | null; nextAttemptAt?: Date;
}): Promise<void> {
    await withDatabaseTransaction(db, function* (tx): DatabaseSteps<void> {
        const updated = yield tx.update(schemas.monitorNotifications).set({
            ...patch, leaseToken: null, leaseExpiresAt: null,
            ...(patch.status === "delivered" ? { deliveredAt: new Date() } : {}),
        }).where(and(eq(schemas.monitorNotifications.uuid, notification.uuid),
            eq(schemas.monitorNotifications.leaseToken, notification.leaseToken), eq(schemas.monitorNotifications.status, "processing"),
            gt(schemas.monitorNotifications.leaseExpiresAt, new Date()))).returning();
        if (updated[0]) yield* refreshChangeNotificationSteps(tx, updated[0].changeUuid);
    });
}

/** Webhook delivery, not queue acceptance, determines the aggregate status. */
export async function refreshWebhookMonitorNotification(db: any, notificationUuid: string): Promise<void> {
    await withDatabaseTransaction(db, function* (tx): DatabaseSteps<void> {
        const [notification] = yield tx.update(schemas.monitorNotifications).set({ status: sql`${schemas.monitorNotifications.status}` })
            .where(eq(schemas.monitorNotifications.uuid, notificationUuid)).returning();
        // Fan-out must finish (or exhaust retries) before delivery callbacks can
        // finalize its aggregate. Otherwise a fast first subscriber can steal
        // the producer lease and lose a later subscriber's failed DB insert.
        if (!notification || !["queued", "failed"].includes(notification.status)) return;
        const deliveries = yield tx.select({ status: schemas.webhookDeliveries.status }).from(schemas.webhookDeliveries)
            .where(eq(schemas.webhookDeliveries.monitorNotificationUuid, notificationUuid));
        if (!deliveries.length) {
            if (notification.status === "queued") {
                yield tx.update(schemas.monitorNotifications).set({ status: "skipped", lastError: "Webhook deliveries were removed" }).where(eq(schemas.monitorNotifications.uuid, notificationUuid));
                yield* refreshChangeNotificationSteps(tx, notification.changeUuid);
            }
            return;
        }
        const delivered = deliveries.some((row: any) => row.status === "delivered");
        const pending = deliveries.some((row: any) => ["pending", "retrying"].includes(row.status));
        const status = delivered ? "delivered" : pending ? "queued" : deliveries.every((row: any) => row.status === "skipped") ? "skipped" : "failed";
        yield tx.update(schemas.monitorNotifications).set({
            status, leaseToken: null, leaseExpiresAt: null,
            ...(delivered ? { deliveredAt: new Date(), lastError: null } : {}),
            ...(!delivered && !pending ? { lastError: "All webhook deliveries failed or were skipped" } : {}),
        }).where(eq(schemas.monitorNotifications.uuid, notificationUuid));
        yield* refreshChangeNotificationSteps(tx, notification.changeUuid);
    });
}

export async function listMonitorCheckHistory(db: any, monitorUuid: string, limit = 50): Promise<any[]> {
    return db.select({
        uuid: schemas.monitorChecks.uuid, sequenceNumber: schemas.monitorChecks.sequenceNumber,
        monitorRevision: schemas.monitorChecks.monitorRevision, state: schemas.monitorChecks.state,
        resultStatus: schemas.monitorChecks.resultStatus, sourceError: schemas.monitorChecks.sourceError,
        attempts: schemas.monitorChecks.attempts, lastError: schemas.monitorChecks.lastError,
        createdAt: schemas.monitorChecks.createdAt, processedAt: schemas.monitorChecks.processedAt,
    }).from(schemas.monitorChecks).where(eq(schemas.monitorChecks.monitorUuid, monitorUuid))
        .orderBy(sql`${schemas.monitorChecks.sequenceNumber} DESC`).limit(limit);
}

export async function listMonitorNotificationHistory(db: any, monitorUuid: string, changeUuid?: string, limit = 100): Promise<any[]> {
    return db.select({
        uuid: schemas.monitorNotifications.uuid, checkUuid: schemas.monitorNotifications.checkUuid,
        changeUuid: schemas.monitorNotifications.changeUuid, channel: schemas.monitorNotifications.channel,
        eventType: schemas.monitorNotifications.eventType, recipient: schemas.monitorNotifications.recipient,
        status: schemas.monitorNotifications.status, attempts: schemas.monitorNotifications.attempts,
        lastError: schemas.monitorNotifications.lastError, createdAt: schemas.monitorNotifications.createdAt,
        deliveredAt: schemas.monitorNotifications.deliveredAt,
    }).from(schemas.monitorNotifications).where(and(eq(schemas.monitorNotifications.monitorUuid, monitorUuid),
        ...(changeUuid ? [eq(schemas.monitorNotifications.changeUuid, changeUuid)] : [])))
        .orderBy(sql`${schemas.monitorNotifications.createdAt} DESC`, sql`${schemas.monitorNotifications.uuid} DESC`).limit(limit);
}
