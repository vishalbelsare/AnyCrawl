import { resolve } from "node:path";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import { getDB, databaseType } from "./db/index.js";
import { migrateSQLiteDatabase } from "./migrations.js";

if (!process.env.ANYCRAWL_API_DB_CONNECTION) throw new Error("ANYCRAWL_API_DB_CONNECTION is required for migrations");
const db = await getDB();
try {
    const migrationsFolder = resolve("drizzle", databaseType === "sqlite" ? "SQLite" : "PostgreSQL");
    if (databaseType === "sqlite") {
        const result = migrateSQLiteDatabase(db, { migrationsFolder });
        console.info(`SQLite migrations: ${result.applied} applied, ${result.compatibilitySteps} verified historical duplicate statement(s)`);
    } else {
        await migratePostgres(db, { migrationsFolder });
        console.info("PostgreSQL migrations completed");
    }
} finally {
    if (databaseType === "sqlite") db.$client.close();
    else await db.$client.end();
}
