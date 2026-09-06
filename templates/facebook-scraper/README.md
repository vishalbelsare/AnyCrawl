# Facebook Scraper

Facebook Scraper extracts **public** post-like data embedded in the page (Relay / Comet JSON in `application/json` and `data-sjs` scripts). It does not log in or bypass access controls. Use only for data you are allowed to collect and in line with Meta’s terms and applicable law.

## What you can scrape

- **Pages & profiles (public)**: feed snippets and post bodies when present in embedded state
- **Groups (public)**: same, where the page loads without a login wall
- **Single posts / permalinks**: message text and engagement hints when embedded JSON is available

Results depend on what Meta ships in the HTML; layouts change frequently.

## Supported URL formats

- `https://www.facebook.com/<pagename>/`
- `https://www.facebook.com/groups/<id>/`
- `https://www.facebook.com/<user>/posts/<post-id>/` (and similar permalink patterns)
- `https://m.facebook.com/...` (mobile)

## Input parameters

| Variable    | Default | Maps to      | Description                                      |
|------------|---------|--------------|--------------------------------------------------|
| waitFor    | 4000    | `wait_for`   | Extra delay before extraction (ms)             |
| timeoutMs  | 120000  | `timeout`    | Request timeout (ms)                           |
| maxItems   | 40      | (handler)    | Max post-like records to collect from JSON     |

Example:

```json
{
  "url": "https://www.facebook.com/meta/",
  "waitFor": 5000,
  "timeoutMs": 120000,
  "maxItems": 25
}
```

## Output

- **jsonResult**: Array of objects with `post_id`, `message`, `permalink`, `actor`, `feedback`, `source_url`. If nothing was parsed, a single summary object with `page_hints` and `posts_found: 0`.
- **markdown**: Human-readable summary.

## Limitations

- Login-required, age-gated, or region-blocked pages may return empty `jsonResult`.
- Comment threads and full media URLs are not guaranteed; this template focuses on embedded feed/post payloads.
- For production-scale or stable schemas, consider Meta’s official APIs where appropriate.

## Legal and ethical use

- Scrape only **public** content you have a right to use.
- Do not attempt to circumvent authentication or rate limits.
- Review Meta Platform Terms and privacy regulations (e.g. GDPR) for your use case.

## Changelog

- **1.0.0** — Initial template: embedded JSON traversal, Markdown output, template SQL generation.
