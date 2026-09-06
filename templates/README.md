# AnyCrawl Templates

Open-source scraper templates for AnyCrawl. Each template is a self-contained
folder that declares how to scrape a site (request options, a sandboxed
`requestHandler`, input variables) and compiles to idempotent SQL that registers
the template into the `templates` table.

## Layout

```
templates/{templateId}/
  template.json        # authoritative definition (req options, handlers, variables, metadata)
  requestHandler.js    # handler source, referenced from template.json via handlers.requestHandler.sourcePath
  README.md            # human docs for the template (not loaded into the DB)
  {templateId}.postgres.sql   # generated — do not edit by hand
  {templateId}.sqlite.sql     # generated — do not edit by hand
```

`template.json` is the single source of truth. The `.sql` files are generated
artifacts; regenerate them whenever `template.json` or `requestHandler.js`
changes.

## Generate

```bash
# all templates, both dialects, with schema validation
pnpm templates:generate

# a single template
pnpm exec tsx templates/generate-sql.ts templates/{templateId}/template.json --dialect both --validate
```

Flags: `--dialect postgres|sqlite|both` · `--validate` · `--dry-run` ·
`--out-dir <dir>` · `--with-docs`.

## Apply

```bash
# applies every *.postgres.sql against $DATABASE_URL (idempotent upsert)
pnpm templates:apply
# preview only
pnpm templates:apply -- --dry-run
```

For a SQLite self-host, apply the generated `*.sqlite.sql` files with your own
SQLite client (the bundled apply script targets Postgres only).

## Notes

- **Idempotent**: each SQL carries a `contentChecksum` header and `ON CONFLICT
  (template_id) DO UPDATE`, so re-applying is safe and re-runnable.
- **Schema-scoped**: generated SQL only touches columns that exist in AnyCrawl's
  `templates` table. There is intentionally **no `template_docs`** output — that
  companion table lives only in the dashboard schema. The per-template
  `README.md` stays as a repo doc. Pass `--with-docs` only against a schema that
  has a `template_docs` table.
- **Handlers** run inside the non-trusted VM sandbox (`@anycrawl/template-client`):
  no module loading, no process/DOM access, standard ECMAScript intrinsics only.
- Keep `variables` and handler sources in the generated SQL identical to
  `template.json` / `requestHandler.js` — always regenerate, never hand-edit SQL.
