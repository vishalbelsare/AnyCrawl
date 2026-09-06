/**
 * Database-only transaction programs. Yield query builders, never network I/O
 * or Promises: better-sqlite3 must execute the entire transaction synchronously.
 * PostgreSQL awaits the same steps on its transaction connection.
 */
export type DatabaseSteps<T> = Generator<any, T, any>;
export type DatabaseWork<T> = (tx: any) => DatabaseSteps<T>;

export function isSQLiteExecutor(db: any): boolean {
    return typeof db.run === "function" && typeof db.all === "function";
}

function executeSync<T>(steps: DatabaseSteps<T>): T {
    let step = steps.next();
    while (!step.done) {
        const query = step.value;
        if (!query || typeof query.prepare !== "function") {
            steps.return(undefined as T);
            throw new Error("SQLite transactions must yield database query builders, not asynchronous work");
        }
        // Drizzle's public prepared-query API exposes a synchronous result for
        // SQLite. It also chooses run/all correctly for RETURNING vs plain writes.
        const preparedResult = query.prepare().execute();
        if (typeof preparedResult?.sync !== "function") {
            steps.return(undefined as T);
            throw new Error("Expected a synchronous SQLite prepared query");
        }
        step = steps.next(preparedResult.sync());
    }
    return step.value;
}

async function executeAsync<T>(steps: DatabaseSteps<T>): Promise<T> {
    let step = steps.next();
    while (!step.done) step = steps.next(await step.value);
    return step.value;
}

/** Execute inside a transaction already owned by the caller. */
export async function runDatabaseWork<T>(db: any, work: DatabaseWork<T>): Promise<T> {
    return isSQLiteExecutor(db) ? executeSync(work(db)) : executeAsync(work(db));
}

export async function withDatabaseTransaction<T>(db: any, work: DatabaseWork<T>): Promise<T> {
    if (isSQLiteExecutor(db)) {
        return db.transaction((tx: any) => executeSync(work(tx)), { behavior: "immediate" });
    }
    return db.transaction((tx: any) => executeAsync(work(tx)));
}
