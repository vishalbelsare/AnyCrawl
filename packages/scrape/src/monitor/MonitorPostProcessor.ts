/** Compare one durable monitor check, then atomically publish its result.
 * External notifications are handled by MonitorManager from persisted intents.
 */
import { randomUUID, createHash } from "node:crypto";
import {
    getDB, getJobResults, getLatestSnapshot, schemas, eq,
    claimMonitorCheck, commitMonitorCheck, type MonitorCheckOutcome,
} from "@anycrawl/db";
import { config, WebhookEventType } from "@anycrawl/libs";
import { normalizeContent, hashContent } from "./normalize.js";
import { textDiff, priceDiff, classifyPriceChange, currencyForPath } from "./diff.js";
import { judgeChange } from "./judge.js";

export interface PreparedMonitorComparison {
    status: "new" | "same" | "changed" | "error";
    content: string;
    contentHash: string;
    extracted: any;
    diffText?: string;
    diffJson?: any[];
    changeType?: string;
    judgment?: any;
    error?: string;
}

/** Empty collections are meaningful when a non-empty page explicitly yielded
 * them; null/undefined and all-null extraction skeletons are not baselines. */
export function hasMonitorData(value: any, allowEmptyCollections = false): boolean {
    if (value === null || value === undefined) return false;
    if (Array.isArray(value)) return value.length === 0 ? allowEmptyCollections : value.some(v => hasMonitorData(v, allowEmptyCollections));
    if (typeof value === "object") return Object.values(value).some(v => hasMonitorData(v, allowEmptyCollections));
    return typeof value === "string" ? value.trim().length > 0 : true;
}

export async function compareMonitorResult(monitor: any, result: any, previous: any | null): Promise<PreparedMonitorComparison> {
    const data = result?.data ?? {};
    const trackMode = monitor.trackMode ?? "text";
    const diffOptions = monitor.diffOptions ?? {};
    const content = normalizeContent(data, { ignoreSelectors: diffOptions.ignore_selectors });
    const extracted = data.json ?? null;
    const base = { content, contentHash: hashContent(content), extracted };
    if (result?.status === "failed") return { ...base, status: "error", error: "The page scrape failed" };
    if (content.length > config.monitor.maxContentChars) {
        return { ...base, content: "", status: "error", error: `Page exceeds the ${config.monitor.maxContentChars}-character monitoring limit` };
    }
    if ((trackMode === "text" || trackMode === "mixed") && !content.trim()) {
        return { ...base, status: "error", error: "The scrape returned no comparable text" };
    }
    if ((trackMode === "json" || trackMode === "mixed") && !hasMonitorData(extracted, !!content.trim())) {
        // Missing JSON is an extraction failure. Do not silently run a second
        // LLM call on a different representation or install an empty baseline.
        return { ...base, status: "error", error: "The scrape returned no usable structured extraction" };
    }
    if (!previous) return { ...base, status: "new" };

    let diffText: string | undefined;
    let diffJson: any[] | undefined;
    let textComplete = true;
    let changeType = "content";
    if (trackMode === "text" || trackMode === "mixed") {
        const diff = textDiff(previous.content ?? "", content);
        const minimum = diffOptions.min_change_ratio ?? 0;
        if (diff.changed && diff.ratio >= minimum) diffText = diff.diffText;
        textComplete = !diff.truncated;
    }
    // JSON comparison is independent of the text hash, including mixed mode.
    if (trackMode === "json" || trackMode === "mixed") {
        const fields = priceDiff(previous.extracted, extracted);
        for (const field of fields) {
            if (/price|cost|amount|rate/i.test(field.path)) {
                field.currency = currencyForPath(extracted, field.path);
                field.fromCurrency = currencyForPath(previous.extracted, field.path);
            }
        }
        const classification = classifyPriceChange(fields, monitor.notifyOptions?.thresholds);
        if (fields.length && classification) { diffJson = fields; changeType = classification; }
    }
    if (!diffText && !diffJson?.length) return { ...base, status: "same" };
    let judgment: any;
    if (monitor.goal) {
        judgment = await judgeChange(monitor.goal, JSON.stringify({ text: diffText ?? null, fields: diffJson ?? [] }),
            monitor.targets[0].url, { complete: textComplete });
        if (monitor.notifyOptions?.only_meaningful !== false && judgment.meaningful === false) {
            return { ...base, status: "same", judgment };
        }
    }
    return { ...base, status: "changed", diffText, diffJson, changeType, judgment };
}

function intentsForEvent(check: any, eventType: string, payload: any, changeUuid?: string, email = false): any[] {
    const options = check.configSnapshot.notifyOptions ?? {};
    const channels: string[] = options.channels ?? ["webhook"];
    const rows: any[] = [];
    const append = (channel: string, recipient?: string) => {
        const recipientKey = recipient ? createHash("sha256").update(recipient.toLowerCase()).digest("hex") : "subscriptions";
        rows.push({ uuid: randomUUID(), channel, recipient: recipient ?? null, eventType, payload,
            changeUuid: changeUuid ?? null, idempotencyKey: `${check.uuid}/${eventType}/${channel}/${recipientKey}` });
    };
    if (channels.includes("webhook")) append("webhook");
    if (email && channels.includes("email")) {
        for (const recipient of new Set<string>(options.email_recipients ?? [])) append("email", recipient);
    }
    return rows;
}

export function prepareMonitorOutcome(check: any, comparison: PreparedMonitorComparison, previous: any | null, capturedAt = new Date()): MonitorCheckOutcome {
    const monitor = check.configSnapshot;
    const url = monitor.targets[0].url;
    const snapshotUuid = randomUUID();
    const snapshot = {
        uuid: snapshotUuid, url, capturedAt, status: comparison.status,
        content: comparison.status === "error" ? comparison.error : comparison.content,
        contentHash: comparison.contentHash, extracted: comparison.status === "error" ? null : comparison.extracted,
        contentComplete: comparison.status !== "error",
    };
    const identity = { monitor_id: monitor.uuid, monitor_name: monitor.name, monitor_type: monitor.monitorType,
        check_id: check.uuid, url, captured_at: capturedAt.toISOString() };
    const summary = { total: 1, new: 0, same: 0, changed: 0, error: 0, removed: 0 };
    summary[comparison.status] = 1;
    const notifications = intentsForEvent(check, WebhookEventType.MONITOR_CHECK_COMPLETED, { ...identity, summary });
    let change: any;
    if (comparison.status === "changed") {
        const uuid = randomUUID();
        change = {
            uuid, url, fromSnapshotUuid: previous.uuid, toSnapshotUuid: snapshotUuid,
            changeType: comparison.changeType, diffText: comparison.diffText ?? null,
            diffJson: comparison.diffJson ?? null, judgment: comparison.judgment ?? null, createdAt: capturedAt,
        };
        const event = comparison.changeType === "price_up" || comparison.changeType === "price_down"
            ? WebhookEventType.MONITOR_PRICE_CHANGED : WebhookEventType.MONITOR_CHANGED;
        notifications.push(...intentsForEvent(check, event, {
            ...identity, change_id: uuid, change_type: comparison.changeType,
            diff_text: comparison.diffText, diff_json: comparison.diffJson, judgment: comparison.judgment,
        }, uuid, true));
    } else if (comparison.status === "error") {
        notifications.push(...intentsForEvent(check, WebhookEventType.MONITOR_ERROR, {
            ...identity, error: { message: comparison.error || "Check failed" },
        }, undefined, true));
    }
    return { snapshot, change, notifications, error: comparison.error };
}

export class MonitorPostProcessor {
    /** Errors propagate to the durable worker, which records/retries them. */
    public static async process(input: { db?: any; check?: any; executionUuid: string; scheduledTaskUuid?: string; jobUuid?: string }): Promise<void> {
        const db = input.db || await getDB();
        const check = input.check || await claimMonitorCheck(db, input.executionUuid, config.monitor.leaseMs);
        if (!check) return;
        const monitor = check.configSnapshot;
        if (check.resultStatus !== "completed") {
            await this.processFailure({ db, check, executionUuid: check.uuid, errorMessage: check.sourceError?.message || "Check failed" });
            return;
        }
        const jobUuid = check.jobUuid ?? input.jobUuid;
        if (!jobUuid) throw new Error("Monitor check has no associated scrape job");
        const [job] = await db.select({ jobId: schemas.jobs.jobId }).from(schemas.jobs).where(eq(schemas.jobs.uuid, jobUuid)).limit(1);
        if (!job) throw new Error("Monitor scrape job could not be found");
        const results = await getJobResults(job.jobId);
        if (!results.length) throw new Error("Monitor scrape results are not available");
        const targetUrl = monitor.targets[0].url;
        const matches = results.filter((result: any) => result.url === targetUrl);
        const candidates = matches.length ? matches : results.length === 1 ? results : [];
        if (!candidates.length) throw new Error("Ambiguous results for a single-target monitor");
        candidates.sort((a: any, b: any) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime() || String(a.uuid ?? "").localeCompare(String(b.uuid ?? "")));
        const result = candidates[candidates.length - 1];
        const previous = await getLatestSnapshot(db, monitor.uuid, targetUrl, check.monitorRevision);
        const comparison = await compareMonitorResult(monitor, result, previous);
        const capturedAt = result.createdAt ? new Date(result.createdAt) : new Date();
        await commitMonitorCheck(db, check, prepareMonitorOutcome(check, comparison, previous, capturedAt));
    }

    public static async processFailure(input: { db?: any; check: any; executionUuid: string; errorMessage?: string }): Promise<void> {
        const db = input.db || await getDB();
        await commitMonitorCheck(db, input.check, prepareMonitorOutcome(input.check, {
            status: "error", content: "", contentHash: "", extracted: null, error: input.errorMessage || "Check failed",
        }, null));
    }
}
