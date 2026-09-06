import { and, eq, gt, lt, ne, asc, desc, inArray, isNotNull, notExists, sql } from "drizzle-orm";
import { schemas } from "../db/index.js";
import { withDatabaseTransaction, type DatabaseSteps } from "../transaction.js";

/** Opt-in, bounded cleanup for records produced by the durable workflow.
 * Legacy snapshots/changes, current healthy baseline, retained change references
 * and every pending delivery are protected. Active checks defer the whole monitor. */
export async function pruneMonitorHistory(db: any, retentionDays: number, afterUuid?: string | null, now = new Date()): Promise<{ nextCursor: string | null; changes: number; snapshots: number; checks: number }> {
    const totals = { nextCursor: null as string | null, changes: 0, snapshots: 0, checks: 0 };
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return totals;
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000);
    const monitors = await db.select({ uuid: schemas.monitors.uuid }).from(schemas.monitors)
        .where(afterUuid ? gt(schemas.monitors.uuid, afterUuid) : undefined).orderBy(asc(schemas.monitors.uuid)).limit(25);
    for (const candidate of monitors) {
        const removed = await withDatabaseTransaction(db, function* (tx): DatabaseSteps<{ changes: number; snapshots: number; checks: number }> {
            const count = { changes: 0, snapshots: 0, checks: 0 };
            const [monitor] = yield tx.update(schemas.monitors).set({ revision: sql`${schemas.monitors.revision}` })
                .where(eq(schemas.monitors.uuid, candidate.uuid)).returning();
            if (!monitor) return count;
            const active = yield tx.select({ uuid: schemas.monitorChecks.uuid }).from(schemas.monitorChecks).where(and(
                eq(schemas.monitorChecks.monitorUuid, monitor.uuid), inArray(schemas.monitorChecks.state, ["pending", "ready", "processing"]))).limit(1);
            if (active.length) return count;
            const pendingWebhook = (notificationColumn: any, outerColumn: any) => tx.select({ uuid: schemas.webhookDeliveries.uuid }).from(schemas.webhookDeliveries)
                .innerJoin(schemas.monitorNotifications, eq(schemas.webhookDeliveries.monitorNotificationUuid, schemas.monitorNotifications.uuid))
                .where(and(eq(notificationColumn, outerColumn), inArray(schemas.webhookDeliveries.status, ["pending", "retrying"])));
            const pendingForChange = tx.select({ uuid: schemas.monitorNotifications.uuid }).from(schemas.monitorNotifications).where(and(
                eq(schemas.monitorNotifications.changeUuid, schemas.monitorChanges.uuid), inArray(schemas.monitorNotifications.status, ["pending", "processing", "retrying", "queued"])));
            const oldChanges = yield tx.select({ uuid: schemas.monitorChanges.uuid }).from(schemas.monitorChanges).where(and(
                eq(schemas.monitorChanges.monitorUuid, monitor.uuid), lt(schemas.monitorChanges.createdAt, cutoff), isNotNull(schemas.monitorChanges.checkUuid), notExists(pendingForChange), notExists(pendingWebhook(schemas.monitorNotifications.changeUuid, schemas.monitorChanges.uuid))))
                .orderBy(asc(schemas.monitorChanges.createdAt)).limit(100);
            if (oldChanges.length) {
                yield tx.delete(schemas.monitorChanges).where(inArray(schemas.monitorChanges.uuid, oldChanges.map((row: any) => row.uuid)));
                count.changes = oldChanges.length;
            }
            const [baseline] = yield tx.select({ uuid: schemas.monitorSnapshots.uuid }).from(schemas.monitorSnapshots).where(and(
                eq(schemas.monitorSnapshots.monitorUuid, monitor.uuid), eq(schemas.monitorSnapshots.monitorRevision, monitor.revision),
                eq(schemas.monitorSnapshots.contentComplete, true), ne(schemas.monitorSnapshots.status, "error")))
                .orderBy(desc(schemas.monitorSnapshots.sequenceNumber), desc(schemas.monitorSnapshots.capturedAt), desc(schemas.monitorSnapshots.uuid)).limit(1);
            const referenced = tx.select({ uuid: schemas.monitorChanges.uuid }).from(schemas.monitorChanges).where(sql`${schemas.monitorChanges.fromSnapshotUuid} = ${schemas.monitorSnapshots.uuid} OR ${schemas.monitorChanges.toSnapshotUuid} = ${schemas.monitorSnapshots.uuid}`);
            const pendingForSnapshot = tx.select({ uuid: schemas.monitorNotifications.uuid }).from(schemas.monitorNotifications).where(and(
                eq(schemas.monitorNotifications.checkUuid, schemas.monitorSnapshots.checkUuid), inArray(schemas.monitorNotifications.status, ["pending", "processing", "retrying", "queued"])));
            const oldSnapshots = yield tx.select({ uuid: schemas.monitorSnapshots.uuid }).from(schemas.monitorSnapshots).where(and(
                eq(schemas.monitorSnapshots.monitorUuid, monitor.uuid), lt(schemas.monitorSnapshots.capturedAt, cutoff), isNotNull(schemas.monitorSnapshots.checkUuid),
                baseline ? ne(schemas.monitorSnapshots.uuid, baseline.uuid) : undefined, notExists(referenced), notExists(pendingForSnapshot), notExists(pendingWebhook(schemas.monitorNotifications.checkUuid, schemas.monitorSnapshots.checkUuid))))
                .orderBy(asc(schemas.monitorSnapshots.capturedAt)).limit(100);
            if (oldSnapshots.length) {
                yield tx.delete(schemas.monitorSnapshots).where(inArray(schemas.monitorSnapshots.uuid, oldSnapshots.map((row: any) => row.uuid)));
                count.snapshots = oldSnapshots.length;
            }
            const [latest] = yield tx.select({ uuid: schemas.monitorChecks.uuid }).from(schemas.monitorChecks).where(eq(schemas.monitorChecks.monitorUuid, monitor.uuid)).orderBy(desc(schemas.monitorChecks.sequenceNumber)).limit(1);
            const oldChecks = yield tx.select({ uuid: schemas.monitorChecks.uuid }).from(schemas.monitorChecks).where(and(
                eq(schemas.monitorChecks.monitorUuid, monitor.uuid), inArray(schemas.monitorChecks.state, ["completed", "failed"]), lt(schemas.monitorChecks.createdAt, cutoff),
                latest ? ne(schemas.monitorChecks.uuid, latest.uuid) : undefined,
                notExists(pendingWebhook(schemas.monitorNotifications.checkUuid, schemas.monitorChecks.uuid)),
                notExists(tx.select().from(schemas.monitorSnapshots).where(eq(schemas.monitorSnapshots.checkUuid, schemas.monitorChecks.uuid))),
                notExists(tx.select().from(schemas.monitorChanges).where(eq(schemas.monitorChanges.checkUuid, schemas.monitorChecks.uuid))),
                notExists(tx.select().from(schemas.monitorNotifications).where(and(eq(schemas.monitorNotifications.checkUuid, schemas.monitorChecks.uuid), inArray(schemas.monitorNotifications.status, ["pending", "processing", "retrying", "queued"])))),
            )).orderBy(asc(schemas.monitorChecks.createdAt)).limit(100);
            if (oldChecks.length) {
                yield tx.delete(schemas.monitorChecks).where(inArray(schemas.monitorChecks.uuid, oldChecks.map((row: any) => row.uuid)));
                count.checks = oldChecks.length;
            }
            return count;
        });
        totals.changes += removed.changes; totals.snapshots += removed.snapshots; totals.checks += removed.checks;
    }
    totals.nextCursor = monitors.length === 25 ? monitors[monitors.length - 1].uuid : null;
    return totals;
}
