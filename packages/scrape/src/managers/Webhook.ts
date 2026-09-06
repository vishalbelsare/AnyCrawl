import crypto from "crypto";
import axios from "axios";
import { log, appConfig, type OwnerContext } from "@anycrawl/libs";
import { getDB, schemas, eq, sql, listWebhooksByOwner, and, lte, or, refreshWebhookMonitorNotification, withDatabaseTransaction, type DatabaseSteps } from "@anycrawl/db";
import { QueueManager } from "./Queue.js";
import { WorkerManager } from "./Worker.js";
import { randomUUID } from "crypto";

// Helper function to check if URL points to a private IP
function isPrivateIP(url: string): boolean {
    try {
        const urlObj = new URL(url);
        const hostname = urlObj.hostname;

        // Check for localhost
        if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") {
            return true;
        }

        // Check for private IP ranges (IPv4)
        const privateRanges = [
            /^10\./,                    // 10.0.0.0/8
            /^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
            /^192\.168\./,              // 192.168.0.0/16
            /^169\.254\./,              // 169.254.0.0/16 (link-local)
        ];

        for (const range of privateRanges) {
            if (range.test(hostname)) {
                return true;
            }
        }

        // Check for private IPv6 ranges
        if (hostname.includes(":")) {
            if (hostname.startsWith("fe80:") || hostname.startsWith("fc") || hostname.startsWith("fd")) {
                return true;
            }
        }

        return false;
    } catch (error) {
        // If URL parsing fails, treat as potentially unsafe
        return true;
    }
}

export class WebhookManager {
    private static instance: WebhookManager;
    private readonly WEBHOOK_QUEUE = "webhooks";
    private retryProcessorInterval: NodeJS.Timeout | null = null;

    private constructor() {}

    public static getInstance(): WebhookManager {
        if (!WebhookManager.instance) {
            WebhookManager.instance = new WebhookManager();
        }
        return WebhookManager.instance;
    }

    public async initialize(): Promise<void> {
        log.info("[WEBHOOK] 🔔 Initializing Webhook Manager...");

        // Create webhook delivery queue
        const queueManager = QueueManager.getInstance();
        queueManager.getQueue(this.WEBHOOK_QUEUE);

        // Start webhook delivery worker
        const workerManager = WorkerManager.getInstance();
        await workerManager.getWorker(
            this.WEBHOOK_QUEUE,
            async (job) => {
                await this.deliverWebhook(job.data.deliveryId);
            }
        );

        // Start retry processor for persisted pending/retrying deliveries
        this.startRetryProcessor();

        log.info("[WEBHOOK] ✅ Webhook Manager initialized successfully");
    }

    /**
     * Fan an event out to all matching subscriptions.
     * Scope is evaluated within the owner's subscriptions. Errors propagate so
     * a lookup/enqueue failure cannot be confused with zero subscriptions.
     */
    public async triggerEvent(
        eventType: string,
        payload: any,
        eventSource: string,
        eventSourceId: string,
        owner: OwnerContext,
        options: { notificationUuid?: string } = {}
    ): Promise<number> {
        if (!owner.userId && !owner.apiKeyId && appConfig.authEnabled) {
            throw new Error("Webhook delivery requires an owner when authentication is enabled");
        }
        const db = await getDB();
        let enqueued = 0;
        // Filtering decoded JSON after the owner-scoped query works with both
        // PostgreSQL jsonb and SQLite JSON text, without dialect-specific casts.
        const subscriptions = await listWebhooksByOwner(db, owner);
        const errors: unknown[] = [];
        for (const subscription of subscriptions) {
            if (!subscription.isActive) continue;
            const directTest = eventType === "webhook.test" && eventSource === "webhook";
            if (directTest ? subscription.uuid !== eventSourceId : !Array.isArray(subscription.eventTypes) || !subscription.eventTypes.includes(eventType)) continue;
            if (owner.userId ? subscription.userId !== owner.userId : owner.apiKeyId && subscription.apiKey !== owner.apiKeyId) continue;
            if (!directTest && subscription.scope !== "all" && (!Array.isArray(subscription.specificTaskIds) || !subscription.specificTaskIds.includes(eventSourceId))) continue;
            try {
                if (await this.enqueueDelivery(subscription, eventType, payload, eventSource, eventSourceId, options.notificationUuid)) enqueued++;
            } catch (error) {
                errors.push(error);
            }
        }
        if (errors.length) throw new AggregateError(errors, `Failed to enqueue ${errors.length} webhook delivery(s)`);
        return enqueued;
    }

    private async enqueueDelivery(
        subscription: any, eventType: string, payload: any, eventSource: string,
        eventSourceId: string, notificationUuid?: string
    ): Promise<boolean> {
        const db = await getDB();
        const digest = notificationUuid ? crypto.createHash("sha256").update(`${notificationUuid}/${subscription.uuid}`).digest("hex") : null;
        const deliveryUuid = digest
            ? `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`
            : randomUUID();
        const record = {
            uuid: deliveryUuid, webhookSubscriptionUuid: subscription.uuid,
            monitorNotificationUuid: notificationUuid ?? null, eventType, eventSource, eventSourceId,
            status: "pending", attemptNumber: 1, maxAttempts: Math.max(1, subscription.maxRetries ?? 3),
            requestUrl: subscription.webhookUrl, requestMethod: "POST", requestHeaders: subscription.customHeaders || {},
            requestBody: payload, createdAt: new Date(), updatedAt: new Date(),
        };
        const insert = db.insert(schemas.webhookDeliveries).values(record);
        if (notificationUuid) {
            await insert.onConflictDoNothing();
            const [existing] = await db.select().from(schemas.webhookDeliveries)
                .where(eq(schemas.webhookDeliveries.uuid, deliveryUuid)).limit(1);
            if (!existing || existing.status !== "pending") return false;
            await this.enqueuePendingDelivery(existing);
        } else {
            await insert;
            await this.enqueuePendingDelivery(record);
        }
        return true;
    }

    private async enqueuePendingDelivery(delivery: any): Promise<void> {
        const queue = QueueManager.getInstance().getQueue(this.WEBHOOK_QUEUE);
        const jobId = `${delivery.uuid}-attempt-${delivery.attemptNumber}`;
        const existing = await boundedQueueOperation(queue.getJob(jobId));
        if (existing) {
            const state = await boundedQueueOperation(existing.getState());
            if (state !== "completed" && state !== "failed") return;
            // A completed queue job with a pending DB record has an unknown
            // delivery outcome. Retry with the same delivery/event identity.
            await boundedQueueOperation(existing.remove());
        }
        await boundedQueueOperation(queue.add("webhook-delivery", { deliveryId: delivery.uuid }, { jobId }));
    }

    private async deliverWebhook(deliveryId: string): Promise<void> {
        const db = await getDB();

        try {
            const delivery = await db
                .select()
                .from(schemas.webhookDeliveries)
                .where(eq(schemas.webhookDeliveries.uuid, deliveryId))
                .limit(1);

            if (!delivery.length) {
                log.error(`[WEBHOOK] Delivery ${deliveryId} not found`);
                return;
            }

            const deliveryRecord = delivery[0];
            if (deliveryRecord.status !== "pending") return;
            if (deliveryRecord.monitorNotificationUuid) {
                const [notification] = await db.select({ status: schemas.monitorNotifications.status, isActive: schemas.monitors.isActive })
                    .from(schemas.monitorNotifications).innerJoin(schemas.monitors, eq(schemas.monitorNotifications.monitorUuid, schemas.monitors.uuid))
                    .where(eq(schemas.monitorNotifications.uuid, deliveryRecord.monitorNotificationUuid)).limit(1);
                if (!notification || !notification.isActive || notification.status === "skipped") {
                    await db.update(schemas.webhookDeliveries).set({ status: "skipped", errorMessage: "Monitor notification cancelled" })
                        .where(eq(schemas.webhookDeliveries.uuid, deliveryId));
                    if (notification) await refreshWebhookMonitorNotification(db, deliveryRecord.monitorNotificationUuid);
                    return;
                }
            }

            const subscription = await db
                .select()
                .from(schemas.webhookSubscriptions)
                .where(eq(schemas.webhookSubscriptions.uuid, deliveryRecord.webhookSubscriptionUuid))
                .limit(1);

            if (!subscription.length || !subscription[0].isActive) {
                await db.update(schemas.webhookDeliveries).set({ status: "skipped", errorMessage: "Subscription inactive" }).where(eq(schemas.webhookDeliveries.uuid, deliveryId));
                if (deliveryRecord.monitorNotificationUuid) await refreshWebhookMonitorNotification(db, deliveryRecord.monitorNotificationUuid);
                return;
            }

            const sub = subscription[0];

            // Check for private IP protection (unless explicitly allowed)
            const allowLocalWebhooks = process.env.ALLOW_LOCAL_WEBHOOKS === "true";
            if (!allowLocalWebhooks && isPrivateIP(deliveryRecord.requestUrl)) {
                const errorMsg = "Webhook delivery blocked: Private IP addresses are not allowed";
                log.warning(`[WEBHOOK] ${errorMsg} - URL: ${deliveryRecord.requestUrl}`);

                await db
                    .update(schemas.webhookDeliveries)
                    .set({
                        status: "failed",
                        errorMessage: errorMsg,
                        errorCode: "PRIVATE_IP_BLOCKED",
                    })
                    .where(eq(schemas.webhookDeliveries.uuid, deliveryId));

                if (deliveryRecord.monitorNotificationUuid) await refreshWebhookMonitorNotification(db, deliveryRecord.monitorNotificationUuid);
                return;
            }

            // Generate HMAC signature
            const signature = this.generateSignature(deliveryRecord.requestBody, sub.webhookSecret);

            // Prepare headers
            const headers = {
                "Content-Type": "application/json",
                "X-AnyCrawl-Signature": signature,
                "X-Webhook-Event": deliveryRecord.eventType,
                "X-Webhook-Delivery-Id": deliveryId,
                "X-Webhook-Timestamp": new Date().toISOString(),
                ...(deliveryRecord.requestHeaders || {}),
                ...(sub.customHeaders || {}),
            };

            const startTime = Date.now();

            try {
                // Send webhook
                const response = await axios({
                    method: deliveryRecord.requestMethod,
                    url: deliveryRecord.requestUrl,
                    headers: headers,
                    data: deliveryRecord.requestBody,
                    timeout: (sub.timeoutSeconds || 10) * 1000,
                    validateStatus: (status) => status >= 200 && status < 300,
                });

                const duration = Date.now() - startTime;

                await withDatabaseTransaction(db, function* (tx): DatabaseSteps<void> {
                    const rows = yield tx.update(schemas.webhookDeliveries).set({
                        status: "delivered", responseStatus: response.status, responseHeaders: response.headers as any,
                        responseBody: JSON.stringify(response.data).substring(0, 1000), responseDurationMs: duration,
                        deliveredAt: new Date(), updatedAt: new Date(),
                    }).where(and(eq(schemas.webhookDeliveries.uuid, deliveryId), eq(schemas.webhookDeliveries.status, "pending"),
                        eq(schemas.webhookDeliveries.attemptNumber, deliveryRecord.attemptNumber))).returning({ uuid: schemas.webhookDeliveries.uuid });
                    if (rows.length) yield tx.update(schemas.webhookSubscriptions).set({
                        lastSuccessAt: new Date(), consecutiveFailures: 0,
                        totalDeliveries: sql`${schemas.webhookSubscriptions.totalDeliveries} + 1`,
                        successfulDeliveries: sql`${schemas.webhookSubscriptions.successfulDeliveries} + 1`,
                    }).where(eq(schemas.webhookSubscriptions.uuid, sub.uuid));
                });
                if (deliveryRecord.monitorNotificationUuid) await refreshWebhookMonitorNotification(db, deliveryRecord.monitorNotificationUuid);

                log.info(`[WEBHOOK] ✅ Webhook delivered: ${deliveryId} to ${sub.webhookUrl} (${duration}ms)`);
            } catch (error: any) {
                const duration = Date.now() - startTime;
                await this.handleDeliveryFailure(deliveryRecord, sub, error, duration);
            }
        } catch (error) {
            log.error(`[WEBHOOK] Failed to process webhook delivery ${deliveryId}: ${error}`);
        }
    }

    private async handleDeliveryFailure(
        delivery: any,
        subscription: any,
        error: any,
        duration: number
    ): Promise<void> {
        const db = await getDB();

        const errorMessage = error instanceof Error ? error.message : String(error);
        const responseStatus = error.response?.status;
        const responseHeaders = error.response?.headers;
        const responseBody = error.response?.data
            ? JSON.stringify(error.response.data).substring(0, 1000)
            : null;

        log.warning(`[WEBHOOK] Webhook delivery failed: ${delivery.uuid} - ${errorMessage}`);

        const retrying = delivery.attemptNumber < delivery.maxAttempts;
        const nextRetryAt = new Date(Date.now() + Math.pow(subscription.retryBackoffMultiplier || 2, delivery.attemptNumber) * 60000);
        const changed = await withDatabaseTransaction(db, function* (tx): DatabaseSteps<boolean> {
            const updated = yield tx.update(schemas.webhookDeliveries).set({
                status: retrying ? "retrying" : "failed", errorMessage,
                responseStatus, responseHeaders: responseHeaders as any, responseBody, responseDurationMs: duration,
                ...(retrying ? { attemptNumber: delivery.attemptNumber + 1, nextRetryAt } : {}),
            }).where(and(eq(schemas.webhookDeliveries.uuid, delivery.uuid), eq(schemas.webhookDeliveries.status, "pending"),
                eq(schemas.webhookDeliveries.attemptNumber, delivery.attemptNumber))).returning({ uuid: schemas.webhookDeliveries.uuid });
            if (!updated.length) return false;
            if (!retrying) {
                const [updatedSub] = yield tx.update(schemas.webhookSubscriptions).set({
                    lastFailureAt: new Date(), consecutiveFailures: sql`${schemas.webhookSubscriptions.consecutiveFailures} + 1`,
                    totalDeliveries: sql`${schemas.webhookSubscriptions.totalDeliveries} + 1`, failedDeliveries: sql`${schemas.webhookSubscriptions.failedDeliveries} + 1`,
                }).where(eq(schemas.webhookSubscriptions.uuid, subscription.uuid)).returning();
                if (updatedSub && updatedSub.consecutiveFailures >= updatedSub.autoDisableAfterFailures) {
                    yield tx.update(schemas.webhookSubscriptions).set({ isActive: false }).where(eq(schemas.webhookSubscriptions.uuid, subscription.uuid));
                }
            }
            return true;
        });
        if (!changed) return;
        if (retrying) log.info(`[WEBHOOK] Delivery ${delivery.uuid} retry ${delivery.attemptNumber + 1}/${delivery.maxAttempts} at ${nextRetryAt.toISOString()}`);
        else log.error(`[WEBHOOK] Delivery permanently failed: ${delivery.uuid}`);
        if (delivery.monitorNotificationUuid) await refreshWebhookMonitorNotification(db, delivery.monitorNotificationUuid);
    }

    private generateSignature(payload: any, secret: string): string {
        const hmac = crypto.createHmac("sha256", secret);
        hmac.update(JSON.stringify(payload));
        return `sha256=${hmac.digest("hex")}`;
    }

    /** Recover both retrying deliveries and DB-persisted intents whose Redis
     * enqueue failed (including failures after retrying -> pending). */
    public async reconcilePendingDeliveries(): Promise<void> {
        const db = await getDB();
        const now = new Date();
        const deliveries = await db.select().from(schemas.webhookDeliveries).where(or(
            eq(schemas.webhookDeliveries.status, "pending"),
            and(eq(schemas.webhookDeliveries.status, "retrying"), lte(schemas.webhookDeliveries.nextRetryAt, now)),
        )).orderBy(sql`${schemas.webhookDeliveries.createdAt} ASC`).limit(100);
        for (const delivery of deliveries) {
            try {
                if (delivery.status === "retrying") {
                    const rows = await db.update(schemas.webhookDeliveries).set({ status: "pending", updatedAt: now })
                        .where(and(eq(schemas.webhookDeliveries.uuid, delivery.uuid), eq(schemas.webhookDeliveries.status, "retrying")))
                        .returning({ uuid: schemas.webhookDeliveries.uuid });
                    if (!rows.length) continue;
                }
                await this.enqueuePendingDelivery(delivery);
            } catch (error) {
                log.warning(`[WEBHOOK] Pending delivery ${delivery.uuid} will be retried: ${error}`);
            }
        }
    }

    private startRetryProcessor(): void {
        this.retryProcessorInterval = setInterval(() => {
            void this.reconcilePendingDeliveries().catch(error => log.error(`[WEBHOOK] Retry processor error: ${error}`));
        }, 5000);
        this.retryProcessorInterval.unref?.();
    }

    public async stop(): Promise<void> {
        log.info("[WEBHOOK] Stopping Webhook Manager...");

        if (this.retryProcessorInterval) {
            clearInterval(this.retryProcessorInterval);
            this.retryProcessorInterval = null;
        }

        log.info("[WEBHOOK] ✅ Webhook Manager stopped successfully");
    }
}

async function boundedQueueOperation<T>(operation: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([operation, new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Webhook queue operation timed out")), 5000);
        })]);
    } finally { if (timer) clearTimeout(timer); }
}
