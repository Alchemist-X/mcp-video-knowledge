/**
 * Transcript fetching and analysis.
 * Supports YouTube (timedtext, no key) and Bilibili (best-effort, see bilibili.js).
 * Provides topical segmentation with one-line section labels.
 */

import { PLATFORM, detectPlatform, buildThumbnailUrls, buildVideoUrl } from './platform.js';
import { fetchBilibiliTranscript } from './bilibili.js';

const TIMEDTEXT_BASE = 'https://www.youtube.com/api/timedtext';

// ─── Platform-agnostic helpers ─────────────────────────────────────────────

/**
 * Parse video ID from any supported input (delegates to platform detector).
 * Returns { platform, id } for callers that need the platform.
 * @param {string} input
 * @returns {{ platform: string, id: string }}
 */
export function parseVideoRef(input) {
  return detectPlatform(input);
}

/**
 * Parse raw YouTube video ID (legacy compatibility — YouTube-only).
 * @param {string} input
 * @returns {string}
 */
export function parseVideoId(input) {
  const { id } = detectPlatform(input);
  return id;
}

// ─── YouTube transcript ────────────────────────────────────────────────────

/**
 * Fetch available transcript tracks for a YouTube video.
 * @param {string} videoId
 * @returns {Promise<Array<{id: string, langCode: string}>>}
 */
async function fetchYtTrackList(videoId) {
  const url = `${TIMEDTEXT_BASE}?type=list&v=${videoId}`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const tracks = [];
    const regex = /<track[^>]+id="(\d+)"[^>]+lang_code="([^"]+)"[^>]*>/g;
    let m;
    while ((m = regex.exec(xml)) !== null) {
      tracks.push({ id: m[1], langCode: m[2] });
    }
    return tracks;
  } catch {
    return [];
  }
}

/**
 * Fetch and parse YouTube timedtext XML.
 * @param {string} videoId
 * @param {string} langCode
 * @returns {Promise<Array<{start:number, dur:number, text:string}>>}
 */
async function fetchYtTimedText(videoId, langCode) {
  const url = `${TIMEDTEXT_BASE}?lang=${langCode}&v=${videoId}&fmt=srv3`;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const xml = await res.text();
    const entries = [];
    const regex = /<p[^>]+t="(\d+)"[^>]+d="(\d+)"[^>]*>([\s\S]*?)<\/p>/g;
    let m;
    while ((m = regex.exec(xml)) !== null) {
      const startMs = parseInt(m[1], 10);
      const durMs = parseInt(m[2], 10);
      const raw = m[3]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
      if (raw) {
        entries.push({ start: startMs / 1000, dur: durMs / 1000, text: raw });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Fetch transcript for a YouTube video.
 * @param {string} videoId
 * @returns {Promise<{entries: Array, plainText: string, available: boolean}>}
 */
async function fetchYouTubeTranscript(videoId) {
  try {
    const tracks = await fetchYtTrackList(videoId);
    const preferred = tracks.find((t) => t.langCode === 'en') ?? tracks[0];
    if (!preferred) return { entries: [], plainText: '', available: false };

    const entries = await fetchYtTimedText(videoId, preferred.langCode);
    if (entries.length === 0) return { entries: [], plainText: '', available: false };

    const plainText = entries.map((e) => e.text).join(' ');
    return { entries, plainText, available: true };
  } catch (err) {
    return { entries: [], plainText: '', available: false, error: err.message };
  }
}

// ─── Unified fetch ────────────────────────────────────────────────────────

/**
 * Fetch transcript for any supported platform.
 * @param {string} videoId
 * @param {string} platform   PLATFORM.YOUTUBE | PLATFORM.BILIBILI
 * @returns {Promise<{entries: Array, plainText: string, available: boolean, title?: string}>}
 */
export async function fetchTranscript(videoId, platform = PLATFORM.YOUTUBE) {
  if (platform === PLATFORM.BILIBILI) {
    return fetchBilibiliTranscript(videoId);
  }
  return fetchYouTubeTranscript(videoId);
}

// ─── CJK-aware sentence splitting ────────────────────────────────────────

/**
 * Split text into sentences, handling both Latin and CJK scripts.
 * @param {string} text
 * @returns {string[]}
 */
export function splitSentences(text) {
  if (!text || text.trim().length === 0) return [];

  // CJK sentence-ending punctuation: 。！？；
  // Latin: .!?
  // Insert newlines at sentence boundaries then split
  const segmented = text
    .replace(/([.!?。！？；])\s*/g, '$1\n')
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return segmented;
}

// ─── Key moments (simple interval-based) ─────────────────────────────────

/**
 * Derive key moments from transcript entries by selecting sentences every N seconds.
 * @param {Array<{start:number,text:string}>} entries
 * @param {number} intervalSeconds
 * @returns {Array<{t: number, note: string}>}
 */
export function extractKeyMoments(entries, intervalSeconds = 60) {
  if (entries.length === 0) return [];

  const moments = [];
  let nextTarget = 0;

  for (const entry of entries) {
    if (entry.start >= nextTarget) {
      moments.push({ t: Math.floor(entry.start), note: entry.text });
      nextTarget = entry.start + intervalSeconds;
    }
  }

  return moments;
}

// ─── Topical segmentation ─────────────────────────────────────────────────

/**
 * Segment transcript entries into topical sections.
 * Uses a sliding-window vocabulary-shift heuristic: a new section starts when
 * the current window shares few words with the previous window.
 *
 * @param {Array<{start:number, dur:number, text:string}>} entries
 * @param {object} [opts]
 * @param {number} [opts.minSectionDuration]  seconds — never cut before this (default 60)
 * @param {number} [opts.maxSections]         hard cap (default 10)
 * @param {string} [opts.platform]            for thumbnail/link building
 * @param {string} [opts.videoId]             for thumbnail/link building
 * @returns {Array<{startTime:number, endTime:number, label:string, entries:Array, thumbnailUrl:string, videoUrl:string}>}
 */
export function segmentTranscript(entries, {
  minSectionDuration = 60,
  maxSections = 10,
  platform = PLATFORM.YOUTUBE,
  videoId = '',
} = {}) {
  if (entries.length === 0) return [];

  const STOP_WORDS = new Set([
    'the','a','an','and','or','but','in','on','at','to','for','of','with',
    'is','are','was','were','be','been','being','have','has','had','do',
    'does','did','will','would','could','should','may','might','this',
    'that','these','those','it','its','we','you','i','he','she','they',
    'them','their','our','your','my','his','her','what','which','who',
    'how','when','where','why','not','no','so','if','as','by','from',
  ]);

  /**
   * @param {string} text
   * @returns {Set<string>}
   */
  function vocab(text) {
    return new Set(
      text.toLowerCase()
        .replace(/[^a-z0-9一-鿿\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
    );
  }

  /**
   * Jaccard similarity between two Sets.
   * @param {Set<string>} a
   * @param {Set<string>} b
   * @returns {number}
   */
  function jaccard(a, b) {
    let intersection = 0;
    for (const w of a) if (b.has(w)) intersection++;
    const union = a.size + b.size - intersection;
    return union === 0 ? 1 : intersection / union;
  }

  // Window size: ~30 entries or 10% of transcript, whichever is smaller
  const windowSize = Math.max(5, Math.min(30, Math.floor(entries.length * 0.1)));

  const cuts = [0]; // indices where new sections start
  let lastCutTime = entries[0].start;

  for (let i = windowSize; i < entries.length - windowSize; i++) {
    const elapsed = entries[i].start - lastCutTime;
    if (elapsed < minSectionDuration) continue;

    const before = entries.slice(i - windowSize, i).map((e) => e.text).join(' ');
    const after = entries.slice(i, i + windowSize).map((e) => e.text).join(' ');
    const sim = jaccard(vocab(before), vocab(after));

    if (sim < 0.15) { // low overlap → topic shift
      cuts.push(i);
      lastCutTime = entries[i].start;
      if (cuts.length >= maxSections) break;
    }
  }

  // Build sections from cuts
  const sections = cuts.map((startIdx, ci) => {
    const endIdx = cuts[ci + 1] ?? entries.length;
    const sectionEntries = entries.slice(startIdx, endIdx);
    const startTime = sectionEntries[0].start;
    const lastEntry = sectionEntries[sectionEntries.length - 1];
    const endTime = lastEntry.start + (lastEntry.dur ?? 0);
    const sectionText = sectionEntries.map((e) => e.text).join(' ');
    const label = deriveLabel(sectionText, ci);
    const thumbs = buildThumbnailUrls(platform, videoId, startTime);
    const videoUrl = buildVideoUrl(platform, videoId, startTime);

    return {
      startTime: Math.floor(startTime),
      endTime: Math.floor(endTime),
      label,
      entries: sectionEntries,
      thumbnailUrl: thumbs.hq ?? thumbs.default,
      videoUrl,
    };
  });

  return sections;
}

/**
 * Derive a short one-line label for a section from its text content.
 * @param {string} text
 * @param {number} sectionIndex
 * @returns {string}
 */
function deriveLabel(text, sectionIndex) {
  const sentences = splitSentences(text);
  if (sentences.length === 0) return `Section ${sectionIndex + 1}`;

  // Use first substantive sentence, truncated
  const first = sentences[0];
  const cleaned = first.replace(/[.!?。！？；,，]+$/, '').trim();
  if (cleaned.length <= 60) return cleaned;

  // Truncate at word boundary
  const words = cleaned.split(/\s+/);
  let label = '';
  for (const w of words) {
    if ((label + ' ' + w).trim().length > 57) break;
    label = (label + ' ' + w).trim();
  }
  return label + '…';
}
