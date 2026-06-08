/**
 * Unit tests (node:test API) for the offline pure-function pipeline.
 *
 * Run:  node --test
 *
 * Covers the four behaviours the eval requires:
 *   1. summarize        — extractive summary is non-trivial and not an echo
 *   2. platform-detect  — YouTube id/URL + Bilibili BVid map correctly
 *   3. study-sheet escaping — HTML output escapes injected markup
 *   4. empty input      — empty/whitespace/garbage never throws
 *
 * No keys, no network — exercises the deterministic offline path only.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  extractiveSummarize,
  extractKeywords,
  summarizeTranscript,
} from '../src/summarize.js';
import { parseVideoRef } from '../src/transcript.js';
import { buildHtmlSheet, buildMarkdownSheet } from '../src/studysheet.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const transcript = readFileSync(join(__dirname, 'sample-transcript.txt'), 'utf8');

// ─── 1. summarize ───────────────────────────────────────────────────────────

test('summarize: extractive summary is non-trivial and not a verbatim echo', () => {
  const summary = extractiveSummarize(transcript, 8, '');
  assert.equal(typeof summary, 'string');
  assert.ok(summary.length >= 120, `summary too short (${summary.length})`);
  assert.ok(
    summary.length < transcript.length,
    'summary should be shorter than the input transcript'
  );
  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  assert.notEqual(norm(summary), norm(transcript), 'summary must not echo input');
});

test('summarize: extractKeywords yields meaningful multi-char tokens, no fillers', () => {
  const kw = extractKeywords(transcript, 12);
  assert.ok(Array.isArray(kw) && kw.length >= 5);
  const top8 = kw.slice(0, 8);
  for (const k of top8) {
    assert.ok(String(k).trim().length >= 2, `keyword too short: "${k}"`);
  }
  const fillers = new Set(['the', 'and', 'like', 'just', 'also', 'most', 'very']);
  for (const k of top8) {
    assert.ok(!fillers.has(String(k).toLowerCase()), `filler leaked: "${k}"`);
  }
  const expected = ['learning', 'data', 'model', 'training', 'machine', 'overfitting'];
  const overlap = top8.filter((k) => expected.includes(String(k).toLowerCase()));
  assert.ok(overlap.length >= 3, `keywords not topical: [${top8.join(', ')}]`);
});

test('summarize: CJK keywords are all multi-char (no single CJK chars)', () => {
  const cjk = '机器学习是人工智能的一个分支。机器学习算法从数据中学习模式。'
    + '神经网络是深度学习的基础。深度学习在计算机视觉领域非常强大。'
    + '机器学习需要大量数据进行训练。模型训练完成后可以做出预测。';
  const kw = extractKeywords(cjk, 12);
  assert.ok(Array.isArray(kw) && kw.length >= 5);
  for (const k of kw.slice(0, 8)) {
    assert.ok([...String(k)].length >= 2, `single-char CJK keyword: "${k}"`);
  }
});

// ─── 2. platform-detect ─────────────────────────────────────────────────────

test('platform-detect: YouTube id, YouTube URL, Bilibili BVid map correctly', () => {
  assert.equal(parseVideoRef('dQw4w9WgXcQ').platform, 'youtube');
  assert.equal(
    parseVideoRef('https://www.youtube.com/watch?v=dQw4w9WgXcQ').platform,
    'youtube'
  );
  assert.equal(parseVideoRef('https://youtu.be/dQw4w9WgXcQ').platform, 'youtube');
  assert.equal(parseVideoRef('BV1uT4y1P7CX').platform, 'bilibili');
  assert.equal(
    parseVideoRef('https://www.bilibili.com/video/BV1uT4y1P7CX').platform,
    'bilibili'
  );
});

test('platform-detect: extracts canonical IDs and rejects garbage', () => {
  assert.equal(
    parseVideoRef('https://www.youtube.com/watch?v=dQw4w9WgXcQ').id,
    'dQw4w9WgXcQ'
  );
  assert.equal(parseVideoRef('BV1uT4y1P7CX').id, 'BV1uT4y1P7CX');
  assert.throws(() => parseVideoRef('not a video at all !!!'));
});

// ─── 3. study-sheet escaping ────────────────────────────────────────────────

test('study-sheet: HTML escapes injected markup (no raw <script>)', () => {
  const malicious = '<script>alert("xss")</script>';
  const data = {
    script: `Intro ${malicious} outro`,
    perVideo: [
      {
        id: 'dQw4w9WgXcQ',
        platform: 'youtube',
        title: malicious,
        summary: `Summary with ${malicious}`,
        keywords: [malicious, 'safe'],
        sections: [],
        keyMoments: [],
        transcriptAvailable: false,
      },
    ],
    meta: { totalVideos: 1, transcriptsAvailable: 0, llmEnabled: false },
  };
  const html = buildHtmlSheet(data, malicious);
  // The injected payload must appear only in escaped form.
  assert.ok(!html.includes('<script>alert'), 'raw <script> payload leaked into HTML');
  assert.ok(html.includes('&lt;script&gt;'), 'payload was not HTML-escaped');
  // Structural markers required by the criteria.
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(/class="toc-section"/.test(html) && /class="toc-list"/.test(html));
  assert.ok(
    /<div class="moment-grid">/.test(html) && /<a class="moment-card"/.test(html),
    'thumbnail grid did not render'
  );
});

test('study-sheet: HTML is self-contained (no external CDN references)', () => {
  const data = {
    script: 'A synthesized study script that is reasonably long for testing.',
    perVideo: [
      {
        id: 'dQw4w9WgXcQ',
        platform: 'youtube',
        title: 'Test Video',
        summary: 'A summary.',
        keywords: ['data', 'model'],
        sections: [],
        keyMoments: [],
        transcriptAvailable: false,
      },
    ],
    meta: { totalVideos: 1, transcriptsAvailable: 0, llmEnabled: false },
  };
  const html = buildHtmlSheet(data, 'Test');
  assert.ok(!/<link[^>]+rel=["']?stylesheet/i.test(html), 'external stylesheet found');
  assert.ok(!/<script[^>]+src=/i.test(html), 'external script src found');
  const cleaned = html.replace(/xmlns=["'][^"']*["']/g, '');
  const cdn = /https?:\/\/(?!img\.youtube\.com|www\.youtube\.com|youtu\.be|www\.bilibili\.com|i0\.hdslb\.com)[^\s"'<>]+/i.exec(
    cleaned
  );
  assert.equal(cdn, null, `external resource leaked: ${cdn?.[0]}`);
});

test('study-sheet: Markdown renders headings and a contents block', () => {
  const data = {
    script: 'Script body for markdown rendering.',
    perVideo: [
      {
        id: 'dQw4w9WgXcQ',
        platform: 'youtube',
        title: 'MD Video',
        summary: 'Markdown summary.',
        keywords: ['alpha', 'beta'],
        sections: [],
        keyMoments: [],
        transcriptAvailable: false,
      },
    ],
    meta: { totalVideos: 1, transcriptsAvailable: 0, llmEnabled: false },
  };
  const md = buildMarkdownSheet(data, 'Markdown Topic');
  assert.ok(md.startsWith('# Study Sheet: Markdown Topic'));
  assert.ok(md.includes('## Contents'));
  assert.ok(md.includes('## Per-Video Summaries'));
});

// ─── 4. empty input ─────────────────────────────────────────────────────────

test('empty input: extractiveSummarize never throws and returns a string', () => {
  for (const input of ['', '   \n\t  ', '!!! @@@ ### $$$']) {
    const r = extractiveSummarize(input, 8, '');
    assert.equal(typeof r, 'string');
  }
});

test('empty input: summarizeTranscript (offline) never throws and returns a string', async () => {
  for (const input of ['', '   \n  ', '~~~ ??? ~~~']) {
    const r = await summarizeTranscript(input, '');
    assert.equal(typeof r, 'string');
  }
});

test('empty input: extractKeywords on empty/garbage returns an array', () => {
  assert.deepEqual(extractKeywords('', 12), []);
  assert.deepEqual(extractKeywords('   ', 12), []);
  assert.ok(Array.isArray(extractKeywords('!!! ??? ...', 12)));
});
