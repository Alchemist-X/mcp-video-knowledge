/**
 * YouTube Data API v3 helpers.
 * Requires YOUTUBE_API_KEY env var for search.
 * Video metadata (title) uses oEmbed (no key needed).
 */

const YT_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';
const YT_OEMBED_URL = 'https://www.youtube.com/oembed';

/**
 * Search YouTube for videos matching a keyword.
 * @param {string} keyword
 * @param {number} maxResults
 * @returns {Promise<string[]>} Array of video IDs
 */
export async function searchVideos(keyword, maxResults = 5) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'YOUTUBE_API_KEY is required for keyword search. ' +
      'Alternatively, pass explicit videoIds to learn_topic.'
    );
  }

  const params = new URLSearchParams({
    part: 'snippet',
    q: keyword,
    type: 'video',
    maxResults: String(Math.min(maxResults, 10)),
    key: apiKey,
  });

  const res = await fetch(`${YT_SEARCH_URL}?${params}`, {
    signal: AbortSignal.timeout(10000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`YouTube search API error ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return (data.items ?? [])
    .filter((item) => item.id?.videoId)
    .map((item) => item.id.videoId);
}

/**
 * Get video title via oEmbed (no API key needed).
 * @param {string} videoId
 * @returns {Promise<string>}
 */
export async function getVideoTitle(videoId) {
  try {
    const params = new URLSearchParams({
      url: `https://www.youtube.com/watch?v=${videoId}`,
      format: 'json',
    });
    const res = await fetch(`${YT_OEMBED_URL}?${params}`, {
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return videoId;
    const data = await res.json();
    return data.title ?? videoId;
  } catch {
    return videoId;
  }
}

/**
 * Build thumbnail URLs for a video.
 * YouTube provides several standard thumbnails — we return them all so the
 * consumer can pick the best available one. True per-frame extraction would
 * require downloading and decoding the video (future: ffmpeg integration).
 *
 * @param {string} videoId
 * @param {number} [timestampSeconds] — hint only; YouTube doesn't support
 *   arbitrary-timestamp thumbnails without storyboard APIs.
 * @returns {{ default: string, hq: string, mq: string, sd: string, maxres: string }}
 */
export function buildThumbnailUrls(videoId, timestampSeconds = 0) {
  const base = `https://img.youtube.com/vi/${videoId}`;
  return {
    default: `${base}/default.jpg`,
    mq: `${base}/mqdefault.jpg`,
    hq: `${base}/hqdefault.jpg`,
    sd: `${base}/sddefault.jpg`,
    maxres: `${base}/maxresdefault.jpg`,
    // Note: YouTube's storyboard thumbnails are video-specific and require
    // parsing the video page's player config — out of scope for this MVP.
    timestampHint: timestampSeconds,
  };
}
