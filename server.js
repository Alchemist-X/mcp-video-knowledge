#!/usr/bin/env node
/**
 * mcp-video-knowledge — MCP stdio server
 *
 * Exposes four tools:
 *   - learn_topic        keyword/videoIds → synthesized script + per-video
 *                        summaries + topical sections with thumbnail URLs
 *   - summarize_transcript  offline extractive or LLM-assisted summarization
 *   - make_study_sheet   polished Markdown or self-contained HTML study sheet
 *   - compare_videos     contrast what each video covers (agreements/unique points)
 *
 * Supports YouTube (no key needed for transcripts) and Bilibili (best-effort;
 * set BILIBILI_COOKIE for logged-in videos — see src/bilibili.js).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { learnTopic } from './src/learn.js';
import { summarizeTranscript } from './src/summarize.js';
import { buildHtmlSheet, buildMarkdownSheet } from './src/studysheet.js';
import { compareVideos } from './src/compare.js';

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'learn_topic',
    description:
      'Learn the implicit knowledge in YouTube or Bilibili videos about a topic. ' +
      'Provide a keyword (requires YOUTUBE_API_KEY) or explicit videoIds/URLs ' +
      '(YouTube 11-char IDs, youtu.be URLs, or Bilibili BV/AV IDs — no key needed). ' +
      'Returns a synthesized script, per-video summaries with keyword extraction, ' +
      'topical sections with timestamps and thumbnail URLs, and interval key moments.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: 'Topic keyword to search YouTube (requires YOUTUBE_API_KEY env var)',
        },
        videoIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Explicit video IDs or full URLs. YouTube (11-char IDs, youtube.com/watch?v=, ' +
            'youtu.be/, youtube.com/shorts/) and Bilibili (BV1xxxxx, av12345, bilibili.com/video/) ' +
            'are both supported. No API key needed.',
        },
        maxVideos: {
          type: 'number',
          description: 'Maximum number of videos to process (default: 5, max: 10)',
        },
      },
    },
  },
  {
    name: 'summarize_transcript',
    description:
      'Summarize a provided transcript text into a structured script. ' +
      'Uses TextRank-style extractive ranking offline (no keys needed); ' +
      'uses the Anthropic LLM if ANTHROPIC_API_KEY is set. ' +
      'Handles long transcripts via chunking and supports CJK text.',
    inputSchema: {
      type: 'object',
      required: ['transcript'],
      properties: {
        transcript: {
          type: 'string',
          description: 'Full transcript text to summarize',
        },
        focus: {
          type: 'string',
          description: 'Optional focus area or keywords to emphasize in the summary',
        },
      },
    },
  },
  {
    name: 'make_study_sheet',
    description:
      'Generate a polished study sheet from a topic or explicit video IDs. ' +
      'Returns either Markdown or a standalone, self-contained HTML document ' +
      '(dark theme, thumbnail grid, TOC, section outline, per-video summaries). ' +
      'The HTML is shareable with no external dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: {
          type: 'string',
          description: 'Topic keyword (requires YOUTUBE_API_KEY)',
        },
        videoIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Explicit video IDs or URLs (YouTube or Bilibili). No API key needed.',
        },
        maxVideos: {
          type: 'number',
          description: 'Maximum number of videos to process (default: 5, max: 10)',
        },
        format: {
          type: 'string',
          enum: ['markdown', 'html'],
          description: 'Output format — "markdown" (default) or "html" (standalone styled document)',
        },
      },
    },
  },
  {
    name: 'compare_videos',
    description:
      'Compare multiple YouTube or Bilibili videos to identify shared topics ' +
      '(agreements) and unique coverage per video. ' +
      'Uses LLM if ANTHROPIC_API_KEY is set, otherwise extractive keyword comparison. ' +
      'Requires at least 2 video IDs/URLs.',
    inputSchema: {
      type: 'object',
      required: ['videoIds'],
      properties: {
        videoIds: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          description:
            'At least 2 video IDs or URLs to compare (YouTube or Bilibili).',
        },
        maxVideos: {
          type: 'number',
          description: 'Maximum number of videos to process (default: 5, max: 10)',
        },
      },
    },
  },
];

// ─── Server setup ──────────────────────────────────────────────────────────

const server = new Server(
  { name: 'mcp-video-knowledge', version: '2.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    // ── learn_topic ──────────────────────────────────────────────────────
    if (name === 'learn_topic') {
      const { keyword, videoIds, maxVideos } = args ?? {};
      const result = await learnTopic({ keyword, videoIds, maxVideos });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }

    // ── summarize_transcript ─────────────────────────────────────────────
    if (name === 'summarize_transcript') {
      const { transcript, focus } = args ?? {};
      if (!transcript) throw new Error('transcript is required');
      const script = await summarizeTranscript(String(transcript), focus ?? '');
      return {
        content: [{ type: 'text', text: JSON.stringify({ script }, null, 2) }],
      };
    }

    // ── make_study_sheet ─────────────────────────────────────────────────
    if (name === 'make_study_sheet') {
      const { keyword, videoIds, maxVideos, format = 'markdown' } = args ?? {};
      if (!keyword && (!videoIds || videoIds.length === 0)) {
        throw new Error('Provide either keyword or videoIds for make_study_sheet');
      }

      const learnResult = await learnTopic({ keyword, videoIds, maxVideos });
      const topic = keyword ?? (videoIds?.[0] ?? 'Study Sheet');

      let sheet;
      if (format === 'html') {
        sheet = buildHtmlSheet(learnResult, topic);
      } else {
        sheet = buildMarkdownSheet(learnResult, topic);
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                format,
                topic,
                meta: learnResult.meta,
                sheet,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    // ── compare_videos ───────────────────────────────────────────────────
    if (name === 'compare_videos') {
      const { videoIds, maxVideos } = args ?? {};
      if (!videoIds || videoIds.length < 2) {
        throw new Error('compare_videos requires at least 2 videoIds');
      }

      // Use learnTopic to fetch and process each video first
      const learnResult = await learnTopic({ videoIds, maxVideos });
      const { perVideo } = learnResult;

      const transcribed = perVideo.filter((v) => v.transcriptAvailable);
      if (transcribed.length < 2) {
        throw new Error(
          `Not enough videos with transcripts to compare (got ${transcribed.length}). ` +
          'Ensure the videos have closed captions enabled.'
        );
      }

      const comparison = await compareVideos(transcribed);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                comparison,
                meta: learnResult.meta,
                videosCompared: transcribed.map((v) => ({
                  id: v.id,
                  platform: v.platform,
                  title: v.title,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: err.message }, null, 2),
        },
      ],
      isError: true,
    };
  }
});

// ─── Boot ──────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // No console.log — MCP stdio must stay clean
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
