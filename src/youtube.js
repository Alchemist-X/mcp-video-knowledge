/**
 * YouTube Data API v3 helpers.
 * Requires YOUTUBE_API_KEY env var for search.
 * Video metadata (title) uses oEmbed (no key needed).
 *
 * Thumbnail and URL building is now delegated to platform.js.
 */

import { PLATFORM, buildThumbnailUrls as platformThumbs } from './platform.js';

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
 * Build thumbnail URLs for a YouTube video.
 * Delegates to platform.js for consistency.
 *
 * @param {string} videoId
 * @param {number} [timestampSeconds]
 * @returns {{ default: string, hq: string, mq: string, sd: string, maxres: string }}
 */
export function buildThumbnailUrls(videoId, timestampSeconds = 0) {
  return platformThumbs(PLATFORM.YOUTUBE, videoId, timestampSeconds);
}
