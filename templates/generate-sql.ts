#!/usr/bin/env ts-node
// @ts-nocheck
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

type HandlerRef = { language: 'javascript' | 'typescript'; sourcePath?: string; source?: string };

type RegexExtract = { pattern: string; flags?: string; group?: number; trim?: boolean };

type QueryTransform = {
    enabled?: boolean;
    mode?: 'template' | 'append';
    template?: string; // template mode uses {{query}}
    prefix?: string;   // append mode
    suffix?: string;   // append mode
    regexExtract?: RegexExtract; // optional pre-extract
};

type UrlTransform = {
    enabled?: boolean;
    mode?: 'template' | 'append';
    template?: string; // template mode uses {{url}}
    prefix?: string;   // append mode
    suffix?: string;   // append mode
    regexExtract?: RegexExtract; // optional pre-extract
};

type Handlers = {
    requestHandler?: HandlerRef;
    failedRequestHandler?: HandlerRef;
    urlTransform?: UrlTransform;
    queryTransform?: QueryTransform;
};

type TemplateJson = {
    uuid: string;
    templateId: string;
    name: string;
    description?: string;
    tags: string[];
    version: string;
    templateType: 'scrape' | 'crawl' | 'search';
    pricing: { perCall: number; currency: 'credits' };
    reqOptions: Record<string, any>;
    handlers?: Handlers;
    metadata: Record<string, any>;
    variables?: Record<string, any>;
    createdBy?: string;
    publishedBy?: string;
    reviewedBy?: string;
    status?: string;
    reviewStatus?: string;
    reviewNotes?: string;
    trusted?: boolean;
    createdAt?: string;
    updatedAt?: string;
    publishedAt?: string;
    reviewedAt?: string;
    output?: { sqlPath: string };
};

// ESM-compatible __filename and __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readText(file: string) {
    return fs.readFileSync(file, 'utf8');
}

function loadHandlerSource(baseDir: string, h?: HandlerRef): string | undefined {
    if (!h) return undefined;
    if (h.source) return h.source;
    if (h.sourcePath) {
        const abs = path.isAbsolute(h.sourcePath) ? h.sourcePath : path.join(baseDir, h.sourcePath);
        return readText(abs);
    }
    return undefined;
}

function loadReadme(baseDir: string): string | undefined {
    const candidates = ['README.md', 'Readme.md', 'readme.md'];
    for (const name of candidates) {
        const abs = path.join(baseDir, name);
        if (fs.existsSync(abs)) {
            return readText(abs);
        }
    }
    return undefined;
}

function extractLogo(t: TemplateJson): string | undefined {
    const anyT = t as any;
    if (typeof anyT.logo === 'string' && anyT.logo.trim()) return anyT.logo.trim();
    if (typeof anyT.metadata?.logo === 'string' && anyT.metadata.logo.trim()) return anyT.metadata.logo.trim();
    return undefined;
}

function jsonb(val: any): string {
    return `'${JSON.stringify(val)}'::jsonb`;
}

function dollarQuote(tag: string, body: string): string {
    // Ensure the tag doesn't appear in the body to prevent premature closing
    let finalTag = tag;
    let counter = 0;
    while (body.includes(`$${finalTag}$`)) {
        finalTag = `${tag}_${counter}`;
        counter++;
    }
    return `$${finalTag}$${body}$${finalTag}$`;
}

function stableStringify(value: any): string {
    const seen = new WeakSet();
    const stringify = (val: any): any => {
        if (val && typeof val === 'object') {
            if (seen.has(val)) return '[Circular]';
            seen.add(val);
            if (Array.isArray(val)) return val.map(stringify);
            const keys = Object.keys(val).sort();
            const obj: Record<string, any> = {};
            for (const k of keys) obj[k] = stringify(val[k]);
            return obj;
        }
        return val;
    };
    return JSON.stringify(stringify(value));
}

function computeContentChecksum(t: TemplateJson, requestHandlerSource?: string, failedHandlerSource?: string): string {
    // Build handlers object with all handler configurations
    const handlersNormalized: Record<string, any> = {};

    // Add urlTransform and queryTransform from handlers
    if (t.handlers?.urlTransform) {
        handlersNormalized.urlTransform = t.handlers.urlTransform;
    }
    if (t.handlers?.queryTransform) {
        handlersNormalized.queryTransform = t.handlers.queryTransform;
    }
    // Include preNav rules if present so checksum accounts for them
    if ((t as any).handlers?.preNav) {
        handlersNormalized.preNav = (t as any).handlers.preNav;
    }

    if (requestHandlerSource) {
        handlersNormalized.requestHandler = {
            enabled: true,
            code: { language: t.handlers?.requestHandler?.language || 'javascript', source: requestHandlerSource },
        };
    }
    if (failedHandlerSource) {
        handlersNormalized.failedRequestHandler = {
            enabled: true,
            code: { language: t.handlers?.failedRequestHandler?.language || 'javascript', source: failedHandlerSource },
        };
    }

    const payload = {
        uuid: t.uuid,
        templateId: t.templateId,
        name: t.name,
        description: t.description || '',
        tags: t.tags || [],
        version: t.version,
        templateType: t.templateType,
        pricing: t.pricing,
        reqOptions: t.reqOptions,
        handlers: handlersNormalized,
        metadata: t.metadata,
        variables: t.variables || undefined,
        status: t.status || 'draft',
        reviewStatus: t.reviewStatus || 'pending',
        reviewNotes: t.reviewNotes || '',
        trusted: !!t.trusted,
    };
    const hash = crypto.createHash('sha256');
    hash.update(stableStringify(payload));
    return hash.digest('hex');
}

function buildSqlPostgres(t: TemplateJson, requestHandlerSource?: string, failedHandlerSource?: string, readmeContent?: string, logoContent?: string): string {
    const lines: string[] = [];
    const checksum = computeContentChecksum(t, requestHandlerSource, failedHandlerSource);
    lines.push('-- Insert SQL for ' + t.name + ' Template');
    lines.push(`-- Generated from ${t.templateId}.json`);
    lines.push(`-- Date: ${new Date().toISOString().slice(0, 10)}`);
    lines.push(`-- Version: ${t.version}`);
    lines.push(`-- contentChecksum: ${checksum}`);
    lines.push('');
    lines.push('INSERT INTO "public"."templates" (');
    lines.push('    "uuid",');
    lines.push('    "template_id",');
    lines.push('    "name",');
    lines.push('    "description",');
    lines.push('    "tags",');
    lines.push('    "version",');
    lines.push('    "template_type",');
    lines.push('    "pricing",');
    lines.push('    "req_options",');
    lines.push('    "custom_handlers",');
    lines.push('    "metadata",');
    lines.push('    "variables",');
    lines.push('    "created_by",');
    lines.push('    "published_by",');
    lines.push('    "reviewed_by",');
    lines.push('    "status",');
    lines.push('    "review_status",');
    lines.push('    "review_notes",');
    lines.push('    "trusted",');
    lines.push('    "created_at",');
    lines.push('    "updated_at",');
    lines.push('    "published_at",');
    lines.push('    "reviewed_at"');
    lines.push(') VALUES (');
    lines.push(`    '${t.uuid}'::uuid,`);
    lines.push(`    '${t.templateId}',`);
    lines.push(`    '${t.name.replace(/'/g, "''")}',`);
    lines.push(`    '${(t.description || '').replace(/'/g, "''")}',`);
    lines.push(`    ${jsonb(t.tags)},`);
    lines.push(`    '${t.version}',`);
    lines.push(`    '${t.templateType}',`);
    lines.push(`    ${jsonb(t.pricing)},`);
    lines.push(`    ${jsonb(t.reqOptions)},`);

    // Build handlers object with all handler configurations for the database
    const handlersObj: Record<string, any> = {};

    // Add urlTransform and queryTransform from handlers
    if (t.handlers?.urlTransform) {
        handlersObj.urlTransform = t.handlers.urlTransform;
    }
    if (t.handlers?.queryTransform) {
        handlersObj.queryTransform = t.handlers.queryTransform;
    }
    // Persist preNav rules if provided in template.json
    if ((t as any).handlers?.preNav) {
        handlersObj.preNav = (t as any).handlers.preNav;
    }

    if (requestHandlerSource) {
        handlersObj.requestHandler = {
            enabled: true,
            code: { language: t.handlers?.requestHandler?.language || 'javascript', source: requestHandlerSource },
        };
    }
    if (failedHandlerSource) {
        handlersObj.failedRequestHandler = {
            enabled: true,
            code: { language: t.handlers?.failedRequestHandler?.language || 'javascript', source: failedHandlerSource },
        };
    }
    const handlersJson = JSON.stringify(handlersObj);
    lines.push(`    ${dollarQuote('custom_handlers', handlersJson)}::jsonb,`);
    lines.push(`    ${dollarQuote('metadata', JSON.stringify(t.metadata))}::jsonb,`);
    lines.push(`    ${t.variables ? dollarQuote('variables', JSON.stringify(t.variables)) + '::jsonb' : 'NULL'},`);
    lines.push(`    '${(t.createdBy || '').replace(/'/g, "''")}',`);
    lines.push(`    '${(t.publishedBy || '').replace(/'/g, "''")}',`);
    lines.push(`    '${(t.reviewedBy || '').replace(/'/g, "''")}',`);
    lines.push(`    '${(t.status || 'draft').replace(/'/g, "''")}',`);
    lines.push(`    '${(t.reviewStatus || 'pending').replace(/'/g, "''")}',`);
    lines.push(`    '${(t.reviewNotes || '').replace(/'/g, "''")}',`);
    lines.push(`    ${t.trusted ? 'true' : 'false'},`);
    lines.push(`    ${t.createdAt ? `'${t.createdAt}'::timestamp` : 'NOW()'},`);
    lines.push(`    ${t.updatedAt ? `'${t.updatedAt}'::timestamp` : 'NOW()'},`);
    lines.push(`    ${t.publishedAt ? `'${t.publishedAt}'::timestamp` : 'NOW()'},`);
    lines.push(`    ${t.reviewedAt ? `'${t.reviewedAt}'::timestamp` : 'NOW()'}`);
    lines.push(')');
    lines.push('ON CONFLICT (template_id)');
    lines.push('DO UPDATE SET');
    lines.push('    "name" = EXCLUDED."name",');
    lines.push('    "description" = EXCLUDED."description",');
    lines.push('    "tags" = EXCLUDED."tags",');
    lines.push('    "version" = EXCLUDED."version",');
    lines.push('    "pricing" = EXCLUDED."pricing",');
    lines.push('    "req_options" = EXCLUDED."req_options",');
    lines.push('    "custom_handlers" = EXCLUDED."custom_handlers",');
    lines.push('    "metadata" = EXCLUDED."metadata",');
    // never update rating via upsert
    lines.push('    "variables" = EXCLUDED."variables",');
    lines.push('    "review_notes" = EXCLUDED."review_notes",');
    lines.push('    "trusted" = EXCLUDED."trusted",');
    lines.push('    "updated_at" = EXCLUDED."updated_at",');
    lines.push('    "published_at" = EXCLUDED."published_at",');
    lines.push('    "reviewed_at" = EXCLUDED."reviewed_at";');
    lines.push('');
    if (readmeContent) {
        const docsUuid = uuidV5FromString(`${t.uuid}:template_docs`);
        lines.push('');
        lines.push('-- Template docs');
        lines.push('INSERT INTO "public"."template_docs" (');
        lines.push('    "uuid",');
        lines.push('    "template_uuid",');
        if (logoContent) lines.push('    "logo",');
        lines.push('    "content"');
        lines.push(') VALUES (');
        lines.push(`    '${docsUuid}'::uuid,`);
        lines.push(`    '${t.uuid}'::uuid,`);
        if (logoContent) lines.push(`    ${dollarQuote('logo', logoContent)},`);
        lines.push(`    ${dollarQuote('readme_md', readmeContent)}`);
        lines.push(')');
        lines.push('ON CONFLICT ("template_uuid") DO UPDATE SET');
        if (logoContent) lines.push('    "logo" = EXCLUDED."logo",');
        lines.push('    "content" = EXCLUDED."content",');
        lines.push('    "updated_at" = NOW();');
        lines.push('');
    }
    return lines.join('\n');
}

function singleQuoteLiteral(input: string): string {
    return `'${input.replace(/'/g, "''")}'`;
}

function buildSqlSqlite(t: TemplateJson, requestHandlerSource?: string, failedHandlerSource?: string, readmeContent?: string, logoContent?: string): string {
    // Build handlers object with all handler configurations for the database
    const handlersObj: Record<string, any> = {};

    // Add urlTransform and queryTransform from handlers
    if (t.handlers?.urlTransform) {
        handlersObj.urlTransform = t.handlers.urlTransform;
    }
    if (t.handlers?.queryTransform) {
        handlersObj.queryTransform = t.handlers.queryTransform;
    }
    // Persist preNav rules if provided in template.json
    if ((t as any).handlers?.preNav) {
        handlersObj.preNav = (t as any).handlers.preNav;
    }

    if (requestHandlerSource) {
        handlersObj.requestHandler = {
            enabled: true,
            code: { language: t.handlers?.requestHandler?.language || 'javascript', source: requestHandlerSource },
        };
    }
    if (failedHandlerSource) {
        handlersObj.failedRequestHandler = {
            enabled: true,
            code: { language: t.handlers?.failedRequestHandler?.language || 'javascript', source: failedHandlerSource },
        };
    }

    const checksum = computeContentChecksum(t, requestHandlerSource, failedHandlerSource);

    const lines: string[] = [];
    lines.push('-- Insert SQL for ' + t.name + ' Template');
    lines.push(`-- Generated from ${t.templateId}.json`);
    lines.push(`-- Date: ${new Date().toISOString().slice(0, 10)}`);
    lines.push(`-- Version: ${t.version}`);
    lines.push(`-- contentChecksum: ${checksum}`);
    lines.push('');
    lines.push('INSERT INTO templates (');
    lines.push('    uuid,');
    lines.push('    template_id,');
    lines.push('    name,');
    lines.push('    description,');
    lines.push('    tags,');
    lines.push('    version,');
    lines.push('    template_type,');
    lines.push('    pricing,');
    lines.push('    req_options,');
    lines.push('    custom_handlers,');
    lines.push('    metadata,');
    lines.push('    variables,');
    lines.push('    created_by,');
    lines.push('    published_by,');
    lines.push('    reviewed_by,');
    lines.push('    status,');
    lines.push('    review_status,');
    lines.push('    review_notes,');
    lines.push('    trusted,');
    lines.push('    created_at,');
    lines.push('    updated_at,');
    lines.push('    published_at,');
    lines.push('    reviewed_at');
    lines.push(') VALUES (');
    lines.push(`    ${singleQuoteLiteral(t.uuid)},`);
    lines.push(`    ${singleQuoteLiteral(t.templateId)},`);
    lines.push(`    ${singleQuoteLiteral(t.name)},`);
    lines.push(`    ${singleQuoteLiteral(t.description || '')},`);
    lines.push(`    ${singleQuoteLiteral(JSON.stringify(t.tags || []))},`);
    lines.push(`    ${singleQuoteLiteral(t.version)},`);
    lines.push(`    ${singleQuoteLiteral(t.templateType)},`);
    lines.push(`    ${singleQuoteLiteral(JSON.stringify(t.pricing))},`);
    lines.push(`    ${singleQuoteLiteral(JSON.stringify(t.reqOptions))},`);
    lines.push(`    ${singleQuoteLiteral(JSON.stringify(handlersObj))},`);
    lines.push(`    ${singleQuoteLiteral(JSON.stringify(t.metadata))},`);
    lines.push(`    ${t.variables ? singleQuoteLiteral(JSON.stringify(t.variables)) : 'NULL'},`);
    lines.push(`    ${singleQuoteLiteral(t.createdBy || '')},`);
    lines.push(`    ${singleQuoteLiteral(t.publishedBy || '')},`);
    lines.push(`    ${singleQuoteLiteral(t.reviewedBy || '')},`);
    lines.push(`    ${t.status ? singleQuoteLiteral(t.status) : singleQuoteLiteral('draft')},`);
    lines.push(`    ${t.reviewStatus ? singleQuoteLiteral(t.reviewStatus) : singleQuoteLiteral('pending')},`);
    lines.push(`    ${singleQuoteLiteral(t.reviewNotes || '')},`);
    lines.push(`    ${t.trusted ? 1 : 0},`);
    lines.push(`    ${t.createdAt ? singleQuoteLiteral(t.createdAt) : "CURRENT_TIMESTAMP"},`);
    lines.push(`    ${t.updatedAt ? singleQuoteLiteral(t.updatedAt) : "CURRENT_TIMESTAMP"},`);
    lines.push(`    ${t.publishedAt ? singleQuoteLiteral(t.publishedAt) : 'CURRENT_TIMESTAMP'},`);
    lines.push(`    ${t.reviewedAt ? singleQuoteLiteral(t.reviewedAt) : 'CURRENT_TIMESTAMP'}`);
    lines.push(')');
    lines.push('ON CONFLICT(template_id) DO UPDATE SET');
    lines.push('    name = excluded.name,');
    lines.push('    description = excluded.description,');
    lines.push('    tags = excluded.tags,');
    lines.push('    version = excluded.version,');
    lines.push('    pricing = excluded.pricing,');
    lines.push('    req_options = excluded.req_options,');
    lines.push('    custom_handlers = excluded.custom_handlers,');
    lines.push('    metadata = excluded.metadata,');
    // never update rating via upsert
    lines.push('    variables = excluded.variables,');
    lines.push('    review_notes = excluded.review_notes,');
    lines.push('    trusted = excluded.trusted,');
    lines.push('    updated_at = excluded.updated_at,');
    lines.push('    published_at = excluded.published_at,');
    lines.push('    reviewed_at = excluded.reviewed_at;');
    lines.push('');
    if (readmeContent) {
        const docsUuid = uuidV5FromString(`${t.uuid}:template_docs`);
        lines.push('');
        lines.push('-- Template docs');
        lines.push('INSERT INTO template_docs (');
        lines.push('    uuid,');
        lines.push('    template_uuid,');
        if (logoContent) lines.push('    logo,');
        lines.push('    content');
        lines.push(') VALUES (');
        lines.push(`    ${singleQuoteLiteral(docsUuid)},`);
        lines.push(`    ${singleQuoteLiteral(t.uuid)},`);
        if (logoContent) lines.push(`    ${singleQuoteLiteral(logoContent)},`);
        lines.push(`    ${singleQuoteLiteral(readmeContent)}`);
        lines.push(')');
        lines.push('ON CONFLICT(template_uuid) DO UPDATE SET');
        if (logoContent) lines.push('    logo = excluded.logo,');
        lines.push('    content = excluded.content,');
        lines.push('    updated_at = CURRENT_TIMESTAMP;');
        lines.push('');
    }
    return lines.join('\n');
}

function isValidUuid(value: string | undefined): boolean {
    if (!value) return false;
    // RFC4122 versions 1-5
    const uuidRegex = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
    return uuidRegex.test(value);
}

function uuidV5FromString(name: string, namespace = 'anycrawl-templates-namespace'): string {
    // Deterministic UUIDv5-like using SHA-1 over a fixed namespace + name
    const hash = crypto.createHash('sha1');
    hash.update(namespace);
    hash.update('\x00');
    hash.update(name);
    const bytes = hash.digest();
    // Take first 16 bytes and set RFC4122 version/variant bits
    const b = Buffer.from(bytes.slice(0, 16));
    b[6] = (b[6] & 0x0f) | 0x50; // version 5 (0101xxxx -> 0x5x); upper nibble set to 5
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10xxxxxx
    const hex = b.toString('hex');
    return (
        hex.slice(0, 8) + '-' +
        hex.slice(8, 12) + '-' +
        hex.slice(12, 16) + '-' +
        hex.slice(16, 20) + '-' +
        hex.slice(20)
    );
}

function validateTemplate(t: TemplateJson) {
    const required = ['uuid', 'templateId', 'name', 'version', 'templateType', 'pricing', 'reqOptions', 'metadata'];
    for (const key of required) {
        if ((t as any)[key] == null) throw new Error(`Missing required field: ${key}`);
    }
    const allowed = t.metadata?.allowedDomains;
    if (!allowed || typeof allowed !== 'object') throw new Error('metadata.allowedDomains is required');
}

function main() {
    // Simple argv parsing
    const argv = process.argv.slice(2);
    let inputArg = '';
    let dialect: 'postgres' | 'sqlite' | 'both' = 'postgres';
    let dryRun = false;
    let validate = false;
    let outDir: string | undefined;
    // AnyCrawl's `templates` table has no `template_docs` companion table (that
    // lives only in the dashboard schema). Docs emission is therefore opt-in via
    // --with-docs; default off so generated SQL only touches columns/tables that
    // exist in this repo's schema. The per-template README.md stays as a repo doc.
    let withDocs = false;

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a) continue;
        if (!a.startsWith('--') && !inputArg) { inputArg = a; continue; }
        if (a === '--dialect' && argv[i + 1]) { dialect = argv[i + 1] as any; i++; continue; }
        if (a === '--dry-run') { dryRun = true; continue; }
        if (a === '--validate') { validate = true; continue; }
        if (a === '--with-docs') { withDocs = true; continue; }
        if (a === '--out-dir' && argv[i + 1]) { outDir = argv[i + 1]; i++; continue; }
    }

    function generateForConfig(configPath: string) {
        const baseDir = path.dirname(configPath);
        const raw = readText(configPath);
        const t: TemplateJson = JSON.parse(raw);
        if (validate) validateTemplate(t);
        const effectiveUuid = isValidUuid(t.uuid) ? t.uuid : uuidV5FromString(t.templateId);
        if (!isValidUuid(t.uuid)) {
            // eslint-disable-next-line no-console
            console.warn(`[templates] Invalid uuid in ${configPath}; using deterministic uuid from templateId: ${effectiveUuid}`);
        }
        const tEffective: TemplateJson = { ...t, uuid: effectiveUuid };
        const requestHandlerSource = loadHandlerSource(baseDir, tEffective.handlers?.requestHandler);
        const failedHandlerSource = loadHandlerSource(baseDir, tEffective.handlers?.failedRequestHandler);
        const readmeContent = withDocs ? loadReadme(baseDir) : undefined;
        const logoContent = withDocs ? extractLogo(tEffective) : undefined;

        const outputs: { file: string; sql: string }[] = [];
        const targetDir = outDir ? (path.isAbsolute(outDir) ? outDir : path.join(baseDir, outDir)) : baseDir;

        if (dialect === 'postgres' || dialect === 'both') {
            const sql = buildSqlPostgres(tEffective, requestHandlerSource, failedHandlerSource, readmeContent, logoContent);
            const file = path.join(targetDir, `${t.templateId}.postgres.sql`);
            outputs.push({ file, sql });
        }
        if (dialect === 'sqlite' || dialect === 'both') {
            const sql = buildSqlSqlite(tEffective, requestHandlerSource, failedHandlerSource, readmeContent, logoContent);
            const file = path.join(targetDir, `${t.templateId}.sqlite.sql`);
            outputs.push({ file, sql });
        }

        for (const out of outputs) {
            if (dryRun) {
                // eslint-disable-next-line no-console
                console.log(`[dry-run] Would write: ${out.file}`);
            } else {
                fs.writeFileSync(out.file, out.sql, 'utf8');
                // eslint-disable-next-line no-console
                console.log(`SQL written to ${out.file}`);
            }
        }
    }

    function findAllTemplateJsons(rootDir: string): string[] {
        const results: string[] = [];
        const entries = fs.readdirSync(rootDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const subdir = path.join(rootDir, entry.name);
            const configCandidate = path.join(subdir, 'template.json');
            if (fs.existsSync(configCandidate)) {
                results.push(configCandidate);
            } else {
                // Also search one level deeper just in case templates are nested further
                try {
                    const nested = fs.readdirSync(subdir, { withFileTypes: true });
                    for (const n of nested) {
                        if (!n.isDirectory()) continue;
                        const nestedConfig = path.join(subdir, n.name, 'template.json');
                        if (fs.existsSync(nestedConfig)) results.push(nestedConfig);
                    }
                } catch { }
            }
        }
        return results;
    }

    // Determine targets
    let targets: string[] = [];
    if (inputArg) {
        const abs = path.isAbsolute(inputArg) ? inputArg : path.join(process.cwd(), inputArg);
        const stat = fs.existsSync(abs) ? fs.statSync(abs) : undefined;
        if (!stat) throw new Error(`Input path not found: ${inputArg}`);
        if (stat.isDirectory()) {
            const cfg = path.join(abs, 'template.json');
            if (!fs.existsSync(cfg)) throw new Error(`template.json not found in directory: ${abs}`);
            targets = [cfg];
        } else {
            targets = [abs];
        }
    } else {
        // No input provided: traverse all templates under this directory
        const templatesRoot = __dirname;
        targets = findAllTemplateJsons(templatesRoot);
        if (!targets.length) {
            // Backward-compat fallback to the original single default if present
            const legacy = path.join(__dirname, 'youtube-video-content-extractor', 'template.json');
            if (fs.existsSync(legacy)) targets = [legacy];
        }
        if (!targets.length) {
            console.log('[templates] No templates found under templates/');
            return;
        }
    }

    console.log(`[templates] Generating SQL for ${targets.length} template(s)...`);
    for (const cfg of targets) {
        console.log(`\n==> Generating from ${cfg}`);
        generateForConfig(cfg);
    }
}

main();


