// Starts `caught-in-4k mcp` over stdio like an agent would, lists the tools, calls
// both, and saves the returned images to .caught-in-4k/mcp-smoke/ for a look.
// Usage: node test/mcp-smoke.mjs [video] [command...]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const video = path.resolve(process.argv[2] || path.join(here, 'demo-bug.mp4'));
const [command, ...args] = process.argv.length > 3 ? process.argv.slice(3) : ['node', path.join(here, '..', 'bin', 'caught-in-4k.mjs'), 'mcp'];
const out = path.resolve('.caught-in-4k', 'mcp-smoke');
await fs.mkdir(out, { recursive: true });

const client = new Client({ name: 'caught-in-4k-smoke', version: '0.0.0' });
await client.connect(new StdioClientTransport({ command, args }));

const { tools } = await client.listTools();
console.log('tools:', tools.map((t) => t.name).join(', '));

async function call(name, args, tag) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const imgs = r.content.filter((c) => c.type === 'image');
  const text = r.content.find((c) => c.type === 'text')?.text ?? '';
  for (const [i, c] of imgs.entries()) await fs.writeFile(path.join(out, `${tag}-${i + 1}.jpg`), Buffer.from(c.data, 'base64'));
  const kb = imgs.map((c) => Math.round((c.data.length * 3) / 4 / 1024));
  console.log(`${name}: ${r.isError ? 'ERROR ' : ''}${imgs.length} image(s) [${kb.join(', ')} KB], ${text.length} chars text, ${Date.now() - t0}ms`);
  return text;
}

const md = await call('watch_video', { path: video }, 'watch');
console.log(md.split('\n').filter((l) => /^\| \d/.test(l)).slice(0, 3).join('\n'));
await call('zoom_video', { path: video, from: '0:13.8', to: 15, count: 6 }, 'zoom');
await call('zoom_video', { path: video, from: 14.8, count: 1 }, 'frame');
console.log((await call('watch_video', { path: '/nope.mp4' }, 'err')).slice(0, 80));
await client.close();
