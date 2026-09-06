import { config, log } from "@anycrawl/libs";
import {
    getDB, schemas, eq, listDueMonitorChecks, claimMonitorCheck, renewMonitorCheckLease,
    retryMonitorCheck, listDueMonitorNotifications, claimMonitorNotification,
    finishMonitorNotification, refreshWebhookMonitorNotification, renewMonitorNotificationLease, pruneMonitorHistory,
} from "@anycrawl/db";
import { MonitorPostProcessor } from "./MonitorPostProcessor.js";
import { EmailNotifier } from "./EmailNotifier.js";
import { WebhookManager } from "../managers/Webhook.js";

/** DB-backed recovery runs independently of BullMQ dispatch. Every worker may
 * poll; atomic claims and fencing tokens keep results from being committed twice. */
export class MonitorManager {
    private static instance: MonitorManager;
    private timer?: NodeJS.Timeout;
    private activePass?: Promise<void>;
    private retentionCursor: string | null = null;
    private lastRetentionPass = 0;

    public static getInstance(): MonitorManager { return this.instance ??= new MonitorManager(); }

    public start(): void {
        if (this.timer) return;
        const run = () => void this.tick().catch(error => log.error(`[MONITOR] Recovery pass failed: ${error}`));
        this.timer = setInterval(run, config.monitor.pollMs);
        this.timer.unref?.();
        run();
    }

    public async stop(): Promise<void> {
        if (this.timer) clearInterval(this.timer);
        this.timer = undefined;
        await this.activePass;
    }

    public async tick(dbOverride?: any): Promise<void> {
        if (this.activePass) return this.activePass;
        this.activePass = this.processDue(dbOverride);
        try { await this.activePass; } finally { this.activePass = undefined; }
    }

    private async processDue(dbOverride?: any): Promise<void> {
        const db = dbOverride || await getDB();
        const checks = await listDueMonitorChecks(db, 3);
        const checkResults = await Promise.allSettled(checks.map(async candidate => {
            const check = await claimMonitorCheck(db, candidate.uuid, config.monitor.leaseMs);
            if (!check) return;
            const heartbeat = setInterval(() => {
                void renewMonitorCheckLease(db, check, config.monitor.leaseMs)
                    .catch(error => log.warning(`[MONITOR] Check lease renewal failed: ${error}`));
            }, Math.max(1000, Math.floor(config.monitor.leaseMs / 3)));
            heartbeat.unref?.();
            try {
                await MonitorPostProcessor.process({ db, check, executionUuid: check.uuid });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (check.attempts >= config.monitor.maxAttempts) {
                    await MonitorPostProcessor.processFailure({ db, check, executionUuid: check.uuid, errorMessage: `Monitor processing failed: ${message}` });
                } else {
                    await retryMonitorCheck(db, check, message, this.retryDelay(check.attempts));
                }
            } finally { clearInterval(heartbeat); }
        }));
        for (const result of checkResults) if (result.status === "rejected") log.error(`[MONITOR] Check recovery failed: ${result.reason}`);
        const notifications = await listDueMonitorNotifications(db, 5);
        const notificationResults = await Promise.allSettled(notifications.map(candidate => this.processNotification(db, candidate.uuid)));
        for (const result of notificationResults) if (result.status === "rejected") log.error(`[MONITOR] Notification recovery failed: ${result.reason}`);
        // Covers a crash between delivery persistence and aggregate refresh.
        const queued = await db.select({ uuid: schemas.monitorNotifications.uuid }).from(schemas.monitorNotifications)
            .where(eq(schemas.monitorNotifications.status, "queued")).limit(100);
        for (const notification of queued) await refreshWebhookMonitorNotification(db, notification.uuid);
        if (config.monitor.retentionDays > 0 && Date.now() - this.lastRetentionPass >= 5 * 60_000) {
            const result = await pruneMonitorHistory(db, config.monitor.retentionDays, this.retentionCursor);
            this.retentionCursor = result.nextCursor;
            this.lastRetentionPass = Date.now();
            if (result.changes || result.snapshots || result.checks) log.info(`[MONITOR] History retention: ${JSON.stringify(result)}`);
        }
    }

    private retryDelay(attempt: number): number {
        return Math.min(config.monitor.retryDelayMs * 2 ** Math.max(0, attempt - 1), 15 * 60_000);
    }

    private async processNotification(db: any, uuid: string): Promise<void> {
        const notification = await claimMonitorNotification(db, uuid, config.monitor.leaseMs);
        if (!notification) return;
        const heartbeat = setInterval(() => {
            void renewMonitorNotificationLease(db, notification, config.monitor.leaseMs)
                .catch(error => log.warning(`[MONITOR] Notification lease renewal failed: ${error}`));
        }, Math.max(1000, Math.floor(config.monitor.leaseMs / 3)));
        heartbeat.unref?.();
        try {
            const [monitor] = await db.select().from(schemas.monitors).where(eq(schemas.monitors.uuid, notification.monitorUuid)).limit(1);
            if (!monitor || !monitor.isActive) {
                await finishMonitorNotification(db, notification, { status: "skipped", lastError: "Monitor was paused or deleted" });
                return;
            }
            if (notification.channel === "email") {
                if (!notification.recipient) throw new Error("Email notification has no recipient");
                await EmailNotifier.sendEventEmail(notification.recipient, notification.payload, notification.uuid);
                await finishMonitorNotification(db, notification, { status: "delivered", lastError: null });
            } else if (notification.channel === "webhook") {
                if (!config.webhooks.enabled) throw new Error("Webhook delivery is disabled");
                await WebhookManager.getInstance().triggerEvent(notification.eventType, notification.payload, "monitor", monitor.uuid,
                    { userId: monitor.userId ?? undefined, apiKeyId: monitor.apiKey ?? undefined }, { notificationUuid: notification.uuid });
                const deliveries = await db.select({ uuid: schemas.webhookDeliveries.uuid }).from(schemas.webhookDeliveries)
                    .where(eq(schemas.webhookDeliveries.monitorNotificationUuid, notification.uuid)).limit(1);
                if (!deliveries.length) {
                    await finishMonitorNotification(db, notification, { status: "skipped", lastError: "No matching active webhook subscription" });
                } else {
                    await finishMonitorNotification(db, notification, { status: "queued", lastError: null });
                    await refreshWebhookMonitorNotification(db, notification.uuid);
                }
            } else {
                throw new Error(`Unsupported monitor notification channel: ${notification.channel}`);
            }
        } catch (error) {
            await finishMonitorNotification(db, notification, {
                status: notification.attempts >= config.monitor.maxAttempts ? "failed" : "retrying",
                lastError: error instanceof Error ? error.message : String(error),
                nextAttemptAt: new Date(Date.now() + this.retryDelay(notification.attempts)),
            });
        } finally { clearInterval(heartbeat); }
    }
}
