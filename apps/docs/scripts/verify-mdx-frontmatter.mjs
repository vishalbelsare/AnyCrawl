#!/usr/bin/env node
/**
 * Fail if any MDX file has an unquoted `description:` value that contains `:`,
 * which breaks YAML parsing (common when mentioning "AnyCrawl: ...").
 *
 * Usage: node scripts/verify-mdx-frontmatter.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..", "content", "docs");

function walk(dir, out = []) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p, out);
        else if (ent.name.endsWith(".mdx")) out.push(p);
    }
    return out;
}

let errors = 0;
for (const file of walk(root)) {
    const text = fs.readFileSync(file, "utf8");
    const m = text.match(/^---\n([\s\S]*?)\n---/);
    if (!m) continue;
    const fm = m[1];
    for (const line of fm.split("\n")) {
        if (!line.startsWith("description:")) continue;
        const rest = line.slice("description:".length).trimStart();
        const quoted = rest.startsWith('"') || rest.startsWith("'");
        if (quoted) continue;
        if (rest.includes(":")) {
            console.error(`[verify-mdx-frontmatter] Unquoted description with ':' may break YAML:\n  ${file}\n  ${line}\n`);
            errors++;
        }
    }
}

if (errors > 0) {
    console.error(`\n${errors} issue(s). Quote the full description, e.g. description: "AnyCrawl: ..."\n`);
    process.exit(1);
}

console.log("verify-mdx-frontmatter: OK");
