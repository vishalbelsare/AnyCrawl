import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { migrateSQLiteDatabase } from "../migrations.js";

describe("SQLite historical migrations", () => {
    let native: Database.Database;
    let db: ReturnType<typeof drizzle>;
    let folder: string;
    beforeEach(() => { native = new Database(":memory:"); db = drizzle(native); folder = mkdtempSync(join(tmpdir(), "anycrawl-monitor-migrations-")); });
    afterEach(() => { native.close(); rmSync(folder, { recursive: true, force: true }); });

    function history(columnDefinition: string, tag = "0010_sturdy_thunderbolt") {
        mkdirSync(join(folder, "meta"));
        writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ version: "7", dialect: "sqlite", entries: [
            { idx: 0, version: "6", when: 1000, tag: "0009_billing_charge_details", breakpoints: true },
            { idx: 1, version: "6", when: 2000, tag, breakpoints: true },
        ] }));
        writeFileSync(join(folder, "0009_billing_charge_details.sql"), `CREATE TABLE billing_ledger (id TEXT, charge_details ${columnDefinition});`);
        writeFileSync(join(folder, `${tag}.sql`), 'ALTER TABLE `billing_ledger` ADD `charge_details` text;');
    }
    it("applies the complete original history once, including the verified duplicate column", () => {
        const first = migrateSQLiteDatabase(db, { migrationsFolder: resolve("drizzle/SQLite") });
        expect(first.applied).toBeGreaterThan(20);
        expect(first.compatibilitySteps).toBe(1);
        expect(native.prepare('PRAGMA table_info("jobs")').all().some((column: any) => column.name === "deducted_at")).toBe(true);
        expect(migrateSQLiteDatabase(db, { migrationsFolder: resolve("drizzle/SQLite") })).toEqual({ applied: 0, compatibilitySteps: 0 });
        expect(native.prepare("SELECT name FROM sqlite_master WHERE name IN ('monitor_checks', 'monitor_notifications')").all()).toHaveLength(2);
    });
    it.each(["INTEGER", "TEXT NOT NULL", "TEXT DEFAULT 'unexpected'"])("rejects a conflicting existing column definition: %s", definition => {
        history(definition);
        expect(() => migrateSQLiteDatabase(db, { migrationsFolder: folder })).toThrow("does not match");
        expect(native.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get()).toEqual({ count: 0 });
        expect(native.prepare("SELECT name FROM sqlite_master WHERE name = 'billing_ledger'").all()).toEqual([]);
    });
    it("does not swallow duplicate-column errors in any other migration", () => {
        history("TEXT", "0011_unexpected_duplicate");
        let error: any;
        try { migrateSQLiteDatabase(db, { migrationsFolder: folder }); } catch (caught) { error = caught; }
        expect(error).toMatchObject({ code: "SQLITE_ERROR" });
        expect(native.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get()).toEqual({ count: 0 });
    });
});
