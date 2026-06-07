/**
 * Core learn_topic pipeline:
 *   1. Resolve video IDs (search or explicit list)
 *   2. Fetch transcript for each video
 *   3. Summarize each transcript
 *   4. Extract key moments with thumbnail URLs
 *   5. Synthesize a cross-video script
 */

import { parseVideoId, fetchTranscript, extractKeyMoments } from './transcript.js';
import { summarizeTranscript, synthesizeScript } from './summarize.js';
import { searchVideos, getVideoTitle, buildThumbnailUrls } from './youtube.js';

const DEFAULT_MAX_VIDEOS = 5;

/**
 * Process a single video: fetch transcript, summarize, extract key moments.
 * @param {string} rawId — video ID or URL
 * @returns {Promise<{id:string, title:string, summary:string, keyMoments:Array, transcriptAvailable:boolean}>}
 */
async function processVideo(rawId) {
  const id = parseVideoId(rawId);
  const [title, transcriptResult] = await Promise.all([
    getVideoTitle(id),
    fetchTranscript(id),
  ]);

  const { entries, plainText, available } = transcriptResult;

  const summary = available
    ? await summarizeTranscript(plainText)
    : '(Transcript unavailable — closed captions may be disabled for this video.)';

  const rawMoments = available ? extractKeyMoments(entries, 60) : [];
  const keyMoments = rawMoments.map((m) => ({
    t: m.t,
    note: m.note,
    thumbnailUrl: buildThumbnailUrls(id, m.t).hq,
  }));

  return {
    id,
    title,
    summary,
    keyMoments,
    transcriptAvailable: available,
  };
}

/**
 * Learn from a set of videos about a topic.
 *
 * @param {object} params
 * @param {string} [params.keyword]       — search term (needs YOUTUBE_API_KEY)
 * @param {string[]} [params.videoIds]    — explicit video IDs/URLs (no key needed)
 * @param {number} [params.maxVideos]     — cap on number of videos (default 5)
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

  // Process videos concurrently (but limit to avoid rate-limiting)
  const batchSize = 3;
  const perVideo = [];
  for (let i = 0; i < resolvedIds.length; i += batchSize) {
    const batch = resolvedIds.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map(processVideo));
    for (const result of results) {
      if (result.status === 'fulfilled') {
        perVideo.push(result.value);
      } else {
        perVideo.push({
          id: batch[perVideo.length - (perVideo.length - i)],
          title: 'Error',
          summary: `Failed to process: ${result.reason?.message ?? 'unknown error'}`,
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

  return {
    script,
    perVideo,
    meta: {
      keyword: keyword ?? null,
      totalVideos: perVideo.length,
      transcriptsAvailable: transcribedVideos.length,
      llmEnabled: Boolean(process.env.ANTHROPIC_API_KEY),
    },
  };
}
