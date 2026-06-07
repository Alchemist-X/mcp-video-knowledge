# mcp-video-knowledge

An MCP (Model Context Protocol) stdio server that learns the implicit knowledge in YouTube and Bilibili videos and returns a synthesized script, topical sections, key-moment thumbnail grids, and a shareable HTML study sheet.

## What it does

Given a keyword or explicit video IDs (YouTube or Bilibili), the server:

1. Auto-detects platform from the ID or URL
2. Fetches transcripts — YouTube via timedtext (no key), Bilibili via subtitle API (best-effort; see cookie note below)
3. Summarizes each video using **TextRank-style extractive ranking** (offline, no key) or Anthropic LLM (if key is set)
4. Extracts TF-IDF keywords per video
5. Segments transcripts into **topical sections** with timestamps, one-line labels, and thumbnail URLs
6. Synthesizes a unified cross-video knowledge script
7. Generates a **self-contained HTML study sheet** (dark theme, thumbnail grid, TOC, section outline)
8. Compares multiple videos to identify shared topics and unique coverage per video

## Tools

### `learn_topic`

Fetch, transcribe, and synthesize knowledge from one or more videos.

```json
{
  "keyword": "machine learning",
  "videoIds": ["dQw4w9WgXcQ", "BV1uT4y1P7CX", "https://youtu.be/abc123"],
  "maxVideos": 5
}
```

- `keyword` — search YouTube (requires `YOUTUBE_API_KEY`)
- `videoIds` — explicit list of YouTube IDs, YouTube URLs, or Bilibili BV/AV IDs (**no API key needed**)
- `maxVideos` — cap on videos processed (default 5, max 10)

Returns:
```jsonc
{
  "script": "Unified cross-video synthesis...",
  "perVideo": [{
    "id": "...",
    "platform": "youtube",
    "title": "...",
    "summary": "...",
    "keywords": ["machine", "learning", ...],
    "sections": [{
      "startTime": 0,
      "endTime": 120,
      "label": "Introduction to supervised learning",
      "thumbnailUrl": "https://img.youtube.com/vi/.../hqdefault.jpg",
      "videoUrl": "https://www.youtube.com/watch?v=...&t=0s"
    }],
    "keyMoments": [{ "t": 0, "note": "...", "thumbnailUrl": "...", "videoUrl": "..." }],
    "transcriptAvailable": true
  }],
  "meta": { "totalVideos": 1, "transcriptsAvailable": 1, "platforms": ["youtube"], "llmEnabled": false }
}
```

### `summarize_transcript`

Summarize any transcript text. Works **fully offline** with no keys.

```json
{
  "transcript": "Full transcript text...",
  "focus": "neural networks"
}
```

- TextRank-style extractive ranking with TF-IDF weights
- Chunking for long transcripts
- CJK-aware sentence splitting
- Focus keyword re-ranking
- LLM path if `ANTHROPIC_API_KEY` is set

### `make_study_sheet`

Generate a polished study sheet from a topic or video IDs.

```json
{
  "keyword": "machine learning",
  "videoIds": ["dQw4w9WgXcQ"],
  "maxVideos": 3,
  "format": "html"
}
```

- `format`: `"markdown"` (default) or `"html"`
- HTML output is a **standalone, self-contained document** (inline CSS, dark theme, no CDN)
- Includes: header with topic, TOC, synthesized script, section outline with timestamps, responsive thumbnail grid (clickable cards linking to the video at that timestamp), per-video keyword chips

Returns `{ format, topic, meta, sheet }` where `sheet` is the full document string.

### `compare_videos`

Contrast what multiple videos cover — shared topics and unique points per video.

```json
{
  "videoIds": ["videoId1", "videoId2", "BV1xxxxx"],
  "maxVideos": 5
}
```

- Requires at least 2 videos with available transcripts
- Extractive fallback (keyword intersection) works offline
- LLM path produces richer `agreementSummary`, `sharedTopics[]`, per-video `uniquePoints[]` and `angle`, plus a `synthesis` paragraph

Returns:
```jsonc
{
  "comparison": {
    "agreementSummary": "All videos share focus on: ...",
    "sharedTopics": ["gradient descent", "overfitting", ...],
    "perVideo": [{ "title": "...", "uniquePoints": ["..."], "angle": "..." }],
    "synthesis": "...",
    "method": "llm"
  },
  "videosCompared": [{ "id": "...", "platform": "youtube", "title": "..." }],
  "meta": { ... }
}
```

## Environment variables

Copy `.env.example` to `.env` and fill in as needed:

```bash
cp .env.example .env
```

| Variable | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | No | Enables LLM summarization + comparison via `claude-sonnet-4-5` |
| `YOUTUBE_API_KEY` | Only for keyword search | YouTube Data API v3 search |
| `BILIBILI_COOKIE` | No | Bilibili logged-in subtitle access (see below) |

### Bilibili cookie note

Bilibili's subtitle API requires a logged-in session for most videos. Copy the full `Cookie` header from your browser's DevTools (Network tab, any bilibili.com request while logged in) and set it as `BILIBILI_COOKIE`. Without it, only a small subset of videos with public CC tracks will return subtitles — the server degrades gracefully and reports `transcriptAvailable: false`.

## Installation

```bash
git clone https://github.com/Alchemist-X/mcp-video-knowledge.git
cd mcp-video-knowledge
npm install
cp .env.example .env   # edit as needed
```

## Demo (offline, no keys)

```bash
node test/demo.js
```

Runs the full offline pipeline on a bundled ML transcript:
- TextRank extractive summary
- TF-IDF keyword extraction
- CJK-aware sentence splitting
- Topical segmentation
- Extractive comparison of two synthetic videos
- Markdown + HTML study sheet generation

The HTML study sheet is written to `/tmp/study-sheet-demo.html`.

## Add to Claude Code / Claude Desktop

### Claude Code (`~/.claude/settings.json`)

```json
{
  "mcpServers": {
    "video-knowledge": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-video-knowledge/server.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "YOUTUBE_API_KEY": "AIza...",
        "BILIBILI_COOKIE": "SESSDATA=...; bili_jct=..."
      }
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "video-knowledge": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-video-knowledge/server.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "YOUTUBE_API_KEY": "AIza...",
        "BILIBILI_COOKIE": "SESSDATA=...; bili_jct=..."
      }
    }
  }
}
```

Replace `/absolute/path/to/mcp-video-knowledge` with the actual clone path.

## Architecture

```
server.js                — MCP stdio server, tool registry + dispatch
src/
  platform.js            — Platform detection (YouTube/Bilibili), ID parsing,
                           thumbnail URL + video deep-link builders
  youtube.js             — YouTube oEmbed title fetch + Data API search
  bilibili.js            — Bilibili video info, subtitle fetch (best-effort)
  transcript.js          — Unified transcript fetch, CJK-aware splitting,
                           topical segmentation (vocabulary-shift heuristic),
                           interval key moments
  summarize.js           — TextRank extractive ranking, TF-IDF keywords,
                           chunked long-transcript handling, Anthropic LLM path
  compare.js             — Cross-video comparison (extractive + LLM)
  studysheet.js          — Markdown + self-contained HTML study sheet generator
test/
  demo.js                — Offline demo harness (no keys or network)
  sample-transcript.txt  — Bundled ML transcript for offline testing
```

## Limitations

- **Transcripts**: YouTube timedtext may be unavailable for auto-caption-disabled or geo-restricted videos. Bilibili subtitles require a valid cookie for most content. Both degrade gracefully.
- **Bilibili thumbnails**: The thumbnail URL pattern is approximated; for reliable cover images use the Bilibili API with a cookie.
- **Key frames**: Returns standard YouTube thumbnail URLs (not per-frame stills). True per-timestamp frame extraction requires `ffmpeg` — documented future enhancement.
- **Keyword search**: Requires a YouTube Data API v3 key (free tier: ~100 searches/day).
- **LLM summarization**: Without `ANTHROPIC_API_KEY`, the server uses extractive TextRank. Quality is lower but the pipeline works fully offline.

## License

MIT © 2026 Alchemist-X
