/**
 * Facebook public-page extraction from embedded JSON (Relay / Comet / __bbox).
 * Collects post-like nodes: message text, ids, feedback counts, actor hints.
 */

const MAX_TRAVERSE_DEPTH = 48;
const SCRIPT_JSON_RE = /<script(?=[^>]*type=["']application\/json["'])[^>]*>([\s\S]*?)<\/script>/gi;
const SCRIPT_SJS_RE = /<script(?=[^>]*\bdata-sjs\b)[^>]*>([\s\S]*?)<\/script>/gi;

const safeJsonParse = (raw) => {
    try {
        return JSON.parse(raw);
    } catch (_) {
        return null;
    }
};

const getMessageText = (o) => {
    if (!o || typeof o !== 'object') return '';
    if (typeof o.message === 'string' && o.message.trim()) return o.message.trim();
    if (o.message && typeof o.message === 'object') {
        if (typeof o.message.text === 'string' && o.message.text.trim()) return o.message.text.trim();
        const tw = o.message.text_with_entities;
        if (tw && typeof tw.text === 'string' && tw.text.trim()) return tw.text.trim();
    }
    if (o.story && typeof o.story === 'object') return getMessageText(o.story);
    if (o.feed_story && typeof o.feed_story === 'object') return getMessageText(o.feed_story);
    return '';
};

const pickFirstId = (o) => {
    if (!o || typeof o !== 'object') return null;
    const keys = [
        'post_id', 'postId', 'legacy_story_id', 'legacyStoryId', 'story_id', 'storyId',
        'feed_story_id', 'fbid', 'feedback_id', 'legacyId'
    ];
    for (const k of keys) {
        const v = o[k];
        if (v != null && String(v).length > 0) return String(v);
    }
    if (o.id != null && String(o.id).length > 0) return String(o.id);
    return null;
};

const pickFeedback = (o) => {
    const fb = o.feedback || o.feedback_target || o.comet_feed_story_feedback || {};
    const top = fb.top_level_comment_info || fb.comment_rendering_instance || {};
    return {
        reaction_count:
            fb.reaction_count ??
            fb.i18n_reaction_count ??
            fb.important_reactors?.count ??
            fb.top_reactors?.length ??
            null,
        comment_count:
            fb.comment_count ??
            top.comment_count ??
            fb.comments_count ??
            null,
        share_count: fb.share_count ?? fb.reshare_count ?? null,
    };
};

const pickActor = (o) => {
    const a =
        o.actor ||
        o.owner ||
        (Array.isArray(o.actors) ? o.actors[0] : null) ||
        o.from ||
        o.author;
    if (!a || typeof a !== 'object') return null;
    return {
        name: a.name || a.name_with_context || a.title || a.username || null,
        id: a.id != null ? String(a.id) : null,
        url: a.url || a.profile_url || a.link || null,
    };
};

const pickPermalink = (o) => {
    if (typeof o.permalink_url === 'string') return o.permalink_url;
    if (typeof o.url === 'string' && o.url.includes('facebook.com')) return o.url;
    if (o.shareable?.url && typeof o.shareable.url === 'string') return o.shareable.url;
    return null;
};

const isPostLike = (o) => {
    if (!o || typeof o !== 'object') return false;
    const text = getMessageText(o);
    if (!text || text.length < 2) return false;
    const id = pickFirstId(o);
    const hasFeedback = o.feedback || o.feedback_target || o.comet_feed_story_feedback;
    const hasStory = !!(o.story || o.feed_story);
    if (id) return true;
    if (hasFeedback) return true;
    if (hasStory && text.length > 10) return true;
    return false;
};

const normalizePost = (o, sourceUrl) => ({
    post_id: pickFirstId(o),
    message: getMessageText(o),
    permalink: pickPermalink(o),
    actor: pickActor(o),
    feedback: pickFeedback(o),
    source_url: sourceUrl,
});

const extractScriptInnerBlocks = (html) => {
    const blocks = [];
    if (typeof html !== 'string' || !html.length) return blocks;

    let m;
    while ((m = SCRIPT_JSON_RE.exec(html)) !== null) {
        const inner = (m[1] || '').trim();
        if (inner) blocks.push(inner);
    }
    SCRIPT_JSON_RE.lastIndex = 0;

    while ((m = SCRIPT_SJS.exec(html)) !== null) {
        const inner = (m[1] || '').trim();
        if (inner && (inner.includes('__bbox') || inner.includes('Relay') || inner.includes('story'))) {
            blocks.push(inner);
        }
    }
    SCRIPT_SJS.lastIndex = 0;

    return blocks;
};

const traverseCollectPosts = (root, out, seenIds, dedupePostIds, maxItems, depth, stack) => {
    if (depth > MAX_TRAVERSE_DEPTH || out.length >= maxItems) return;
    if (root == null) return;

    if (typeof root === 'object') {
        if (seenIds.has(root)) return;
        seenIds.add(root);
    }

    if (Array.isArray(root)) {
        for (let i = 0; i < root.length && out.length < maxItems; i++) {
            traverseCollectPosts(root[i], out, seenIds, dedupePostIds, maxItems, depth + 1, stack);
        }
        return;
    }

    if (typeof root !== 'object') return;

    if (isPostLike(root)) {
        const id = pickFirstId(root) || `hash_${stack}_${getMessageText(root).slice(0, 64)}`;
        if (!dedupePostIds.has(id)) {
            dedupePostIds.add(id);
            out.push(normalizePost(root, stack));
        }
    }

    const keys = Object.keys(root);
    for (const k of keys) {
        if (out.length >= maxItems) break;
        try {
            traverseCollectPosts(root[k], out, seenIds, dedupePostIds, maxItems, depth + 1, stack);
        } catch (_) { }
    }
};

const extractPageTitleHints = (html) => {
    const hints = { title: null, og_title: null };
    if (typeof html !== 'string') return hints;
    const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
    if (og) hints.og_title = og[1];
    const t = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (t) hints.title = t[1].trim();
    return hints;
};

const scrapeFacebook = async (context) => {
    const page = context.page;
    const url = page ? await page.url() : (context.request?.url || '');
    const html = typeof context.html === 'string' ? context.html : '';
    const log = (...args) => console.log('[FB-SCRAPER]', ...args);

    log('URL:', url, '| HTML length:', html.length);

    const variables = context.variables || {};
    const maxItems = Number.isFinite(Number(variables.maxItems))
        ? Math.max(1, Math.min(200, Number(variables.maxItems)))
        : 40;

    const jsonResult = [];
    const blocks = extractScriptInnerBlocks(html);
    log('JSON script blocks:', blocks.length);

    const seenObjs = new WeakSet();
    const dedupePostIds = new Set();
    for (const raw of blocks) {
        const obj = safeJsonParse(raw);
        if (!obj) continue;
        traverseCollectPosts(obj, jsonResult, seenObjs, dedupePostIds, maxItems, 0, url);
        if (jsonResult.length >= maxItems) break;
    }

    const pageHints = extractPageTitleHints(html);
    const summary = {
        url,
        page_hints: pageHints,
        posts_found: jsonResult.length,
    };

    const buildPostMd = (p) => {
        const actor = p.actor || {};
        const fb = p.feedback || {};
        const stats = [
            fb.reaction_count != null ? `Reactions ${fb.reaction_count}` : null,
            fb.comment_count != null ? `Comments ${fb.comment_count}` : null,
            fb.share_count != null ? `Shares ${fb.share_count}` : null,
        ].filter(Boolean).join(' · ');
        const link = p.permalink || url;
        return `### ${p.post_id || 'post'}\n\n- Link: ${link}\n- Author: ${actor.name || ''} ${actor.id ? `(id ${actor.id})` : ''}\n- Stats: ${stats || 'n/a'}\n\n${p.message || ''}\n`;
    };

    let markdown = '';
    if (jsonResult.length === 0) {
        markdown = `# Facebook\n\nURL: ${url}\n\nNo post-like embedded data was parsed from this page. This often happens for login walls, geo blocks, empty feeds, or when Meta changes embedded JSON shapes. Try a public Page URL, increase wait time, or verify the page opens in a logged-out browser.\n\n## Page hints\n\n- title: ${pageHints.title || ''}\n- og:title: ${pageHints.og_title || ''}\n`;
    } else if (jsonResult.length === 1) {
        markdown = `# Facebook post\n\n${buildPostMd(jsonResult[0])}\n\n## Summary\n\n${JSON.stringify(summary, null, 2)}\n`;
    } else {
        markdown = `# Facebook feed\n\n${jsonResult.map(buildPostMd).join('\n')}\n\n## Summary\n\n${JSON.stringify(summary, null, 2)}\n`;
    }

    log('Done. posts:', jsonResult.length);
    return { markdown, jsonResult: jsonResult.length ? jsonResult : [summary] };
};

return await scrapeFacebook(context);
