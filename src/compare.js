/**
 * compare_videos tool implementation.
 * Contrasts what each video covers: agreements, unique points per video.
 * Fully extractive (offline) fallback; LLM-enhanced when ANTHROPIC_API_KEY is set.
 */

import { extractKeywords } from './summarize.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-5';
const ANTHROPIC_VERSION = '2023-06-01';

// ─── Extractive comparison ────────────────────────────────────────────────

/**
 * Find terms that appear in at least `minVideos` video keyword sets.
 * @param {string[][]} keywordSets  one set per video
 * @param {number} minVideos
 * @returns {string[]}
 */
function findCommonTerms(keywordSets, minVideos) {
  const freq = new Map();
  for (const set of keywordSets) {
    for (const kw of new Set(set)) {
      freq.set(kw, (freq.get(kw) ?? 0) + 1);
    }
  }
  return [...freq.entries()]
    .filter(([, count]) => count >= minVideos)
    .sort((a, b) => b[1] - a[1])
    .map(([term]) => term);
}

/**
 * Find terms that appear in exactly one video's keyword set.
 * @param {string[][]} keywordSets
 * @param {number} videoIdx
 * @returns {string[]}
 */
function findUniqueTerms(keywordSets, videoIdx) {
  const others = keywordSets.filter((_, i) => i !== videoIdx);
  const otherTerms = new Set(others.flat());
  return keywordSets[videoIdx].filter((kw) => !otherTerms.has(kw));
}

/**
 * Extractive comparison of multiple video summaries.
 * @param {Array<{id:string, title:string, summary:string, keywords:string[]}>} videos
 * @returns {object}
 */
function extractiveCompare(videos) {
  const keywordSets = videos.map((v) =>
    v.keywords && v.keywords.length > 0
      ? v.keywords
      : extractKeywords(v.summary ?? '', 12)
  );

  const threshold = Math.max(2, Math.ceil(videos.length * 0.6));
  const agreements = findCommonTerms(keywordSets, threshold);

  const perVideo = videos.map((v, i) => ({
    id: v.id,
    title: v.title || v.id,
    uniquePoints: findUniqueTerms(keywordSets, i),
    topKeywords: keywordSets[i].slice(0, 8),
  }));

  // Build a short textual summary of agreements
  const agreementSummary =
    agreements.length > 0
      ? `All videos share focus on: ${agreements.slice(0, 10).join(', ')}.`
      : 'No strongly shared topics detected across the selected videos.';

  return {
    agreementSummary,
    sharedTopics: agreements.slice(0, 15),
    perVideo,
    method: 'extractive',
  };
}

// ─── LLM comparison ───────────────────────────────────────────────────────

/**
 * LLM-powered comparison of video summaries.
 * @param {Array<{id:string, title:string, summary:string}>} videos
 * @returns {Promise<object>}
 */
async function llmCompare(videos) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const combined = videos
    .map(
      (v, i) =>
        `### Video ${i + 1}: ${v.title || v.id}\n${(v.summary ?? '').slice(0, 2000)}`
    )
    .join('\n\n---\n\n');

  const prompt = `You are an expert analyst comparing educational video content.

Given the following video summaries, produce a structured comparison:
1. Key agreements: topics all (or most) videos share
2. Per-video unique points: what does each video cover that others don't?
3. A one-paragraph synthesis of how they complement each other

Respond in this exact JSON format (no markdown fences):
{
  "agreementSummary": "...",
  "sharedTopics": ["...", "..."],
  "perVideo": [
    { "title": "...", "uniquePoints": ["...", "..."], "angle": "..." }
  ],
  "synthesis": "..."
}

SUMMARIES:
${combined.slice(0, 12000)}`;

  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: 1500,
    messages: [{ role: 'user', content: prompt }],
  };

  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text ?? '';

  try {
    // Strip potential markdown fences before parsing
    const clean = text.replace(/^```[a-z]*\n?/m, '').replace(/```$/m, '').trim();
    const parsed = JSON.parse(clean);
    return { ...parsed, method: 'llm' };
  } catch {
    // If JSON parse fails, return the raw text wrapped
    return {
      agreementSummary: text,
      sharedTopics: [],
      perVideo: [],
      synthesis: '',
      method: 'llm-raw',
    };
  }
}

// ─── Public entry point ───────────────────────────────────────────────────

/**
 * Compare multiple videos to find agreements and unique coverage.
 * Requires videos to have been processed (id, title, summary, keywords).
 *
 * @param {Array<{id:string, title:string, summary:string, keywords?:string[]}>} videos
 * @returns {Promise<object>}
 */
export async function compareVideos(videos) {
  if (!videos || videos.length < 2) {
    throw new Error('compareVideos requires at least 2 videos');
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      return await llmCompare(videos);
    } catch (err) {
      process.stderr.write(`LLM compare failed, using extractive fallback: ${err.message}\n`);
    }
  }

  return extractiveCompare(videos);
}
