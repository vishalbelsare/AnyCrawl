-- Insert SQL for Facebook Scraper Template
-- Generated from facebook-scraper.json
-- Date: 2026-08-11
-- Version: 1.0.0
-- contentChecksum: 65a032336dd963583f21b0864e857ed3b005c2fb164e5f8ad332a974bc837a7d

INSERT INTO "public"."templates" (
    "uuid",
    "template_id",
    "name",
    "description",
    "tags",
    "version",
    "template_type",
    "pricing",
    "req_options",
    "custom_handlers",
    "metadata",
    "variables",
    "created_by",
    "published_by",
    "reviewed_by",
    "status",
    "review_status",
    "review_notes",
    "trusted",
    "created_at",
    "updated_at",
    "published_at",
    "reviewed_at"
) VALUES (
    'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e'::uuid,
    'facebook-scraper',
    'Facebook Scraper',
    'Extract public posts, page feed snippets, and embedded metadata from Facebook URLs (pages, groups, public posts). Outputs structured JSON and Markdown summaries. For public, ethically accessible content only.',
    '["facebook scraper","scrape facebook posts","facebook page scraper","facebook group scraper","social media scraper"]'::jsonb,
    '1.0.0',
    'scrape',
    '{"perCall":1,"currency":"credits"}'::jsonb,
    '{"engine":"playwright","formats":["markdown"],"timeout":120000,"retry":true,"wait_until":"networkidle","wait_for":4000,"wait_for_selector":[{"selector":"[role=\"main\"]","state":"visible","timeout":25000}]}'::jsonb,
    $custom_handlers${"requestHandler":{"enabled":true,"code":{"language":"javascript","source":"/**\n * Facebook public-page extraction from embedded JSON (Relay / Comet / __bbox).\n * Collects post-like nodes: message text, ids, feedback counts, actor hints.\n */\n\nconst MAX_TRAVERSE_DEPTH = 48;\nconst SCRIPT_JSON_RE = /<script(?=[^>]*type=[\"']application\\/json[\"'])[^>]*>([\\s\\S]*?)<\\/script>/gi;\nconst SCRIPT_SJS_RE = /<script(?=[^>]*\\bdata-sjs\\b)[^>]*>([\\s\\S]*?)<\\/script>/gi;\n\nconst safeJsonParse = (raw) => {\n    try {\n        return JSON.parse(raw);\n    } catch (_) {\n        return null;\n    }\n};\n\nconst getMessageText = (o) => {\n    if (!o || typeof o !== 'object') return '';\n    if (typeof o.message === 'string' && o.message.trim()) return o.message.trim();\n    if (o.message && typeof o.message === 'object') {\n        if (typeof o.message.text === 'string' && o.message.text.trim()) return o.message.text.trim();\n        const tw = o.message.text_with_entities;\n        if (tw && typeof tw.text === 'string' && tw.text.trim()) return tw.text.trim();\n    }\n    if (o.story && typeof o.story === 'object') return getMessageText(o.story);\n    if (o.feed_story && typeof o.feed_story === 'object') return getMessageText(o.feed_story);\n    return '';\n};\n\nconst pickFirstId = (o) => {\n    if (!o || typeof o !== 'object') return null;\n    const keys = [\n        'post_id', 'postId', 'legacy_story_id', 'legacyStoryId', 'story_id', 'storyId',\n        'feed_story_id', 'fbid', 'feedback_id', 'legacyId'\n    ];\n    for (const k of keys) {\n        const v = o[k];\n        if (v != null && String(v).length > 0) return String(v);\n    }\n    if (o.id != null && String(o.id).length > 0) return String(o.id);\n    return null;\n};\n\nconst pickFeedback = (o) => {\n    const fb = o.feedback || o.feedback_target || o.comet_feed_story_feedback || {};\n    const top = fb.top_level_comment_info || fb.comment_rendering_instance || {};\n    return {\n        reaction_count:\n            fb.reaction_count ??\n            fb.i18n_reaction_count ??\n            fb.important_reactors?.count ??\n            fb.top_reactors?.length ??\n            null,\n        comment_count:\n            fb.comment_count ??\n            top.comment_count ??\n            fb.comments_count ??\n            null,\n        share_count: fb.share_count ?? fb.reshare_count ?? null,\n    };\n};\n\nconst pickActor = (o) => {\n    const a =\n        o.actor ||\n        o.owner ||\n        (Array.isArray(o.actors) ? o.actors[0] : null) ||\n        o.from ||\n        o.author;\n    if (!a || typeof a !== 'object') return null;\n    return {\n        name: a.name || a.name_with_context || a.title || a.username || null,\n        id: a.id != null ? String(a.id) : null,\n        url: a.url || a.profile_url || a.link || null,\n    };\n};\n\nconst pickPermalink = (o) => {\n    if (typeof o.permalink_url === 'string') return o.permalink_url;\n    if (typeof o.url === 'string' && o.url.includes('facebook.com')) return o.url;\n    if (o.shareable?.url && typeof o.shareable.url === 'string') return o.shareable.url;\n    return null;\n};\n\nconst isPostLike = (o) => {\n    if (!o || typeof o !== 'object') return false;\n    const text = getMessageText(o);\n    if (!text || text.length < 2) return false;\n    const id = pickFirstId(o);\n    const hasFeedback = o.feedback || o.feedback_target || o.comet_feed_story_feedback;\n    const hasStory = !!(o.story || o.feed_story);\n    if (id) return true;\n    if (hasFeedback) return true;\n    if (hasStory && text.length > 10) return true;\n    return false;\n};\n\nconst normalizePost = (o, sourceUrl) => ({\n    post_id: pickFirstId(o),\n    message: getMessageText(o),\n    permalink: pickPermalink(o),\n    actor: pickActor(o),\n    feedback: pickFeedback(o),\n    source_url: sourceUrl,\n});\n\nconst extractScriptInnerBlocks = (html) => {\n    const blocks = [];\n    if (typeof html !== 'string' || !html.length) return blocks;\n\n    let m;\n    while ((m = SCRIPT_JSON_RE.exec(html)) !== null) {\n        const inner = (m[1] || '').trim();\n        if (inner) blocks.push(inner);\n    }\n    SCRIPT_JSON_RE.lastIndex = 0;\n\n    while ((m = SCRIPT_SJS.exec(html)) !== null) {\n        const inner = (m[1] || '').trim();\n        if (inner && (inner.includes('__bbox') || inner.includes('Relay') || inner.includes('story'))) {\n            blocks.push(inner);\n        }\n    }\n    SCRIPT_SJS.lastIndex = 0;\n\n    return blocks;\n};\n\nconst traverseCollectPosts = (root, out, seenIds, dedupePostIds, maxItems, depth, stack) => {\n    if (depth > MAX_TRAVERSE_DEPTH || out.length >= maxItems) return;\n    if (root == null) return;\n\n    if (typeof root === 'object') {\n        if (seenIds.has(root)) return;\n        seenIds.add(root);\n    }\n\n    if (Array.isArray(root)) {\n        for (let i = 0; i < root.length && out.length < maxItems; i++) {\n            traverseCollectPosts(root[i], out, seenIds, dedupePostIds, maxItems, depth + 1, stack);\n        }\n        return;\n    }\n\n    if (typeof root !== 'object') return;\n\n    if (isPostLike(root)) {\n        const id = pickFirstId(root) || `hash_${stack}_${getMessageText(root).slice(0, 64)}`;\n        if (!dedupePostIds.has(id)) {\n            dedupePostIds.add(id);\n            out.push(normalizePost(root, stack));\n        }\n    }\n\n    const keys = Object.keys(root);\n    for (const k of keys) {\n        if (out.length >= maxItems) break;\n        try {\n            traverseCollectPosts(root[k], out, seenIds, dedupePostIds, maxItems, depth + 1, stack);\n        } catch (_) { }\n    }\n};\n\nconst extractPageTitleHints = (html) => {\n    const hints = { title: null, og_title: null };\n    if (typeof html !== 'string') return hints;\n    const og = html.match(/<meta[^>]+property=[\"']og:title[\"'][^>]+content=[\"']([^\"']+)[\"']/i);\n    if (og) hints.og_title = og[1];\n    const t = html.match(/<title[^>]*>([^<]+)<\\/title>/i);\n    if (t) hints.title = t[1].trim();\n    return hints;\n};\n\nconst scrapeFacebook = async (context) => {\n    const page = context.page;\n    const url = page ? await page.url() : (context.request?.url || '');\n    const html = typeof context.html === 'string' ? context.html : '';\n    const log = (...args) => console.log('[FB-SCRAPER]', ...args);\n\n    log('URL:', url, '| HTML length:', html.length);\n\n    const variables = context.variables || {};\n    const maxItems = Number.isFinite(Number(variables.maxItems))\n        ? Math.max(1, Math.min(200, Number(variables.maxItems)))\n        : 40;\n\n    const jsonResult = [];\n    const blocks = extractScriptInnerBlocks(html);\n    log('JSON script blocks:', blocks.length);\n\n    const seenObjs = new WeakSet();\n    const dedupePostIds = new Set();\n    for (const raw of blocks) {\n        const obj = safeJsonParse(raw);\n        if (!obj) continue;\n        traverseCollectPosts(obj, jsonResult, seenObjs, dedupePostIds, maxItems, 0, url);\n        if (jsonResult.length >= maxItems) break;\n    }\n\n    const pageHints = extractPageTitleHints(html);\n    const summary = {\n        url,\n        page_hints: pageHints,\n        posts_found: jsonResult.length,\n    };\n\n    const buildPostMd = (p) => {\n        const actor = p.actor || {};\n        const fb = p.feedback || {};\n        const stats = [\n            fb.reaction_count != null ? `Reactions ${fb.reaction_count}` : null,\n            fb.comment_count != null ? `Comments ${fb.comment_count}` : null,\n            fb.share_count != null ? `Shares ${fb.share_count}` : null,\n        ].filter(Boolean).join(' · ');\n        const link = p.permalink || url;\n        return `### ${p.post_id || 'post'}\\n\\n- Link: ${link}\\n- Author: ${actor.name || ''} ${actor.id ? `(id ${actor.id})` : ''}\\n- Stats: ${stats || 'n/a'}\\n\\n${p.message || ''}\\n`;\n    };\n\n    let markdown = '';\n    if (jsonResult.length === 0) {\n        markdown = `# Facebook\\n\\nURL: ${url}\\n\\nNo post-like embedded data was parsed from this page. This often happens for login walls, geo blocks, empty feeds, or when Meta changes embedded JSON shapes. Try a public Page URL, increase wait time, or verify the page opens in a logged-out browser.\\n\\n## Page hints\\n\\n- title: ${pageHints.title || ''}\\n- og:title: ${pageHints.og_title || ''}\\n`;\n    } else if (jsonResult.length === 1) {\n        markdown = `# Facebook post\\n\\n${buildPostMd(jsonResult[0])}\\n\\n## Summary\\n\\n${JSON.stringify(summary, null, 2)}\\n`;\n    } else {\n        markdown = `# Facebook feed\\n\\n${jsonResult.map(buildPostMd).join('\\n')}\\n\\n## Summary\\n\\n${JSON.stringify(summary, null, 2)}\\n`;\n    }\n\n    log('Done. posts:', jsonResult.length);\n    return { markdown, jsonResult: jsonResult.length ? jsonResult : [summary] };\n};\n\nreturn await scrapeFacebook(context);\n"}},"failedRequestHandler":{"enabled":true,"code":{"language":"javascript","source":"function handleFailedRequest(context, error) {\n    const { request } = context;\n    return {\n        success: false,\n        url: request?.url,\n        error: error?.message || 'Unknown error',\n        timestamp: new Date().toISOString()\n    };\n}\n\nreturn handleFailedRequest(context, error);"}}}$custom_handlers$::jsonb,
    $metadata${"allowedDomains":{"type":"glob","patterns":["https://www.facebook.com/**","https://facebook.com/**","https://m.facebook.com/**","https://web.facebook.com/**"]},"source":"custom","resultTabs":[{"name":"jsonResult","label":"JSON Result"}],"reviewRecords":[{"reviewDate":"2026-03-21T00:00:00.000Z","reviewStatus":"approved","reviewNotes":"Initial version"}]}$metadata$::jsonb,
    $variables${"waitFor":{"type":"number","label":"Wait For (ms)","description":"Extra delay before extraction in milliseconds","required":false,"defaultValue":4000,"mapping":{"target":"wait_for"}},"timeoutMs":{"type":"number","label":"Timeout (ms)","description":"Override request timeout for the scraper","required":false,"defaultValue":120000,"mapping":{"target":"timeout"}},"maxItems":{"type":"number","label":"Max Posts","description":"Maximum post-like items to collect from embedded page data","required":false,"defaultValue":40}}$variables$::jsonb,
    'system-admin',
    'system-admin',
    'system-admin',
    'published',
    'approved',
    'Initial version',
    true,
    '2026-03-21T00:00:00.000Z'::timestamp,
    '2026-03-21T00:00:00.000Z'::timestamp,
    '2026-03-21T00:00:00.000Z'::timestamp,
    '2026-03-21T00:00:00.000Z'::timestamp
)
ON CONFLICT (template_id)
DO UPDATE SET
    "name" = EXCLUDED."name",
    "description" = EXCLUDED."description",
    "tags" = EXCLUDED."tags",
    "version" = EXCLUDED."version",
    "pricing" = EXCLUDED."pricing",
    "req_options" = EXCLUDED."req_options",
    "custom_handlers" = EXCLUDED."custom_handlers",
    "metadata" = EXCLUDED."metadata",
    "variables" = EXCLUDED."variables",
    "review_notes" = EXCLUDED."review_notes",
    "trusted" = EXCLUDED."trusted",
    "updated_at" = EXCLUDED."updated_at",
    "published_at" = EXCLUDED."published_at",
    "reviewed_at" = EXCLUDED."reviewed_at";
