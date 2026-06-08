/**
 * Study sheet generator.
 * Produces a polished Markdown or self-contained HTML study sheet
 * from a learn_topic result (or equivalent structured data).
 *
 * Offline — no CDN, no external resources. Inline CSS only.
 */

import { PLATFORM, buildThumbnailUrls, buildVideoUrl } from './platform.js';

// ─── Moment collection ─────────────────────────────────────────────────────

/**
 * Collect renderable thumbnail-grid moments for a single video.
 *
 * Prefers topical sections, then interval key moments. When neither is
 * available (e.g. the transcript could not be fetched), it falls back to a
 * single "video overview" moment derived purely from the video ID — the
 * platform thumbnail and deep-link are computable offline with no network.
 * This guarantees the study sheet always renders at least one card per video.
 *
 * @param {object} v  per-video record from learnTopic()
 * @returns {Array<{videoTitle,platform,t,note,thumbnailUrl,videoUrl}>}
 */
function collectMoments(v) {
  const platform = v.platform && v.platform !== 'unknown' ? v.platform : PLATFORM.YOUTUBE;
  const videoTitle = v.title || v.id;

  const fromSource = (source) =>
    source.map((m) => ({
      videoTitle,
      platform,
      t: m.startTime ?? m.t ?? 0,
      note: m.label ?? m.note ?? '',
      thumbnailUrl: m.thumbnailUrl ?? '',
      videoUrl: m.videoUrl ?? '',
    }));

  if (Array.isArray(v.sections) && v.sections.length > 0) {
    return fromSource(v.sections.slice(0, 6));
  }
  if (Array.isArray(v.keyMoments) && v.keyMoments.length > 0) {
    return fromSource(v.keyMoments.slice(0, 6));
  }

  // Fallback: a single overview card from the video ID alone (offline-safe).
  if (!v.id) return [];
  const thumbs = buildThumbnailUrls(platform, v.id, 0);
  return [{
    videoTitle,
    platform,
    t: 0,
    note: v.transcriptAvailable === false
      ? 'Open video (transcript unavailable offline)'
      : 'Watch from the start',
    thumbnailUrl: thumbs.hq ?? thumbs.default ?? '',
    videoUrl: buildVideoUrl(platform, v.id, 0),
  }];
}

// ─── Timestamp formatting ─────────────────────────────────────────────────

/**
 * Format seconds as MM:SS or H:MM:SS.
 * @param {number} seconds
 * @returns {string}
 */
function formatTime(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  }
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// ─── Markdown generator ───────────────────────────────────────────────────

/**
 * Build a Markdown study sheet.
 * @param {object} data   learnTopic() result
 * @param {string} topic  display title
 * @returns {string}
 */
export function buildMarkdownSheet(data, topic) {
  const { script, perVideo = [], meta = {} } = data;
  const lines = [];

  lines.push(`# Study Sheet: ${topic}`);
  lines.push('');
  lines.push(
    `> ${meta.totalVideos ?? perVideo.length} video(s) · ` +
    `${meta.transcriptsAvailable ?? 0} with transcript · ` +
    `Generated ${new Date().toISOString().slice(0, 10)}`
  );
  lines.push('');

  // Table of contents
  lines.push('## Contents');
  lines.push('');
  lines.push('1. [Synthesized Script](#synthesized-script)');
  lines.push('2. [Section Outline](#section-outline)');
  lines.push('3. [Key Moments](#key-moments)');
  lines.push('4. [Per-Video Summaries](#per-video-summaries)');
  lines.push('');

  // Synthesized script
  lines.push('## Synthesized Script');
  lines.push('');
  lines.push(script || '*(No script available)*');
  lines.push('');

  // Section outline from first transcribed video
  const firstWithSections = perVideo.find((v) => v.sections && v.sections.length > 0);
  if (firstWithSections) {
    lines.push('## Section Outline');
    lines.push('');
    lines.push(`*From: ${firstWithSections.title || firstWithSections.id}*`);
    lines.push('');
    for (const sec of firstWithSections.sections) {
      lines.push(`- **${formatTime(sec.startTime)}** — ${sec.label}`);
    }
    lines.push('');
  }

  // Key moments — collectMoments() guarantees at least one entry per video.
  const allMoments = perVideo.flatMap(collectMoments);

  if (allMoments.length > 0) {
    lines.push('## Key Moments');
    lines.push('');
    for (const m of allMoments) {
      const ts = formatTime(m.t ?? 0);
      const link = m.videoUrl ? `[${ts}](${m.videoUrl})` : ts;
      lines.push(`- ${link} — **${m.videoTitle}**: ${m.note}`);
    }
    lines.push('');
  }

  // Per-video summaries
  lines.push('## Per-Video Summaries');
  lines.push('');
  for (const v of perVideo) {
    lines.push(`### ${v.title || v.id}`);
    if (v.platform) lines.push(`*Platform: ${v.platform}*`);
    lines.push('');
    lines.push(v.summary || '*(No summary available)*');
    if (v.keywords && v.keywords.length > 0) {
      lines.push('');
      lines.push(`**Keywords:** ${v.keywords.slice(0, 8).join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── HTML generator ───────────────────────────────────────────────────────

/** Inline CSS for the dark-theme HTML study sheet. */
const INLINE_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #0f1117;
    --surface: #1a1d27;
    --surface2: #22263a;
    --border: #2e334a;
    --accent: #7c6afe;
    --accent2: #4ecdc4;
    --text: #e2e8f0;
    --text-muted: #8892a4;
    --text-dim: #4a5568;
    --radius: 10px;
    --font: 'Segoe UI', system-ui, -apple-system, sans-serif;
    --font-mono: 'Cascadia Code', 'Fira Code', 'JetBrains Mono', monospace;
  }

  html { font-size: 16px; scroll-behavior: smooth; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: var(--font);
    line-height: 1.7;
    padding: 0;
    min-height: 100vh;
  }

  /* ── Layout ── */
  .page-wrap {
    max-width: 1100px;
    margin: 0 auto;
    padding: 2rem 1.5rem 4rem;
  }

  /* ── Header ── */
  .sheet-header {
    background: linear-gradient(135deg, #1a1d27 0%, #12172b 100%);
    border-bottom: 1px solid var(--border);
    padding: 2.5rem 1.5rem 2rem;
    text-align: center;
    position: relative;
    overflow: hidden;
  }
  .sheet-header::before {
    content: '';
    position: absolute;
    inset: 0;
    background:
      radial-gradient(ellipse at 20% 50%, rgba(124,106,254,0.12) 0%, transparent 60%),
      radial-gradient(ellipse at 80% 50%, rgba(78,205,196,0.08) 0%, transparent 60%);
    pointer-events: none;
  }
  .sheet-header h1 {
    font-size: clamp(1.6rem, 4vw, 2.6rem);
    font-weight: 700;
    letter-spacing: -0.02em;
    background: linear-gradient(135deg, #a78bfa, #4ecdc4);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    position: relative;
    margin-bottom: 0.5rem;
  }
  .sheet-header .meta-row {
    color: var(--text-muted);
    font-size: 0.85rem;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .meta-badge {
    background: rgba(124,106,254,0.15);
    border: 1px solid rgba(124,106,254,0.3);
    border-radius: 999px;
    padding: 0.2rem 0.75rem;
    font-size: 0.78rem;
    color: #a78bfa;
  }

  /* ── TOC ── */
  .toc-section {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.25rem 1.5rem;
    margin: 2rem 0;
  }
  .toc-section h2 {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--accent2);
    margin-bottom: 0.75rem;
  }
  .toc-list {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }
  .toc-list a {
    color: var(--text-muted);
    text-decoration: none;
    font-size: 0.85rem;
    padding: 0.25rem 0.65rem;
    border-radius: 6px;
    border: 1px solid var(--border);
    transition: all 0.15s;
  }
  .toc-list a:hover {
    background: var(--surface2);
    color: var(--text);
    border-color: var(--accent);
  }

  /* ── Sections ── */
  .section {
    margin: 2.5rem 0;
  }
  .section-title {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--text);
    margin-bottom: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border);
  }
  .section-title .icon {
    width: 28px;
    height: 28px;
    border-radius: 7px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.9rem;
    flex-shrink: 0;
  }
  .icon-script  { background: rgba(124,106,254,0.2); }
  .icon-outline { background: rgba(78,205,196,0.2); }
  .icon-moments { background: rgba(251,146,60,0.2); }
  .icon-videos  { background: rgba(52,211,153,0.2); }

  /* ── Script ── */
  .script-body {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.5rem;
    font-size: 0.95rem;
    line-height: 1.8;
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* ── Outline ── */
  .outline-list {
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .outline-item {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 0.65rem 1rem;
    font-size: 0.9rem;
    transition: border-color 0.15s;
  }
  .outline-item:hover { border-color: var(--accent); }
  .outline-item .ts-chip {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: 5px;
    padding: 0.1rem 0.5rem;
    font-family: var(--font-mono);
    font-size: 0.78rem;
    color: var(--accent2);
    white-space: nowrap;
    flex-shrink: 0;
    margin-top: 0.1rem;
  }
  .outline-item .label { color: var(--text); }

  /* ── Thumbnail grid ── */
  .moment-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
    gap: 1rem;
  }
  .moment-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow: hidden;
    transition: transform 0.15s, border-color 0.15s, box-shadow 0.15s;
    text-decoration: none;
    display: flex;
    flex-direction: column;
  }
  .moment-card:hover {
    transform: translateY(-3px);
    border-color: var(--accent);
    box-shadow: 0 8px 24px rgba(124,106,254,0.2);
  }
  .thumb-wrap {
    position: relative;
    aspect-ratio: 16/9;
    background: var(--surface2);
    overflow: hidden;
  }
  .thumb-wrap img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .thumb-wrap .play-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0,0,0,0.3);
    opacity: 0;
    transition: opacity 0.15s;
  }
  .moment-card:hover .play-overlay { opacity: 1; }
  .play-btn {
    width: 40px;
    height: 40px;
    background: rgba(124,106,254,0.9);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .play-btn svg { fill: white; width: 16px; height: 16px; margin-left: 2px; }
  .card-body {
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    flex: 1;
  }
  .card-ts {
    font-family: var(--font-mono);
    font-size: 0.75rem;
    color: var(--accent);
    background: rgba(124,106,254,0.1);
    border: 1px solid rgba(124,106,254,0.25);
    border-radius: 4px;
    padding: 0.1rem 0.4rem;
    display: inline-block;
    width: fit-content;
  }
  .card-title {
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--text);
    line-height: 1.4;
  }
  .card-video {
    font-size: 0.72rem;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── Per-video cards ── */
  .video-cards {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
  }
  .video-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.25rem;
  }
  .video-card-header {
    display: flex;
    align-items: flex-start;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }
  .platform-badge {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 0.15rem 0.5rem;
    border-radius: 4px;
    flex-shrink: 0;
    margin-top: 0.2rem;
  }
  .platform-youtube  { background: rgba(255,0,0,0.15); color: #f87171; border: 1px solid rgba(255,0,0,0.2); }
  .platform-bilibili { background: rgba(0,160,255,0.15); color: #60a5fa; border: 1px solid rgba(0,160,255,0.2); }
  .platform-unknown  { background: var(--surface2); color: var(--text-muted); border: 1px solid var(--border); }
  .video-card-title { font-size: 1rem; font-weight: 600; color: var(--text); }
  .video-card-body { font-size: 0.88rem; color: var(--text-muted); line-height: 1.7; }
  .keyword-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin-top: 0.75rem;
  }
  .kw-chip {
    font-size: 0.72rem;
    background: rgba(78,205,196,0.1);
    border: 1px solid rgba(78,205,196,0.2);
    color: var(--accent2);
    border-radius: 4px;
    padding: 0.1rem 0.45rem;
  }

  /* ── Footer ── */
  .sheet-footer {
    margin-top: 3rem;
    padding-top: 1rem;
    border-top: 1px solid var(--border);
    text-align: center;
    font-size: 0.75rem;
    color: var(--text-dim);
  }

  /* ── Responsive ── */
  @media (max-width: 640px) {
    .sheet-header { padding: 1.5rem 1rem 1.25rem; }
    .moment-grid { grid-template-columns: 1fr 1fr; }
    .page-wrap { padding: 1rem 1rem 3rem; }
  }
  @media (max-width: 400px) {
    .moment-grid { grid-template-columns: 1fr; }
  }
`;

/**
 * Escape characters that are special in HTML.
 * @param {string} str
 * @returns {string}
 */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Build a self-contained HTML study sheet.
 * @param {object} data   learnTopic() result
 * @param {string} topic  display title
 * @returns {string}  complete HTML document
 */
export function buildHtmlSheet(data, topic) {
  const { script, perVideo = [], meta = {} } = data;
  const date = new Date().toISOString().slice(0, 10);

  // Collect all moments. collectMoments() guarantees at least one card per
  // video (a video-overview card derived from the ID) even when transcripts
  // were unavailable, so the thumbnail grid always renders offline.
  const allMoments = perVideo.flatMap(collectMoments);

  // First video with topical sections for the outline
  const outlineVideo = perVideo.find((v) => v.sections && v.sections.length > 0);

  // Play-button SVG
  const playSvg = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M8 5v14l11-7z"/></svg>`;

  // Build thumbnail cards
  const thumbCards = allMoments.map((m) => {
    const ts = formatTime(m.t);
    const href = m.videoUrl ? esc(m.videoUrl) : '#';
    const hasThumb = m.thumbnailUrl && m.thumbnailUrl.length > 0;
    const thumbImg = hasThumb
      ? `<img src="${esc(m.thumbnailUrl)}" alt="${esc(m.note)}" loading="lazy" onerror="this.style.display='none'">`
      : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#4a5568;font-size:2rem;">▶</div>`;

    return `
      <a class="moment-card" href="${href}" target="_blank" rel="noopener noreferrer">
        <div class="thumb-wrap">
          ${thumbImg}
          <div class="play-overlay"><div class="play-btn">${playSvg}</div></div>
        </div>
        <div class="card-body">
          <span class="card-ts">${esc(ts)}</span>
          <div class="card-title">${esc(m.note.slice(0, 80) || 'Section')}</div>
          <div class="card-video">${esc(m.videoTitle)}</div>
        </div>
      </a>`;
  }).join('\n');

  // Outline items
  const outlineItems = outlineVideo
    ? outlineVideo.sections.map((sec) => {
        const ts = formatTime(sec.startTime);
        const href = sec.videoUrl ? esc(sec.videoUrl) : '#';
        return `
          <li class="outline-item">
            <a href="${href}" target="_blank" rel="noopener noreferrer" class="ts-chip">${esc(ts)}</a>
            <span class="label">${esc(sec.label)}</span>
          </li>`;
      }).join('\n')
    : '<li class="outline-item"><span class="label">No sections available</span></li>';

  // Per-video cards
  const videoCards = perVideo.map((v) => {
    const badgeClass = `platform-${esc(v.platform ?? 'unknown')}`;
    const kwChips = (v.keywords ?? []).slice(0, 10).map((kw) =>
      `<span class="kw-chip">${esc(kw)}</span>`
    ).join('');
    return `
      <div class="video-card">
        <div class="video-card-header">
          <span class="platform-badge ${badgeClass}">${esc(v.platform ?? 'unknown')}</span>
          <div class="video-card-title">${esc(v.title || v.id)}</div>
        </div>
        <div class="video-card-body">${esc(v.summary || '(No summary available)')}</div>
        ${kwChips ? `<div class="keyword-chips">${kwChips}</div>` : ''}
      </div>`;
  }).join('\n');

  // Meta badges
  const metaBadges = [
    `${meta.totalVideos ?? perVideo.length} video${(meta.totalVideos ?? perVideo.length) === 1 ? '' : 's'}`,
    `${meta.transcriptsAvailable ?? 0} transcript${(meta.transcriptsAvailable ?? 0) === 1 ? '' : 's'}`,
    `${meta.llmEnabled ? 'LLM + extractive' : 'Extractive (offline)'}`,
  ].map((b) => `<span class="meta-badge">${esc(b)}</span>`).join('\n');

  const scriptText = esc(script || '(No synthesized script available)');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Study Sheet: ${esc(topic)}</title>
  <style>${INLINE_CSS}</style>
</head>
<body>

<header class="sheet-header">
  <h1>Study Sheet: ${esc(topic)}</h1>
  <div class="meta-row">
    ${metaBadges}
    <span class="meta-badge">${esc(date)}</span>
  </div>
</header>

<div class="page-wrap">

  <nav class="toc-section" aria-label="Table of contents">
    <h2>Contents</h2>
    <ul class="toc-list">
      <li><a href="#synthesized-script">Synthesized Script</a></li>
      <li><a href="#section-outline">Section Outline</a></li>
      <li><a href="#key-moments">Key Moments</a></li>
      <li><a href="#per-video">Per-Video Summaries</a></li>
    </ul>
  </nav>

  <section class="section" id="synthesized-script">
    <h2 class="section-title">
      <span class="icon icon-script">📝</span>
      Synthesized Script
    </h2>
    <div class="script-body">${scriptText}</div>
  </section>

  <section class="section" id="section-outline">
    <h2 class="section-title">
      <span class="icon icon-outline">🗂</span>
      Section Outline
    </h2>
    <ul class="outline-list">
      ${outlineItems}
    </ul>
  </section>

  <section class="section" id="key-moments">
    <h2 class="section-title">
      <span class="icon icon-moments">⏱</span>
      Key Moments
    </h2>
    ${allMoments.length > 0
      ? `<div class="moment-grid">${thumbCards}</div>`
      : '<p style="color:var(--text-muted)">No key moments available.</p>'}
  </section>

  <section class="section" id="per-video">
    <h2 class="section-title">
      <span class="icon icon-videos">🎬</span>
      Per-Video Summaries
    </h2>
    <div class="video-cards">
      ${videoCards || '<p style="color:var(--text-muted)">No video data available.</p>'}
    </div>
  </section>

</div>

<footer class="sheet-footer">
  Generated by mcp-video-knowledge · ${esc(date)}
</footer>

</body>
</html>`;
}
