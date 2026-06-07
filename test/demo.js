/**
 * Offline demo / test harness for mcp-video-knowledge.
 * Tests the full extractive pipeline with no API keys or network.
 *
 * Run: node test/demo.js
 *
 * Outputs:
 *   1. TextRank extractive summary
 *   2. TF-IDF keyword extraction
 *   3. Focus-based re-ranking
 *   4. Topical section segmentation
 *   5. Extractive video comparison
 *   6. Markdown study sheet (stdout)
 *   7. HTML study sheet → /tmp/study-sheet-demo.html
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { extractiveSummarize, extractKeywords } from '../src/summarize.js';
import { extractKeyMoments, segmentTranscript, splitSentences } from '../src/transcript.js';
import { compareVideos } from '../src/compare.js';
import { buildMarkdownSheet, buildHtmlSheet } from '../src/studysheet.js';
import { PLATFORM } from '../src/platform.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const samplePath = join(__dirname, 'sample-transcript.txt');

function divider(label) {
  const line = '─'.repeat(64);
  process.stdout.write(`\n${line}\n  ${label}\n${line}\n`);
}

function ok(label) {
  process.stdout.write(`  ✓ ${label}\n`);
}

// ─── Build simulated video data ────────────────────────────────────────────

function makeSimulatedEntries(transcript) {
  const words = transcript.split(/\s+/);
  const wordsPerChunk = 30;
  const entries = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    entries.push({
      start: (i / wordsPerChunk) * 10,
      dur: 10,
      text: words.slice(i, i + wordsPerChunk).join(' '),
    });
  }
  return entries;
}

function makeVideoData(transcript, id, title) {
  const entries = makeSimulatedEntries(transcript);
  const keywords = extractKeywords(transcript);
  const summary = extractiveSummarize(transcript, 8, '');
  const sections = segmentTranscript(entries, {
    platform: PLATFORM.YOUTUBE,
    videoId: id,
    minSectionDuration: 40,
    maxSections: 8,
  });
  const keyMoments = extractKeyMoments(entries, 60).map((m) => ({
    ...m,
    thumbnailUrl: `https://img.youtube.com/vi/${id}/hqdefault.jpg`,
    videoUrl: `https://www.youtube.com/watch?v=${id}&t=${m.t}s`,
  }));

  return {
    id,
    platform: PLATFORM.YOUTUBE,
    title,
    summary,
    keywords,
    sections,
    keyMoments,
    transcriptAvailable: true,
  };
}

// ─── Run demo ──────────────────────────────────────────────────────────────

async function run() {
  const transcript = readFileSync(samplePath, 'utf8');

  // 1. TextRank extractive summary
  divider('1. TextRank Extractive Summary (no API key)');
  const summary = extractiveSummarize(transcript, 8, 'machine learning');
  process.stdout.write(summary + '\n');
  ok(`Summary: ${summary.length} chars`);

  // 2. TF-IDF keyword extraction
  divider('2. TF-IDF Keyword Extraction');
  const keywords = extractKeywords(transcript, 12);
  process.stdout.write(`  Keywords: ${keywords.join(', ')}\n`);
  ok(`${keywords.length} keywords extracted`);

  // 3. Focus-based summary
  divider('3. Focus-Adjusted Summary (focus: "overfitting regularization")');
  const focused = extractiveSummarize(
    transcript,
    6,
    'overfitting regularization neural network'
  );
  process.stdout.write(focused + '\n');
  ok(`Focused summary: ${focused.length} chars`);

  // 4. CJK-aware sentence splitting
  divider('4. CJK-Aware Sentence Splitting');
  const mixed = 'Machine learning is powerful. 机器学习非常强大！Neural networks excel at vision tasks. 神经网络擅长视觉任务。';
  const sentences = splitSentences(mixed);
  sentences.forEach((s, i) => process.stdout.write(`  [${i + 1}] ${s}\n`));
  ok(`Split into ${sentences.length} sentences`);

  // 5. Topical segmentation
  divider('5. Topical Section Segmentation');
  const simEntries = makeSimulatedEntries(transcript);
  const sections = segmentTranscript(simEntries, {
    platform: PLATFORM.YOUTUBE,
    videoId: 'dQw4w9WgXcQ',
    minSectionDuration: 40,
    maxSections: 8,
  });
  sections.forEach((sec) => {
    const ts = `${sec.startTime}s–${sec.endTime}s`;
    process.stdout.write(`  [${ts}] ${sec.label}\n`);
    process.stdout.write(`         ${sec.thumbnailUrl}\n`);
  });
  ok(`${sections.length} topical sections detected`);

  // 6. Interval key moments
  divider('6. Interval Key Moments');
  const moments = extractKeyMoments(simEntries, 60);
  moments.forEach((m) => {
    process.stdout.write(`  t=${m.t}s — ${m.note.slice(0, 80)}…\n`);
  });
  ok(`${moments.length} key moments`);

  // 7. Extractive video comparison (two synthetic videos)
  divider('7. Extractive Video Comparison (2 synthetic videos)');
  const video1 = makeVideoData(
    transcript,
    'aaaaaaaaaaa',
    'Machine Learning Fundamentals Part 1'
  );
  const video2 = makeVideoData(
    `Neural networks are the backbone of modern AI. Deep learning has transformed computer vision.
     Convolutional neural networks process images layer by layer. Transfer learning enables
     reuse of pre-trained models on new tasks. Attention mechanisms power transformer architectures.
     Self-supervised learning reduces the need for labeled data. Reinforcement learning trains
     agents via reward signals. Gradient descent optimizes model parameters iteratively.
     Backpropagation computes gradients efficiently through the network. Regularization prevents
     overfitting by penalizing large weights. Batch normalization stabilizes training dynamics.
     Dropout randomly disables neurons during training to improve generalization.`,
    'bbbbbbbbbbb',
    'Deep Learning and Neural Networks'
  );

  const comparison = await compareVideos([video1, video2]);
  process.stdout.write(`  Agreement: ${comparison.agreementSummary}\n`);
  process.stdout.write(`  Shared topics: ${(comparison.sharedTopics ?? []).slice(0, 8).join(', ')}\n`);
  comparison.perVideo?.forEach((v) => {
    process.stdout.write(`  [${v.title}] unique: ${(v.uniquePoints ?? []).slice(0, 5).join(', ')}\n`);
  });
  ok('Comparison complete');

  // 8. Markdown study sheet
  divider('8. Markdown Study Sheet');
  const learnResult = {
    script: summary,
    perVideo: [video1, video2],
    meta: {
      keyword: 'machine learning',
      totalVideos: 2,
      transcriptsAvailable: 2,
      platforms: ['youtube'],
      llmEnabled: false,
    },
  };
  const markdownSheet = buildMarkdownSheet(learnResult, 'Machine Learning');
  process.stdout.write(markdownSheet.slice(0, 600) + '\n…(truncated)\n');
  ok(`Markdown sheet: ${markdownSheet.length} chars`);

  // 9. HTML study sheet → /tmp
  divider('9. HTML Study Sheet → /tmp/study-sheet-demo.html');
  const htmlSheet = buildHtmlSheet(learnResult, 'Machine Learning');
  const outPath = '/tmp/study-sheet-demo.html';
  writeFileSync(outPath, htmlSheet, 'utf8');
  ok(`HTML sheet: ${htmlSheet.length} chars → ${outPath}`);

  // Validate HTML structure
  const hasDoctype = htmlSheet.startsWith('<!DOCTYPE html>');
  const hasCss = htmlSheet.includes('<style>');
  const hasToc = htmlSheet.includes('toc-section');
  const hasGrid = htmlSheet.includes('moment-grid');
  const hasScript = htmlSheet.includes('synthesized-script');
  process.stdout.write(`  DOCTYPE: ${hasDoctype} | <style>: ${hasCss} | TOC: ${hasToc} | grid: ${hasGrid} | script: ${hasScript}\n`);

  divider('Demo complete — no API keys or network required');
}

run().catch((err) => {
  process.stderr.write(`Demo failed: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
