/**
 * Core learn_topic pipeline:
 *   1. Resolve video IDs (search or explicit list), auto-detect platform
 *   2. Fetch transcript for each video (YouTube or Bilibili)
 *   3. Summarize each transcript
 *   4. Segment transcript into topical sections with timestamps + thumbnails
 *   5. Synthesize a cross-video script
 */

import { parseVideoRef, fetchTranscript, segmentTranscript, extractKeyMoments } from './transcript.js';
import { summarizeTranscript, synthesizeScript, extractKeywords } from './summarize.js';
import { searchVideos, getVideoTitle, buildThumbnailUrls } from './youtube.js';
import { getBilibiliTitle } from './bilibili.js';
import { PLATFORM, buildVideoUrl } from './platform.js';

const DEFAULT_MAX_VIDEOS = 5;

// ─── Single-video processing ───────────────────────────────────────────────

/**
 * Process a single video: detect platform, fetch transcript, summarize,
 * segment into topical sections.
 *
 * @param {string} rawId  video ID, URL (YouTube or Bilibili)
 * @returns {Promise<{
 *   id: string,
 *   platform: string,
 *   title: string,
 *   summary: string,
 *   keywords: string[],
 *   sections: Array,
 *   keyMoments: Array,
 *   transcriptAvailable: boolean
 * }>}
 */
async function processVideo(rawId) {
  const { platform, id } = parseVideoRef(rawId);

  // Fetch title and transcript concurrently
  const [titleResult, transcriptResult] = await Promise.all([
    platform === PLATFORM.BILIBILI ? getBilibiliTitle(id) : getVideoTitle(id),
    fetchTranscript(id, platform),
  ]);

  // Bilibili transcript includes title in result; prefer that if available
  const title =
    (platform === PLATFORM.BILIBILI && transcriptResult.title)
      ? transcriptResult.title
      : (typeof titleResult === 'string' ? titleResult : id);

  const { entries, plainText, available } = transcriptResult;

  const summary = available
    ? await summarizeTranscript(plainText)
    : '(Transcript unavailable — closed captions may be disabled or require login for this video.)';

  const keywords = available ? extractKeywords(plainText) : [];

  // Topical sections (richer than simple interval key moments)
  const sections = available
    ? segmentTranscript(entries, { platform, videoId: id })
    : [];

  // Simple interval key moments (legacy, kept for compatibility)
  const rawMoments = available ? extractKeyMoments(entries, 90) : [];
  const keyMoments = rawMoments.map((m) => ({
    t: m.t,
    note: m.note,
    thumbnailUrl: buildThumbnailUrls(id, m.t).hq,
    videoUrl: buildVideoUrl(platform, id, m.t),
  }));

  return {
    id,
    platform,
    title,
    summary,
    keywords,
    sections,
    keyMoments,
    transcriptAvailable: available,
  };
}

// ─── Batch processing ──────────────────────────────────────────────────────

/**
 * Learn from a set of videos about a topic.
 *
 * @param {object} params
 * @param {string} [params.keyword]      search term (needs YOUTUBE_API_KEY)
 * @param {string[]} [params.videoIds]   explicit video IDs/URLs (YouTube or Bilibili)
 * @param {number} [params.maxVideos]    cap on number of videos (default 5)
 * @returns {Promise<{script: string, perVideo: Array, meta: object}>}
 */
export async function learnTopic({ keyword, videoIds, maxVideos } = {}) {
  const max = Math.min(Number(maxVideos) || DEFAULT_MAX_VIDEOS, 10);

  let resolvedIds;
  if (videoIds && videoIds.length > 0) {
    resolvedIds = videoIds.slice(0, max);
  } else if (keyword) {
    resolvedIds = await searchVideos(keyword, max);
    if (resolvedIds.length === 0) {
      throw new Error(`No videos found for keyword: "${keyword}"`);
    }
  } else {
    throw new Error('Provide either keyword or videoIds');
  }

  // Process videos concurrently (batch of 3 to avoid rate-limiting)
  const batchSize = 3;
  const perVideo = [];
  for (let i = 0; i < resolvedIds.length; i += batchSize) {
    const batch = resolvedIds.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(processVideo));
    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === 'fulfilled') {
        perVideo.push(result.value);
      } else {
        perVideo.push({
          id: batch[j],
          platform: 'unknown',
          title: 'Error',
          summary: `Failed to process: ${result.reason?.message ?? 'unknown error'}`,
          keywords: [],
          sections: [],
          keyMoments: [],
          transcriptAvailable: false,
        });
      }
    }
  }

  const transcribedVideos = perVideo.filter((v) => v.transcriptAvailable);
  const script =
    transcribedVideos.length > 0
      ? await synthesizeScript(transcribedVideos, keyword ?? '')
      : '(No transcripts were available to synthesize. Try videos with closed captions enabled.)';

  const platforms = [...new Set(perVideo.map((v) => v.platform))];

  return {
    script,
    perVideo,
    meta: {
      keyword: keyword ?? null,
      totalVideos: perVideo.length,
      transcriptsAvailable: transcribedVideos.length,
      platforms,
      llmEnabled: Boolean(process.env.ANTHROPIC_API_KEY),
    },
  };
}
