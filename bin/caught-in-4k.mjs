#!/usr/bin/env node
import path from 'node:path';
import { watch, zoom, checkTools } from '../src/engine.mjs';

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) opt[k] = v;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) opt[k] = argv[++i];
      else opt[k] = true;
    } else pos.push(a);
  }
  return { pos, opt };
}

const HELP = `caught-in-4k: let an AI agent watch a video

  caught-in-4k <video|url> [--max N] [--out dir] [--no-audio]
      Pick the keyframes, mark what changed, transcribe speech, and write
      .caught-in-4k/<name>/index.md plus labelled overview sheets.

  caught-in-4k zoom <video|url> --from <time> --to <time> [--count 9]
      Dense frames across one time range, as a labelled sheet. Times are
      seconds or m:ss. --count 1 gives one full-resolution frame.

  caught-in-4k mcp
      Run as an MCP server (stdio) with watch_video and zoom_video tools.

Needs ffmpeg. Speech needs whisper.cpp (whisper-cli) and a ggml model.
URLs need yt-dlp.`;

async function main() {
  const { pos, opt } = parseArgs(process.argv.slice(2));
  if (!pos.length || opt.help || opt.h) { console.log(HELP); return; }
  if (pos[0] === 'mcp') { await import('../src/mcp.mjs'); return; }
  checkTools();
  const rel = (f) => path.relative(process.cwd(), f);
  if (pos[0] === 'zoom') {
    if (!pos[1]) throw new Error('usage: caught-in-4k zoom <video> --from <time> --to <time>');
    const { sheets, dir } = await zoom(pos[1], opt);
    console.log(`${sheets.length === 1 && opt.count == 1 ? 'frame' : 'zoom sheet'}: ${sheets.map((s) => rel(s.file)).join(', ')}`);
    console.log(`frames: ${rel(dir)}/`);
    return;
  }
  const t0 = Date.now();
  const { indexFile, sheets, keys } = await watch(pos[0], opt);
  console.log(`${keys.length} keyframes, ${sheets.length} sheet(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`read this first: ${rel(indexFile)}`);
}

main().catch((e) => { console.error(`caught-in-4k: ${e.message}`); process.exit(1); });
