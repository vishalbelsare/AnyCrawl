import { getDB, schemas, eq, sql, withDatabaseTransaction, type DatabaseSteps } from "@anycrawl/db";

type FinalExecutionStatus = "completed" | "failed" | "cancelled";

type MissingExecutionPayload = {
    scheduledTaskUuid: string;
    executionNumber: number;
    idempotencyKey: string;
    scheduledFor?: Date;
    triggeredBy?: string;
    createdAt?: Date;
    jobUuid?: string;
};

export type FinalizeExecutionInput = {
    db?: any;
    executionUuid: string;
    status: FinalExecutionStatus;
    jobUuid?: string;
    startedAt?: Date;
    completedAt?: Date;
    errorMessage?: string;
    errorCode?: string;
    errorDetails?: any;
    updateTaskStats?: boolean;
    allowCreateIfMissing?: boolean;
    createIfMissing?: MissingExecutionPayload;
    source?: "scheduler" | "worker" | "cleanup" | "system";
};

export type FinalizeExecutionResult = {
    transitioned: boolean;
    created: boolean;
    taskStatsUpdated: boolean;
    scheduledTaskUuid?: string;
};

/**
 * Finalize an execution in an idempotent way:
 * - Only transitions pending/running executions into terminal states once
 * - Updates scheduled_tasks counters consistently on real transitions
 * - Optionally recreates a failed record when transaction rollback removed it
 */
export async function finalizeExecution(input: FinalizeExecutionInput): Promise<FinalizeExecutionResult> {
    const db = input.db || await getDB();
    const completedAt = input.completedAt || new Date();
    const updateData: any = { status: input.status, completedAt };
    for (const key of ["jobUuid", "startedAt", "errorMessage", "errorCode", "errorDetails"] as const) {
        if (input[key] !== undefined) updateData[key] = input[key];
    }
    return withDatabaseTransaction(db, function* (tx): DatabaseSteps<FinalizeExecutionResult> {
        let rows = yield tx.update(schemas.taskExecutions).set(updateData).where(
            sql`${schemas.taskExecutions.uuid} = ${input.executionUuid} AND ${schemas.taskExecutions.status} IN ('pending', 'running')`
        ).returning({ uuid: schemas.taskExecutions.uuid, scheduledTaskUuid: schemas.taskExecutions.scheduledTaskUuid });
        let created = false;
        if (!rows.length && input.allowCreateIfMissing && input.status === "failed" && input.createIfMissing) {
            const payload = input.createIfMissing;
            rows = yield tx.insert(schemas.taskExecutions).values({
                uuid: input.executionUuid, scheduledTaskUuid: payload.scheduledTaskUuid,
                executionNumber: payload.executionNumber, idempotencyKey: payload.idempotencyKey,
                scheduledFor: payload.scheduledFor || completedAt, triggeredBy: payload.triggeredBy || "scheduler",
                createdAt: payload.createdAt || completedAt, jobUuid: payload.jobUuid,
                ...updateData,
            }).onConflictDoNothing().returning({ uuid: schemas.taskExecutions.uuid, scheduledTaskUuid: schemas.taskExecutions.scheduledTaskUuid });
            created = rows.length > 0;
        }
        const scheduledTaskUuid = rows[0]?.scheduledTaskUuid as string | undefined;
        if (!scheduledTaskUuid) return { transitioned: false, created: false, taskStatsUpdated: false };
        let taskStatsUpdated = false;
        if (input.updateTaskStats !== false && (input.status === "completed" || input.status === "failed")) {
            const stats = input.status === "completed" ? {
                successfulExecutions: sql`${schemas.scheduledTasks.successfulExecutions} + 1`, consecutiveFailures: 0,
            } : {
                failedExecutions: sql`${schemas.scheduledTasks.failedExecutions} + 1`,
                consecutiveFailures: sql`${schemas.scheduledTasks.consecutiveFailures} + 1`,
            };
            yield tx.update(schemas.scheduledTasks).set({ ...stats, updatedAt: completedAt })
                .where(eq(schemas.scheduledTasks.uuid, scheduledTaskUuid));
            taskStatsUpdated = true;
        }
        // The durable post-process intent commits with the execution terminal
        // state and statistics. The monitor worker can pick it up after a crash;
        // replay never requires moving an execution out of its terminal state.
        yield tx.update(schemas.monitorChecks).set({
            state: input.status === "cancelled" ? "failed" : "ready",
            resultStatus: input.status,
            sourceError: input.status === "completed" ? null : {
                message: input.errorMessage || (input.status === "cancelled" ? "Check cancelled" : "Check failed"),
                code: input.errorCode,
            },
            nextAttemptAt: completedAt,
            ...(input.jobUuid ? { jobUuid: input.jobUuid } : {}),
            ...(input.status === "cancelled" ? { processedAt: completedAt, lastError: "Check cancelled" } : {}),
        }).where(sql`${schemas.monitorChecks.uuid} = ${input.executionUuid} AND ${schemas.monitorChecks.state} = 'pending'`);
        return { transitioned: true, created, taskStatsUpdated, scheduledTaskUuid };
    });
}
