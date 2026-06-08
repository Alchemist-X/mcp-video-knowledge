/**
 * Summarization module — extractive (offline) and LLM-assisted.
 *
 * Offline pipeline:
 *   1. CJK-aware sentence splitting
 *   2. TextRank-style graph ranking with TF-IDF weights
 *   3. Long transcript chunking before ranking
 *   4. Topic/keyword extraction (TF-IDF)
 *
 * LLM path: Anthropic API, if ANTHROPIC_API_KEY is set.
 */

import { splitSentences } from './transcript.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-5';
const ANTHROPIC_VERSION = '2023-06-01';

// Max chars to send to the LLM in one call
const LLM_CHAR_LIMIT = 14000;
// Chunk size for long transcripts during extractive ranking
const CHUNK_CHAR_LIMIT = 6000;

// ─── Stop words ───────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with',
  'is','are','was','were','be','been','being','have','has','had','do','does',
  'did','will','would','could','should','may','might','shall','can','need',
  'this','that','these','those','it','its','we','you','i','he','she','they',
  'them','their','our','your','my','his','her','what','which','who','how',
  'when','where','why','not','no','so','if','as','by','from','up','about',
  'than','then','just','more','also','into','over','such','after','before',
  'get','got','go','going','went','come','came','take','took','make','made',
  'know','think','see','look','want','use','find','give','tell','work','call',
  'try','ask','need','feel','become','leave','put','mean','keep','let','begin',
  'show','hear','play','run','move','live','believe','hold','bring','happen',
  'write','provide','sit','stand','lose','pay','meet','include','continue',
  'set','learn','change','lead','understand','watch','follow','stop','create',
  // Common discourse fillers / quantifiers / intensifiers that are never
  // meaningful topical keywords. Keeping these out of the top-keyword list
  // keeps extraction focused on the document's actual subject matter.
  'like','very','much','many','most','some','any','all','each','every',
  'few','well','even','still','quite','rather','really','actually','simply',
  'often','always','never','sometimes','usually','here','there','thing',
  'things','stuff','way','ways','lot','lots','kind','sort','etc','one','two',
  'three','first','second','third','next','last','other','others','another',
  'same','own','both','either','neither','too','only','also','again','around',
  'through','during','while','because','though','although','however',
  'therefore','thus','hence','within','without','between','among','across',
  'whether','while','being','let','using','used','doing','having','said',
  'says','saying','example','examples','etc','via','per','versus','vs',
]);

// ─── TF-IDF helpers ───────────────────────────────────────────────────────

/**
 * Tokenize text into lower-cased words, filtering stop-words.
 * CJK characters are kept as individual tokens.
 * @param {string} text
 * @returns {string[]}
 */
function tokenize(text) {
  // Split on whitespace/punctuation, keep CJK chars together as bigrams
  const latinWords = text
    .toLowerCase()
    .replace(/[^\w\s一-鿿]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  // CJK bigrams (simple approach)
  const cjkChars = [...text.matchAll(/[一-鿿぀-ヿ가-힯]+/g)]
    .flatMap((m) => {
      const chars = [...m[0]];
      const bigrams = [];
      for (let i = 0; i < chars.length - 1; i++) {
        bigrams.push(chars[i] + chars[i + 1]);
      }
      return bigrams;
    });

  return [...latinWords, ...cjkChars];
}

/**
 * Compute term frequency map for a list of tokens.
 * @param {string[]} tokens
 * @returns {Map<string, number>}
 */
function termFreq(tokens) {
  return tokens.reduce((map, t) => {
    map.set(t, (map.get(t) ?? 0) + 1);
    return map;
  }, new Map());
}

/**
 * Derive the top-N keywords from text by TF-IDF-like scoring.
 * (Single-document IDF approximation: penalize extremely common terms.)
 * @param {string} text
 * @param {number} [n]
 * @returns {string[]}
 */
export function extractKeywords(text, n = 12) {
  if (!text || text.trim().length === 0) return [];
  const tokens = tokenize(text);
  const tf = termFreq(tokens);
  const total = tokens.length || 1;

  // Penalize terms that appear in > 60% of sentences (document-frequency proxy)
  const sentences = splitSentences(text);
  const dfMap = new Map();
  for (const s of sentences) {
    const uniq = new Set(tokenize(s));
    for (const t of uniq) dfMap.set(t, (dfMap.get(t) ?? 0) + 1);
  }
  const N = sentences.length || 1;

  const scored = [...tf.entries()].map(([term, count]) => {
    const tfScore = count / total;
    const df = dfMap.get(term) ?? 1;
    // IDF: log(N / df) — terms appearing everywhere get lower score
    const idfScore = Math.log((N + 1) / (df + 1)) + 1;
    return { term, score: tfScore * idfScore };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((s) => s.term);
}

// ─── TextRank sentence ranking ────────────────────────────────────────────

/**
 * Cosine similarity between two TF maps.
 * @param {Map<string,number>} a
 * @param {Map<string,number>} b
 * @returns {number}
 */
function cosineSim(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, val] of a) {
    normA += val * val;
    if (b.has(term)) dot += val * (b.get(term) ?? 0);
  }
  for (const val of b.values()) normB += val * val;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * TextRank-style extractive summarizer.
 * Builds a sentence similarity graph and runs power iteration.
 *
 * @param {string[]} sentences  Already-split sentences
 * @param {number} topN         Number of sentences to return
 * @returns {number[]}          Sorted original indices of top sentences
 */
function textRank(sentences, topN) {
  const n = sentences.length;
  if (n <= topN) return sentences.map((_, i) => i);

  // Build TF vectors for each sentence
  const tfVecs = sentences.map((s) => termFreq(tokenize(s)));

  // Build similarity matrix
  const sim = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const s = cosineSim(tfVecs[i], tfVecs[j]);
      sim[i][j] = s;
      sim[j][i] = s;
    }
  }

  // Normalize rows
  const rowSum = sim.map((row) => row.reduce((a, b) => a + b, 0));
  const normSim = sim.map((row, i) =>
    rowSum[i] === 0 ? row.map(() => 0) : row.map((v) => v / rowSum[i])
  );

  // Power iteration (damping d = 0.85)
  const d = 0.85;
  let scores = new Array(n).fill(1 / n);
  for (let iter = 0; iter < 30; iter++) {
    const next = scores.map((_, i) => {
      let sum = 0;
      for (let j = 0; j < n; j++) sum += (normSim[j][i] ?? 0) * scores[j];
      return (1 - d) / n + d * sum;
    });
    scores = next;
  }

  // Return top-N indices in original order
  return scores
    .map((score, idx) => ({ score, idx }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map((x) => x.idx)
    .sort((a, b) => a - b);
}

// ─── Chunked extraction ───────────────────────────────────────────────────

/**
 * Extract key sentences from a potentially long text via chunked TextRank.
 * Splits into chunks, runs TextRank per chunk, combines and re-ranks.
 *
 * @param {string} text
 * @param {number} maxSentences
 * @param {string} [focus]
 * @returns {string}
 */
export function extractiveSummarize(text, maxSentences = 8, focus = '') {
  if (!text || text.trim().length === 0) return '(no content available)';

  const allSentences = splitSentences(text).filter((s) => s.length > 15);
  if (allSentences.length === 0) return text.slice(0, 500);
  if (allSentences.length <= maxSentences) {
    return allSentences.join(' ');
  }

  // For very long texts, chunk it
  const chunks = [];
  let current = [];
  let currentLen = 0;
  for (const s of allSentences) {
    current.push(s);
    currentLen += s.length;
    if (currentLen > CHUNK_CHAR_LIMIT) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
  }
  if (current.length > 0) chunks.push(current);

  // Sentences per chunk, weighted by chunk length
  const sentencesPerChunk = Math.max(
    2,
    Math.ceil(maxSentences / chunks.length)
  );

  const candidates = [];
  for (const chunk of chunks) {
    if (chunk.length === 0) continue;
    const topIndices = textRank(chunk, sentencesPerChunk);
    for (const idx of topIndices) {
      candidates.push(chunk[idx]);
    }
  }

  // If focus provided, re-score candidates by keyword overlap
  if (focus && focus.trim().length > 0) {
    const focusTokens = new Set(tokenize(focus));
    const reScored = candidates.map((s) => {
      const tokens = new Set(tokenize(s));
      let overlap = 0;
      for (const t of focusTokens) if (tokens.has(t)) overlap++;
      return { s, overlap };
    });
    reScored.sort((a, b) => b.overlap - a.overlap || 0);
    return reScored.slice(0, maxSentences).map((x) => x.s).join(' ');
  }

  // Re-rank combined candidates with TextRank again, then re-order
  const finalIndices = textRank(candidates, maxSentences);
  return finalIndices.map((i) => candidates[i]).join(' ');
}

// ─── Anthropic LLM summarization ─────────────────────────────────────────

/**
 * Summarize transcript text using the Anthropic Messages API.
 * @param {string} transcript
 * @param {string} [focus]
 * @param {string} [context]
 * @returns {Promise<string>}
 */
async function llmSummarize(transcript, focus = '', context = '') {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const focusLine = focus ? `Focus on: ${focus}.` : '';
  const contextLine = context || '';

  const prompt = [
    'You are an expert knowledge synthesizer.',
    focusLine,
    contextLine,
    '',
    'Given the following video transcript, extract the key implicit knowledge,',
    'organize it into a clear script with headings and bullet points.',
    'Be concise but capture the essential insights.',
    '',
    'TRANSCRIPT:',
    transcript.slice(0, LLM_CHAR_LIMIT),
  ]
    .filter(Boolean)
    .join('\n');

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
  const content = data.content?.[0]?.text;
  if (!content) throw new Error('Empty response from Anthropic API');
  return content;
}

// ─── Cross-video synthesis ────────────────────────────────────────────────

/**
 * Synthesize multiple per-video summaries into a unified script.
 * @param {Array<{id:string, title:string, summary:string}>} videoSummaries
 * @param {string} [keyword]
 * @returns {Promise<string>}
 */
export async function synthesizeScript(videoSummaries, keyword = '') {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const combined = videoSummaries
    .map((v, i) => `## Video ${i + 1}: ${v.title || v.id}\n${v.summary}`)
    .join('\n\n');

  if (apiKey) {
    try {
      const context = keyword
        ? `Synthesize insights about: "${keyword}"`
        : 'Synthesize the key insights across all videos.';
      return await llmSummarize(combined, keyword, context);
    } catch (err) {
      process.stderr.write(`LLM synthesis failed, using extractive fallback: ${err.message}\n`);
    }
  }

  return extractiveSummarize(combined, 15, keyword);
}

/**
 * Summarize a single transcript.
 * @param {string} transcript
 * @param {string} [focus]
 * @returns {Promise<string>}
 */
export async function summarizeTranscript(transcript, focus = '') {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      return await llmSummarize(transcript, focus);
    } catch (err) {
      process.stderr.write(`LLM summarize failed, using extractive fallback: ${err.message}\n`);
    }
  }
  return extractiveSummarize(transcript, 8, focus);
}
