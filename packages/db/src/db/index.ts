import { drizzle } from "drizzle-orm/node-postgres";
import { drizzle as drizzleSQLite } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as sqliteSchema from "./schemas/SQLite.js";
import * as postgresqlSchema from "./schemas/PostgreSQL.js";
import { Pool } from "pg";
import { log } from "@anycrawl/libs/log";

export const databaseType = process.env.ANYCRAWL_API_DB_TYPE?.toLowerCase() ?? "sqlite";
export const schemas = (databaseType === "sqlite" ? sqliteSchema : postgresqlSchema) as any;

let dbInstance: ReturnType<typeof drizzle> | ReturnType<typeof drizzleSQLite> | null = null;

export const initializeDatabase = async () => {
    if (dbInstance) return dbInstance;
    log.info(`Initializing database with type: ${process.env.ANYCRAWL_API_DB_TYPE}`);
    const dbType = databaseType;
    switch (dbType) {
        case "sqlite":
            log.info("Using SQLite database");
            const sqlite = new Database(process.env.ANYCRAWL_API_DB_CONNECTION);
            dbInstance = drizzleSQLite(sqlite, { schema: sqliteSchema });
            return dbInstance;
        case "postgresql":
            log.info("Using PostgreSQL database");
            if (!process.env.ANYCRAWL_API_DB_CONNECTION) {
                throw new Error("Database connection string is required");
            }
            // Transactions need their own checked-out connection. Sharing one
            // pg Client lets concurrent BEGIN/COMMIT calls interleave.
            const client = new Pool({ connectionString: process.env.ANYCRAWL_API_DB_CONNECTION });
            try {
                await client.query("SELECT 1");
                log.info("PostgreSQL connection established");
                dbInstance = drizzle(client, { schema: postgresqlSchema });
                return dbInstance;
            } catch (error) {
                await client.end();
                log.error(`Failed to connect to PostgreSQL: ${error}`);
                throw error;
            }
        default:
            throw new Error(
                `Unsupported database type: ${dbType}. Please set ANYCRAWL_API_DB_TYPE to one of: postgresql, sqlite`
            );
    }
};

let initializing: ReturnType<typeof initializeDatabase> | null = null;

// Share startup across concurrent API requests instead of allocating extra pools.
export const getDB = async (): Promise<any> => {
    if (!dbInstance) {
        initializing ??= initializeDatabase();
        try { dbInstance = await initializing; } finally { initializing = null; }
    }
    return dbInstance;
};
