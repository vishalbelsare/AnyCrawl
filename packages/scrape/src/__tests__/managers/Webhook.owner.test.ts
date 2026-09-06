import { jest, beforeEach, describe, it, expect } from "@jest/globals";

let subscriptions: any[];
let authEnabled = true;
const inserted: any[] = [];
const add = jest.fn<any>();
const list = jest.fn<any>();
jest.unstable_mockModule("@anycrawl/libs", () => ({
    appConfig: { get authEnabled() { return authEnabled; } },
    log: { debug() {}, error() {}, info() {}, warning() {} },
}));
jest.unstable_mockModule("@anycrawl/db", () => ({
    getDB: async () => ({ insert: () => ({ values: async (row: any) => { inserted.push(row); } }) }),
    listWebhooksByOwner: list,
    schemas: { webhookDeliveries: {} }, eq() {}, sql() {}, and() {}, or() {}, lte() {}, withDatabaseTransaction() {}, refreshWebhookMonitorNotification() {},
}));
jest.unstable_mockModule("./src/managers/Queue.js", () => ({
    QueueManager: { getInstance: () => ({ getQueue: () => ({ add, getJob: async () => null }) }) },
}));
jest.unstable_mockModule("./src/managers/Worker.js", () => ({ WorkerManager: {} }));
const { WebhookManager } = await import("../../managers/Webhook.js");

describe("Webhook owner boundary and enqueue result", () => {
    beforeEach(() => {
        authEnabled = true; inserted.length = 0; add.mockReset(); add.mockResolvedValue({});
        subscriptions = [
            { uuid: "key-only", apiKey: "key-a", userId: null, isActive: true, scope: "all", eventTypes: ["monitor.changed"] },
            { uuid: "foreign", apiKey: "key-b", userId: "user-b", isActive: true, scope: "all", eventTypes: ["monitor.changed"] },
            { uuid: "same-user-another-key", apiKey: "key-c", userId: "user-b", isActive: true, scope: "specific", specificTaskIds: ["m"], eventTypes: ["monitor.changed"] },
        ];
        list.mockReset(); list.mockImplementation(async () => subscriptions);
    });

    it("isolates an API-key-only monitor from every other owner", async () => {
        expect(await WebhookManager.getInstance().triggerEvent("monitor.changed", {}, "monitor", "m", { apiKeyId: "key-a" })).toBe(1);
        expect(inserted.map(row => row.webhookSubscriptionUuid)).toEqual(["key-only"]);
        expect(list).toHaveBeenCalledWith(expect.anything(), { apiKeyId: "key-a" });
    });
    it("allows a user's other keys but still applies the specific monitor scope", async () => {
        expect(await WebhookManager.getInstance().triggerEvent("monitor.changed", {}, "monitor", "m", { userId: "user-b", apiKeyId: "key-b" })).toBe(2);
        expect(inserted.map(row => row.webhookSubscriptionUuid)).toEqual(["foreign", "same-user-another-key"]);
    });
    it("rejects an empty owner in authenticated deployments", async () => {
        await expect(WebhookManager.getInstance().triggerEvent("monitor.changed", {}, "monitor", "m", {})).rejects.toThrow("requires an owner");
        expect(inserted).toEqual([]);
    });
    it("permits explicitly configured auth-disabled single-tenant use", async () => {
        authEnabled = false;
        expect(await WebhookManager.getInstance().triggerEvent("monitor.changed", {}, "monitor", "m", {})).toBe(3);
    });
    it("does not report an enqueue failure as a successful notification", async () => {
        add.mockRejectedValue(new Error("Redis unavailable"));
        await expect(WebhookManager.getInstance().triggerEvent("monitor.changed", {}, "monitor", "m", { apiKeyId: "key-a" })).rejects.toThrow("Failed to enqueue");
        expect(inserted[0].status).toBe("pending");
    });
    it("distinguishes a lookup failure from no matching subscription", async () => {
        list.mockRejectedValue(new Error("DB unavailable"));
        await expect(WebhookManager.getInstance().triggerEvent("monitor.changed", {}, "monitor", "m", { apiKeyId: "key-a" })).rejects.toThrow("DB unavailable");
    });
});
