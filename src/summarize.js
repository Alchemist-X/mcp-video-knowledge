/**
 * Summarization module.
 * Uses Anthropic API if ANTHROPIC_API_KEY is set, otherwise falls back to
 * extractive rule-based summarization.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-5';
const ANTHROPIC_VERSION = '2023-06-01';

// ─── Extractive fallback ───────────────────────────────────────────────────

/**
 * Score a sentence by keyword density and position.
 * @param {string} sentence
 * @param {string[]} keywords
 * @param {number} index
 * @param {number} total
 * @returns {number}
 */
function scoreSentence(sentence, keywords, index, total) {
  const lower = sentence.toLowerCase();
  const keywordScore = keywords.reduce(
    (acc, kw) => acc + (lower.includes(kw) ? 1 : 0),
    0
  );
  const lengthScore = sentence.split(' ').length > 5 ? 1 : 0;
  const positionScore = index < total * 0.2 || index > total * 0.8 ? 0.5 : 0;
  return keywordScore + lengthScore + positionScore;
}

/**
 * Extract the most important sentences from a block of text.
 * @param {string} text
 * @param {number} maxSentences
 * @param {string} [focus]
 * @returns {string}
 */
export function extractiveSummarize(text, maxSentences = 8, focus = '') {
  if (!text || text.trim().length === 0) return '(no content available)';

  const sentences = text
    .replace(/([.!?])\s+/g, '$1\n')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 20);

  if (sentences.length === 0) return text.slice(0, 500);

  const keywords = focus
    ? focus.toLowerCase().split(/\s+/)
    : deriveKeywords(text);

  const scored = sentences.map((s, i) => ({
    sentence: s,
    score: scoreSentence(s, keywords, i, sentences.length),
    index: i,
  }));

  const topSentences = [...scored]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSentences)
    .sort((a, b) => a.index - b.index)
    .map((s) => s.sentence);

  return topSentences.join(' ');
}

/**
 * Derive rough keywords by term frequency (stop-word filtered).
 * @param {string} text
 * @returns {string[]}
 */
function deriveKeywords(text) {
  const STOP_WORDS = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','of','with',
    'is','are','was','were','be','been','being','have','has','had','do','does',
    'did','will','would','could','should','may','might','shall','can','need',
    'this','that','these','those','it','its','we','you','i','he','she','they',
    'them','their','our','your','my','his','her','what','which','who','how',
    'when','where','why','not','no','so','if','as','by','from','up','about',
    'than','then','just','more','also','into','over','such','after','before',
  ]);

  const freq = {};
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w))
    .forEach((w) => { freq[w] = (freq[w] ?? 0) + 1; });

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([w]) => w);
}

// ─── Anthropic LLM summarization ──────────────────────────────────────────

/**
 * Summarize transcript text using the Anthropic Messages API.
 * @param {string} transcript
 * @param {string} [focus]
 * @param {string} [context] — extra instructions for cross-video synthesis
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
    transcript.slice(0, 12000), // stay within reasonable token budget
  ]
    .filter(Boolean)
    .join('\n');

  const body = {
    model: ANTHROPIC_MODEL,
    max_tokens: 1024,
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

// ─── Cross-video synthesis ─────────────────────────────────────────────────

/**
 * Synthesize multiple per-video summaries into a unified script.
 * @param {Array<{id: string, title: string, summary: string}>} videoSummaries
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
      // Fall through to extractive on API failure
      console.error('LLM synthesis failed, using extractive fallback:', err.message);
    }
  }

  // Extractive cross-video synthesis
  return extractiveSummarize(combined, 12, keyword);
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
      console.error('LLM summarize failed, using extractive fallback:', err.message);
    }
  }
  return extractiveSummarize(transcript, 8, focus);
}
