# Eval Criteria — mcp-video-knowledge

Human-readable copy of the orchestrator's pass/fail criteria. The runnable
harness lives at `eval/eval.mjs` and is invoked as:

```
node eval/eval.mjs
```

(run from the repo root). `npm install` must succeed first; the harness runs it
automatically if `node_modules/@modelcontextprotocol/sdk` is missing.

The harness prints `PASS Cn: ...` or `FAIL Cn: <why>` for each criterion, ends
with `RESULT: X/Y passed`, and exits 0 only if every non-skipped criterion
passes (else 1). Spawned servers and temp files are always cleaned up. Isolated
stores are forced via env vars (`ANTHROPIC_API_KEY`, `YOUTUBE_API_KEY`,
`BILIBILI_COOKIE` are blanked so only the offline extractive path is exercised).

## Project under test

Node MCP stdio server (dep: `@modelcontextprotocol/sdk`). Tools:
`learn_topic`, `summarize_transcript`, `make_study_sheet`, `compare_videos`.
Offline extractive fallback + optional Anthropic/YouTube keys.
`test/demo.js`, `sample-transcript.txt`.

## Criteria

- **C1 handshake** — Spawn `server.js` over stdio, send `initialize` +
  `tools/list` JSON-RPC. Assert all 4 tools are present (`learn_topic`,
  `summarize_transcript`, `make_study_sheet`, `compare_videos`). Kill the server
  afterwards.

- **C2 summarize offline** — Call `summarize_transcript` (via stdio) on the
  bundled sample transcript with NO keys. Returns a non-trivial extractive
  script: assert the script is reasonably long AND that it is NOT a verbatim echo
  of the input transcript.

- **C3 make_study_sheet html** — `format:"html"` returns a self-contained HTML
  string (no external CDN) with a TOC AND a thumbnail grid. Assert: valid
  `<!DOCTYPE html>`, inline `<style>`, a rendered TOC container, an actual
  rendered thumbnail grid container with thumbnail cards, and NO external
  stylesheet/script CDN references.

- **C4 compare_videos** — With 2 sample transcripts, returns a structured
  comparison: shared topics AND per-video unique points. Assert `sharedTopics`
  is a non-empty array and every video has a `uniquePoints` array.

- **C5 platform detect** — `parseVideoRef` (or equivalent) maps a YouTube id, a
  YouTube URL, and a Bilibili BVid to the correct platform. Assert all three map
  correctly.

- **C6 robustness** — Summarize on empty/garbage transcript does not crash and
  returns a graceful result (a string, no throw). Also assert the stdio server
  survives an empty-transcript tool call without dying.

- **C7 quality (no-key path)** — Keyword/topic extraction returns sensible
  multi-char tokens (NOT single CJK chars or stopwords) on a sample; CJK-aware.
  Assert the top keywords look meaningful on the English ML sample (overlap with
  an expected topical set) AND that the top keywords on a CJK sample are all
  multi-char (no single CJK characters).

- **C8 tests** — `node --test` discovers >= 4 tests covering summarize,
  platform-detect, study-sheet escaping, and empty input.

- **C9 packaging** — `package.json` has a `"bin"` entry AND the README contains
  the exact MCP config JSON snippet (an `mcpServers` block pointing `command` at
  `node` with `server.js` in `args`).

- **AESTHETIC** (implemented; judged later) — the study-sheet HTML stays polished
  (dark theme, TOC, thumbnail grid). The harness checks the structural markers
  (dark palette CSS vars, TOC, grid) as a proxy but does not score aesthetics.

## Notes on faithfulness

- The CORRECTNESS / bug checks (C2 non-echo, C3 actually-rendered grid + no CDN,
  C4 shared + unique, C5 all three platforms, C6 no-crash, C7 multi-char /
  CJK-aware) are the point and are encoded strictly.
- C2/C1/C6-server are exercised end-to-end over real stdio JSON-RPC against
  `server.js`. C3/C4/C7 use the project's exported pure functions
  (`buildHtmlSheet`, `compareVideos`, `extractKeywords`) so they run fully
  offline and deterministically without network (the stdio paths for those tools
  call `learnTopic`, which requires network fetches).
- No project source is modified by the harness.
