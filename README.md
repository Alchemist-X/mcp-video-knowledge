# mcp-video-knowledge

An MCP (Model Context Protocol) stdio server that learns the implicit knowledge in YouTube videos and returns a synthesized script plus key timestamped frames.

## What it does

Given a keyword or explicit YouTube video IDs, the server:

1. Fetches transcripts via YouTube's timedtext endpoint (no API key required)
2. Summarizes each video's content (LLM via Anthropic API if key is set, otherwise rule-based extractive fallback)
3. Extracts key moments with thumbnail URLs at timestamps
4. Synthesizes a unified cross-video knowledge script

## Tools

### `learn_topic`

```json
{
  "keyword": "machine learning",
  "videoIds": ["dQw4w9WgXcQ", "https://youtu.be/abc123"],
  "maxVideos": 5
}
```

- `keyword` — search YouTube (requires `YOUTUBE_API_KEY`)
- `videoIds` — explicit list of IDs or full YouTube URLs (**no API key needed**)
- `maxVideos` — cap on videos processed (default 5, max 10)

Returns `{ script, perVideo: [{id, title, summary, keyMoments: [{t, note, thumbnailUrl}]}], meta }`.

### `summarize_transcript`

```json
{
  "transcript": "Full transcript text...",
  "focus": "neural networks"
}
```

Summarizes any transcript text. Works completely offline with no keys.

## Environment variables

Copy `.env.example` to `.env` and fill in as needed:

```
ANTHROPIC_API_KEY=   # optional — enables LLM summarization via claude-sonnet-4-5
YOUTUBE_API_KEY=     # optional — required only for keyword search
```

Neither key is required if you pass explicit `videoIds`.

## Installation

```bash
git clone https://github.com/Alchemist-X/mcp-video-knowledge.git
cd mcp-video-knowledge
npm install
cp .env.example .env   # edit as needed
```

## Demo command (offline, no keys)

```bash
node test/demo.js
```

Runs extractive summarization on a bundled ML transcript with no network or API key.

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
        "YOUTUBE_API_KEY": "AIza..."
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
        "YOUTUBE_API_KEY": "AIza..."
      }
    }
  }
}
```

Replace `/absolute/path/to/mcp-video-knowledge` with the actual path where you cloned the repo.

## Limitations

- **Transcripts**: Uses YouTube's public timedtext endpoint. Transcripts are unavailable for videos with auto-captions disabled or restricted embeds. The server degrades gracefully and reports which videos had no transcript.
- **Key frames**: Returns standard YouTube thumbnail URLs (default, MQ, HQ, SD, maxres). True per-timestamp frame extraction requires downloading the video and running ffmpeg — this is a documented future enhancement.
- **Keyword search**: Requires a YouTube Data API v3 key and consumes quota. Free tier allows ~100 searches/day.
- **LLM summarization**: Without `ANTHROPIC_API_KEY`, the server uses extractive summarization (TF-IDF-style sentence scoring). Quality is lower but the pipeline works fully offline.
- **Rate limiting**: YouTube's timedtext endpoint may throttle repeated requests. The server batches at most 3 concurrent video fetches.

## License

MIT © 2026 Alchemist-X
