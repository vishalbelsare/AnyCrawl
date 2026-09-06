/** Isolated, real API / scheduler / Cheerio worker harness. No .env is loaded.
 * Requires the explicit test DB/Redis variables below. Keeps services available
 * for Dashboard/browser regression until SIGINT/SIGTERM. */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createSmtpServer } from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { QueueManager } from '../../packages/scrape/dist/managers/Queue.js';
import { Utils } from '../../packages/scrape/dist/Utils.js';
import { getDB, schemas, databaseType, migrateSQLiteDatabase, eq } from '../../packages/db/dist/index.js';
import { migrate as migratePostgres } from '../../packages/db/node_modules/drizzle-orm/node-postgres/migrator.js';

const root = process.cwd();
const connection = process.env.ANYCRAWL_API_DB_CONNECTION || '';
if (databaseType === 'sqlite' ? !connection.startsWith('/private/tmp/anycrawl-monitor-test-system-') : new URL(connection).pathname !== '/monitor_system_test') throw new Error('Only an isolated system test database is allowed');
const redis = process.env.ANYCRAWL_REDIS_URL;
if (!['redis://127.0.0.1:56379/2', 'redis://127.0.0.1:56379/3'].includes(redis)) throw new Error('Use isolated Redis DB 2 or 3');
const port = Number(process.env.MONITOR_TEST_BASE_PORT || 3012), fixturePort = port + 1;
const work = `/private/tmp/anycrawl-monitor-system-${databaseType}-${Date.now()}`;
mkdirSync(work, { recursive: true });
const db = await getDB();
const migrationsFolder = resolve(root, 'packages/db/drizzle', databaseType === 'sqlite' ? 'SQLite' : 'PostgreSQL');
if (databaseType === 'sqlite') migrateSQLiteDatabase(db, { migrationsFolder });
else await migratePostgres(db, { migrationsFolder });
const keyId = randomUUID(), foreignId = randomUUID(), apiKey = `monitor-system-${keyId}`, foreignKey = `monitor-system-${foreignId}`;
for (const [uuid, key] of [[keyId, apiKey], [foreignId, foreignKey]]) await db.insert(schemas.apiKey).values({ uuid, key, name: 'Isolated monitor test', credits: 1000, isActive: true, createdAt: new Date() });
let version = 1, delayMs = 0;
const emails = [], webhooks = [], sockets = new Set();
const fixtures = createHttpServer(async (req, res) => {
  if (req.url === '/target') {
    if (delayMs) await new Promise(done => setTimeout(done, delayMs));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><head><title>Monitoring test page</title></head><body><main><h1>Test pricing</h1><p>Current plan price is ${version === 1 ? '$19' : '$24'}. Version ${version}.</p></main></body></html>`);
  } else if (req.url === '/hook') {
    let body = ''; for await (const chunk of req) body += chunk;
    webhooks.push({ headers: req.headers, payload: JSON.parse(body) }); res.end('ok');
  } else { res.writeHead(404); res.end('not found'); }
});
fixtures.listen(fixturePort, '127.0.0.1'); await once(fixtures, 'listening');
const smtp = createSmtpServer(socket => {
  sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.write('220 localhost SMTP test\r\n');
  let buffer = '', inData = false, message = '';
  socket.on('data', chunk => {
    buffer += chunk.toString();
    while (buffer.includes('\r\n')) {
      const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
      if (inData) {
        if (line === '.') { emails.push(message); inData = false; message = ''; socket.write('250 Accepted\r\n'); }
        else message += line + '\r\n';
      } else if (/^EHLO|^HELO/i.test(line)) socket.write('250-localhost\r\n250 PIPELINING\r\n');
      else if (/^DATA/i.test(line)) { inData = true; socket.write('354 Send data\r\n'); }
      else if (/^QUIT/i.test(line)) socket.end('221 Bye\r\n');
      else socket.write('250 OK\r\n');
    }
  });
});
smtp.listen(0, '127.0.0.1'); await once(smtp, 'listening');
const smtpPort = smtp.address().port;
const children = [];
writeFileSync(`${work}/pid`, String(process.pid));
const childEnv = {
  PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
  NODE_ENV: 'test', ANYCRAWL_API_DB_TYPE: databaseType, ANYCRAWL_API_DB_CONNECTION: connection,
  ANYCRAWL_REDIS_URL: redis, ANYCRAWL_API_AUTH_ENABLED: 'true', ANYCRAWL_API_CREDITS_ENABLED: 'false',
  ANYCRAWL_API_HOST: '127.0.0.1', ANYCRAWL_API_PORT: String(port), ANYCRAWL_AVAILABLE_ENGINES: 'cheerio',
  ANYCRAWL_SCHEDULER_ENABLED: 'true', ANYCRAWL_SCHEDULER_SYNC_INTERVAL_MS: '1000',
  ANYCRAWL_SCHEDULED_TASKS_LIMIT_ENABLED: 'true', ANYCRAWL_SCHEDULED_TASKS_LIMIT_FREE: '1',
  ANYCRAWL_WEBHOOKS_ENABLED: 'true', ALLOW_LOCAL_WEBHOOKS: 'true', ANYCRAWL_CACHE_ENABLED: 'false',
  ANYCRAWL_MONITOR_POLL_MS: '1000', ANYCRAWL_MONITOR_RETRY_DELAY_MS: '1000',
  ANYCRAWL_SMTP_HOST: '127.0.0.1', ANYCRAWL_SMTP_PORT: String(smtpPort), ANYCRAWL_SMTP_SECURE: 'false', ANYCRAWL_SMTP_FROM: 'test@example.com',
  ANYCRAWL_LOCAL_STORAGE_DIR: `${work}/storage`, CRAWLEE_MEMORY_MBYTES: '1024',
};
function child(name, script, args = []) {
  const logfile = `${work}/${name}.log`, output = createWriteStream(logfile, { flags: 'a' });
  const running = spawn(process.execPath, [script, ...args], { cwd: root, env: { ...childEnv, ANYCRAWL_CRAWLEE_STORAGE_DIR: `${work}/crawlee-${name}` }, stdio: ['ignore', 'pipe', 'pipe'] });
  running.serviceName = name;
  running.stdout.pipe(output); running.stderr.pipe(output); children.push(running);
  running.on('exit', (code, signal) => console.log(`SERVICE_EXIT ${name} code=${code} signal=${signal}`));
  return running;
}
child('api', 'apps/api/dist/index.js');
child('scheduler', 'packages/scrape/dist/Worker.js', ['--queues=scheduler,monitor']);
child('cheerio', 'packages/scrape/dist/Worker.js', ['--queues=cheerio']);
const apiUrl = `http://127.0.0.1:${port}`;
const manifest = { work, apiUrl, apiKey, keyId, foreignKey, smtpPort, redis, fixtureUrl: `http://127.0.0.1:${fixturePort}/target`, databaseType, connection };
writeFileSync(`${work}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`HARNESS ${JSON.stringify(manifest)}`);
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  for (const child of children) child.kill('SIGTERM');
  await Promise.race([Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit'))), new Promise(done => setTimeout(done, 12000))]);
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  fixtures.closeAllConnections(); fixtures.close(); for (const socket of sockets) socket.destroy(); smtp.close();
  await QueueManager.getInstance().closeAll();
  await Utils.getInstance().getRedisConnection().quit();
  if (databaseType === 'sqlite') db.$client.close(); else await db.$client.end();
  process.exit(0);
}
process.on('SIGINT', stop); process.on('SIGTERM', stop);
async function call(path, method = 'GET', body, key = apiKey) {
  const response = await fetch(`${apiUrl}/v1${path}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) });
  return { status: response.status, ...(await response.json()) };
}
async function waitFor(label, predicate, timeout = 45000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const result = await predicate();
    if (result) return result;
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error(`Timed out: ${label}. Inspect ${work}/*.log`);
}
async function verify() {
  await waitFor('API health', async () => { try { return (await fetch(`${apiUrl}/health`)).ok; } catch { return false; } });
  // Give the actual scheduler worker time to register its BullMQ consumer.
  await waitFor('scheduler consumer', async () => {
    const text = await import('node:fs/promises').then(fs => fs.readFile(`${work}/scheduler.log`, 'utf8'));
    return text.includes('Scheduler Manager initialized') && text.includes('Worker started successfully');
  });
  const subscription = await call('/webhooks', 'POST', { name: 'System test hook', webhook_url: `http://127.0.0.1:${fixturePort}/hook`, event_types: ['monitor.changed', 'monitor.error'], scope: 'all' });
  assert.equal(subscription.status, 201, JSON.stringify(subscription));
  const created = await call('/monitors', 'POST', { name: 'System test monitor', cron_expression: '0 */6 * * *', targets: [{ url: manifest.fixtureUrl, engine: 'cheerio' }], notify_options: { channels: ['email', 'webhook'], email_recipients: ['test@example.com'] } });
  assert.equal(created.status, 201, JSON.stringify(created)); const id = created.data.monitor_id;
  manifest.monitorId = id; writeFileSync(`${work}/manifest.json`, JSON.stringify(manifest, null, 2));
  const baseline = await waitFor('baseline snapshot', async () => { const result = await call(`/monitors/${id}/snapshots`); return result.data?.[0]; });
  assert.equal(baseline.status, 'new', JSON.stringify(baseline));
  assert.equal((await call(`/monitors/${id}`, 'GET', undefined, foreignKey)).status, 404);
  assert.equal((await call(`/monitors/${id}/changes`)).data.length, 0); assert.equal(emails.length, 0);
  version = 2;
  const triggers = await Promise.all([call(`/monitors/${id}/check`, 'POST'), call(`/monitors/${id}/check`, 'POST')]);
  assert.ok(triggers.every(result => [202, 409].includes(result.status)), JSON.stringify(triggers));
  const changed = await waitFor('change and actual notification delivery', async () => { const result = await call(`/monitors/${id}/changes`); return result.data?.find(row => row.notification_status === 'delivered'); });
  assert.equal(changed.change_type, 'content');
  assert.ok(changed.diff_text.includes('24'));
  await waitFor('SMTP and Webhook accepted', () => emails.length === 1 && webhooks.some(row => row.payload.event_type === 'monitor.changed' || row.headers['x-webhook-event'] === 'monitor.changed'));
  const checks = await call(`/monitors/${id}/checks`); assert.equal(checks.data.length, 2, 'Concurrent manual triggers must collapse into one check');
  assert.equal((await call(`/monitors/${id}/pause`, 'POST')).status, 200);
  const pausedCheck = await call(`/monitors/${id}/check`, 'POST'); assert.equal(pausedCheck.code, 'MONITOR_PAUSED');
  assert.equal((await call(`/monitors/${id}/resume`, 'POST')).status, 200);
  const updated = await call(`/monitors/${id}`, 'PATCH', { diff_options: { ignore_selectors: ['Current plan'] }, goal: null }); assert.equal(updated.status, 200);
  assert.equal((await call(`/monitors/${id}/check`, 'POST')).status, 202);
  const revised = await waitFor('new configuration baseline', async () => { const result = await call(`/monitors/${id}/snapshots`); return result.data?.find(row => row.monitor_revision === updated.data.revision); });
  assert.equal(revised.status, 'new');
  // Two real scheduler jobs must queue across the complete scrape/postprocess
  // interval, with no skipped work and no counter increments on delayed retries.
  await call(`/monitors/${id}`, 'PATCH', { concurrency_mode: 'queue', notify_options: { channels: [] } });
  delayMs = 2000;
  const task = (await call(`/monitors/${id}`)).data;
  const queue = QueueManager.getInstance().getQueue('scheduler');
  const queueRunIds = [];
  for (let index = 0; index < 2; index++) {
    const jobId = randomUUID(); queueRunIds.push(jobId);
    await queue.add('scheduler', { taskUuid: task.scheduled_task_uuid, triggeredBy: 'scheduler', scheduledFor: new Date(Date.now() - (index + 1) * 900000).toISOString() }, { jobId, removeOnComplete: true });
  }
  await waitFor('both queued checks finish serially', async () => { const history = await call(`/monitors/${id}/checks`); return history.data?.length === 5 && history.data.every(row => ['completed', 'failed'].includes(row.state)); });
  const afterQueue = (await call(`/monitors/${id}/checks`)).data;
  assert.deepEqual(afterQueue.map(row => row.sequence_number), [5, 4, 3, 2, 1]);
  assert.ok(afterQueue.every(row => row.state === 'completed'), JSON.stringify(afterQueue));

  // Kill the actual postprocess/scheduler process while Cheerio still runs.
  // Scrape completion must remain durable and be recovered by a new worker.
  delayMs = 3000;
  assert.equal((await call(`/monitors/${id}/check`, 'POST')).status, 202);
  await waitFor('manual check admitted before crash', async () => { const history = await call(`/monitors/${id}/checks`); return history.data?.length === 6 && history.data[0].state === 'pending'; });
  const scheduler = children.find(child => child.serviceName === 'scheduler');
  const exited = once(scheduler, 'exit'); scheduler.kill('SIGKILL'); await exited;
  await waitFor('scrape commits ready while processor is offline', async () => { const history = await call(`/monitors/${id}/checks`); return history.data?.[0]?.state === 'ready'; });
  child('scheduler-restarted', 'packages/scrape/dist/Worker.js', ['--queues=scheduler,monitor']);
  await waitFor('ready check recovers after worker restart', async () => { const history = await call(`/monitors/${id}/checks`); return history.data?.[0]?.state === 'completed'; });
  delayMs = 0;
  const second = await call('/monitors', 'POST', { name: 'Monitor quota exclusion test', cron_expression: '0 */6 * * *', targets: [{ url: manifest.fixtureUrl, engine: 'cheerio' }], notify_options: { channels: [] } });
  assert.equal(second.status, 201);
  await waitFor('second monitor baseline', async () => (await call(`/monitors/${second.data.monitor_id}/snapshots`)).data?.[0]);
  assert.equal((await call(`/monitors/${id}`)).data.is_paused, false);
  assert.equal((await call(`/monitors/${second.data.monitor_id}`)).data.is_paused, false);
  await call(`/monitors/${id}/pause`, 'POST');
  await call(`/monitors/${second.data.monitor_id}`, 'DELETE');
  assert.equal((await call(`/monitors/${second.data.monitor_id}`)).status, 404);
  // Reproduce legacy inconsistent pause/orphan rows without fabricating a
  // replacement monitor. The worker must pause them without another execution.
  await db.update(schemas.scheduledTasks).set({ isPaused: false }).where(eq(schemas.scheduledTasks.uuid, task.scheduled_task_uuid));
  await queue.add('scheduler', { taskUuid: task.scheduled_task_uuid, triggeredBy: 'scheduler', scheduledFor: new Date().toISOString() }, { jobId: randomUUID(), removeOnComplete: true });
  await waitFor('legacy inactive monitor stops its task', async () => (await db.select().from(schemas.scheduledTasks).where(eq(schemas.scheduledTasks.uuid, task.scheduled_task_uuid)))[0]?.isPaused);
  const orphanUuid = randomUUID();
  await db.insert(schemas.scheduledTasks).values({ uuid: orphanUuid, apiKey: keyId, name: 'Legacy orphan test', taskType: 'scrape', taskPayload: { url: manifest.fixtureUrl, engine: 'cheerio' }, cronExpression: '0 */6 * * *', metadata: { monitorManaged: true, monitorUuid: randomUUID() }, nextExecutionAt: new Date(Date.now() + 86400000), createdAt: new Date(), updatedAt: new Date() });
  await queue.add('scheduler', { taskUuid: orphanUuid, triggeredBy: 'scheduler', scheduledFor: new Date().toISOString() }, { jobId: randomUUID(), removeOnComplete: true });
  await waitFor('legacy orphan stops without dispatch', async () => (await db.select().from(schemas.scheduledTasks).where(eq(schemas.scheduledTasks.uuid, orphanUuid)))[0]?.isPaused);
  assert.equal((await db.select().from(schemas.taskExecutions).where(eq(schemas.taskExecutions.scheduledTaskUuid, orphanUuid))).length, 0);
  await db.delete(schemas.scheduledTasks).where(eq(schemas.scheduledTasks.uuid, orphanUuid));
  await db.update(schemas.monitors).set({ trackMode: 'json', extractSchema: null }).where(eq(schemas.monitors.uuid, id));
  assert.equal((await call(`/monitors/${id}/pause`, 'POST')).status, 200, 'A broken legacy monitor must still be pausable');
  assert.equal((await call(`/monitors/${id}/resume`, 'POST')).status, 400, 'A broken legacy monitor cannot resume until repaired');
  await db.update(schemas.monitors).set({ trackMode: 'text' }).where(eq(schemas.monitors.uuid, id));
  const allChecks = (await call(`/monitors/${id}/checks`)).data;
  assert.equal(allChecks.length, 6);
  assert.ok(allChecks.every(row => row.state === 'completed'));
  writeFileSync(`${work}/verification.json`, JSON.stringify({ passed: true, checks: allChecks, baseline, changed, revised, queueMode: true, workerCrashRecovery: true, quotaExclusion: true, legacyPauseGuard: true, ownerIsolation: true, emails: emails.length, webhooks: webhooks.length }, null, 2));
  console.log(`SYSTEM_VERIFIED ${databaseType} ${work}/verification.json`);
}
verify().catch(error => { console.error(`SYSTEM_FAILED ${error.stack}`); writeFileSync(`${work}/failure.txt`, String(error.stack)); });
