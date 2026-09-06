import { createServer as createHttpServer } from 'node:http';
import { createServer as createSmtpServer, type Socket } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { migrate as migratePostgres } from 'drizzle-orm/node-postgres/migrator';
import { getDB, schemas, eq, databaseType, migrateSQLiteDatabase, withDatabaseTransaction, type DatabaseSteps, createMonitorCheckSteps, claimMonitorCheck, commitMonitorCheck } from '@anycrawl/db';
import { MonitorManager } from '../monitor/MonitorManager.js';
import { EmailNotifier } from '../monitor/EmailNotifier.js';
import { WebhookManager } from '../managers/Webhook.js';
import { QueueManager } from '../managers/Queue.js';
import { Utils } from '../Utils.js';

/** Actual DB, Redis, nodemailer SMTP and axios HTTP; no mocked transport. */
describe(`Monitor notification delivery on ${databaseType}`, () => {
    let db: any;
    let smtp: ReturnType<typeof createSmtpServer>, http: ReturnType<typeof createHttpServer>;
    const sockets = new Set<Socket>();
    let smtpReject = false, httpStatus = 500;
    const messages: string[] = [], requests: any[] = [];
    let smtpPort: number, httpPort: number;
    const ownedTasks: string[] = [], ownedKeys: string[] = [], ownedSubscriptions: string[] = [];
    const environment = { ...process.env };

    beforeAll(async () => {
        const connection = process.env.ANYCRAWL_API_DB_CONNECTION || '';
        if (databaseType === 'sqlite' ? !connection.startsWith('/private/tmp/anycrawl-monitor-test-delivery') : new URL(connection).pathname !== '/monitor_delivery_test') throw new Error('Use the isolated notification test database');
        if (process.env.ANYCRAWL_REDIS_URL !== 'redis://127.0.0.1:56379/1') throw new Error('Use Redis test DB 1 on the isolated local container');
        db = await getDB();
        const migrationsFolder = resolve('../db/drizzle', databaseType === 'sqlite' ? 'SQLite' : 'PostgreSQL');
        if (databaseType === 'sqlite') migrateSQLiteDatabase(db, { migrationsFolder });
        else await migratePostgres(db, { migrationsFolder });
        smtp = createSmtpServer(socket => {
            sockets.add(socket); socket.on('close', () => sockets.delete(socket));
            socket.write('220 localhost test SMTP\r\n');
            let buffer = '', dataMode = false, message = '';
            socket.on('data', chunk => {
                buffer += chunk.toString();
                while (buffer.includes('\r\n')) {
                    const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
                    if (dataMode) {
                        if (line === '.') {
                            messages.push(message); dataMode = false; message = '';
                            socket.write(smtpReject ? '451 Temporary test failure\r\n' : '250 Message accepted\r\n');
                        } else message += line + '\r\n';
                    } else if (/^EHLO|^HELO/i.test(line)) socket.write('250-localhost\r\n250 PIPELINING\r\n');
                    else if (/^DATA/i.test(line)) { dataMode = true; socket.write('354 End with dot\r\n'); }
                    else if (/^QUIT/i.test(line)) socket.end('221 Goodbye\r\n');
                    else if (/^RCPT TO:.*rejected@example.com/i.test(line)) socket.write('550 Recipient rejected\r\n');
                    else socket.write('250 OK\r\n');
                }
            });
        });
        smtp.listen(0, '127.0.0.1'); await once(smtp, 'listening'); smtpPort = (smtp.address() as any).port;
        http = createHttpServer((req, res) => {
            let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => { requests.push({ headers: req.headers, body: JSON.parse(body) }); res.writeHead(httpStatus); res.end('test'); });
        });
        http.listen(0, '127.0.0.1'); await once(http, 'listening'); httpPort = (http.address() as any).port;
        Object.assign(process.env, { ANYCRAWL_SMTP_HOST: '127.0.0.1', ANYCRAWL_SMTP_PORT: String(smtpPort), ANYCRAWL_SMTP_SECURE: 'false', ANYCRAWL_SMTP_FROM: 'test@example.com', ANYCRAWL_WEBHOOKS_ENABLED: 'true', ANYCRAWL_API_AUTH_ENABLED: 'true', ALLOW_LOCAL_WEBHOOKS: 'true', ANYCRAWL_MONITOR_MAX_ATTEMPTS: '3' });
        delete process.env.ANYCRAWL_SMTP_USER; delete process.env.ANYCRAWL_SMTP_PASS;
        await Utils.getInstance().getRedisConnection().ping();
    });
    afterAll(async () => {
        await MonitorManager.getInstance().stop();
        await QueueManager.getInstance().closeAll();
        await Utils.getInstance().getRedisConnection().quit();
        for (const socket of sockets) socket.destroy();
        if (smtp) await new Promise<void>(resolveClose => smtp.close(() => resolveClose()));
        if (http) await new Promise<void>(resolveClose => http.close(() => resolveClose()));
        if (db) {
            for (const uuid of ownedSubscriptions) await db.delete(schemas.webhookSubscriptions).where(eq(schemas.webhookSubscriptions.uuid, uuid));
            // Delete monitors first because snapshots retain their execution FK.
            for (const uuid of ownedTasks) {
                await db.delete(schemas.monitors).where(eq(schemas.monitors.scheduledTaskUuid, uuid));
                await db.delete(schemas.scheduledTasks).where(eq(schemas.scheduledTasks.uuid, uuid));
            }
            for (const uuid of ownedKeys) await db.delete(schemas.apiKey).where(eq(schemas.apiKey.uuid, uuid));
            if (databaseType === 'sqlite') db.$client.close(); else await db.$client.end();
        }
        for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
        Object.assign(process.env, environment);
    });
    beforeEach(() => { messages.length = 0; requests.length = 0; smtpReject = false; httpStatus = 500; });

    async function fixture(channel: string, eventType = 'monitor.changed', recipient = 'accepted@example.com') {
        const now = new Date(), apiKey = randomUUID(), taskUuid = randomUUID(), monitorUuid = randomUUID(), checkUuid = randomUUID(), changeUuid = eventType === 'monitor.error' ? null : randomUUID(), notificationUuid = randomUUID();
        ownedKeys.push(apiKey); ownedTasks.push(taskUuid);
        const monitor = { uuid: monitorUuid, apiKey, name: 'Delivery test', monitorType: 'webpage', trackMode: 'text', revision: 1, targets: [{ url: 'https://example.com' }], scheduledTaskUuid: taskUuid, isActive: true, createdAt: now, updatedAt: now };
        await withDatabaseTransaction(db, function* (tx): DatabaseSteps<void> {
            yield tx.insert(schemas.apiKey).values({ uuid: apiKey, key: `delivery-${apiKey}`, name: 'test', credits: 100, createdAt: now });
            yield tx.insert(schemas.scheduledTasks).values({ uuid: taskUuid, apiKey, name: 'test', taskType: 'scrape', taskPayload: { url: 'https://example.com' }, cronExpression: '0 9 * * *', createdAt: now, updatedAt: now });
            yield tx.insert(schemas.monitors).values(monitor);
            yield tx.insert(schemas.taskExecutions).values({ uuid: checkUuid, scheduledTaskUuid: taskUuid, executionNumber: 1, idempotencyKey: checkUuid, scheduledFor: now, createdAt: now });
            yield* createMonitorCheckSteps(tx, { monitor, executionUuid: checkUuid, sequenceNumber: 1, now });
        });
        await db.update(schemas.monitorChecks).set({ state: 'ready' }).where(eq(schemas.monitorChecks.uuid, checkUuid));
        const check = await claimMonitorCheck(db, checkUuid, 60000);
        await commitMonitorCheck(db, check, {
            snapshot: { uuid: randomUUID(), url: 'https://example.com', content: 'Test', contentHash: 'hash', status: changeUuid ? 'changed' : 'error', contentComplete: !!changeUuid, capturedAt: now },
            ...(changeUuid ? { change: { uuid: changeUuid, url: 'https://example.com', changeType: 'content', createdAt: now } } : { error: 'Extraction failed' }),
            notifications: [{ uuid: notificationUuid, channel, recipient: channel === 'email' ? recipient : null, eventType, changeUuid, idempotencyKey: notificationUuid,
                payload: { monitor_id: monitorUuid, monitor_name: 'Delivery test', monitor_type: 'webpage', url: 'https://example.com', change_type: 'content', diff_text: 'Test changed', ...(changeUuid ? {} : { error: { message: 'Extraction failed' } }) } }],
        });
        return { monitor, changeUuid, notificationUuid };
    }
    async function notification(uuid: string) { return (await db.select().from(schemas.monitorNotifications).where(eq(schemas.monitorNotifications.uuid, uuid)))[0]; }
    async function change(uuid: string) { return (await db.select().from(schemas.monitorChanges).where(eq(schemas.monitorChanges.uuid, uuid)))[0]; }

    it('retries an actual temporary SMTP failure, then marks delivered with a stable Message-ID', async () => {
        const f = await fixture('email'); smtpReject = true;
        await MonitorManager.getInstance().tick(db);
        expect(await notification(f.notificationUuid)).toMatchObject({ status: 'retrying', attempts: 1 });
        expect((await change(f.changeUuid!)).notified).toBe(false);
        smtpReject = false;
        await db.update(schemas.monitorNotifications).set({ nextAttemptAt: new Date(Date.now() - 2000) }).where(eq(schemas.monitorNotifications.uuid, f.notificationUuid));
        await MonitorManager.getInstance().tick(db);
        expect(await notification(f.notificationUuid)).toMatchObject({ status: 'delivered', attempts: 2 });
        expect(await change(f.changeUuid!)).toMatchObject({ notified: true, notificationStatus: 'delivered' });
        expect(messages).toHaveLength(2);
        for (const message of messages) expect(message).toContain(`Message-ID: <${f.notificationUuid}@monitors.anycrawl.dev>`);
    });
    it('records error-only email delivery without inventing a change', async () => {
        const f = await fixture('email', 'monitor.error');
        await MonitorManager.getInstance().tick(db);
        expect(await notification(f.notificationUuid)).toMatchObject({ status: 'delivered' });
        expect(messages[0]).toContain('Extraction failed');
        expect(await db.select().from(schemas.monitorChanges).where(eq(schemas.monitorChanges.monitorUuid, f.monitor.uuid))).toEqual([]);
    });
    it('handles partial SMTP acceptance and makes all-recipient rejection an error', async () => {
        await expect(EmailNotifier.sendChangeEmail(['accepted@example.com', 'rejected@example.com'], { uuid: 'test', name: 'Test', monitorType: 'webpage' }, [{ url: 'https://example.com', changeType: 'content' }])).resolves.toBeUndefined();
        await expect(EmailNotifier.sendChangeEmail(['rejected@example.com'], { uuid: 'test', name: 'Test', monitorType: 'webpage' }, [{ url: 'https://example.com', changeType: 'content' }])).rejects.toBeDefined();
    });
    it('reconciles a persisted delivery without a Redis job and retries actual HTTP 500 -> 200 once', async () => {
        const f = await fixture('webhook'), subscriptionUuid = randomUUID(); ownedSubscriptions.push(subscriptionUuid);
        await db.insert(schemas.webhookSubscriptions).values({ uuid: subscriptionUuid, apiKey: f.monitor.apiKey, name: 'Local test', webhookUrl: `http://127.0.0.1:${httpPort}/hook`, webhookSecret: 'test-secret', eventTypes: ['monitor.changed'], maxRetries: 3, createdAt: new Date(), updatedAt: new Date() });
        await MonitorManager.getInstance().tick(db);
        expect(await notification(f.notificationUuid)).toMatchObject({ status: 'queued' });
        expect((await change(f.changeUuid!)).notified).toBe(false);
        const [delivery] = await db.select().from(schemas.webhookDeliveries).where(eq(schemas.webhookDeliveries.monitorNotificationUuid, f.notificationUuid));
        const queue = QueueManager.getInstance().getQueue('webhooks');
        await (await queue.getJob(`${delivery.uuid}-attempt-1`))!.remove(); // model a lost Redis enqueue after DB commit
        await WebhookManager.getInstance().reconcilePendingDeliveries();
        expect(await queue.getJob(`${delivery.uuid}-attempt-1`)).toBeDefined();
        await (WebhookManager.getInstance() as any).deliverWebhook(delivery.uuid);
        let [stored] = await db.select().from(schemas.webhookDeliveries).where(eq(schemas.webhookDeliveries.uuid, delivery.uuid));
        expect(stored).toMatchObject({ status: 'retrying', attemptNumber: 2 });
        httpStatus = 200;
        await db.update(schemas.webhookDeliveries).set({ nextRetryAt: new Date(Date.now() - 2000) }).where(eq(schemas.webhookDeliveries.uuid, delivery.uuid));
        await WebhookManager.getInstance().reconcilePendingDeliveries();
        await (WebhookManager.getInstance() as any).deliverWebhook(delivery.uuid);
        await (WebhookManager.getInstance() as any).deliverWebhook(delivery.uuid); // duplicate callback must not resend
        expect(await notification(f.notificationUuid)).toMatchObject({ status: 'delivered' });
        expect((await change(f.changeUuid!)).notified).toBe(true);
        expect(requests).toHaveLength(2);
        expect(requests.map(request => request.headers['x-webhook-delivery-id'])).toEqual([delivery.uuid, delivery.uuid]);
        expect(requests[0].headers['x-anycrawl-signature']).toMatch(/^sha256=/);
    });
});
