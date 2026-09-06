const RE_YOUTUBE = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/i;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_4) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/85.0.4183.83 Safari/537.36,gzip(gfe)';
const INNERTUBE_API_URL = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false';
const INNERTUBE_CLIENT_VERSION = '20.10.38';
const INNERTUBE_CONTEXT = {
    client: {
        clientName: 'ANDROID',
        clientVersion: INNERTUBE_CLIENT_VERSION,
    },
};
const INNERTUBE_USER_AGENT = `com.google.android.youtube/${INNERTUBE_CLIENT_VERSION} (Linux; U; Android 14)`;

const decodeTranscriptEntities = (text) => String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));

const readXmlAttr = (attrs, name) => {
    const match = String(attrs || '').match(new RegExp(`\\b${name}=["']([^"']*)["']`, 'i'));
    return match ? match[1] : '';
};

const formatTranscriptTime = (value) => {
    const totalMs = Math.max(0, Math.round(Number(value || 0) * 1000));
    const totalSeconds = Math.floor(totalMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const milliseconds = totalMs % 1000;
    const base = hours > 0
        ? `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`
        : `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    return milliseconds > 0 ? `${base}.${milliseconds.toString().padStart(3, '0')}` : base;
};

const normalizeTranscriptSegments = (segments) => (segments || [])
    .map((segment) => {
        const offset = Number(segment?.offset || 0);
        const duration = Number(segment?.duration || 0);
        const safeOffset = Number.isFinite(offset) && offset >= 0 ? offset : 0;
        const safeDuration = Number.isFinite(duration) && duration >= 0 ? duration : 0;
        const start = safeOffset / 1000;
        const durationSeconds = safeDuration / 1000;
        const end = start + durationSeconds;
        const text = decodeTranscriptEntities(segment?.text || '').replace(/\s+/g, ' ').trim();
        return {
            text,
            start,
            end,
            duration: durationSeconds,
            startTime: formatTranscriptTime(start),
            endTime: formatTranscriptTime(end),
            lang: segment?.lang || undefined,
        };
    })
    .filter((segment) => segment.text);

const formatTranscriptSegments = (segments) => (segments || [])
    .map((segment) => {
        const end = segment.end > segment.start ? ` - ${segment.endTime}` : '';
        return `[${segment.startTime}${end}] ${segment.text}`;
    })
    .join('\n');

const getPageContentMarkdown = (context, currentMarkdown) => {
    const pageMarkdown = typeof context?.markdown === 'string' ? context.markdown.trim() : '';
    if (!pageMarkdown) return '';

    if (pageMarkdown === String(currentMarkdown || '').trim()) return '';
    return `\n\n## Page Content\n\n${pageMarkdown}`;
};

const parseTranscriptXml = (xml, lang = '') => {
    const raw = String(xml || '');
    const segments = [];
    const pRegex = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
    let pMatch;

    while ((pMatch = pRegex.exec(raw)) !== null) {
        const attrs = pMatch[1] || '';
        const inner = pMatch[2] || '';
        const startMs = parseInt(readXmlAttr(attrs, 't') || '0', 10) || 0;
        const durMs = parseInt(readXmlAttr(attrs, 'd') || '0', 10) || 0;
        const words = [];
        const sRegex = /<s\b[^>]*>([\s\S]*?)<\/s>/g;
        let sMatch;

        while ((sMatch = sRegex.exec(inner)) !== null) {
            words.push(sMatch[1] || '');
        }

        const text = decodeTranscriptEntities((words.length ? words.join(' ') : inner.replace(/<[^>]+>/g, '')).trim());
        if (text) {
            segments.push({ text, duration: durMs, offset: startMs, lang });
        }
    }

    if (segments.length) return segments;

    const textRegex = /<text\b([^>]*)>([\s\S]*?)<\/text>/g;
    let textMatch;
    while ((textMatch = textRegex.exec(raw)) !== null) {
        const attrs = textMatch[1] || '';
        const text = decodeTranscriptEntities((textMatch[2] || '').replace(/<[^>]+>/g, '').trim());
        if (text) {
            segments.push({
                text,
                duration: (parseFloat(readXmlAttr(attrs, 'dur') || '0') || 0) * 1000,
                offset: (parseFloat(readXmlAttr(attrs, 'start') || '0') || 0) * 1000,
                lang,
            });
        }
    }

    return segments;
};

const buildTranscriptResult = (segments) => {
    const normalized = normalizeTranscriptSegments(segments);
    return {
        segments: normalized,
        timedText: formatTranscriptSegments(normalized),
    };
};

const parseTranscriptJson3 = (payload, lang = '') => {
    const data = typeof payload === 'string'
        ? (() => { try { return JSON.parse(payload); } catch (_) { return null; } })()
        : payload;
    const events = Array.isArray(data?.events) ? data.events : [];

    return events
        .map((event) => {
            const text = (event?.segs || []).map((seg) => seg?.utf8 || '').join('');
            return {
                text: decodeTranscriptEntities(text),
                duration: Number(event?.dDurationMs || 0),
                offset: Number(event?.tStartMs || 0),
                lang,
            };
        })
        .filter((segment) => segment.text.trim());
};

const parseTimedTextPayload = (body, responseUrl = '') => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body || '');
    const fmt = (() => {
        try { return new URL(responseUrl).searchParams.get('fmt') || ''; } catch (_) { return ''; }
    })();

    if (fmt === 'json3' || raw.trim().startsWith('{')) {
        const jsonSegments = parseTranscriptJson3(raw);
        if (jsonSegments.length) return jsonSegments;
    }

    return parseTranscriptXml(raw);
};

const isYoutubeTimedTextUrl = (responseUrl, videoId) => {
    try {
        const parsed = new URL(responseUrl);
        const host = parsed.hostname.toLowerCase();
        return (host === 'youtube.com' || host.endsWith('.youtube.com'))
            && parsed.pathname === '/api/timedtext'
            && (!videoId || parsed.searchParams.get('v') === videoId);
    } catch (_) {
        return false;
    }
};

const retrieveVideoId = (value) => {
    const raw = String(value || '').trim();
    if (raw.length === 11) return raw;
    const match = raw.match(RE_YOUTUBE);
    return match?.[1] || '';
};

const parseInlineJson = (html, globalName) => {
    const body = String(html || '');
    const startToken = `var ${globalName} = `;
    const startIndex = body.indexOf(startToken);
    if (startIndex === -1) return null;

    const jsonStart = startIndex + startToken.length;
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = jsonStart; i < body.length; i++) {
        const char = body[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
        } else if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(body.slice(jsonStart, i + 1)); } catch (_) { return null; }
            }
        }
    }
    return null;
};

const fetchTranscriptFromTracks = async (context, captionTracks, videoId, lang, debugNotes, source) => {
    if (!Array.isArray(captionTracks) || captionTracks.length === 0) return [];

    const selectedTrack = lang
        ? (captionTracks.find((track) => track?.languageCode === lang) || captionTracks[0])
        : captionTracks[0];
    const transcriptUrl = selectedTrack?.baseUrl || '';

    try {
        const captionUrl = new URL(transcriptUrl);
        const host = captionUrl.hostname.toLowerCase();
        if (!(host === 'youtube.com' || host.endsWith('.youtube.com'))) {
            debugNotes.push(`transcript.${source}.url.invalid=1`);
            return [];
        }
    } catch (_) {
        debugNotes.push(`transcript.${source}.url.parse_error=1`);
        return [];
    }

    try {
        const transcriptResponse = await context.httpClient.get(transcriptUrl, {
            headers: {
                ...(lang ? { 'Accept-Language': lang } : {}),
                'User-Agent': USER_AGENT,
            },
            retries: 0,
        });

        if (!transcriptResponse || transcriptResponse.status < 200 || transcriptResponse.status >= 300) {
            debugNotes.push(`transcript.${source}.caption.status=${transcriptResponse?.status || 0}`);
            return [];
        }

        const body = transcriptResponse.rawText ?? (typeof transcriptResponse.data === 'string' ? transcriptResponse.data : '');
        const segments = parseTranscriptXml(body, lang || selectedTrack?.languageCode || '');
        debugNotes.push(`transcript.${source}=${segments.length ? 1 : 0}`);
        return segments;
    } catch (e) {
        debugNotes.push(`transcript.${source}.caption.error=${e?.message || 'unknown'}`);
        return [];
    }
};

const fetchTranscriptViaInnerTube = async (context, videoId, lang, debugNotes) => {
    try {
        const res = await context.httpClient.post(INNERTUBE_API_URL, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': INNERTUBE_USER_AGENT,
            },
            body: {
                context: INNERTUBE_CONTEXT,
                videoId,
            },
            retries: 0,
        });

        if (!res || res.status < 200 || res.status >= 300) {
            debugNotes.push(`transcript.innertube.status=${res?.status || 0}`);
            return { segments: [], playerJson: null };
        }

        const playerJson = typeof res.data === 'object' && res.data
            ? res.data
            : (() => { try { return JSON.parse(res.rawText || ''); } catch (_) { return null; } })();
        const captionTracks = playerJson?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

        if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
            debugNotes.push('transcript.innertube.tracks=0');
            return { segments: [], playerJson };
        }

        const segments = await fetchTranscriptFromTracks(context, captionTracks, videoId, lang, debugNotes, 'innertube');
        return { segments, playerJson };
    } catch (e) {
        debugNotes.push(`transcript.innertube.error=${e?.message || 'unknown'}`);
        return { segments: [], playerJson: null };
    }
};

const fetchTranscriptViaHtml = async (context, videoId, originalUrl, html, existingPlayerJson, lang, debugNotes) => {
    try {
        let playerJson = existingPlayerJson || parseInlineJson(html, 'ytInitialPlayerResponse');
        let pageBody = String(html || '');

        if (!playerJson?.captions?.playerCaptionsTracklistRenderer?.captionTracks) {
            const videoPageResponse = await context.httpClient.get(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
                headers: {
                    ...(lang ? { 'Accept-Language': lang } : {}),
                    'User-Agent': USER_AGENT,
                },
                retries: 0,
            });

            if (!videoPageResponse || videoPageResponse.status < 200 || videoPageResponse.status >= 300) {
                debugNotes.push(`transcript.html.page.status=${videoPageResponse?.status || 0}`);
                return { segments: [], playerJson };
            }

            pageBody = videoPageResponse.rawText ?? (typeof videoPageResponse.data === 'string' ? videoPageResponse.data : '');
            if (pageBody.includes('class="g-recaptcha"')) {
                debugNotes.push('transcript.html.captcha=1');
                return { segments: [], playerJson };
            }
            if (!pageBody.includes('"playabilityStatus":')) {
                debugNotes.push(`transcript.html.unavailable=${originalUrl || videoId}`);
                return { segments: [], playerJson };
            }
            playerJson = parseInlineJson(pageBody, 'ytInitialPlayerResponse');
        }

        const captionTracks = playerJson?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (!Array.isArray(captionTracks) || captionTracks.length === 0) {
            debugNotes.push('transcript.html.tracks=0');
            return { segments: [], playerJson };
        }

        const segments = await fetchTranscriptFromTracks(context, captionTracks, videoId, lang, debugNotes, 'html');
        return { segments, playerJson };
    } catch (e) {
        debugNotes.push(`transcript.html.error=${e?.message || 'unknown'}`);
        return { segments: [], playerJson: null };
    }
};

const fetchTranscriptViaSubtitleButton = async (page, videoId, debugNotes) => {
    if (!page) return [];

    const selector = 'button.ytp-subtitles-button.ytp-button, button.ytp-subtitles-button';
    try {
        await page.waitForSelector(selector, { timeout: 8000 });
    } catch (_) {
        debugNotes.push('transcript.button.missing=1');
        return [];
    }

    const waitForTimedText = page.waitForResponse(
        (response) => isYoutubeTimedTextUrl(response.url(), videoId),
        { timeout: 12000 }
    ).catch((e) => {
        debugNotes.push(`transcript.timedtext.wait=${e?.message || 'timeout'}`);
        return null;
    });

    const clickSubtitleButton = async () => {
        return await page.evaluate((buttonSelector) => {
            const button = document.querySelector(buttonSelector);
            if (!button) return { clicked: false, pressed: null };
            button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return { clicked: true, pressed: button.getAttribute('aria-pressed') };
        }, selector);
    };

    try {
        const pressed = await page.evaluate((buttonSelector) => {
            return document.querySelector(buttonSelector)?.getAttribute('aria-pressed') || '';
        }, selector).catch(() => '');

        const firstClick = await clickSubtitleButton();
        debugNotes.push(`transcript.button.click=1 pressed=${pressed || 'unknown'} clicked=${firstClick?.clicked ? 1 : 0}`);

        if (pressed === 'true') {
            try { await page.waitForTimeout(250); } catch (_) { }
            await clickSubtitleButton();
            debugNotes.push('transcript.button.reenable=1');
        }
    } catch (e) {
        debugNotes.push(`transcript.button.click.error=${e?.message || 'unknown'}`);
        return [];
    }

    const response = await waitForTimedText;
    if (!response) return [];

    try {
        const body = await response.text();
        const segments = parseTimedTextPayload(body, response.url());
        debugNotes.push(`transcript.timedtext=${segments.length ? 1 : 0}`);
        return segments;
    } catch (e) {
        debugNotes.push(`transcript.timedtext.parse.error=${e?.message || 'unknown'}`);
        return [];
    }
};

const extractYouTubeSimple = async (context) => {
    const debugNotes = [];
    let visitorData = "";
    let content = "";
    let initialData = null;
    let ytInitialData = null;

    const page = context.page;
    let pageUrl = '';
    try {
        pageUrl = page ? await page.url() : '';
    } catch (_) { }
    const requestedUrl = context?.input || context?.request?.userData?.input || context?.request?.url || pageUrl || '';



    // Handle YouTube consent using cookie approach
    if (page) {
        try {
            // Set consent cookie to accept cookies (based on Stack Overflow solution)
            await page.evaluate(() => {
                try {
                    // Set CONSENT cookie to accept cookies
                    document.cookie = 'CONSENT=YES+1; domain=.youtube.com; path=/';
                    document.cookie = 'CONSENT=YES+cb.20210328-17-p0.en-GB+FX+123; domain=.youtube.com; path=/';
                } catch (e) {
                    console.log('Consent cookie setting failed:', e.message);
                }
            });
            debugNotes.push('consent.cookie.set=1');
        } catch (e) {
            debugNotes.push(`consent.cookie.error=${e?.message || 'unknown'}`);
        }
    }

    // Small stabilization wait to ensure inline JSON is present
    if (page) {
        try { await page.waitForTimeout(300); debugNotes.push('wait.afterConsent.ms=300'); } catch (_) { }
    }

    // Prefer page content; fallback to provided HTML
    try {
        if (page) content = await page.content();
        if (!content && context.html) content = context.html;
    } catch (_) { }
    const match = content.match(/"visitorData":"([^"]+)/);
    if (match && match[1]) {
        visitorData = match[1];
        debugNotes.push("visitorData.regex=true");
    }
    // Extract ytInitialPlayerResponse from HTML, but keep going if the page shape changes.
    try {
        if (content) {
            debugNotes.push(`content.length=${content.length}`);
            const splitPart = content.split("var ytInitialPlayerResponse = ")[1];
            debugNotes.push(`splitPart=${!!splitPart}`);
            if (splitPart) {
                const jsonStr = splitPart.split(";var meta =")[0];
                debugNotes.push(`jsonStrFound=${!!jsonStr} jsonStr.length=${jsonStr ? jsonStr.length : 0}`);
                if (jsonStr) {
                    try {
                        initialData = JSON.parse(jsonStr);
                        debugNotes.push(`primaryParse=ok`);
                    } catch (e) {
                        debugNotes.push(`primaryParse=error message=${e?.message || 'unknown'}`);
                    }
                }
            }
            if (!initialData) {
                initialData = parseInlineJson(content, 'ytInitialPlayerResponse');
                debugNotes.push(`inlineParse=${!!initialData}`);
            }
        }
    } catch (e) {
        debugNotes.push(`initialData.parse.error=${e?.message || 'unknown'}`);
    }
    if (!initialData && !retrieveVideoId(requestedUrl)) {
        throw new Error('ERR_NEED_TO_RETRY');
    }
    // check login required
    if (content.includes('LOGIN_REQUIRED')) {
        debugNotes.push('login.required=1');
        if (!retrieveVideoId(requestedUrl) && !initialData?.videoDetails?.videoId) {
            throw new Error('ERR_NEED_TO_RETRY');
        }
    }
    // Extract ytInitialData for secondary fallbacks (title/owner/stats)
    try {
        if (page) {
            for (let i = 0; i < 3 && !ytInitialData; i++) {
                try {
                    const d = await page.evaluate(() => { try { return (window).ytInitialData || null; } catch (_) { return null; } });
                    if (d) { ytInitialData = d; break; }
                } catch (_) { }
                try { await page.waitForTimeout(200); } catch (_) { }
            }
            debugNotes.push(`window.ytInitialData=${!!ytInitialData}`);
        }
        if (!ytInitialData && content) {
            let parsed = null;
            try {
                const split = content.split("var ytInitialData = ")[1];
                if (split) {
                    const jsonStr = split.split(";\n")[0];
                    if (jsonStr) parsed = JSON.parse(jsonStr);
                }
            } catch (_) { }
            if (!parsed) {
                try {
                    const matchY = content.match(/ytInitialData\s*=\s*(\{[\s\S]*?\})\s*;/);
                    if (matchY && matchY[1]) parsed = JSON.parse(matchY[1]);
                } catch (_) { }
            }
            if (parsed) {
                ytInitialData = parsed;
                debugNotes.push('ytInitialData.parse=ok');
            }
        }
    } catch (_) { }
    // Extract metadata first (needed for both captions and comments)
    let meta = null;
    if (page) {
        try {
            meta = await page.evaluate(() => {
                try {
                    const ytcfg = (window).ytcfg;
                    const get = ytcfg && typeof ytcfg.get === 'function' ? ytcfg.get.bind(ytcfg) : null;
                    const apiKey = get ? get('INNERTUBE_API_KEY') : (ytcfg?.data_?.INNERTUBE_API_KEY || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8');
                    const visitor = get ? get('VISITOR_DATA') : (ytcfg?.data_?.VISITOR_DATA || '');
                    const cvFromGet = get ? get('INNERTUBE_CONTEXT_CLIENT_VERSION') : undefined;
                    const cvFromCtx = ytcfg?.data_?.INNERTUBE_CONTEXT?.client?.clientVersion;
                    const cvFallback = ytcfg?.data_?.INNERTUBE_CONTEXT_CLIENT_VERSION;
                    const clientVersion = cvFromGet || cvFromCtx || cvFallback || '2.20241218.01.00';
                    const vid = (window).ytInitialPlayerResponse?.videoDetails?.videoId || '';
                    return { apiKey, visitor, clientVersion, vid };
                } catch (_) { return null; }
            });
        } catch (e) {
            debugNotes.push(`meta.extract.error=${e?.message || 'unknown'}`);
        }
    }

    if (meta?.visitor && !visitorData) visitorData = meta.visitor;
    const videoId = meta?.vid
        || initialData?.videoDetails?.videoId
        || retrieveVideoId(requestedUrl);

    if (!videoId) {
        debugNotes.push('youtubei.videoId.missing=1');
    }

    const url = pageUrl || (context.request?.url || null);

    let transcriptSegments = [];
    let transcriptTimedText = "";
    let playerVideoDetails = null;
    let playerMicroformat = null;
    let playerApproxDurationMs = null;
    if (videoId) {
        let fallbackPlayerJson = null;
        const applyPlayerJsonFallbacks = (playerJson) => {
            if (!playerJson) return;
            try {
                playerVideoDetails = playerVideoDetails || playerJson?.videoDetails || null;
                playerMicroformat = playerMicroformat || playerJson?.microformat?.playerMicroformatRenderer || null;
                const sd = playerJson?.streamingData;
                const firstFormat = (sd?.adaptiveFormats || sd?.formats || []).find((format) => format?.approxDurationMs);
                playerApproxDurationMs = playerApproxDurationMs || firstFormat?.approxDurationMs || sd?.approxDurationMs || null;
            } catch (_) { }
        };

        const innerTubeResult = await fetchTranscriptViaInnerTube(context, videoId, undefined, debugNotes);
        transcriptSegments = innerTubeResult.segments || [];
        fallbackPlayerJson = innerTubeResult.playerJson || null;
        applyPlayerJsonFallbacks(fallbackPlayerJson);

        if (!transcriptSegments.length) {
            const htmlResult = await fetchTranscriptViaHtml(context, videoId, url, content, initialData || fallbackPlayerJson, undefined, debugNotes);
            transcriptSegments = htmlResult.segments || [];
            fallbackPlayerJson = htmlResult.playerJson || fallbackPlayerJson;
            applyPlayerJsonFallbacks(fallbackPlayerJson);
        }

        if (!transcriptSegments.length) {
            transcriptSegments = await fetchTranscriptViaSubtitleButton(page, videoId, debugNotes);
        }

        const transcriptResult = buildTranscriptResult(transcriptSegments);
        transcriptSegments = transcriptResult.segments;
        transcriptTimedText = transcriptResult.timedText;
    }

    if (visitorData) debugNotes.push(`visitorData.len=${String(visitorData).length}`);

    const videoDetails = initialData?.videoDetails || playerVideoDetails || {};
    const micro = initialData?.microformat?.playerMicroformatRenderer || playerMicroformat || {};
    const yti = ytInitialData || {};
    const ytiMicro = yti?.microformat?.playerMicroformatRenderer || {};
    const ytiPrimary = (() => {
        try {
            const contents = yti?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
            const found = contents.find(c => c?.videoPrimaryInfoRenderer)?.videoPrimaryInfoRenderer;
            return found || null;
        } catch (_) { return null; }
    })();
    const ytiSecondary = (() => {
        try {
            const contents = yti?.contents?.twoColumnWatchNextResults?.results?.results?.contents || [];
            const found = contents.find(c => c?.videoSecondaryInfoRenderer)?.videoSecondaryInfoRenderer;
            return found || null;
        } catch (_) { return null; }
    })();
    if (!initialData) debugNotes.push('initialData=null');
    debugNotes.push(`has.videoDetails=${!!initialData?.videoDetails} has.microformat=${!!initialData?.microformat}`);
    if (initialData?.playabilityStatus) {
        debugNotes.push(`playabilityStatus=${initialData.playabilityStatus.status || ''} reason=${initialData.playabilityStatus.reason || ''}`);
    }

    // Title and canonical URL
    const title = videoDetails.title
        || ytiMicro?.title?.simpleText
        || (ytiPrimary?.title?.runs?.[0]?.text || "");
    const canonicalUrl = micro.canonicalUrl || url || "";

    // Uploader info and visibility
    const author = videoDetails.author
        || (ytiSecondary?.owner?.videoOwnerRenderer?.title?.runs?.[0]?.text || "");
    const ownerProfileUrl = micro.ownerProfileUrl
        || (ytiSecondary?.owner?.videoOwnerRenderer?.navigationEndpoint?.browseEndpoint?.canonicalBaseUrl || "");
    const isPrivate = !!videoDetails.isPrivate;
    const isUnlisted = !!micro.isUnlisted;

    // Dates
    let uploadDate = micro.uploadDate || ytiMicro?.uploadDate || "";
    let publishDate = micro.publishDate || ytiMicro?.publishDate || (ytiPrimary?.dateText?.simpleText || "");
    if (!uploadDate && publishDate) uploadDate = publishDate;

    // Length formatting
    let lengthSeconds = parseInt(videoDetails.lengthSeconds || ytiMicro?.lengthSeconds || "0", 10) || 0;
    if (!lengthSeconds && playerApproxDurationMs) {
        const ms = Number(playerApproxDurationMs);
        if (!Number.isNaN(ms) && ms > 0) lengthSeconds = Math.round(ms / 1000);
    }
    const lengthHours = Math.floor(lengthSeconds / 3600);
    const lengthMinutes = Math.floor((lengthSeconds % 3600) / 60);
    const lengthTrueSeconds = Math.floor(lengthSeconds % 60);

    // Views and Likes
    const viewCountFromPrimary = (() => {
        try {
            const simple = ytiPrimary?.viewCount?.videoViewCountRenderer?.viewCount?.simpleText
                || (ytiPrimary?.viewCount?.videoViewCountRenderer?.viewCount?.runs || []).map(r => r?.text || '').join('');
            if (!simple) return "";
            const digits = String(simple).replace(/[^0-9]/g, '');
            return digits || "";
        } catch (_) { return ""; }
    })();
    const viewCount = videoDetails.viewCount || viewCountFromPrimary || "";
    const likeCount = (() => {
        if (micro.likeCount) return micro.likeCount;
        try {
            const buttons = ytiPrimary?.videoActions?.menuRenderer?.topLevelButtons || [];
            const collectText = (node) => {
                try {
                    return node?.toggleButtonRenderer?.defaultText?.accessibility?.accessibilityData?.label
                        || node?.toggleButtonRenderer?.defaultText?.simpleText
                        || node?.segmentedLikeDislikeButtonRenderer?.likeButton?.toggleButtonRenderer?.defaultText?.accessibility?.accessibilityData?.label
                        || node?.segmentedLikeDislikeButtonRenderer?.likeButton?.toggleButtonRenderer?.defaultText?.simpleText
                        || node?.text?.simpleText
                        || ((node?.text?.runs || []).map(r => r?.text || '').join(''))
                        || ((node?.defaultText?.runs || []).map(r => r?.text || '').join(''))
                        || '';
                } catch (_) { return ''; }
            };
            let label = '';
            for (const b of buttons) {
                const t = collectText(b);
                if (/like/i.test(String(t))) { label = t; break; }
            }
            if (!label && buttons[0]) label = collectText(buttons[0]);
            const num = String(label).replace(/[^0-9]/g, '');
            return num || "";
        } catch (_) { return ""; }
    })();

    // Category
    const category = micro.category || ytiMicro?.category || (() => {
        try {
            const rows = ytiSecondary?.metadataRowContainer?.metadataRowContainerRenderer?.rows || [];
            const row = rows.find(r => (r?.metadataRowRenderer?.title?.simpleText || '').toLowerCase() === 'category');
            const runs = row?.metadataRowRenderer?.contents?.[0]?.runs || [];
            const text = runs.map(r => r?.text || '').join('');
            return text || "";
        } catch (_) { return ""; }
    })();

    // Description
    const shortDescription = (
        videoDetails.shortDescription
        || (ytiSecondary?.attributedDescription?.content || ((ytiSecondary?.attributedDescription?.runs || []).map(r => r?.text || '').join('')))
        || ((ytiSecondary?.description?.runs || []).map(r => r?.text || '').join(''))
        || (ytiMicro?.description?.simpleText || "")
    );

    // Thumbnails - pick the largest
    const thumbs = (videoDetails.thumbnail?.thumbnails || ytiMicro?.thumbnail?.thumbnails || []).slice();
    let largestThumbnail = null;
    if (thumbs.length) {
        thumbs.sort((a, b) => (b.width * (b.height || 0)) - (a.width * (a.height || 0)));
        largestThumbnail = thumbs[0];
    }



    // Endscreen elements
    const endscreen = (initialData?.endscreen?.endscreenRenderer?.elements || []).filter(x => x?.endscreenElementRenderer?.style === "VIDEO");

    // Keep transcript segments with timing.




    // Build markdown exactly per requested structure
    const visibility = isPrivate ? "Private" : (isUnlisted ? "Unlisted" : "Public");

    // Debug notes are collected but not included in output
    const transcriptSection = transcriptTimedText
        ? `\n\n## Transcript\n\n\`\`\`\n${transcriptTimedText}\n\`\`\``
        : "";

    const markdown = `\
${largestThumbnail ? `![Thumbnail (${largestThumbnail.width}x${largestThumbnail.height})](${largestThumbnail.url})` : ""}
# [${title}](${canonicalUrl})

**Visibility**: ${visibility}
**Uploaded by**: ${author && ownerProfileUrl ? `[${author}](${ownerProfileUrl})` : `${author || ""}`}
**Uploaded at**: ${uploadDate}
**Published at**: ${publishDate}
**Length**: ${lengthHours > 0 ? `${lengthHours.toString().padStart(2, "0")}:` : ""}${lengthMinutes.toString().padStart(2, "0")}:${lengthTrueSeconds.toString().padStart(2, "0")}
**Views**: ${viewCount}
**Likes**: ${likeCount}
**Category**: ${category}

## Description

\`\`\`
${shortDescription}
\`\`\`
${transcriptSection}\
${endscreen.length > 0
            ? `## Endscreen
    
${endscreen.map(element => {
                const r = element.endscreenElementRenderer || {};
                const titleText = r.title?.simpleText || "";
                const rel = r.endpoint?.commandMetadata?.webCommandMetadata?.url || "";
                let abs = rel;
                try { abs = new URL(rel, url || "https://www.youtube.com").toString(); } catch (_) { }
                return `- [${titleText}](${abs})`;
            }).join("\n")}`
            : ""
        }`;
    const finalMarkdown = `${markdown}${getPageContentMarkdown(context, markdown)}`;

    // Derive channel identifiers only from available player/microformat data (no extra requests)
    const channelIdFromProfile = (() => {
        try { return (ownerProfileUrl && ownerProfileUrl.match(/\/channel\/([\w-]+)/)?.[1]) || ""; } catch (_) { return ""; }
    })();
    const channelId = videoDetails.channelId || micro.externalChannelId || ytiMicro?.ownerChannelId || (ytiSecondary?.owner?.videoOwnerRenderer?.navigationEndpoint?.browseEndpoint?.browseId || "") || channelIdFromProfile || "";
    const channelName = author || "";
    const channelUrl = (() => {
        if (!ownerProfileUrl && !channelId) return "";
        const rel = ownerProfileUrl || `/channel/${channelId}`;
        try { return new URL(rel, "https://www.youtube.com").toString(); } catch (_) { return rel; }
    })();
    const channelUsername = (() => {
        if (ownerProfileUrl && ownerProfileUrl.includes('/@')) return ownerProfileUrl.split('/@')[1] || '';
        return '';
    })();

    // Build JSON payload (only include fields we can derive)
    const lengthFormatted = `${lengthHours > 0 ? `${lengthHours.toString().padStart(2, "0")}:` : ""}${lengthMinutes.toString().padStart(2, "0")}:${lengthTrueSeconds.toString().padStart(2, "0")}`;
    const endscreenJson = endscreen.map(element => {
        const r = element.endscreenElementRenderer || {};
        const titleText = r.title?.simpleText || "";
        const rel = r.endpoint?.commandMetadata?.webCommandMetadata?.url || "";
        let abs = rel;
        try { abs = new URL(rel, url || "https://www.youtube.com").toString(); } catch (_) { }
        return { title: titleText, url: abs };
    });
    const isAgeRestricted = (() => {
        try {
            const status = initialData?.playabilityStatus?.status || '';
            const familySafe = (micro?.isFamilySafe !== undefined ? !!micro?.isFamilySafe : (ytiMicro?.isFamilySafe !== undefined ? !!ytiMicro?.isFamilySafe : true));
            return status === 'AGE_VERIFICATION_REQUIRED' || status === 'AGE_CHECK_REQUIRED' || familySafe === false;
        } catch (_) { return false; }
    })();
    const inputChannelUrl = (() => {
        const inputUrl = context?.input || context?.request?.userData?.input || context?.request?.url || '';
        if (!inputUrl) return '';
        try {
            const u = String(inputUrl);
            if (/\/channel\//.test(u) || /https?:\/\/www\.youtube\.com\/@/.test(u) || /https?:\/\/youtube\.com\/@/.test(u)) return u;
        } catch (_) { }
        return '';
    })();

    const jsonPayload = {
        title,
        url: canonicalUrl || url || "",
        thumbnail: largestThumbnail?.url,
        visibility,
        uploadedBy: author || undefined,
        uploadedAt: uploadDate || undefined,
        publishedAt: publishDate || undefined,
        length: lengthFormatted,
        views: viewCount ? parseInt(String(viewCount), 10) || undefined : undefined,
        likes: likeCount ? parseInt(String(likeCount).replace(/[^0-9]/g, ''), 10) || undefined : undefined,
        category: category || undefined,
        description: shortDescription || undefined,
        transcript: transcriptSegments.length ? transcriptSegments : undefined,
        endscreen: endscreenJson && endscreenJson.length ? endscreenJson : undefined,
        // Channel subset derivable without extra requests
        channelName: channelName || undefined,
        channelUrl: channelUrl || undefined,
        channelId: channelId || undefined,
        channelUsername: channelUsername || undefined,
        inputChannelUrl: inputChannelUrl || undefined,
        isAgeRestricted
    };

    // Remove undefined/empty fields per requirement
    const prune = (obj) => {
        Object.keys(obj).forEach((k) => {
            const v = obj[k];
            const isEmptyString = typeof v === 'string' && v.trim() === '';
            const isEmptyArray = Array.isArray(v) && v.length === 0;
            if (v === undefined || v === null || isEmptyString || isEmptyArray) delete obj[k];
        });
        return obj;
    };

    return {
        markdown: finalMarkdown,
        jsonResult: prune(jsonPayload),
        transcript: transcriptSegments.length ? transcriptSegments : undefined
    };
};

return await extractYouTubeSimple(context);
