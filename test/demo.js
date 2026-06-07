/**
 * Offline demo / test harness for mcp-video-knowledge.
 * Tests the extractive summarization pipeline with no API keys or network.
 *
 * Run: node test/demo.js
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { extractiveSummarize } from '../src/summarize.js';
import { extractKeyMoments } from '../src/transcript.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const samplePath = join(__dirname, 'sample-transcript.txt');

function divider(label) {
  const line = '─'.repeat(60);
  process.stdout.write(`\n${line}\n  ${label}\n${line}\n`);
}

function run() {
  const transcript = readFileSync(samplePath, 'utf8');

  divider('1. Extractive Summary (no API key)');
  const summary = extractiveSummarize(transcript, 8, 'machine learning');
  process.stdout.write(summary + '\n');

  divider('2. Key Moments from Simulated Timed Entries');
  // Simulate timed transcript entries (as if fetched from YouTube timedtext)
  const words = transcript.split(/\s+/);
  const wordsPerChunk = 30;
  const simulatedEntries = [];
  for (let i = 0; i < words.length; i += wordsPerChunk) {
    simulatedEntries.push({
      start: (i / wordsPerChunk) * 10, // ~10 seconds per chunk
      dur: 10,
      text: words.slice(i, i + wordsPerChunk).join(' '),
    });
  }

  const moments = extractKeyMoments(simulatedEntries, 60);
  moments.forEach((m) => {
    process.stdout.write(`  t=${m.t}s — ${m.note.slice(0, 80)}...\n`);
  });

  divider('3. Focus-Based Summary (focus: "overfitting regularization")');
  const focused = extractiveSummarize(
    transcript,
    6,
    'overfitting regularization neural network'
  );
  process.stdout.write(focused + '\n');

  divider('Demo complete — no API keys or network required');
}

try {
  run();
} catch (err) {
  process.stderr.write(`Demo failed: ${err.message}\n`);
  process.exit(1);
}
