import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { migrateSQLiteDatabase } from "../migrations.js";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { eq } from "drizzle-orm";
import { getDB, schemas, databaseType } from "../db/index.js";
import { withDatabaseTransaction, type DatabaseSteps } from "../transaction.js";
import { createMonitorCheckSteps, claimMonitorCheck, commitMonitorCheck, MonitorBusyError, claimMonitorNotification, finishMonitorNotification, refreshWebhookMonitorNotification } from "../model/MonitorWorkflow.js";
import { getLatestSnapshot, listSnapshotsByMonitor, getOwnedMonitor, listChangesByOwner, encodeMonitorCursor } from "../model/MonitorAccess.js";

import { Billing } from "../model/Billing.js";
import { updateOwnedMonitor, deleteOwnedMonitor } from "../model/MonitorConfiguration.js";
import { pruneMonitorHistory } from "../model/MonitorRetention.js";
import { prepareMonitorUpdate, updateMonitorSchema } from "@anycrawl/libs";

describe(`Monitor workflow on ${databaseType} (real migrated database)`, () => {
    let db: any;
    beforeAll(async () => {
        const connection = process.env.ANYCRAWL_API_DB_CONNECTION || "";
        if (databaseType === "sqlite" ? !connection.startsWith("/private/tmp/anycrawl-monitor-test-") : new URL(connection).pathname !== "/monitor_test") {
            throw new Error("Refusing to migrate a non-test database");
        }
        db = await getDB();
        const migrationsFolder = resolve("drizzle", databaseType === "sqlite" ? "SQLite" : "PostgreSQL");
        if (databaseType === "sqlite") migrateSQLiteDatabase(db, { migrationsFolder });
        else await migratePostgres(db, { migrationsFolder });
    });
    afterAll(async () => {
        if (databaseType === "sqlite") db?.$client.close();
        else if (db) await db.$client.end();
    });

    async function fixture() {
        const taskUuid = randomUUID(), monitorUuid = randomUUID(), apiKeyUuid = randomUUID();
        const monitor = { uuid: monitorUuid, apiKey: apiKeyUuid, name: "Workflow test", monitorType: "webpage", trackMode: "text", revision: 1,
            scheduledTaskUuid: taskUuid, targets: [{ url: "https://example.com" }], notifyOptions: { channels: ["webhook"] }, createdAt: new Date(), updatedAt: new Date() };
        await withDatabaseTransaction(db, function* (tx): DatabaseSteps<void> {
            yield tx.insert(schemas.apiKey).values({ uuid: apiKeyUuid, key: `test-${randomUUID()}`, name: "test", credits: 100, createdAt: new Date() });
            yield tx.insert(schemas.scheduledTasks).values({ uuid: taskUuid, apiKey: apiKeyUuid, name: "test", taskType: "scrape", taskPayload: { url: "https://example.com" }, cronExpression: "0 */6 * * *", createdAt: new Date(), updatedAt: new Date() });
            yield tx.insert(schemas.monitors).values(monitor);
        });
        return { monitor, taskUuid };
    }
    async function createCheck(f: Awaited<ReturnType<typeof fixture>>, sequence = 1) {
        const uuid = randomUUID();
        await withDatabaseTransaction(db, function* (tx): DatabaseSteps<void> {
            yield tx.insert(schemas.taskExecutions).values({ uuid, scheduledTaskUuid: f.taskUuid, executionNumber: sequence, idempotencyKey: uuid, scheduledFor: new Date(), createdAt: new Date() });
            yield* createMonitorCheckSteps(tx, { monitor: f.monitor, executionUuid: uuid, sequenceNumber: sequence, now: new Date() });
        });
        await db.update(schemas.monitorChecks).set({ state: "ready", resultStatus: "completed" }).where(eq(schemas.monitorChecks.uuid, uuid));
        return uuid;
    }
    function baselineOutcome() {
        return { snapshot: { uuid: randomUUID(), url: "https://example.com", content: "A".repeat(300000) + "complete tail", contentHash: "hash", extracted: null,
            status: "new", contentComplete: true, capturedAt: new Date() }, notifications: [] as any[] };
    }

    it("enforces one active monitor check and rolls back the losing execution", async () => {
        const f = await fixture();
        await createCheck(f);
        await expect(createCheck(f, 2)).rejects.toBeInstanceOf(MonitorBusyError);
        const executions = await db.select().from(schemas.taskExecutions).where(eq(schemas.taskExecutions.scheduledTaskUuid, f.taskUuid));
        expect(executions).toHaveLength(1);
    });

    it("fences expired processors and stores the complete baseline exactly once", async () => {
        const f = await fixture(), uuid = await createCheck(f);
        const first = await claimMonitorCheck(db, uuid, 60000);
        await db.update(schemas.monitorChecks).set({ leaseExpiresAt: new Date(Date.now() - 2000) }).where(eq(schemas.monitorChecks.uuid, uuid));
        const second = await claimMonitorCheck(db, uuid, 60000);
        const outcome = baselineOutcome();
        expect(await commitMonitorCheck(db, first, outcome)).toBe(false);
        expect(await commitMonitorCheck(db, second, outcome)).toBe(true);
        expect(await commitMonitorCheck(db, second, outcome)).toBe(false);
        expect((await getLatestSnapshot(db, f.monitor.uuid, "https://example.com", 1)).content).toBe(outcome.snapshot.content);
        const list = await listSnapshotsByMonitor(db, f.monitor.uuid, 0, 50);
        expect(list).toHaveLength(1);
        expect(list[0]).not.toHaveProperty("content");
    });

    it("rolls back both the snapshot and check completion if an intent write fails, then replays", async () => {
        const f = await fixture(), uuid = await createCheck(f), check = await claimMonitorCheck(db, uuid, 60000);
        const outcome = baselineOutcome();
        outcome.notifications = [{ uuid: randomUUID(), channel: null, eventType: "monitor.check.completed", payload: {}, idempotencyKey: uuid }];
        await expect(commitMonitorCheck(db, check, outcome)).rejects.toThrow();
        expect(await listSnapshotsByMonitor(db, f.monitor.uuid, 0, 50)).toEqual([]);
        const [stored] = await db.select().from(schemas.monitorChecks).where(eq(schemas.monitorChecks.uuid, uuid));
        expect(stored.state).toBe("processing");
        expect(stored.leaseToken).toBe(check.leaseToken);
        outcome.notifications[0].channel = "webhook";
        expect(await commitMonitorCheck(db, check, outcome)).toBe(true);
        expect(await db.select().from(schemas.monitorNotifications).where(eq(schemas.monitorNotifications.checkUuid, uuid))).toHaveLength(1);
    });

    it("does not compare a newly configured monitor against a legacy truncated snapshot", async () => {
        const f = await fixture();
        await db.insert(schemas.monitorSnapshots).values({ uuid: randomUUID(), monitorUuid: f.monitor.uuid, url: "https://example.com", content: "old…[truncated]", contentHash: "old", status: "same", capturedAt: new Date() });
        expect(await getLatestSnapshot(db, f.monitor.uuid, "https://example.com", 1)).toBeNull();
    });
    async function changedCheck(f: Awaited<ReturnType<typeof fixture>>, sequence = 1, channels = ["email"]) {
        const checkUuid = await createCheck(f, sequence), check = await claimMonitorCheck(db, checkUuid, 60000);
        const outcome: any = baselineOutcome();
        const changeUuid = randomUUID();
        outcome.snapshot.status = "changed";
        outcome.change = { uuid: changeUuid, url: "https://example.com", toSnapshotUuid: outcome.snapshot.uuid, changeType: "content", diffText: "changed", createdAt: new Date() };
        outcome.notifications = channels.map((channel, index) => ({ uuid: randomUUID(), channel, recipient: channel === "email" ? `user${index}@example.com` : null, eventType: "monitor.changed", payload: {}, changeUuid, idempotencyKey: `${checkUuid}/${index}` }));
        await commitMonitorCheck(db, check, outcome);
        return { checkUuid, changeUuid, outcome };
    }

    it("merges concurrent owned PATCHes atomically and leaves both records untouched on validation/task-write failures", async () => {
        const f = await fixture(), owner = { apiKeyId: f.monitor.apiKey };
        await Promise.all([
            updateOwnedMonitor(db, f.monitor.uuid, owner, (monitor, task) => prepareMonitorUpdate(monitor, task, { diff_options: { only_main_content: false } })),
            updateOwnedMonitor(db, f.monitor.uuid, owner, (monitor, task) => prepareMonitorUpdate(monitor, task, { diff_options: { ignore_selectors: ["Clock"] } })),
        ]);
        const before = await getOwnedMonitor(db, f.monitor.uuid, owner);
        expect(before.diffOptions).toMatchObject({ only_main_content: false, ignore_selectors: ["Clock"] });
        expect(before.revision).toBe(3);
        await expect(updateOwnedMonitor(db, f.monitor.uuid, owner, (monitor, task) => prepareMonitorUpdate(monitor, task, updateMonitorSchema.parse({ notify_options: { channels: ["email"] } })))).rejects.toThrow("email_recipients");
        await expect(updateOwnedMonitor(db, f.monitor.uuid, owner, () => ({ monitor: { name: "must roll back" }, task: { taskType: null } }))).rejects.toBeDefined();
        expect(await getOwnedMonitor(db, f.monitor.uuid, owner)).toEqual(before);
        expect(await updateOwnedMonitor(db, f.monitor.uuid, { apiKeyId: randomUUID() }, () => { throw new Error("must not run"); })).toBeNull();
        const paused = await updateOwnedMonitor(db, f.monitor.uuid, owner, (monitor, task) => prepareMonitorUpdate(monitor, task, { is_active: false }));
        expect(paused.isPaused).toBe(true);
        expect(await getOwnedMonitor(db, f.monitor.uuid, owner)).toMatchObject({ isActive: false, isPaused: true, pauseReason: "Paused by user (monitor)" });
    });

    it("retains a result under its captured revision without publishing an obsolete change", async () => {
        const f = await fixture(), uuid = await createCheck(f), check = await claimMonitorCheck(db, uuid, 60000);
        await updateOwnedMonitor(db, f.monitor.uuid, { apiKeyId: f.monitor.apiKey }, (monitor, task) => prepareMonitorUpdate(monitor, task, { goal: "A different criterion" }));
        const outcome: any = baselineOutcome();
        outcome.change = { uuid: randomUUID(), url: "https://example.com", changeType: "content", createdAt: new Date() };
        expect(await commitMonitorCheck(db, check, outcome)).toBe(true);
        expect(await getLatestSnapshot(db, f.monitor.uuid, "https://example.com", 2)).toBeNull();
        expect(await db.select().from(schemas.monitorChanges).where(eq(schemas.monitorChanges.monitorUuid, f.monitor.uuid))).toEqual([]);
    });

    it("records delivered only after an accepted channel, preserving failures per recipient and fencing old leases", async () => {
        const f = await fixture(), change = await changedCheck(f, 1, ["email", "email"]);
        const [firstIntent, secondIntent] = change.outcome.notifications;
        const first = await claimMonitorNotification(db, firstIntent.uuid, 60000);
        await db.update(schemas.monitorNotifications).set({ leaseExpiresAt: new Date(Date.now() - 2000) }).where(eq(schemas.monitorNotifications.uuid, first.uuid));
        const replacement = await claimMonitorNotification(db, first.uuid, 60000);
        await finishMonitorNotification(db, first, { status: "delivered" });
        let [record] = await db.select().from(schemas.monitorChanges).where(eq(schemas.monitorChanges.uuid, change.changeUuid));
        expect(record.notified).toBe(false);
        const second = await claimMonitorNotification(db, secondIntent.uuid, 60000);
        await Promise.all([finishMonitorNotification(db, replacement, { status: "delivered" }), finishMonitorNotification(db, second, { status: "failed", lastError: "Recipient rejected" })]);
        [record] = await db.select().from(schemas.monitorChanges).where(eq(schemas.monitorChanges.uuid, change.changeUuid));
        expect(record).toMatchObject({ notified: true, notificationStatus: "delivered" });
        const statuses = await db.select().from(schemas.monitorNotifications).where(eq(schemas.monitorNotifications.changeUuid, change.changeUuid));
        expect(statuses.map((row: any) => row.status).sort()).toEqual(["delivered", "failed"]);
    });

    it("does not let a fast webhook finalize fan-out while other subscribers are still being prepared", async () => {
        const f = await fixture(), change = await changedCheck(f, 1, ["webhook"]);
        const notification = await claimMonitorNotification(db, change.outcome.notifications[0].uuid, 60000);
        const subscriptionUuid = randomUUID();
        await db.insert(schemas.webhookSubscriptions).values({ uuid: subscriptionUuid, apiKey: f.monitor.apiKey, name: "Test", webhookUrl: "https://example.com/hook", webhookSecret: "test-secret", eventTypes: ["monitor.changed"], createdAt: new Date(), updatedAt: new Date() });
        await db.insert(schemas.webhookDeliveries).values({ uuid: randomUUID(), webhookSubscriptionUuid: subscriptionUuid, monitorNotificationUuid: notification.uuid, eventType: "monitor.changed", eventSource: "monitor", eventSourceId: f.monitor.uuid, requestUrl: "https://example.com/hook", requestBody: {}, status: "delivered", createdAt: new Date() });
        await refreshWebhookMonitorNotification(db, notification.uuid);
        let [stored] = await db.select().from(schemas.monitorNotifications).where(eq(schemas.monitorNotifications.uuid, notification.uuid));
        expect(stored).toMatchObject({ status: "processing", leaseToken: notification.leaseToken });
        await finishMonitorNotification(db, notification, { status: "queued" });
        await refreshWebhookMonitorNotification(db, notification.uuid);
        [stored] = await db.select().from(schemas.monitorNotifications).where(eq(schemas.monitorNotifications.uuid, notification.uuid));
        expect(stored.status).toBe("delivered");
    });

    it("paginates equal timestamps with an owner-scoped cursor even when newer events arrive", async () => {
        const f = await fixture(), foreign = await fixture(), time = new Date("2026-09-06T00:00:00Z");
        const ids = Array.from({ length: 4 }, () => randomUUID());
        await db.insert(schemas.monitorChanges).values(ids.map(uuid => ({ uuid, monitorUuid: f.monitor.uuid, url: "https://example.com", changeType: "content", createdAt: time })));
        await db.insert(schemas.monitorChanges).values({ uuid: randomUUID(), monitorUuid: foreign.monitor.uuid, url: "https://example.com", changeType: "content", createdAt: time });
        const owner = { apiKeyId: f.monitor.apiKey }, first = await listChangesByOwner(db, owner, 0, 2);
        await db.insert(schemas.monitorChanges).values({ uuid: randomUUID(), monitorUuid: f.monitor.uuid, url: "https://example.com", changeType: "content", createdAt: new Date() });
        const second = await listChangesByOwner(db, owner, 0, 2, { cursor: encodeMonitorCursor(first[1]) });
        expect([...first, ...second].map(row => row.uuid).sort()).toEqual(ids.sort());
        expect(first[0]).not.toHaveProperty("diffText");
        await expect(listChangesByOwner(db, owner, 0, 2, { cursor: "bad" })).rejects.toThrow("Invalid monitor pagination cursor");
    });

    it("retention is opt-in and preserves healthy baseline, legacy history and pending notification references", async () => {
        const f = await fixture(), old = new Date(Date.now() - 60 * 86_400_000);
        const first = await changedCheck(f, 1, []), pending = await changedCheck(f, 2, ["email"]);
        await db.update(schemas.monitorSnapshots).set({ capturedAt: old }).where(eq(schemas.monitorSnapshots.monitorUuid, f.monitor.uuid));
        await db.update(schemas.monitorChanges).set({ createdAt: old }).where(eq(schemas.monitorChanges.monitorUuid, f.monitor.uuid));
        await db.update(schemas.monitorChecks).set({ createdAt: old }).where(eq(schemas.monitorChecks.monitorUuid, f.monitor.uuid));
        const latestUuid = await createCheck(f, 3), latest = await claimMonitorCheck(db, latestUuid, 60000);
        const baseline = baselineOutcome(); baseline.snapshot.capturedAt = old;
        await commitMonitorCheck(db, latest, baseline);
        const legacyUuid = randomUUID();
        await db.insert(schemas.monitorSnapshots).values({ uuid: legacyUuid, monitorUuid: f.monitor.uuid, url: "https://example.com", content: "legacy", contentHash: "old", status: "same", capturedAt: old });
        expect(await pruneMonitorHistory(db, 0)).toMatchObject({ snapshots: 0, changes: 0, checks: 0 });
        let cursor: string | null = null;
        do { cursor = (await pruneMonitorHistory(db, 30, cursor)).nextCursor; } while (cursor);
        const snapshots = await listSnapshotsByMonitor(db, f.monitor.uuid, 0, 50);
        expect(snapshots.map(row => row.uuid).sort()).toEqual([baseline.snapshot.uuid, pending.outcome.snapshot.uuid, legacyUuid].sort());
        expect(await db.select().from(schemas.monitorChanges).where(eq(schemas.monitorChanges.uuid, first.changeUuid))).toEqual([]);
        expect(await db.select().from(schemas.monitorNotifications).where(eq(schemas.monitorNotifications.checkUuid, pending.checkUuid))).toHaveLength(1);
    });

    it("deletes an owned monitor and all dependent workflow rows atomically", async () => {
        const f = await fixture(); await changedCheck(f);
        expect(await deleteOwnedMonitor(db, f.monitor.uuid, { apiKeyId: randomUUID() })).toBeNull();
        expect(await deleteOwnedMonitor(db, f.monitor.uuid, { apiKeyId: f.monitor.apiKey })).toBe(f.taskUuid);
        expect(await getOwnedMonitor(db, f.monitor.uuid, { apiKeyId: f.monitor.apiKey })).toBeNull();
        expect(await db.select().from(schemas.scheduledTasks).where(eq(schemas.scheduledTasks.uuid, f.taskUuid))).toEqual([]);
        expect(await db.select().from(schemas.monitorNotifications).where(eq(schemas.monitorNotifications.monitorUuid, f.monitor.uuid))).toEqual([]);
    });

    it("retains pending webhook deliveries even after another subscriber has delivered", async () => {
        const f = await fixture(), old = new Date(Date.now() - 60 * 86_400_000);
        const pending = await changedCheck(f, 1, ["webhook"]);
        const notificationUuid = pending.outcome.notifications[0].uuid, subscriptionUuid = randomUUID();
        await db.insert(schemas.webhookSubscriptions).values({ uuid: subscriptionUuid, apiKey: f.monitor.apiKey, name: "retention", webhookUrl: "https://example.com/hook", webhookSecret: "test", eventTypes: ["monitor.changed"], createdAt: old, updatedAt: old });
        await db.insert(schemas.webhookDeliveries).values({ uuid: randomUUID(), webhookSubscriptionUuid: subscriptionUuid, monitorNotificationUuid: notificationUuid, eventType: "monitor.changed", eventSource: "monitor", eventSourceId: f.monitor.uuid, requestUrl: "https://example.com/hook", requestBody: {}, status: "retrying", createdAt: old });
        await db.update(schemas.monitorNotifications).set({ status: "delivered" }).where(eq(schemas.monitorNotifications.uuid, notificationUuid));
        await db.update(schemas.monitorChanges).set({ createdAt: old }).where(eq(schemas.monitorChanges.uuid, pending.changeUuid));
        await db.update(schemas.monitorSnapshots).set({ capturedAt: old }).where(eq(schemas.monitorSnapshots.monitorUuid, f.monitor.uuid));
        const nextUuid = await createCheck(f, 2), check = await claimMonitorCheck(db, nextUuid, 60000);
        await commitMonitorCheck(db, check, baselineOutcome());
        let cursor: string | null = null;
        do { cursor = (await pruneMonitorHistory(db, 30, cursor)).nextCursor; } while (cursor);
        expect(await db.select().from(schemas.monitorChanges).where(eq(schemas.monitorChanges.uuid, pending.changeUuid))).toHaveLength(1);
        expect(await db.select().from(schemas.monitorNotifications).where(eq(schemas.monitorNotifications.uuid, notificationUuid))).toHaveLength(1);
        expect((await listSnapshotsByMonitor(db, f.monitor.uuid, 0, 50)).some(row => row.uuid === pending.outcome.snapshot.uuid)).toBe(true);
    });

    it("preserves real billing transactions and idempotency on the migrated jobs schema", async () => {
        const f = await fixture(), jobId = randomUUID(), now = new Date();
        await db.insert(schemas.jobs).values({ jobId, apiKey: f.monitor.apiKey, jobType: "scrape", jobQueueName: "scrape-cheerio", url: "https://example.com", origin: "scheduled-task", status: "completed", createdAt: now, updatedAt: now });
        expect(await Billing.chargeToUsedByJobId({ jobId, targetUsed: 10 })).toMatchObject({ charged: 10, currentUsed: 10 });
        expect(await Billing.chargeToUsedByJobId({ jobId, targetUsed: 10 })).toMatchObject({ charged: 0 });
        expect(await Billing.chargeDeltaByJobId({ jobId, delta: 5, idempotencyKey: `${jobId}/delta` })).toMatchObject({ charged: 5 });
        expect(await Billing.chargeDeltaByJobId({ jobId, delta: 5, idempotencyKey: `${jobId}/delta` })).toMatchObject({ charged: 0 });
        const concurrent = await Promise.all([Billing.chargeToUsedByJobId({ jobId, targetUsed: 20 }), Billing.chargeToUsedByJobId({ jobId, targetUsed: 20 })]);
        expect(concurrent.reduce((total, result) => total + result.charged, 0)).toBe(5);
        const [key] = await db.select().from(schemas.apiKey).where(eq(schemas.apiKey.uuid, f.monitor.apiKey));
        const [job] = await db.select().from(schemas.jobs).where(eq(schemas.jobs.jobId, jobId));
        expect(key.credits).toBe(80);
        expect(job.creditsUsed).toBe(20);
        expect(job.deductedAt).toBeInstanceOf(Date);
    });

});
