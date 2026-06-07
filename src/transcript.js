/**
 * Fetches YouTube transcript via the timedtext endpoint (no API key required).
 * Degrades gracefully if unavailable.
 */

const TIMEDTEXT_BASE = 'https://www.youtube.com/api/timedtext';

/**
 * Parse video ID from a YouTube URL or return as-is if already an ID.
 * @param {string} input
 * @returns {string}
 */
export function parseVideoId(input) {
  if (!input) throw new Error('Video ID or URL is required');

  try {
    const url = new URL(input);
    if (url.hostname.includes('youtube.com')) {
      const v = url.searchParams.get('v');
      if (v) return v;
      const parts = url.pathname.split('/');
      const idx = parts.indexOf('embed');
      if (idx !== -1) return parts[idx + 1];
    }
    if (url.hostname === 'youtu.be') {
      return url.pathname.slice(1);
    }
  } catch {
    // Not a URL — treat as raw ID
  }

  // Validate raw ID format (11 alphanumeric chars + dashes/underscores)
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;

  throw new Error(`Cannot parse video ID from: ${input}`);
}

/**
 * Fetch available transcript tracks for a video.
 * @param {string} videoId
 * @returns {Promise<Array<{lang: string, langCode: string}>>}
 */
async function fetchTrackList(videoId) {
  const url = `${TIMEDTEXT_BASE}?type=list&v=${videoId}`;
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
}

/**
 * Fetch timed text XML and parse into plain text with timestamps.
 * @param {string} videoId
 * @param {string} langCode
 * @returns {Promise<Array<{start: number, dur: number, text: string}>>}
 */
async function fetchTimedText(videoId, langCode) {
  const url = `${TIMEDTEXT_BASE}?lang=${langCode}&v=${videoId}&fmt=srv3`;
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
}

/**
 * Fetch transcript for a given video ID.
 * Returns { entries, plainText, available } — entries may be empty if unavailable.
 * @param {string} videoId
 * @returns {Promise<{entries: Array<{start:number,dur:number,text:string}>, plainText: string, available: boolean}>}
 */
export async function fetchTranscript(videoId) {
  try {
    const tracks = await fetchTrackList(videoId);
    const preferred = tracks.find((t) => t.langCode === 'en') ?? tracks[0];

    if (!preferred) {
      return { entries: [], plainText: '', available: false };
    }

    const entries = await fetchTimedText(videoId, preferred.langCode);
    if (entries.length === 0) {
      return { entries: [], plainText: '', available: false };
    }

    const plainText = entries.map((e) => e.text).join(' ');
    return { entries, plainText, available: true };
  } catch (err) {
    // Degrade gracefully — transcript unavailable
    return { entries: [], plainText: '', available: false, error: err.message };
  }
}

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
