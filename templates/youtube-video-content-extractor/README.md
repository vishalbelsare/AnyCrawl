# 🎬 YouTube Video Data Extractor

High-fidelity extractor for a YouTube watch page. It collects rich metadata and the transcript (when available) directly from `ytInitialPlayerResponse` and YouTubei, then returns a human-readable Markdown plus a structured JSON result and LLM-ready Markdown.

This template focuses on single-video detail extraction (not channel or search scraping). It’s conceptually similar to tools like Apify’s YouTube Scraper but tailored to our runtime and limited to the watch page scope only.

## ✨ Features

- 📺 Video basics: title, canonical URL, visibility (Public/Unlisted/Private)
- 🧭 Channel subset: channel name, channel URL, channel ID, channel username (best-effort from page data)
- 🕒 Dates and duration: upload date, publish date, formatted length (hh:mm:ss)
- 📈 Stats: view count, like count (snapshot if exposed), category
- 🖼️ Media: largest thumbnail URL
- 📝 Content: full description (verbatim)
- 🎤 Transcript: caption track parsed to plain text (if available)
- 🎬 Endscreen: outgoing video links at the endscreen (titles + URLs)
- 🔞 Age restriction: flag inferred from playability status/microformat

## 🧩 Inputs

- `url` (required): YouTube watch URL (e.g., `https://www.youtube.com/watch?v=VIDEO_ID` or `https://youtu.be/VIDEO_ID`).
- `variables.waitFor` (optional, default 1500): Additional wait in ms before extraction.
- `variables.timeoutMs` (optional, default 30000): HTTP/page timeout in ms.

🚫 Note: Comments are not fetched by this template.

### 💁‍♂️ Example input (JSON)

```json
{
    "url": "https://www.youtube.com/watch?v=VIDEO_ID",
    "variables": {
        "waitFor": 1500,
        "timeoutMs": 30000
    }
}
```

### 💁‍♂️ Example JSON (full demo)

```json
{
    "title": "Install Claude Code to GitHub (= INSTANT background agent)",
    "url": "https://www.youtube.com/watch?v=0kJh4KuJ1nY",
    "thumbnail": "https://i.ytimg.com/vi/0kJh4KuJ1nY/maxresdefault.jpg",
    "visibility": "Public",
    "uploadedBy": "Ian Nuttall",
    "uploadedAt": "2025-07-15T08:04:17-07:00",
    "publishedAt": "2025-07-15T08:04:17-07:00",
    "length": "08:14",
    "views": 12213,
    "likes": 266,
    "category": "People & Blogs",
    "description": "If you use GitHub...",
    "transcript": [{ "start": 0, "end": 1.78, "duration": 1.78, "startTime": "00:00", "endTime": "00:01.780", "text": "If you're using ..." }],
    "channelName": "Ian Nuttall",
    "channelUrl": "http://www.youtube.com/@inuttall",
    "channelId": "UC0z38FxOnJjJIN83E7OHZjQ",
    "channelUsername": "inuttall",
    "isAgeRestricted": false
}
```

## 📦 Output

The run produces:

- 📄 Markdown document that includes the core fields, description, optional transcript and endscreen section, followed by default HTML-to-Markdown page content when available.
- 🧾 JSON result under the `jsonResult` tab with the following fields (only present when derivable):
    - `title`, `url`, `thumbnail`, `visibility`
    - `uploadedBy`, `uploadedAt`, `publishedAt`, `length`
    - `views` (number), `likes` (number), `category`, `description`
    - `transcript` (timed caption segments with `start`, `end`, `duration`, `startTime`, `endTime`, `text`, `lang`)
    - `endscreen` (array of `{ title, url }`)
    - `channelName`, `channelUrl`, `channelId`, `channelUsername`
    - `inputChannelUrl` (if the input looked like a channel URL)
    - `isAgeRestricted` (boolean)

### 💁‍♂️ Example JSON fragment

```json
{
    "title": "Sample Video",
    "url": "https://www.youtube.com/watch?v=...",
    "thumbnail": "https://i.ytimg.com/.../maxresdefault.jpg",
    "visibility": "Public",
    "uploadedBy": "Sample Channel",
    "uploadedAt": "2025-01-23",
    "publishedAt": "2025-01-23",
    "length": "00:12:34",
    "views": 12345,
    "likes": 678,
    "category": "Science & Technology",
    "description": "...",
    "transcript": [{ "start": 0, "end": 1.2, "duration": 1.2, "startTime": "00:00", "endTime": "00:01.200", "text": "... timed text ..." }],
    "endscreen": [{ "title": "Next video", "url": "https://www.youtube.com/watch?v=..." }],
    "channelName": "Sample Channel",
    "channelUrl": "https://www.youtube.com/channel/UC...",
    "channelId": "UC...",
    "channelUsername": "sample",
    "isAgeRestricted": false
}
```

## ⚙️ How it works

- 🧠 Primary source: `window.ytInitialPlayerResponse` (with fallback to HTML parsing for the same object).
- 🎧 Captions: we follow the `youtube-transcript` strategy first: call Android InnerTube `player`, fetch the first caption track XML, and parse it to plain text. If that fails, we keep the HTML `ytInitialPlayerResponse` fallback from the same approach. As a final browser fallback, we click YouTube's subtitles button and capture `/api/timedtext` responses.
- 📄 Page content: when the runtime provides the standard HTML-to-Markdown scrape result, it is appended to the bottom of `markdown` under `## Page Content`.
- 🪪 Channel fields are inferred only from the current page’s player/microformat data; no extra channel lookups.

## 📝 Notes & limitations

- ⚠️ Availability: Age-restricted, private, region-locked, or disabled-embedding videos may limit fields.
- 🎯 Captions: The first available caption track is used by the direct transcript paths. Transcript output preserves per-segment timing; Markdown renders those segments as `[mm:ss - mm:ss] text` lines.
- 🧭 Proxies: For high-volume or geo-sensitive runs, configure your proxies as needed (see project-level proxy configuration).
- 💲 Pricing: `1 credits` per call (see `template.json`).

## ⚖️ Legal

Ensure your use of scraped data complies with YouTube’s Terms of Service and applicable laws (e.g., GDPR). If unsure, consult legal counsel. See also guidance similar to that discussed on the Apify page linked above.
