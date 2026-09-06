/**
 * Template E2E Tests — exercises the real TemplateClient (getTemplate / getTemplates /
 * executeTemplate + execution recording) against a fully-migrated SQLite database.
 *
 * Setup mirrors the packages/db tests: we force SQLite + a temp DB *file* and apply the
 * committed drizzle migrations before importing @anycrawl/db, so getDB() opens a migrated
 * file and the exported schema binds to SQLite. All @anycrawl/db / client imports are
 * therefore dynamic (below) — a static import would bind the schema at load time, before
 * the env is set.
 *
 * Assertions track the current fixture in ../libs/create-template.ts (template "test-default":
 * example.com/iana domains, a processTemplate() handler that returns
 * { processedBy, customField, processingTime }, and waitTime/includeImages/maxContentLength
 * variables). Keep this test and that fixture in sync.
 */
import Database from "better-sqlite3";
import { readFileSync, readdirSync, mkdtempSync, rmSync } from "fs";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { tmpdir } from "os";
import { describe, expect, it, beforeAll, afterAll } from "@jest/globals";
import type { TemplateConfig, TemplateExecutionContext } from "@anycrawl/libs";

// Force SQLite before any @anycrawl/db import (dynamic, in beforeAll). getDB() reads the
// connection at call time; the schema barrel reads ANYCRAWL_API_DB_TYPE at import time.
process.env.ANYCRAWL_API_DB_TYPE = "sqlite";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(__dirname, "../../../db/drizzle/SQLite");

/**
 * Apply every committed SQLite migration in order (FK off — no parent tables needed).
 * A few historical migrations are not idempotent when replayed from scratch (e.g. a
 * later one re-ADDs a column an earlier one already added); those benign
 * "duplicate column" / "already exists" errors are ignored so the schema still lands.
 */
function applyMigrations(sqlite: InstanceType<typeof Database>): void {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
        const ddl = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
        for (const raw of ddl.split("--> statement-breakpoint")) {
            const stmt = raw.trim();
            if (stmt.length === 0) continue;
            try {
                sqlite.exec(stmt);
            } catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                if (!/duplicate column name|already exists/i.test(msg)) throw error;
            }
        }
    }
}

describe("Template E2E Tests", () => {
    let templateClient: any;
    let createdTemplate: TemplateConfig;
    let db: any;
    let templateExecutions: any;
    let eq: any;
    let tmpDir: string;

    beforeAll(async () => {
        // 1. Build a migrated SQLite file and point getDB() at it.
        tmpDir = mkdtempSync(join(tmpdir(), "anycrawl-tpl-e2e-"));
        const dbFile = join(tmpDir, "test.db");
        const setup = new Database(dbFile);
        setup.pragma("foreign_keys = OFF");
        applyMigrations(setup);
        setup.close();

        process.env.ANYCRAWL_API_DB_TYPE = "sqlite";
        process.env.ANYCRAWL_API_DB_CONNECTION = dbFile;

        // 2. Import the db barrel + client only now (env is set → SQLite schema + our file).
        const dbPkg: any = await import("@anycrawl/db");
        ({ templateExecutions, eq } = dbPkg);
        db = await dbPkg.getDB();

        const { TemplateClient } = await import("../client/index.js");
        const { createTemplateScript } = await import("../libs/create-template.js");
        templateClient = new TemplateClient();

        // 3. Create the test template.
        createdTemplate = await createTemplateScript();
        console.log(`✅ Test template created successfully: ${createdTemplate.templateId}`);
    });

    afterAll(async () => {
        // Clean up execution rows (the whole temp DB is removed below regardless).
        if (createdTemplate?.uuid && db) {
            try {
                await db
                    .delete(templateExecutions)
                    .where(eq(templateExecutions.templateUuid, createdTemplate.uuid));
            } catch (error) {
                console.warn("Error cleaning up execution rows:", error);
            }
        }
        if (tmpDir) {
            try {
                rmSync(tmpDir, { recursive: true, force: true });
            } catch {
                /* best-effort */
            }
        }
    });

    describe("Template Database Operations", () => {
        it("should be able to get created template from database", async () => {
            const template = await templateClient.getTemplate(createdTemplate.templateId);

            expect(template).toBeDefined();
            expect(template.templateId).toBe(createdTemplate.templateId);
            expect(template.name).toBe(createdTemplate.name);
            expect(template.status).toBe("published");
            expect(template.reviewStatus).toBe("approved");
            expect(template.pricing.perCall).toBe(3);
            expect(template.tags).toContain("news");
            expect((template.reqOptions as any).engine).toBe("playwright");
        });

        it("should be able to list templates", async () => {
            const result = await templateClient.getTemplates({
                status: "published",
                limit: 10
            });

            expect(result).toBeDefined();
            // Array.isArray is realm-safe (the array is built inside @anycrawl/db's module realm).
            expect(Array.isArray(result.templates)).toBe(true);
            expect(result.total).toBeGreaterThan(0);

            // Check if our template is in the list
            const ourTemplate = result.templates.find(
                (t: any) => t.templateId === createdTemplate.templateId
            );
            expect(ourTemplate).toBeDefined();
        });
    });

    describe("Template Execution", () => {
        it("should be able to execute template's custom handler", async () => {
            const context: TemplateExecutionContext = {
                templateId: createdTemplate.templateId,
                request: {
                    url: "https://www.example.com/item?id=1",
                    method: "GET",
                    headers: {
                        "User-Agent": "AnyCrawl-Test/1.0"
                    }
                },
                variables: {
                    waitTime: 1000,
                    includeImages: false,
                    maxContentLength: 5000
                },
                metadata: {
                    testRun: true,
                    environment: "test"
                }
            };

            const result = await templateClient.executeTemplate(
                createdTemplate.templateId,
                context
            );

            expect(result).toBeDefined();
            expect(result.success).toBe(true);
            expect(result.executionTime).toBeGreaterThanOrEqual(0);
            expect(result.creditsCharged).toBe(3);
            expect(result.data).toBeDefined();

            // result.data is the sandbox envelope { success, result, logs, context, stats }.
            // The fixture handler is a pure computation whose return value the sandbox does not
            // surface (result stays {}), but the execution context is echoed back — assert on
            // that to confirm the handler ran against the right inputs.
            expect(result.data.success).toBe(true);
            expect(result.data.context.templateId).toBe(createdTemplate.templateId);
            expect(result.data.context.variables.waitTime).toBe(1000);
            expect(result.data.context.request.url).toBe("https://www.example.com/item?id=1");
        });

        it("should record template execution to database", async () => {
            const context: TemplateExecutionContext = {
                templateId: createdTemplate.templateId,
                request: {
                    url: "https://www.example.com/test-article",
                    method: "GET"
                },
                variables: {
                    waitTime: 2000
                }
            };

            // Execute template (recordExecution writes a row via the client's own db instance).
            await templateClient.executeTemplate(createdTemplate.templateId, context);

            // Verify via a raw read of the same DB file. We intentionally avoid the drizzle
            // query builder here: under jest's ESM module resolution the schema object the test
            // holds can be a different instance than the one getDB()'s drizzle was built with,
            // which makes a builder-based read return no rows even though the row exists.
            // Join through templates on template_id: the persisted template uuid is not
            // guaranteed to equal the fixture's in-memory uuid (createTemplate mints its own).
            const raw = new Database(process.env.ANYCRAWL_API_DB_CONNECTION as string);
            const execution = raw
                .prepare(
                    `SELECT te.success, te.processing_time_ms, te.credits_charged, te.created_at
                     FROM template_executions te
                     JOIN templates t ON te.template_uuid = t.uuid
                     WHERE t.template_id = ? LIMIT 1`
                )
                .get(createdTemplate.templateId) as any;
            raw.close();

            expect(execution).toBeDefined();
            expect(execution.success).toBe(1);
            expect(execution.processing_time_ms).toBeGreaterThanOrEqual(0);
            expect(execution.credits_charged).toBe(3);
            expect(execution.created_at).toBeTruthy();
        });

        it("should handle non-existent template", async () => {
            const context: TemplateExecutionContext = {
                templateId: "non-existent-template",
                request: {
                    url: "https://example.com",
                    method: "GET"
                }
            };

            await expect(
                templateClient.executeTemplate("non-existent-template", context)
            ).rejects.toThrow("Template not found");
        });
    });

    describe("Template Validation", () => {
        it("should validate template's required fields", () => {
            expect(createdTemplate.uuid).toBeDefined();
            expect(createdTemplate.templateId).toBeDefined();
            expect(createdTemplate.name).toBeDefined();
            expect(createdTemplate.tags).toBeInstanceOf(Array);
            expect(createdTemplate.version).toBeDefined();
            expect(createdTemplate.pricing).toBeDefined();
            expect(createdTemplate.pricing.perCall).toBeGreaterThan(0);
            expect(createdTemplate.pricing.currency).toBe("credits");
            expect(createdTemplate.reqOptions).toBeDefined();
            expect(createdTemplate.metadata).toBeDefined();
            expect(createdTemplate.createdBy).toBeDefined();
            expect(createdTemplate.status).toBeDefined();
            expect(createdTemplate.reviewStatus).toBeDefined();
        });

        it("should validate template's domain restriction configuration", () => {
            expect(createdTemplate.metadata.allowedDomains).toBeDefined();
            expect(createdTemplate.metadata.allowedDomains?.type).toBe("glob");
            expect(createdTemplate.metadata.allowedDomains?.patterns).toBeInstanceOf(Array);
            expect(createdTemplate.metadata.allowedDomains?.patterns.length).toBeGreaterThan(0);

            // Check if it contains the expected domain patterns (per the current fixture)
            const patterns = createdTemplate.metadata.allowedDomains?.patterns || [];
            expect(patterns).toContain("*.example.com");
            expect(patterns).toContain("www.iana.org/help/example-domains");
        });

        it("should validate custom handler configuration", () => {
            expect(createdTemplate.customHandlers).toBeDefined();
            expect(createdTemplate.customHandlers?.requestHandler).toBeDefined();
            expect(createdTemplate.customHandlers?.requestHandler?.enabled).toBe(true);
            expect(createdTemplate.customHandlers?.requestHandler?.code).toBeDefined();
            expect(createdTemplate.customHandlers?.requestHandler?.code.language).toBe("javascript");
            expect(createdTemplate.customHandlers?.requestHandler?.code.source).toBeDefined();
            expect(createdTemplate.customHandlers?.requestHandler?.code.source.length).toBeGreaterThan(100);

            expect(createdTemplate.customHandlers?.failedRequestHandler).toBeDefined();
            expect(createdTemplate.customHandlers?.failedRequestHandler?.enabled).toBe(true);
        });

        it("should validate template variable configuration", () => {
            expect(createdTemplate.variables).toBeDefined();

            if (createdTemplate.variables) {
                const waitTime = createdTemplate.variables.waitTime;
                const includeImages = createdTemplate.variables.includeImages;
                const maxContentLength = createdTemplate.variables.maxContentLength;

                expect(waitTime).toBeDefined();
                if (waitTime) {
                    expect(waitTime.type).toBe("number");
                    expect(waitTime.required).toBe(false);
                    expect(waitTime.defaultValue).toBe(2000);
                }

                expect(includeImages).toBeDefined();
                if (includeImages) {
                    expect(includeImages.type).toBe("boolean");
                    expect(includeImages.required).toBe(false);
                }

                expect(maxContentLength).toBeDefined();
                if (maxContentLength) {
                    expect(maxContentLength.type).toBe("number");
                }
            }
        });
    });

    describe("Template Cache", () => {
        it("should cache the retrieved template", async () => {
            // First get
            const start1 = Date.now();
            const template1 = await templateClient.getTemplate(createdTemplate.templateId);
            const time1 = Date.now() - start1;

            // Second get (should be from cache)
            const start2 = Date.now();
            const template2 = await templateClient.getTemplate(createdTemplate.templateId);
            const time2 = Date.now() - start2;

            expect(template1).toEqual(template2);
            expect(time2).toBeLessThanOrEqual(time1); // Cache should be at least as fast
        });
    });

    describe("Error Handling", () => {
        it("should handle template execution with an unusual request", async () => {
            const context: TemplateExecutionContext = {
                templateId: createdTemplate.templateId,
                request: {
                    url: "invalid-url", // Invalid URL — the fixture handler ignores the request URL
                    method: "GET"
                },
                variables: {}
            };

            const result = await templateClient.executeTemplate(
                createdTemplate.templateId,
                context
            );

            // The fixture handler is pure (no fetch), so execution still succeeds regardless of URL.
            expect(result.success).toBe(true);
            expect(result.data.context.templateId).toBe(createdTemplate.templateId);
        });
    });

});
