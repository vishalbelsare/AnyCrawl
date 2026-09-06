import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { withDatabaseTransaction, type DatabaseSteps } from "../transaction.js";

const records = sqliteTable("records", {
    id: text("id").primaryKey(),
    value: text("value", { mode: "json" }),
    createdAt: integer("created_at", { mode: "timestamp" }),
});

describe("SQLite database transactions", () => {
    let connection: Database.Database;
    let db: ReturnType<typeof drizzle>;
    beforeEach(() => {
        connection = new Database(":memory:");
        connection.exec("CREATE TABLE records (id TEXT PRIMARY KEY, value TEXT, created_at INTEGER)");
        db = drizzle(connection);
    });
    afterEach(() => connection.close());

    it("commits all steps and preserves RETURNING JSON/date decoding", async () => {
        const date = new Date("2026-09-06T00:00:00Z");
        const row = await withDatabaseTransaction(db, function* (tx): DatabaseSteps<any> {
            yield tx.insert(records).values({ id: "a", value: { price: 19 }, createdAt: date });
            const [updated] = yield tx.update(records).set({ value: { price: 24 } })
                .where(eq(records.id, "a")).returning();
            return updated;
        });
        expect(row).toEqual({ id: "a", value: { price: 24 }, createdAt: date });
        expect(db.select().from(records).all()).toEqual([row]);
    });

    it("rolls back a partial write and cannot write again after rejection", async () => {
        await expect(withDatabaseTransaction(db, function* (tx): DatabaseSteps<void> {
            yield tx.insert(records).values({ id: "a" });
            throw new Error("second step failed");
        })).rejects.toThrow("second step failed");
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(db.select().from(records).all()).toEqual([]);
    });

    it("rolls back when a later database constraint fails", async () => {
        await expect(withDatabaseTransaction(db, function* (tx): DatabaseSteps<void> {
            yield tx.insert(records).values({ id: "a" });
            yield tx.insert(records).values({ id: "a" });
        // Assert the native driver code; its Error constructor can originate
        // in an earlier Jest VM when better-sqlite3 is shared across suites.
        })).rejects.toMatchObject({ code: "SQLITE_CONSTRAINT_PRIMARYKEY" });
        expect(db.select().from(records).all()).toEqual([]);
    });
});
