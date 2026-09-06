import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";

/** Apply the original SQLite history without rewriting applied migration files.
 * 0009 and 0010 both add the same nullable TEXT column. The one known redundant
 * statement is accepted only after verifying its actual definition. All other
 * DDL/schema errors fail and roll back the migration transaction.
 */
export function migrateSQLiteDatabase(db: any, options: { migrationsFolder: string }): { applied: number; compatibilitySteps: number } {
    const client = db.$client;
    if (!client || typeof client.transaction !== "function") throw new Error("A better-sqlite3 database is required");
    const migrations = readMigrationFiles(options);
    const journal = JSON.parse(readFileSync(join(options.migrationsFolder, "meta", "_journal.json"), "utf8"));
    client.exec('CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (id SERIAL PRIMARY KEY, hash TEXT NOT NULL, created_at NUMERIC)');
    return client.transaction(() => {
        const last = client.prepare('SELECT created_at FROM "__drizzle_migrations" ORDER BY created_at DESC LIMIT 1').get();
        let applied = 0, compatibilitySteps = 0;
        for (let index = 0; index < migrations.length; index++) {
            const migration = migrations[index]!;
            if (last && Number(last.created_at) >= migration.folderMillis) continue;
            const tag = journal.entries[index]?.tag;
            for (const statement of migration.sql) {
                const duplicateChargeDetails = tag === "0010_sturdy_thunderbolt" &&
                    /^ALTER\s+TABLE\s+[`"]billing_ledger[`"]\s+ADD\s+(?:COLUMN\s+)?[`"]charge_details[`"]\s+text\s*;?$/i.test(statement.trim());
                if (duplicateChargeDetails) {
                    const column = client.prepare('PRAGMA table_info("billing_ledger")').all().find((row: any) => row.name === "charge_details");
                    if (column) {
                        if (column.type.toUpperCase() !== "TEXT" || column.notnull !== 0 || column.dflt_value !== null || column.pk !== 0) {
                            throw new Error("Existing billing_ledger.charge_details does not match the known nullable TEXT migration");
                        }
                        compatibilitySteps++;
                        continue;
                    }
                }
                client.exec(statement);
            }
            client.prepare('INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES (?, ?)').run(migration.hash, migration.folderMillis);
            applied++;
        }
        return { applied, compatibilitySteps };
    }).immediate();
}
