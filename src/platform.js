/**
 * Platform detection and per-platform helpers.
 * Supports YouTube and Bilibili (best-effort).
 */

// ─── Platform constants ────────────────────────────────────────────────────

export const PLATFORM = Object.freeze({
  YOUTUBE: 'youtube',
  BILIBILI: 'bilibili',
});

// ─── ID detection ──────────────────────────────────────────────────────────

/**
 * Detect platform and extract canonical video ID from any supported input.
 * @param {string} input  URL, YouTube ID (11 chars), or Bilibili BV/AV id
 * @returns {{ platform: string, id: string }}
 */
export function detectPlatform(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('Video ID or URL is required');
  }
  const trimmed = input.trim();

  // ── Try URL parse first ──────────────────────────────────────────────────
  try {
    const url = new URL(trimmed);

    // Bilibili
    if (url.hostname.includes('bilibili.com')) {
      const bvMatch = url.pathname.match(/\/(BV[a-zA-Z0-9]+)/);
      if (bvMatch) return { platform: PLATFORM.BILIBILI, id: bvMatch[1] };
      const avMatch = url.pathname.match(/\/av(\d+)/i);
      if (avMatch) return { platform: PLATFORM.BILIBILI, id: `av${avMatch[1]}` };
      throw new Error(`Cannot parse Bilibili video ID from: ${trimmed}`);
    }

    // YouTube
    if (url.hostname.includes('youtube.com')) {
      const v = url.searchParams.get('v');
      if (v) return { platform: PLATFORM.YOUTUBE, id: v };
      const embedIdx = url.pathname.split('/').indexOf('embed');
      if (embedIdx !== -1) {
        const id = url.pathname.split('/')[embedIdx + 1];
        if (id) return { platform: PLATFORM.YOUTUBE, id };
      }
      const shortsMatch = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
      if (shortsMatch) return { platform: PLATFORM.YOUTUBE, id: shortsMatch[1] };
    }

    if (url.hostname === 'youtu.be') {
      const id = url.pathname.slice(1).split('?')[0];
      if (id) return { platform: PLATFORM.YOUTUBE, id };
    }
  } catch {
    // Not a URL — fall through to raw ID detection
  }

  // ── Bilibili BV raw id ───────────────────────────────────────────────────
  if (/^BV[a-zA-Z0-9]{10}$/.test(trimmed)) {
    return { platform: PLATFORM.BILIBILI, id: trimmed };
  }
  if (/^av\d+$/i.test(trimmed)) {
    return { platform: PLATFORM.BILIBILI, id: trimmed.toLowerCase() };
  }

  // ── YouTube raw 11-char id ───────────────────────────────────────────────
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return { platform: PLATFORM.YOUTUBE, id: trimmed };
  }

  throw new Error(`Cannot detect platform or parse video ID from: ${trimmed}`);
}

// ─── Thumbnail builders ───────────────────────────────────────────────────

/**
 * Build thumbnail URL(s) for a given platform + video ID.
 * @param {string} platform
 * @param {string} videoId
 * @param {number} [timestampSeconds]  hint only — not all platforms support it
 * @returns {{ default: string, hq: string, mq: string }}
 */
export function buildThumbnailUrls(platform, videoId, timestampSeconds = 0) {
  if (platform === PLATFORM.BILIBILI) {
    // Bilibili doesn't expose a simple thumbnail-by-ID scheme without the API.
    // Return placeholder pattern; callers should use the fetched cover URL when available.
    return {
      default: `https://i0.hdslb.com/bfs/archive/${videoId}.jpg`,
      hq: `https://i0.hdslb.com/bfs/archive/${videoId}.jpg`,
      mq: `https://i0.hdslb.com/bfs/archive/${videoId}.jpg`,
      timestampHint: timestampSeconds,
    };
  }

  // YouTube
  const base = `https://img.youtube.com/vi/${videoId}`;
  return {
    default: `${base}/default.jpg`,
    mq: `${base}/mqdefault.jpg`,
    hq: `${base}/hqdefault.jpg`,
    sd: `${base}/sddefault.jpg`,
    maxres: `${base}/maxresdefault.jpg`,
    timestampHint: timestampSeconds,
  };
}

/**
 * Build a deep-link URL to a video at a given timestamp.
 * @param {string} platform
 * @param {string} videoId
 * @param {number} [timestampSeconds]
 * @returns {string}
 */
export function buildVideoUrl(platform, videoId, timestampSeconds = 0) {
  if (platform === PLATFORM.BILIBILI) {
    const t = Math.floor(timestampSeconds);
    return `https://www.bilibili.com/video/${videoId}${t > 0 ? `?t=${t}` : ''}`;
  }
  const t = Math.floor(timestampSeconds);
  return `https://www.youtube.com/watch?v=${videoId}${t > 0 ? `&t=${t}s` : ''}`;
}
