// MCP server: the same watch and zoom, but the images come back inline so the
// agent sees them in the tool result instead of opening files.
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { watch, zoom, checkTools, fmt } from './engine.mjs';

const pkg = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

// JPEG keeps a full sheet well under client image size limits; the PNGs on
// disk stay lossless for anyone who opens them.
async function image(file) {
  const data = await sharp(file).jpeg({ quality: 82 }).toBuffer();
  return { type: 'image', data: data.toString('base64'), mimeType: 'image/jpeg' };
}

const fail = (e) => ({ isError: true, content: [{ type: 'text', text: `caught-in-4k: ${e.message}` }] });
const time = z.union([z.number(), z.string()]);

const server = new McpServer({ name: 'caught-in-4k', version: pkg.version });

server.registerTool('watch_video', {
  title: 'Watch a video',
  description: 'Watch a video file or URL (screen recording, Loom, bug repro, demo, tutorial). Returns labelled overview sheets of the keyframes, with red boxes on what changed since the previous keyframe, plus a timeline with the transcript lined up. Use zoom_video afterwards for any moment you need to see in more detail.',
  inputSchema: {
    path: z.string().describe('Video file path (absolute is safest) or an http(s) URL'),
    max_frames: z.number().int().min(2).max(200).optional().describe('Keyframe budget. Default grows with length: 12 plus about 0.8 per minute, up to 60.'),
    transcribe: z.boolean().optional().describe('Transcribe speech if whisper.cpp is installed. Default true.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ path: input, max_frames, transcribe }) => {
  try {
    checkTools();
    const r = await watch(input, { max: max_frames, 'no-audio': transcribe === false });
    return {
      content: [
        { type: 'text', text: `${r.markdown}\nFiles: ${r.outDir}` },
        ...(await Promise.all(r.sheets.map((s) => image(s.file)))),
        ...(r.details ? [await image(r.details)] : []),
      ],
    };
  } catch (e) { return fail(e); }
});

server.registerTool('zoom_video', {
  title: 'Zoom into a video',
  description: 'Look closely at one stretch of a video: evenly spaced frames from `from` to `to` as one labelled sheet, with red boxes on what changed between frames. Set count to 1 to get the single frame at `from` in full resolution, for reading small text.',
  inputSchema: {
    path: z.string().describe('Same video path or URL given to watch_video'),
    from: time.describe('Start time, seconds or m:ss'),
    to: time.optional().describe('End time, seconds or m:ss. Default: 3 seconds after from.'),
    count: z.number().int().min(1).max(16).optional().describe('Frames to show. Default 9. 1 = one full-resolution frame.'),
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}, async ({ path: input, from, to, count }) => {
  try {
    checkTools();
    const r = await zoom(input, { from, to, count });
    const span = r.times.length > 1 ? `${fmt(r.times[0])} to ${fmt(r.times[r.times.length - 1])}, ${r.times.length} frames` : `frame at ${fmt(r.times[0])}`;
    return {
      content: [
        { type: 'text', text: `${span}. Full-resolution frames: ${r.dir}` },
        ...(await Promise.all(r.sheets.map((s) => image(s.file)))),
      ],
    };
  } catch (e) { return fail(e); }
});

await server.connect(new StdioServerTransport());
