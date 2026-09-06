import type { OwnerContext } from "@anycrawl/libs";
import { eq, sql } from "drizzle-orm";
import { schemas } from "../db/index.js";
import { buildMonitorWhereClause } from "./MonitorAccess.js";
import { withDatabaseTransaction, type DatabaseSteps } from "../transaction.js";

/** Lock and read the owned row before merging a PATCH. A failed validation or
 * backing-task write rolls back both records, including the lock write. */
export async function updateOwnedMonitor(db: any, id: string, owner: OwnerContext,
    prepare: (monitor: any, task: any) => { monitor: any; task: any }): Promise<any | null> {
    return withDatabaseTransaction(db, function* (tx): DatabaseSteps<any | null> {
        const [owned] = yield tx.select({ taskUuid: schemas.monitors.scheduledTaskUuid }).from(schemas.monitors)
            .where(buildMonitorWhereClause(id, owner)).limit(1);
        if (!owned) return null;
        // Match Scheduler's task -> monitor -> check lock order.
        const [task] = yield tx.update(schemas.scheduledTasks).set({ updatedAt: sql`${schemas.scheduledTasks.updatedAt}` })
            .where(eq(schemas.scheduledTasks.uuid, owned.taskUuid)).returning();
        if (!task) throw new Error("Monitor backing task is missing");
        const [monitor] = yield tx.update(schemas.monitors).set({ updatedAt: new Date() })
            .where(buildMonitorWhereClause(id, owner)).returning();
        if (!monitor) return null;
        const updates = prepare(monitor, task);
        yield tx.update(schemas.monitors).set(updates.monitor).where(eq(schemas.monitors.uuid, id));
        const [updatedTask] = yield tx.update(schemas.scheduledTasks).set(updates.task)
            .where(eq(schemas.scheduledTasks.uuid, task.uuid)).returning();
        return updatedTask;
    });
}

export async function deleteOwnedMonitor(db: any, id: string, owner: OwnerContext): Promise<string | null> {
    return withDatabaseTransaction(db, function* (tx): DatabaseSteps<string | null> {
        const [owned] = yield tx.select({ taskUuid: schemas.monitors.scheduledTaskUuid }).from(schemas.monitors)
            .where(buildMonitorWhereClause(id, owner)).limit(1);
        if (!owned) return null;
        if (owned.taskUuid) yield tx.update(schemas.scheduledTasks).set({ updatedAt: sql`${schemas.scheduledTasks.updatedAt}` })
            .where(eq(schemas.scheduledTasks.uuid, owned.taskUuid));
        yield tx.delete(schemas.monitors).where(buildMonitorWhereClause(id, owner));
        if (owned.taskUuid) yield tx.delete(schemas.scheduledTasks).where(eq(schemas.scheduledTasks.uuid, owned.taskUuid));
        return owned.taskUuid ?? "";
    });
}
