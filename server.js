/**
 * mcp-video-knowledge — MCP stdio server
 *
 * Exposes two tools:
 *   - learn_topic: fetch, transcribe, and synthesize knowledge from YouTube videos
 *   - summarize_transcript: offline summarization of arbitrary transcript text
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { learnTopic } from './src/learn.js';
import { summarizeTranscript } from './src/summarize.js';

// ─── Tool definitions ──────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'learn_topic',
    description:
      'Learn the implicit knowledge in YouTube videos about a topic. ' +
      'Provide a keyword (requires YOUTUBE_API_KEY) or explicit videoIds/URLs (no key needed). ' +
      'Returns a synthesized script and per-video summaries with timestamped key moments.',
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
          description: 'Explicit YouTube video IDs or full URLs (no API key needed)',
        },
        maxVideos: {
          type: 'number',
          description: 'Maximum number of videos to process (default: 5, max: 10)',
        },
      },
      // At least one of keyword or videoIds must be provided (enforced at runtime)
    },
  },
  {
    name: 'summarize_transcript',
    description:
      'Summarize a provided transcript text into a structured script. ' +
      'Works offline with extractive fallback; uses LLM if ANTHROPIC_API_KEY is set.',
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
];

// ─── Server setup ──────────────────────────────────────────────────────────

const server = new Server(
  { name: 'mcp-video-knowledge', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'learn_topic') {
      const { keyword, videoIds, maxVideos } = args ?? {};
      const result = await learnTopic({ keyword, videoIds, maxVideos });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
      };
    }

    if (name === 'summarize_transcript') {
      const { transcript, focus } = args ?? {};
      if (!transcript) {
        throw new Error('transcript is required');
      }
      const script = await summarizeTranscript(String(transcript), focus ?? '');
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ script }, null, 2),
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
  // Intentionally no console.log here — MCP stdio must stay clean
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
