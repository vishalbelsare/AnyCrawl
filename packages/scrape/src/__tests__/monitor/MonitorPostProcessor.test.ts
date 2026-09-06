import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { normalizeContent, hashContent } from "../../monitor/normalize.js";

const judge = jest.fn<any>();
const claim = jest.fn<any>();
jest.unstable_mockModule("./src/monitor/judge.js", () => ({ judgeChange: judge }));
jest.unstable_mockModule("@anycrawl/db", () => ({ getDB: async () => ({}), schemas: {}, eq() {}, getJobResults() {}, getLatestSnapshot() {}, claimMonitorCheck: claim, commitMonitorCheck() {} }));
const { MonitorPostProcessor, compareMonitorResult, prepareMonitorOutcome } = await import("../../monitor/MonitorPostProcessor.js");

const target = { url: "https://example.com/pricing" };
function monitor(mode = "text", extra: any = {}) {
    return { uuid: "monitor", name: "Test", monitorType: mode === "text" ? "webpage" : "price", trackMode: mode, targets: [target], notifyOptions: { channels: ["webhook", "email"], email_recipients: ["test@example.com"] }, ...extra };
}
function previous(markdown: string, json?: any) {
    const content = normalizeContent({ markdown });
    return { uuid: "previous", content, contentHash: hashContent(content), extracted: json };
}
function result(markdown: string, json?: any) { return { data: { markdown, ...(json === undefined ? {} : { json }) } }; }
function prepare(config: any, comparison: any, prev: any) { return prepareMonitorOutcome({ uuid: "check", configSnapshot: config }, comparison, prev); }

beforeEach(() => {
    judge.mockReset().mockResolvedValue({ meaningful: true, confidence: "high", status: "complete", reason: "test" });
    claim.mockReset().mockResolvedValue(null);
});

describe("Monitor comparison and durable notification preparation", () => {
    it.each(["json", "mixed"])("detects a %s price change when Markdown and its real hash are unchanged", async mode => {
        const config = monitor(mode), prev = previous("Pricing page", { price: 19, currency: "USD" });
        const comparison = await compareMonitorResult(config, result("Pricing page", { price: 24, currency: "USD" }), prev);
        expect(comparison).toMatchObject({ status: "changed", changeType: "price_up", diffJson: [{ path: "price", from: 19, to: 24, delta: 5, currency: "USD", fromCurrency: "USD" }] });
        const outcome = prepare(config, comparison, prev);
        expect(outcome.notifications.filter(n => n.eventType === "monitor.price.changed").map(n => n.channel).sort()).toEqual(["email", "webhook"]);
        expect(outcome.change).not.toHaveProperty("notified", true);
    });
    it("detects a text change and prepares monitor.changed", async () => {
        const config = monitor(), prev = previous("Old copy");
        const comparison = await compareMonitorResult(config, result("New copy"), prev);
        expect(comparison).toMatchObject({ status: "changed", changeType: "content" });
        expect(prepare(config, comparison, prev).notifications.some(n => n.eventType === "monitor.changed")).toBe(true);
    });
    it("preserves both text and structured diffs in mixed-mode AI input", async () => {
        const config = monitor("mixed", { goal: "Pricing matters" });
        await compareMonitorResult(config, result("New copy", { price: 24 }), previous("Old copy", { price: 19 }));
        const input = JSON.parse(judge.mock.calls[0]![1] as string);
        expect(input.text).toContain("New copy");
        expect(input.fields).toEqual([expect.objectContaining({ path: "price", to: 24 })]);
    });
    it("downgrades a positively judged non-meaningful change to same", async () => {
        judge.mockResolvedValue({ meaningful: false, confidence: "high", status: "complete" });
        const config = monitor("text", { goal: "Ignore noise" }), prev = previous("Old copy");
        const outcome = prepare(config, await compareMonitorResult(config, result("New copy"), prev), prev);
        expect(outcome.snapshot.status).toBe("same");
        expect(outcome.change).toBeUndefined();
        expect(outcome.notifications.map(n => n.eventType)).toEqual(["monitor.check.completed"]);
    });
    it.each(["unavailable", "incomplete"])("retains an unknown AI judgment (%s) and its evidence", async status => {
        judge.mockResolvedValue({ meaningful: null, confidence: "low", status });
        expect(await compareMonitorResult(monitor("text", { goal: "Changes" }), result("New"), previous("Old"))).toMatchObject({ status: "changed", judgment: { meaningful: null, status } });
    });
    it.each(["text", "json", "mixed"])("does not alert when %s data is unchanged", async mode => {
        const config = monitor(mode), prev = previous("Pricing", { price: 19 });
        const outcome = prepare(config, await compareMonitorResult(config, result("Pricing", { price: 19 }), prev), prev);
        expect(outcome.snapshot.status).toBe("same");
        expect(outcome.change).toBeUndefined();
        expect(outcome.notifications.every(n => n.eventType === "monitor.check.completed")).toBe(true);
    });
    it("ignores executions without a claimable monitor check", async () => {
        await expect(MonitorPostProcessor.process({ executionUuid: "non-monitor" })).resolves.toBeUndefined();
        expect(claim).toHaveBeenCalled();
    });
    it("establishes the first valid baseline without sending change emails", async () => {
        const config = monitor("json");
        const outcome = prepare(config, await compareMonitorResult(config, result("Pricing", { price: 19 }), null), null);
        expect(outcome.snapshot).toMatchObject({ status: "new", contentComplete: true });
        expect(outcome.notifications.map(n => n.eventType)).toEqual(["monitor.check.completed"]);
    });
    it.each([undefined, null, {}, { price: null }, { nested: { price: null } }])("rejects invalid extraction %p on the first check and on later checks", async extraction => {
        const config = monitor("json");
        for (const prev of [null, previous("Pricing", { price: 19 })]) {
            const outcome = prepare(config, await compareMonitorResult(config, result("Pricing", extraction), prev), prev);
            expect(outcome.snapshot).toMatchObject({ status: "error", contentComplete: false });
            expect(outcome.change).toBeUndefined();
            expect(outcome.notifications.filter(n => n.eventType === "monitor.error").map(n => n.channel).sort()).toEqual(["email", "webhook"]);
        }
    });
    it.each([[], { products: [] }, { price: 0 }, { in_stock: false }])("accepts meaningful empty/zero/false extraction %p", async json => {
        expect(await compareMonitorResult(monitor("json"), result("Available products", json), null)).toMatchObject({ status: "new" });
    });
    it("treats scrape failures and empty text as errors", async () => {
        expect(await compareMonitorResult(monitor(), { status: "failed", data: { markdown: "cached" } }, null)).toMatchObject({ status: "error" });
        expect(await compareMonitorResult(monitor(), result(" "), null)).toMatchObject({ status: "error" });
    });
    it("records object-to-array shape drift as a change", async () => {
        expect(await compareMonitorResult(monitor("json"), result("Pricing", [{ price: 24 }]), previous("Pricing", { price: 19 }))).toMatchObject({ status: "changed" });
    });
    it("compares and retains a long tail beyond the API preview limit", async () => {
        const text = "Repeated line\n".repeat(30000);
        const comparison = await compareMonitorResult(monitor(), result(text + "New final price"), previous(text + "Old final price"));
        expect(comparison.status).toBe("changed");
        expect(comparison.content.endsWith("New final price")).toBe(true);
        expect(prepare(monitor(), comparison, previous(text)).snapshot.content).toBe(comparison.content);
    });
    it("marks oversized content as error rather than same", async () => {
        expect(await compareMonitorResult(monitor(), result("X".repeat(2_000_001)), previous("X"))).toMatchObject({ status: "error" });
    });
    it("applies the price threshold without suppressing unrelated text changes", async () => {
        const config = monitor("mixed", { notifyOptions: { thresholds: { price_change_pct: 10 } } });
        expect(await compareMonitorResult(config, result("Pricing", { price: 101 }), previous("Pricing", { price: 100 }))).toMatchObject({ status: "same" });
        expect(await compareMonitorResult(config, result("New terms", { price: 101 }), previous("Old terms", { price: 100 }))).toMatchObject({ status: "changed", changeType: "content" });
    });
    it("prepares no delivery when no channels are enabled", async () => {
        const config = monitor("text", { notifyOptions: { channels: [] } }), prev = previous("Old");
        const outcome = prepare(config, await compareMonitorResult(config, result("New"), prev), prev);
        expect(outcome.change).toBeDefined();
        expect(outcome.notifications).toEqual([]);
    });
    it("keeps stable event intent keys when a result is prepared for replay", async () => {
        const config = monitor(), prev = previous("Old"), comparison = await compareMonitorResult(config, result("New"), prev);
        expect(prepare(config, comparison, prev).notifications.map(n => n.idempotencyKey)).toEqual(prepare(config, comparison, prev).notifications.map(n => n.idempotencyKey));
    });
});
