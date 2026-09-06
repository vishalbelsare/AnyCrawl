#!/usr/bin/env tsx
// @ts-nocheck
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Pool } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readDirRecursive(dir: string): string[] {
    const result: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            result.push(...readDirRecursive(full));
        } else {
            result.push(full);
        }
    }
    return result;
}

function getSqlFilesForPostgres(root: string): string[] {
    const all = readDirRecursive(root);
    return all.filter((f) => {
        if (!f.endsWith('.sql')) return false;
        return f.endsWith('.postgres.sql');
    });
}

async function executeSqlFile(file: string, dryRun: boolean, pool: Pool) {
    const sqlContent = fs.readFileSync(file, 'utf8');
    if (!sqlContent.trim()) {
        console.warn(`[templates] Skipping empty SQL file: ${file}`);
        return;
    }
    if (dryRun) {
        console.info(`[DRY RUN] Would execute SQL file: ${file}`);
        return;
    }
    await pool.query(sqlContent);
}

async function main() {
    const argv = process.argv.slice(2);
    const isDryRun = argv.includes('--dry-run') || argv.includes('-d');
    const showHelp = argv.includes('--help') || argv.includes('-h');

    if (showHelp) {
        console.log(`\nUsage: pnpm templates:apply-sql [options]\n\nOptions:\n  --dry-run, -d    Preview SQL execution without applying changes\n  --help, -h       Show this help message\n`);
        process.exit(0);
    }

    const pool = new Pool({
        connectionString: process.env.DATABASE_URL!,
    });

    try {
        const startTime = Date.now();
        const templatesRoot = path.join(__dirname);
        const files = getSqlFilesForPostgres(templatesRoot);
        if (!files.length) {
            console.info(`[templates] No SQL files found for postgresql`);
            return;
        }
        console.info(`[templates] ${isDryRun ? 'DRY RUN - would apply' : 'Applying'} ${files.length} SQL file(s) for postgresql...`);
        for (const file of files) {
            console.info(`==> ${isDryRun ? 'Would apply' : 'Applying'} ${file}`);
            try {
                await executeSqlFile(file, isDryRun, pool);
            } catch (err) {
                console.error(`[templates] Failed to execute ${file}`);
                if (err instanceof Error) {
                    console.error('Error name:', err.name);
                    console.error('Error message:', err.message);
                    // Check for PostgreSQL error properties
                    const pgErr = err as any;
                    if (pgErr.code) console.error('PostgreSQL Error Code:', pgErr.code);
                    if (pgErr.detail) console.error('Error Detail:', pgErr.detail);
                    if (pgErr.hint) console.error('Error Hint:', pgErr.hint);
                    if (pgErr.position) console.error('Error Position:', pgErr.position);
                } else {
                    console.error('Error:', JSON.stringify(err, null, 2));
                }
                await pool.end();
                process.exit(1);
            }
        }
        const durationMs = Date.now() - startTime;
        console.info(`[templates] ${isDryRun ? 'Dry run finished.' : 'All SQL applied successfully.'} (${durationMs}ms)`);
    } finally {
        await pool.end();
    }
}

main();
