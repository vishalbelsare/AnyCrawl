import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { pgTable, text, jsonb, timestamp } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";
import { withDatabaseTransaction, type DatabaseSteps } from "../transaction.js";

const records = pgTable("monitor_transaction_probe", {
    id: text("id").primaryKey(), value: jsonb("value"), createdAt: timestamp("created_at", { withTimezone: true }),
});

describe("PostgreSQL database transactions (isolated test database)", () => {
    let pool: Pool;
    let db: ReturnType<typeof drizzle>;
    beforeAll(async () => {
        const connectionString = process.env.MONITOR_TEST_POSTGRES_URL;
        if (!connectionString || new URL(connectionString).pathname !== "/monitor_test") {
            throw new Error("MONITOR_TEST_POSTGRES_URL must explicitly point to the isolated monitor_test database");
        }
        pool = new Pool({ connectionString, max: 4 });
        db = drizzle(pool);
        await pool.query("CREATE TABLE IF NOT EXISTS monitor_transaction_probe (id TEXT PRIMARY KEY, value JSONB, created_at TIMESTAMPTZ)");
    });
    beforeEach(async () => { await pool.query("TRUNCATE monitor_transaction_probe"); });
    afterAll(async () => { if (pool) { await pool.query("DROP TABLE IF EXISTS monitor_transaction_probe"); await pool.end(); } });

    it("commits JSON/date values across multiple steps", async () => {
        const date = new Date("2026-09-06T00:00:00Z");
        const row = await withDatabaseTransaction(db, function* (tx): DatabaseSteps<any> {
            yield tx.insert(records).values({ id: "a", value: { price: 19 }, createdAt: date });
            const [updated] = yield tx.update(records).set({ value: { price: 24 } }).where(eq(records.id, "a")).returning();
            return updated;
        });
        expect(row).toEqual({ id: "a", value: { price: 24 }, createdAt: date });
    });

    it("keeps concurrent commits and rollbacks on separate connections", async () => {
        const outcomes = await Promise.allSettled([
            withDatabaseTransaction(db, function* (tx): DatabaseSteps<void> {
                yield tx.insert(records).values({ id: "rollback" });
                throw new Error("injected failure");
            }),
            withDatabaseTransaction(db, function* (tx): DatabaseSteps<void> {
                yield tx.insert(records).values({ id: "commit" });
            }),
        ]);
        expect(outcomes.map(result => result.status)).toEqual(["rejected", "fulfilled"]);
        expect((await db.select().from(records)).map(row => row.id)).toEqual(["commit"]);
    });
});
