import { createMonitorSchema, updateMonitorSchema } from "../types/MonitorSchema.js";
import { buildMonitorTaskPayload, prepareMonitorUpdate } from "../monitor-configuration.js";

const schema = { type: "object", properties: { products: { type: "array", items: { type: "object", properties: { price: { type: "number", minimum: 0 }, currency: { type: "string", enum: ["USD", "EUR"] } }, required: ["price"], additionalProperties: false } } }, required: ["products"], additionalProperties: false };
const monitor = { uuid: "m", name: "Price", monitorType: "price", trackMode: "mixed", revision: 2, targets: [{ url: "https://example.com", options: { only_main_content: false } }], goal: "A lower price", extractSchema: schema, diffOptions: { only_main_content: true, ignore_selectors: ["Updated at"], min_change_ratio: 0.02 }, notifyOptions: { channels: ["webhook"], email_recipients: ["a@example.com"], only_meaningful: false }, isActive: true };
const task = { cronExpression: "0 */6 * * *", timezone: "UTC" };

describe("Effective monitor configuration", () => {
    it("preserves nested JSON Schema keywords through create and PATCH validation", () => {
        expect(createMonitorSchema.parse({ name: "Price", monitor_type: "price", cron_expression: task.cronExpression, targets: monitor.targets, extract_schema: schema }).extract_schema).toEqual(schema);
        expect(updateMonitorSchema.parse({ extract_schema: schema }).extract_schema).toEqual(schema);
    });
    it("merges siblings and makes the stored main-content option authoritative", () => {
        const next = prepareMonitorUpdate(monitor, task, updateMonitorSchema.parse({ diff_options: { min_change_ratio: 0.1 } }));
        expect(next.monitor.diffOptions).toEqual({ ...monitor.diffOptions, min_change_ratio: 0.1 });
        expect(next.task.taskPayload.options.only_main_content).toBe(true);
        expect(next.monitor.revision).toBe(2);
    });
    it("clears a goal from both records and starts a new baseline revision", () => {
        const next = prepareMonitorUpdate(monitor, task, { goal: null });
        expect(next.monitor.goal).toBeNull();
        expect(next.task.taskPayload.options.json_options).not.toHaveProperty("user_prompt");
        expect(next.monitor.revision).toBe(3);
    });
    it("validates email recipients after merging the partial PATCH", () => {
        const patch = updateMonitorSchema.parse({ notify_options: { channels: ["email"] } });
        expect(prepareMonitorUpdate(monitor, task, patch).monitor.notifyOptions.email_recipients).toEqual(["a@example.com"]);
        expect(() => prepareMonitorUpdate({ ...monitor, notifyOptions: { channels: ["email"], email_recipients: ["a@example.com"] } }, task, { notify_options: { email_recipients: [] } })).toThrow("email_recipients");
    });
    it("rejects schema removal for json/mixed and accepts explicit text conversion", () => {
        expect(() => prepareMonitorUpdate(monitor, task, { extract_schema: null })).toThrow("extract_schema");
        const next = prepareMonitorUpdate({ ...monitor, monitorType: "webpage" }, task, { track_mode: "text", extract_schema: null });
        expect(next.monitor.extractSchema).toBeNull();
        expect(next.task.taskPayload.options).not.toHaveProperty("json_options");
    });
    it("keeps reserved task metadata and propagates tags/name/description", () => {
        const next = prepareMonitorUpdate(monitor, task, { name: "New", description: null, tags: ["test"], metadata: { monitorManaged: false, monitorUuid: "other", team: "test" } });
        expect(next.task).toMatchObject({ name: "[monitor] New", description: null, tags: ["test"], metadata: { monitorManaged: true, monitorUuid: "m", team: "test" } });
    });
    it("rejects unsupported fields and geographic locking instead of ignoring them", () => {
        expect(() => updateMonitorSchema.parse({ monitor_type: "price" })).toThrow();
        expect(() => updateMonitorSchema.parse({ targets: [{ url: "https://example.com", location: { country: "US" } }] })).toThrow("Location locking");
    });
    it("retains required formats and respects user main-content when no diff override exists", () => {
        expect(buildMonitorTaskPayload(monitor.targets[0], "mixed", schema, null, {}).options).toMatchObject({ only_main_content: false, formats: ["markdown", "json"] });
    });
    it("allows stopping a broken legacy configuration but refuses to resume it", () => {
        const broken = { ...monitor, extractSchema: null, notifyOptions: { channels: ["email"], email_recipients: [] } };
        expect(prepareMonitorUpdate(broken, task, { is_active: false })).toMatchObject({ monitor: { isActive: false }, task: { isPaused: true } });
        expect(() => prepareMonitorUpdate(broken, task, { is_active: true })).toThrow();
    });

});
