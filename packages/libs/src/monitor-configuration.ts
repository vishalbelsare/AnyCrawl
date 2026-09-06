import { CronExpressionParser } from "cron-parser";
import { z } from "zod";
import { estimateTaskCredits } from "./credits.js";
import { effectiveMonitorSchema, type UpdateMonitorInput } from "./types/MonitorSchema.js";

export function buildMonitorTaskPayload(target: any, trackMode: string, extractSchema: any, goal: string | null | undefined, diffOptions: any): any {
    const userOptions = target.options ?? {};
    const options: any = {
        ...userOptions,
        only_main_content: diffOptions?.only_main_content ?? userOptions.only_main_content ?? true,
        formats: [...new Set([...(userOptions.formats ?? []), "markdown", ...(trackMode === "text" ? [] : ["json"])])],
    };
    if (trackMode !== "text") options.json_options = { schema: extractSchema, ...(goal ? { user_prompt: goal } : {}) };
    return { url: target.url, engine: target.engine ?? "auto", options };
}

function stable(value: any): string {
    return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
}

/** Called under the owned monitor lock, so sibling fields and configuration
 * revision are based on the current committed row, not an earlier HTTP read. */
export function prepareMonitorUpdate(monitor: any, task: any, patch: UpdateMonitorInput): { monitor: any; task: any } {
    // Stopping work must remain possible for invalid configurations created by
    // older releases. Resuming or editing still validates the effective state.
    if (patch.is_active === false && Object.keys(patch).every(key => key === "is_active")) {
        const updatedAt = new Date();
        return { monitor: { isActive: false, updatedAt }, task: { isPaused: true, pauseReason: "Paused by user (monitor)", updatedAt } };
    }
    const next = { ...monitor };
    const mapping = { name: "name", description: "description", goal: "goal", targets: "targets", track_mode: "trackMode", extract_schema: "extractSchema", is_active: "isActive" } as const;
    for (const [input, column] of Object.entries(mapping)) {
        if ((patch as any)[input] !== undefined) next[column] = (patch as any)[input];
    }
    if (patch.diff_options !== undefined) next.diffOptions = { ...monitor.diffOptions, ...patch.diff_options };
    if (patch.notify_options !== undefined) {
        next.notifyOptions = { ...monitor.notifyOptions, ...patch.notify_options };
        if (patch.notify_options.thresholds !== undefined) next.notifyOptions.thresholds = { ...monitor.notifyOptions?.thresholds, ...patch.notify_options.thresholds };
    }
    effectiveMonitorSchema.parse({ monitor_type: next.monitorType, track_mode: next.trackMode, extract_schema: next.extractSchema, notify_options: next.notifyOptions });
    const payload = buildMonitorTaskPayload(next.targets[0], next.trackMode, next.extractSchema, next.goal, next.diffOptions);
    const previousPayload = buildMonitorTaskPayload(monitor.targets[0], monitor.trackMode, monitor.extractSchema, monitor.goal, monitor.diffOptions);
    const comparisonChanged = stable([payload, next.trackMode, next.goal ?? null, next.diffOptions?.ignore_selectors ?? []]) !== stable([previousPayload, monitor.trackMode, monitor.goal ?? null, monitor.diffOptions?.ignore_selectors ?? []]);
    const updatedAt = new Date();
    const monitorUpdate: any = { updatedAt, revision: (monitor.revision ?? 1) + Number(comparisonChanged) };
    for (const column of Object.values(mapping)) monitorUpdate[column] = next[column];
    monitorUpdate.diffOptions = next.diffOptions;
    monitorUpdate.notifyOptions = next.notifyOptions;
    const taskUpdate: any = { updatedAt, name: `[monitor] ${next.name}`, description: next.description,
        taskPayload: payload, minCreditsRequired: estimateTaskCredits("scrape", payload) };
    for (const [input, column] of Object.entries({ cron_expression: "cronExpression", timezone: "timezone", concurrency_mode: "concurrencyMode", max_executions_per_day: "maxExecutionsPerDay", tags: "tags" })) {
        if ((patch as any)[input] !== undefined) taskUpdate[column] = (patch as any)[input];
    }
    if (patch.metadata !== undefined) taskUpdate.metadata = { ...(patch.metadata ?? {}), monitorManaged: true, monitorUuid: monitor.uuid };
    if (patch.is_active !== undefined) {
        taskUpdate.isPaused = !patch.is_active;
        taskUpdate.isActive = true;
        taskUpdate.pauseReason = patch.is_active ? null : "Paused by user (monitor)";
        if (patch.is_active) taskUpdate.consecutiveFailures = 0;
    }
    if (patch.cron_expression !== undefined || patch.timezone !== undefined || patch.is_active === true) {
        try {
            taskUpdate.nextExecutionAt = CronExpressionParser.parse(taskUpdate.cronExpression ?? task.cronExpression, { tz: taskUpdate.timezone ?? task.timezone ?? "UTC", currentDate: updatedAt }).next().toDate();
        } catch {
            throw new z.ZodError([{ code: z.ZodIssueCode.custom, path: ["cron_expression"], message: "cron_expression and timezone produced no future execution time" }]);
        }
    }
    return { monitor: monitorUpdate, task: taskUpdate };
}
