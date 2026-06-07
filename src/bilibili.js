/**
 * Bilibili subtitle / metadata fetching.
 *
 * ⚠️  Cookie caveat: Bilibili's subtitle API (/api/subtitle/v2) requires a
 * logged-in session cookie (SESSDATA) for most videos. Without it, only a
 * subset of videos (with public CC tracks) will work. Pass the BILIBILI_COOKIE
 * environment variable (value of the full Cookie header from your browser) to
 * authenticate.
 *
 * All failures degrade gracefully — the caller gets `available: false`.
 */

const BILIBILI_API = 'https://api.bilibili.com';
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Resolve a BV id to an AID + CID (needed for subtitle API).
 * @param {string} bvid  e.g. "BVxxxxxxx"
 * @returns {Promise<{aid: number, cid: number, title: string, cover: string} | null>}
 */
async function resolveVideoInfo(bvid) {
  try {
    const url = `${BILIBILI_API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
    const res = await fetch(url, {
      headers: buildHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== 0 || !json.data) return null;
    return {
      aid: json.data.aid,
      cid: json.data.cid,
      title: json.data.title ?? bvid,
      cover: json.data.pic ?? '',
    };
  } catch {
    return null;
  }
}

/**
 * Fetch subtitle list for a video (aid/cid).
 * @param {number} aid
 * @param {number} cid
 * @returns {Promise<Array<{lan: string, url: string}>>}
 */
async function fetchSubtitleList(aid, cid) {
  try {
    const url =
      `${BILIBILI_API}/x/player/v2?aid=${aid}&cid=${cid}`;
    const res = await fetch(url, {
      headers: buildHeaders(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    const subs = json.data?.subtitle?.subtitles ?? [];
    return subs.map((s) => ({
      lan: s.lan ?? 'zh-CN',
      url: s.subtitle_url
        ? s.subtitle_url.startsWith('http')
          ? s.subtitle_url
          : `https:${s.subtitle_url}`
        : null,
    })).filter((s) => s.url);
  } catch {
    return [];
  }
}

/**
 * Download and parse a Bilibili JSON subtitle file.
 * Format: { body: [{from, to, content}] }
 * @param {string} url
 * @returns {Promise<Array<{start:number, dur:number, text:string}>>}
 */
async function downloadSubtitle(url) {
  try {
    const res = await fetch(url, {
      headers: buildHeaders(),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const json = await res.json();
    return (json.body ?? []).map((item) => ({
      start: Number(item.from) ?? 0,
      dur: Math.max(0, (Number(item.to) ?? 0) - (Number(item.from) ?? 0)),
      text: String(item.content ?? '').trim(),
    })).filter((e) => e.text.length > 0);
  } catch {
    return [];
  }
}

/**
 * Build request headers, optionally injecting the BILIBILI_COOKIE env var.
 * @returns {Record<string, string>}
 */
function buildHeaders() {
  const headers = {
    'User-Agent': USER_AGENT,
    Referer: 'https://www.bilibili.com',
  };
  const cookie = process.env.BILIBILI_COOKIE;
  if (cookie) headers['Cookie'] = cookie;
  return headers;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Fetch transcript for a Bilibili video.
 * @param {string} bvid  e.g. "BVxxxxxxx" or "av12345"
 * @returns {Promise<{entries: Array, plainText: string, available: boolean, title: string, cover: string}>}
 */
export async function fetchBilibiliTranscript(bvid) {
  const empty = { entries: [], plainText: '', available: false, title: bvid, cover: '' };

  try {
    const info = await resolveVideoInfo(bvid);
    if (!info) return empty;

    const subtitleList = await fetchSubtitleList(info.aid, info.cid);
    if (subtitleList.length === 0) {
      return { ...empty, title: info.title, cover: info.cover };
    }

    // Prefer Chinese, then first available
    const preferred =
      subtitleList.find((s) => s.lan.startsWith('zh')) ?? subtitleList[0];

    const entries = await downloadSubtitle(preferred.url);
    if (entries.length === 0) {
      return { ...empty, title: info.title, cover: info.cover };
    }

    const plainText = entries.map((e) => e.text).join(' ');
    return {
      entries,
      plainText,
      available: true,
      title: info.title,
      cover: info.cover,
    };
  } catch (err) {
    return { ...empty, error: err.message };
  }
}

/**
 * Get Bilibili video title (standalone, without full transcript fetch).
 * @param {string} bvid
 * @returns {Promise<string>}
 */
export async function getBilibiliTitle(bvid) {
  try {
    const info = await resolveVideoInfo(bvid);
    return info?.title ?? bvid;
  } catch {
    return bvid;
  }
}
