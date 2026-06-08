#!/usr/bin/env node
/**
 * Pass/fail eval harness for mcp-video-knowledge.
 *
 * Run from repo root:   node eval/eval.mjs
 *
 * Zero external deps. Node 23 (global fetch / child_process / node:test).
 * Forces the offline extractive path by blanking all key/cookie env vars so
 * the harness never touches the network or any external store.
 *
 * Prints "PASS Cn: ..." / "FAIL Cn: <why>" per criterion, then
 * "RESULT: X/Y passed". Exits 0 only if every non-skipped criterion passes.
 *
 * Always cleans up spawned servers and temp files.
 */

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, rmSync, mkdtempSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const FIX = join(__dirname, 'fixtures');
const SERVER = join(REPO, 'server.js');

// ─── Isolation: force the offline / no-key path, isolated stores ────────────
// The criteria reference these env vars; blanking them guarantees the
// extractive fallback and prevents any real network/store access.
process.env.ANTHROPIC_API_KEY = '';
process.env.YOUTUBE_API_KEY = '';
process.env.BILIBILI_COOKIE = '';
// Isolated scratch dir for any temp artifacts.
const SCRATCH = mkdtempSync(join(tmpdir(), 'mcpvk-eval-'));

// ─── Result accounting ──────────────────────────────────────────────────────
const results = [];
const cleanups = [];
function record(id, passed, msg) {
  results.push({ id, passed, msg });
  const tag = passed ? 'PASS' : 'FAIL';
  process.stdout.write(`${tag} ${id}: ${msg}\n`);
}
function fail(id, why) { record(id, false, why); }
function pass(id, msg) { record(id, true, msg); }

// ─── npm install (harness may run it) ───────────────────────────────────────
function ensureInstalled() {
  const sdk = join(REPO, 'node_modules', '@modelcontextprotocol', 'sdk');
  if (existsSync(sdk)) return true;
  process.stdout.write('… node_modules/@modelcontextprotocol/sdk missing — running npm install\n');
  const r = spawnSync('npm', ['install'], { cwd: REPO, stdio: 'inherit' });
  if (r.status !== 0) {
    process.stdout.write('npm install FAILED\n');
    return false;
  }
  return existsSync(sdk);
}

// ─── stdio MCP client (newline-delimited JSON-RPC) ──────────────────────────
const OFFLINE_PRELOAD = join(__dirname, 'offline-preload.mjs');
function spawnServer() {
  // --import an eval-owned preload that disables outbound fetch, so the server
  // is deterministically confined to its offline extractive path (isolation).
  const srv = spawn('node', ['--import', pathToFileURL(OFFLINE_PRELOAD).href, SERVER], {
    cwd: REPO,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
  });
  const state = { srv, buf: '', msgs: [], stderr: '', exited: false };
  cleanups.push(() => { try { srv.kill('SIGKILL'); } catch {} });
  srv.on('exit', () => { state.exited = true; });
  srv.stdout.on('data', (d) => {
    state.buf += d.toString();
    let i;
    while ((i = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, i);
      state.buf = state.buf.slice(i + 1);
      if (line.trim()) { try { state.msgs.push(JSON.parse(line)); } catch {} }
    }
  });
  srv.stderr.on('data', (d) => { state.stderr += d.toString(); });
  return state;
}
function send(state, obj) {
  state.srv.stdin.write(JSON.stringify(obj) + '\n');
}
function waitForId(state, id, timeoutMs = 4000) {
  return new Promise((res) => {
    const t0 = Date.now();
    const tick = () => {
      const m = state.msgs.find((x) => x.id === id);
      if (m) return res(m);
      if (state.exited || Date.now() - t0 > timeoutMs) return res(null);
      setTimeout(tick, 25);
    };
    tick();
  });
}
async function handshake(state) {
  send(state, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'eval-harness', version: '1.0.0' },
    },
  });
  const init = await waitForId(state, 1);
  send(state, { jsonrpc: '2.0', method: 'notifications/initialized' });
  return init;
}
function parseToolResult(msg) {
  try { return JSON.parse(msg.result.content[0].text); } catch { return null; }
}

// ─── Dynamic import of project source (offline pure-function paths) ─────────
async function imp(rel) {
  return import(pathToFileURL(join(REPO, rel)).href);
}

// ─── C1: handshake + tools/list over stdio ──────────────────────────────────
async function c1() {
  const id = 'C1';
  const required = ['learn_topic', 'summarize_transcript', 'make_study_sheet', 'compare_videos'];
  let state;
  try {
    state = spawnServer();
    const init = await handshake(state);
    if (!init || !init.result) {
      return fail(id, `initialize got no/invalid response${state.stderr ? ` (stderr: ${state.stderr.slice(0, 200)})` : ''}`);
    }
    send(state, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const tl = await waitForId(state, 2);
    const names = (tl?.result?.tools ?? []).map((t) => t.name);
    const missing = required.filter((n) => !names.includes(n));
    if (missing.length > 0) {
      return fail(id, `tools/list missing: ${missing.join(', ')} (got: ${names.join(', ') || 'none'})`);
    }
    pass(id, `handshake ok, all 4 tools present (${names.join(', ')})`);
  } catch (e) {
    fail(id, `threw: ${e.message}`);
  } finally {
    try { state?.srv.kill('SIGKILL'); } catch {}
  }
}

// ─── C2: summarize_transcript offline via stdio, non-trivial, not an echo ────
async function c2() {
  const id = 'C2';
  let state;
  try {
    const transcript = readFileSync(join(FIX, 'ml-transcript.txt'), 'utf8');
    state = spawnServer();
    const init = await handshake(state);
    if (!init?.result) return fail(id, 'server failed to initialize');
    send(state, {
      jsonrpc: '2.0', id: 10, method: 'tools/call',
      params: { name: 'summarize_transcript', arguments: { transcript } },
    });
    const msg = await waitForId(state, 10, 6000);
    if (!msg) return fail(id, 'no response to summarize_transcript call');
    if (msg.result?.isError) {
      return fail(id, `tool returned error: ${msg.result.content?.[0]?.text ?? 'unknown'}`);
    }
    const out = parseToolResult(msg);
    const script = out?.script;
    if (typeof script !== 'string') return fail(id, `no string "script" in result (got ${JSON.stringify(out)?.slice(0, 120)})`);
    if (script.length < 120) return fail(id, `script too short (${script.length} chars) — not a non-trivial summary`);
    const norm = (s) => s.replace(/\s+/g, ' ').trim();
    if (norm(script) === norm(transcript)) return fail(id, 'script is a verbatim echo of the input transcript');
    if (script.length >= transcript.length) return fail(id, `script (${script.length}) not shorter than input (${transcript.length}) — likely echo`);
    pass(id, `extractive script: ${script.length} chars, not a verbatim echo (input ${transcript.length} chars)`);
  } catch (e) {
    fail(id, `threw: ${e.message}`);
  } finally {
    try { state?.srv.kill('SIGKILL'); } catch {}
  }
}

// ─── C3: make_study_sheet html — self-contained, TOC + thumbnail grid ───────
// Faithful to the criterion ("format:'html'"): drive the actual tool over
// stdio and assert the returned HTML has a TOC AND an actually-rendered
// thumbnail grid, with no external CDN. A grid that exists only in the inline
// CSS but is never rendered (because the offline path produces no moments) does
// NOT count — the criterion asks for a thumbnail grid in the output.
async function c3() {
  const id = 'C3';
  let state;
  try {
    state = spawnServer();
    const init = await handshake(state);
    if (!init?.result) return fail(id, 'server failed to initialize');
    send(state, {
      jsonrpc: '2.0', id: 30, method: 'tools/call',
      params: {
        name: 'make_study_sheet',
        arguments: { videoIds: ['dQw4w9WgXcQ'], format: 'html' },
      },
    });
    const msg = await waitForId(state, 30, 20000);
    if (!msg) return fail(id, 'no response to make_study_sheet(format:html)');
    if (msg.result?.isError) {
      return fail(id, `tool returned error: ${(msg.result.content?.[0]?.text ?? '').slice(0, 160)}`);
    }
    const out = parseToolResult(msg);
    const html = out?.sheet;
    if (typeof html !== 'string' || html.length < 500) {
      return fail(id, `no "sheet" HTML string returned (got ${JSON.stringify(out)?.slice(0, 120)})`);
    }
    if (out.format !== 'html') return fail(id, `format field is "${out.format}", expected "html"`);

    const problems = [];
    if (!/^\s*<!DOCTYPE html>/i.test(html)) problems.push('no <!DOCTYPE html>');
    if (!/<style[\s>]/i.test(html)) problems.push('no inline <style>');
    // TOC: a rendered table-of-contents container, not just CSS for it.
    const hasToc = /class="toc-section"/.test(html) && /class="toc-list"/.test(html);
    if (!hasToc) problems.push('no rendered TOC (toc-section/toc-list)');
    // Thumbnail grid: an ACTUALLY-RENDERED grid container with >= 1 card anchor.
    const hasGrid = /<div class="moment-grid">/.test(html) && /<a class="moment-card"/.test(html);
    if (!hasGrid) problems.push('no rendered thumbnail grid (<div class="moment-grid"> with <a class="moment-card">)');
    // Self-contained: no external CDN stylesheet/script.
    if (/<link[^>]+rel=["']?stylesheet/i.test(html)) problems.push('external <link rel=stylesheet> (CDN)');
    if (/<script[^>]+src=/i.test(html)) problems.push('external <script src> (CDN)');
    // Any http(s) host other than first-party thumbnail/video hosts -> CDN leak.
    const cleaned = html.replace(/xmlns=["'][^"']*["']/g, '');
    const cdn = /https?:\/\/(?!img\.youtube\.com|www\.youtube\.com|youtu\.be|www\.bilibili\.com|i0\.hdslb\.com)[^\s"'<>]+/i.exec(cleaned);
    if (cdn) problems.push(`external resource reference: ${cdn[0].slice(0, 60)}`);

    if (problems.length > 0) return fail(id, problems.join('; '));
    pass(id, `make_study_sheet(html): self-contained (${html.length} chars) with TOC + rendered thumbnail grid, no CDN`);
  } catch (e) {
    fail(id, `threw: ${e.message}`);
  } finally {
    try { state?.srv.kill('SIGKILL'); } catch {}
  }
}

// ─── C4: compare_videos — shared topics + per-video unique points ───────────
async function c4() {
  const id = 'C4';
  try {
    let compareVideos, extractKeywords, extractiveSummarize;
    try {
      ({ compareVideos } = await imp('src/compare.js'));
      ({ extractKeywords, extractiveSummarize } = await imp('src/summarize.js'));
    } catch (e) {
      return fail(id, `cannot import compare/summarize: ${e.message}`);
    }
    if (typeof compareVideos !== 'function') return fail(id, 'compareVideos not exported');

    const tA = readFileSync(join(FIX, 'ml-transcript.txt'), 'utf8');
    const tB = readFileSync(join(FIX, 'raven-meeting.txt'), 'utf8');
    // Give both videos OVERLAP so shared topics exist: append a shared paragraph.
    const shared = ' We also rely on data quality, model evaluation, and clear team review processes for the data pipeline.';
    const vA = {
      id: 'aaaaaaaaaaa', title: 'Machine Learning Fundamentals',
      summary: extractiveSummarize(tA + shared, 8, ''),
      keywords: extractKeywords(tA + shared, 12),
    };
    const vB = {
      id: 'bbbbbbbbbbb', title: 'Raven Product Strategy',
      summary: extractiveSummarize(tB + shared, 8, ''),
      keywords: extractKeywords(tB + shared, 12),
    };
    const cmp = await compareVideos([vA, vB]);
    if (!cmp || typeof cmp !== 'object') return fail(id, 'comparison is not an object');
    if (!Array.isArray(cmp.sharedTopics)) return fail(id, 'comparison.sharedTopics missing/not an array');
    if (cmp.sharedTopics.length === 0) return fail(id, 'comparison.sharedTopics is empty (no shared topics detected)');
    if (!Array.isArray(cmp.perVideo) || cmp.perVideo.length < 2) return fail(id, 'comparison.perVideo missing or < 2 videos');
    const everyHasUnique = cmp.perVideo.every((v) => Array.isArray(v.uniquePoints));
    if (!everyHasUnique) return fail(id, 'a video is missing a uniquePoints array');
    const anyUnique = cmp.perVideo.some((v) => v.uniquePoints.length > 0);
    if (!anyUnique) return fail(id, 'no per-video unique points found at all');
    pass(id, `structured comparison: ${cmp.sharedTopics.length} shared topics, per-video uniquePoints present (e.g. [${cmp.sharedTopics.slice(0, 4).join(', ')}])`);
  } catch (e) {
    fail(id, `threw: ${e.message}`);
  }
}

// ─── C5: platform detection for YouTube id / URL / Bilibili BVid ────────────
async function c5() {
  const id = 'C5';
  try {
    let parseVideoRef;
    try {
      const mod = await imp('src/transcript.js');
      parseVideoRef = mod.parseVideoRef;
      if (typeof parseVideoRef !== 'function') {
        const pm = await imp('src/platform.js');
        parseVideoRef = pm.detectPlatform;
      }
    } catch (e) {
      return fail(id, `cannot import platform detector: ${e.message}`);
    }
    if (typeof parseVideoRef !== 'function') return fail(id, 'parseVideoRef / detectPlatform not exported');

    const cases = [
      { input: 'dQw4w9WgXcQ', want: 'youtube', label: 'YouTube id' },
      { input: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', want: 'youtube', label: 'YouTube URL' },
      { input: 'BV1uT4y1P7CX', want: 'bilibili', label: 'Bilibili BVid' },
    ];
    const bad = [];
    for (const c of cases) {
      let got;
      try { got = parseVideoRef(c.input)?.platform; } catch (e) { got = `threw:${e.message}`; }
      if (got !== c.want) bad.push(`${c.label} -> ${got} (want ${c.want})`);
    }
    if (bad.length > 0) return fail(id, bad.join('; '));
    pass(id, 'YouTube id, YouTube URL, and Bilibili BVid all map to correct platform');
  } catch (e) {
    fail(id, `threw: ${e.message}`);
  }
}

// ─── C6: robustness on empty/garbage; server survives empty call ────────────
async function c6() {
  const id = 'C6';
  let state;
  try {
    let summarizeTranscript, extractiveSummarize;
    try {
      ({ summarizeTranscript, extractiveSummarize } = await imp('src/summarize.js'));
    } catch (e) {
      return fail(id, `cannot import summarizer: ${e.message}`);
    }

    // Pure-function path: empty + garbage must not throw and must return a string.
    const probes = [
      ['empty', ''],
      ['whitespace', '   \n\t  '],
      ['garbage', readFileSync(join(FIX, 'garbage.txt'), 'utf8')],
    ];
    for (const [name, input] of probes) {
      let r;
      try { r = await summarizeTranscript(input, ''); }
      catch (e) { return fail(id, `summarizeTranscript on ${name} threw: ${e.message}`); }
      if (typeof r !== 'string') return fail(id, `summarizeTranscript on ${name} returned non-string`);
      try {
        const r2 = extractiveSummarize(input, 8, '');
        if (typeof r2 !== 'string') return fail(id, `extractiveSummarize on ${name} returned non-string`);
      } catch (e) { return fail(id, `extractiveSummarize on ${name} threw: ${e.message}`); }
    }

    // Server-survival path: an empty-transcript tool call must not kill the server.
    state = spawnServer();
    const init = await handshake(state);
    if (!init?.result) return fail(id, 'server failed to initialize');
    send(state, {
      jsonrpc: '2.0', id: 20, method: 'tools/call',
      params: { name: 'summarize_transcript', arguments: { transcript: '' } },
    });
    const m1 = await waitForId(state, 20, 4000);
    if (!m1) return fail(id, 'no response to empty-transcript call (server may have crashed)');
    // A graceful structured error OR a graceful result both count; what matters
    // is that the server stays alive and answers a follow-up request.
    send(state, { jsonrpc: '2.0', id: 21, method: 'tools/list', params: {} });
    const m2 = await waitForId(state, 21, 4000);
    if (!m2?.result) return fail(id, 'server did not survive empty-transcript call (follow-up tools/list failed)');
    pass(id, 'empty/whitespace/garbage handled gracefully (string, no throw); server survived empty call');
  } catch (e) {
    fail(id, `threw: ${e.message}`);
  } finally {
    try { state?.srv.kill('SIGKILL'); } catch {}
  }
}

// ─── C7: keyword quality — meaningful multi-char tokens, CJK-aware ───────────
async function c7() {
  const id = 'C7';
  try {
    let extractKeywords;
    try { ({ extractKeywords } = await imp('src/summarize.js')); }
    catch (e) { return fail(id, `cannot import extractKeywords: ${e.message}`); }
    if (typeof extractKeywords !== 'function') return fail(id, 'extractKeywords not exported');

    // Common English fillers/stopwords that a quality keyword extractor MUST NOT
    // surface as top keywords. Independent of the project's own stopword list so
    // the check is not circular — this faithfully encodes "NOT stopwords".
    const STOP = new Set([
      'the', 'and', 'for', 'are', 'was', 'were', 'with', 'this', 'that', 'these',
      'those', 'you', 'your', 'our', 'they', 'their', 'have', 'has', 'had',
      'like', 'just', 'also', 'most', 'more', 'very', 'much', 'such', 'even',
      'well', 'thing', 'things', 'into', 'than', 'then', 'them', 'about', 'over',
      'large', 'some', 'when', 'where', 'what', 'which', 'will', 'would',
    ]);

    // English: top keywords must be meaningful & multi-char, not stopwords/fillers.
    const ml = readFileSync(join(FIX, 'ml-transcript.txt'), 'utf8');
    const enKw = extractKeywords(ml, 12);
    if (!Array.isArray(enKw) || enKw.length < 5) return fail(id, `too few English keywords (${enKw?.length})`);
    const top8 = enKw.slice(0, 8);
    const tooShort = top8.filter((k) => String(k).trim().length < 2);
    if (tooShort.length > 0) return fail(id, `top keywords contain <2-char tokens: ${tooShort.join(', ')}`);
    const stops = top8.filter((k) => STOP.has(String(k).toLowerCase()));
    if (stops.length > 0) return fail(id, `top keywords contain stopwords/fillers: ${stops.join(', ')} (incomplete stopword filtering)`);
    // Meaningfulness: overlap with the obvious topical vocabulary of the sample.
    const expected = ['learning', 'data', 'model', 'training', 'machine', 'overfitting', 'features', 'networks', 'gradient', 'neural'];
    const overlap = top8.filter((k) => expected.includes(String(k).toLowerCase()));
    if (overlap.length < 3) return fail(id, `top keywords don't look topical (overlap ${overlap.length}/3 with expected ML terms): [${top8.join(', ')}]`);

    // CJK-aware: top keywords must be multi-char, NOT single CJK characters.
    const cjk = readFileSync(join(FIX, 'cjk-transcript.txt'), 'utf8');
    const cjkKw = extractKeywords(cjk, 12);
    if (!Array.isArray(cjkKw) || cjkKw.length < 5) return fail(id, `too few CJK keywords (${cjkKw?.length})`);
    const cjkTop8 = cjkKw.slice(0, 8);
    const singleChar = cjkTop8.filter((k) => [...String(k)].length === 1);
    if (singleChar.length > 0) return fail(id, `CJK top keywords contain single chars: ${singleChar.join(', ')}`);
    const allMulti = cjkTop8.every((k) => [...String(k)].length >= 2);
    if (!allMulti) return fail(id, 'not all CJK top keywords are multi-char');

    pass(id, `meaningful multi-char keywords; EN top: [${top8.slice(0, 5).join(', ')}], CJK top all multi-char: [${cjkTop8.slice(0, 4).join(', ')}]`);
  } catch (e) {
    fail(id, `threw: ${e.message}`);
  }
}

// ─── C8: node --test discovers >= 4 tests ───────────────────────────────────
function c8() {
  const id = 'C8';
  try {
    const r = spawnSync('node', ['--test'], {
      cwd: REPO,
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 120000,
    });
    const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
    // node:test TAP/spec summary line: "# tests N" or "ℹ tests N".
    const m = out.match(/(?:^|\n)\s*(?:#|ℹ)\s*tests\s+(\d+)/);
    const count = m ? parseInt(m[1], 10) : 0;
    const passM = out.match(/(?:^|\n)\s*(?:#|ℹ)\s*pass\s+(\d+)/);
    const failM = out.match(/(?:^|\n)\s*(?:#|ℹ)\s*fail\s+(\d+)/);
    const passCount = passM ? parseInt(passM[1], 10) : 0;
    const failCount = failM ? parseInt(failM[1], 10) : 0;

    if (count < 4) return fail(id, `node --test reports ${count} tests (need >= 4)`);
    if (failCount > 0) return fail(id, `node --test has ${failCount} failing test(s)`);
    if (r.status !== 0) return fail(id, `node --test exited ${r.status} despite ${count} tests`);
    pass(id, `node --test: ${count} tests, ${passCount} passing`);
  } catch (e) {
    fail(id, `threw: ${e.message}`);
  }
}

// ─── C9: packaging — bin entry + README MCP config snippet ──────────────────
function c9() {
  const id = 'C9';
  try {
    let pkg;
    try { pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')); }
    catch (e) { return fail(id, `cannot read package.json: ${e.message}`); }
    const hasBin = pkg.bin && (typeof pkg.bin === 'string' || (typeof pkg.bin === 'object' && Object.keys(pkg.bin).length > 0));
    const problems = [];
    if (!hasBin) problems.push('package.json has no "bin" entry');

    let readme = '';
    try { readme = readFileSync(join(REPO, 'README.md'), 'utf8'); } catch {}
    // Exact MCP config snippet: an mcpServers block running node with server.js.
    const hasMcpServers = /"mcpServers"\s*:/.test(readme);
    const hasCommandNode = /"command"\s*:\s*"node"/.test(readme);
    const hasServerArg = /server\.js/.test(readme) && /"args"\s*:/.test(readme);
    if (!(hasMcpServers && hasCommandNode && hasServerArg)) {
      problems.push('README missing exact MCP config JSON snippet (mcpServers + command:node + server.js in args)');
    }
    if (problems.length > 0) return fail(id, problems.join('; '));
    pass(id, `package.json "bin" present and README has MCP config snippet`);
  } catch (e) {
    fail(id, `threw: ${e.message}`);
  }
}

// ─── Runner ─────────────────────────────────────────────────────────────────
async function main() {
  if (!ensureInstalled()) {
    process.stdout.write('FAIL setup: npm install / @modelcontextprotocol/sdk unavailable\n');
    process.stdout.write('RESULT: 0/9 passed\n');
    process.exit(1);
  }

  await c1();
  await c2();
  await c3();
  await c4();
  await c5();
  await c6();
  await c7();
  c8();
  c9();

  // Cleanup spawned servers + temp files.
  for (const fn of cleanups) { try { fn(); } catch {} }
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {}

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  process.stdout.write(`\nRESULT: ${passed}/${total} passed\n`);
  process.exit(passed === total ? 0 : 1);
}

main().catch((e) => {
  for (const fn of cleanups) { try { fn(); } catch {} }
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
  process.stdout.write(`FAIL harness: ${e.stack ?? e.message}\n`);
  process.stdout.write('RESULT: 0/9 passed\n');
  process.exit(1);
});
