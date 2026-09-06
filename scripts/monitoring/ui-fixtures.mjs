/** Synthetic visual fixtures in the isolated system-test DB; no network calls. */
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { getDB, schemas, eq, withDatabaseTransaction } from '../../packages/db/dist/index.js';
const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (process.env.ANYCRAWL_API_DB_CONNECTION !== manifest.connection || !manifest.work.startsWith('/private/tmp/anycrawl-monitor-system-')) throw new Error('Use the matching isolated system-test manifest');
const db = await getDB();
const [key] = await db.select().from(schemas.apiKey).where(eq(schemas.apiKey.uuid, manifest.keyId));
if (key?.key !== manifest.apiKey) throw new Error('Fixture owner mismatch');
const schema = { type: 'object', properties: { plans: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'number', minimum: 0 }, currency: { type: 'string', enum: ['USD', 'EUR'] } }, required: ['name', 'price'], additionalProperties: false } } }, required: ['plans'], additionalProperties: false };
const result = {};
for (const [kind, name] of [['price', 'UI regression — pricing and stock'], ['long', 'UI-regression-long-name-' + 'A'.repeat(232)], ['active', 'UI regression — active webpage']]) {
  const uuid = randomUUID(), taskUuid = randomUUID(), snapshotUuid = randomUUID(), now = new Date();
  const content = '# Pricing\n\n' + 'The current plan has updated pricing and limits.\n'.repeat(7000);
  const capturedAt = new Date(Date.now() - 120000);
  await withDatabaseTransaction(db, function* (tx) {
    yield tx.insert(schemas.scheduledTasks).values({ uuid: taskUuid, apiKey: key.uuid, name: `[monitor] ${name}`, taskType: 'scrape', taskPayload: { url: manifest.fixtureUrl, engine: 'cheerio', options: { formats: ['markdown'] } }, cronExpression: '0 9 * * *', timezone: 'UTC', isActive: true, isPaused: kind !== 'active', pauseReason: kind === 'price' ? 'Auto-paused after repeated extraction failures (UI fixture)' : null, nextExecutionAt: new Date(Date.now() + 86400000), createdAt: now, updatedAt: now, metadata: { monitorManaged: true, monitorUuid: uuid } });
    yield tx.insert(schemas.monitors).values({ uuid, apiKey: key.uuid, scheduledTaskUuid: taskUuid, name, monitorType: kind === 'price' ? 'price' : 'webpage', trackMode: kind === 'price' ? 'mixed' : 'text', extractSchema: kind === 'price' ? schema : null, targets: [{ url: manifest.fixtureUrl, engine: 'cheerio' }], notifyOptions: { channels: [] }, isActive: kind !== 'long', createdAt: now, updatedAt: now });
    yield tx.insert(schemas.monitorSnapshots).values({ uuid: snapshotUuid, monitorUuid: uuid, url: manifest.fixtureUrl, content, contentHash: createHash('sha256').update(content).digest('hex'), contentComplete: true, monitorRevision: 1, sequenceNumber: 1, status: 'changed', capturedAt, extracted: kind === 'price' ? { plans: [{ name: 'Pro', price: 24, currency: 'USD' }] } : null });
    if (kind === 'price') for (let i = 0; i < 55; i++) {
      yield tx.insert(schemas.monitorChanges).values({ uuid: randomUUID(), monitorUuid: uuid, url: manifest.fixtureUrl, fromSnapshotUuid: null, toSnapshotUuid: snapshotUuid, changeType: i % 2 ? 'price_down' : 'price_up', diffText: '@@ -1 +1 @@\n-Old plan price\n+New plan price', diffJson: [{ path: 'plans[0].price', from: 19, to: 24, delta: 5, currency: i % 3 ? 'USD' : 'EUR' }, { path: 'plans[1].price', from: 49, to: 45, delta: -4, currency: 'USD' }], judgment: { meaningful: null, confidence: 'low', reason: 'Synthetic regression fixture: AI unavailable', status: 'unavailable' }, notified: i % 4 === 0, notificationStatus: ['delivered', 'failed', 'queued', 'legacy'][i % 4], createdAt: new Date(Date.now() - i * 60000) });
    }
  });
  result[kind] = { uuid, snapshotUuid, name };
}
writeFileSync(`${manifest.work}/ui-fixtures.json`, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
if (manifest.databaseType === 'sqlite') db.$client.close(); else await db.$client.end();
