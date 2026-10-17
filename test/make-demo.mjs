// Renders a fake screen recording of a bug: in a todo app, deleting the first
// task removes the second one. Narrated with macOS `say`. Output: test/demo-bug.mp4
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const W = 1280, H = 720, FPS = 15, DUR = 21;
const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'caught-in-4k-demo-'));

const run = (cmd, args) => new Promise((res, rej) => {
  const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let e = ''; p.stderr.on('data', (d) => { e += d; });
  p.on('close', (c) => (c ? rej(new Error(`${cmd}: ${e}`)) : res()));
});

const tasks = [
  { text: 'Buy milk', typeAt: 3.0, addAt: 4.4 },
  { text: 'Call mom', typeAt: 5.6, addAt: 7.0 },
  { text: 'Fix bike', typeAt: 8.2, addAt: 9.6 },
];
const CLICK_DELETE = 14.5;
const ADD_BTN = { x: 905, y: 205 };
const INPUT = { x: 560, y: 205 };
const rowY = (i) => 290 + i * 70;
const DEL_X = 925;

const lerp = (a, b, k) => a + (b - a) * Math.min(1, Math.max(0, k));
const ease = (k) => (k < 0 ? 0 : k > 1 ? 1 : k * k * (3 - 2 * k));

// Cursor path: list of [time, x, y]; moves are eased between waypoints.
const way = [[0, 700, 600], [2.4, 700, 600], [2.9, INPUT.x, INPUT.y]];
for (const t of tasks) way.push([t.addAt - 0.4, INPUT.x, INPUT.y], [t.addAt - 0.05, ADD_BTN.x, ADD_BTN.y], [t.addAt + 0.6, ADD_BTN.x, ADD_BTN.y], [t.addAt + 1.0, INPUT.x, INPUT.y]);
way.push([12.6, INPUT.x, INPUT.y], [14.2, DEL_X, rowY(0)], [DUR, DEL_X, rowY(0)]);
way.sort((a, b) => a[0] - b[0]);
function cursor(t) {
  for (let i = 1; i < way.length; i++) {
    const [t0, x0, y0] = way[i - 1], [t1, x1, y1] = way[i];
    if (t <= t1) { const k = ease((t - t0) / Math.max(t1 - t0, 1e-6)); return [lerp(x0, x1, k), lerp(y0, y1, k)]; }
  }
  return way[way.length - 1].slice(1);
}

function frame(t) {
  const added = tasks.filter((x) => t >= x.addAt).map((x) => x.text);
  let list = added;
  if (t >= CLICK_DELETE) list = added.filter((x) => x !== 'Call mom'); // the bug: wrong row removed
  const typing = tasks.find((x) => t >= x.typeAt && t < x.addAt);
  const typed = typing ? typing.text.slice(0, Math.floor((t - typing.typeAt) * 9)) : '';
  const [cx, cy] = cursor(t);
  const clickFlash = [...tasks.map((x) => x.addAt), CLICK_DELETE].some((c) => t >= c && t < c + 0.2);
  const hoverRow = t > 14.0 && t < CLICK_DELETE ? 0 : -1;
  const toast = t >= CLICK_DELETE && t < CLICK_DELETE + 2.5;

  let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
  <rect width="100%" height="100%" fill="#eef1f5"/>
  <rect x="0" y="0" width="${W}" height="44" fill="#dfe3ea"/>
  <circle cx="24" cy="22" r="7" fill="#ff5f57"/><circle cx="46" cy="22" r="7" fill="#febc2e"/><circle cx="68" cy="22" r="7" fill="#28c840"/>
  <rect x="380" y="10" width="520" height="24" rx="6" fill="#fff"/>
  <text x="400" y="27" font-family="Helvetica" font-size="14" fill="#555">localhost:5173/tasks</text>
  <rect x="290" y="80" width="700" height="580" rx="16" fill="#fff" stroke="#d6dbe3"/>
  <text x="330" y="140" font-family="Helvetica" font-weight="bold" font-size="34" fill="#1d2433">Tasks</text>
  <rect x="330" y="180" width="500" height="50" rx="8" fill="#f7f8fa" stroke="${typing ? '#4c7cf0' : '#cfd5de'}" stroke-width="2"/>
  <text x="348" y="213" font-family="Helvetica" font-size="20" fill="${typed ? '#1d2433' : '#9aa3b2'}">${typed || 'What needs doing?'}</text>
  <rect x="845" y="180" width="120" height="50" rx="8" fill="#4c7cf0"/>
  <text x="881" y="212" font-family="Helvetica" font-weight="bold" font-size="19" fill="#fff">Add</text>`;
  list.forEach((txt, i) => {
    const y = rowY(i);
    s += `<rect x="330" y="${y - 28}" width="635" height="56" rx="8" fill="${i === hoverRow ? '#fdecec' : '#f7f8fa'}"/>
    <rect x="348" y="${y - 11}" width="22" height="22" rx="5" fill="#fff" stroke="#b9c1cd" stroke-width="2"/>
    <text x="388" y="${y + 7}" font-family="Helvetica" font-size="21" fill="#1d2433">${txt}</text>
    <text x="${DEL_X - 9}" y="${y + 8}" font-family="Helvetica" font-size="24" fill="${i === hoverRow ? '#d93025' : '#9aa3b2'}">✕</text>`;
  });
  s += `<text x="330" y="630" font-family="Helvetica" font-size="17" fill="#6b7383">${list.length} task${list.length === 1 ? '' : 's'}</text>`;
  if (toast) s += `<rect x="1010" y="70" width="240" height="54" rx="10" fill="#1d2433"/><text x="1032" y="104" font-family="Helvetica" font-size="18" fill="#fff">Task deleted</text>`;
  if (clickFlash) s += `<circle cx="${cx}" cy="${cy}" r="16" fill="#4c7cf0" fill-opacity="0.35"/>`;
  s += `<path d="M${cx},${cy} l0,22 l6,-6 l5,11 l4,-2 l-5,-11 l8,0 z" fill="#000" stroke="#fff" stroke-width="1.5"/></svg>`;
  return s;
}

const n = DUR * FPS;
for (let i = 0; i < n; i += 8) {
  await Promise.all(Array.from({ length: Math.min(8, n - i) }, (_, k) =>
    sharp(Buffer.from(frame((i + k) / FPS))).png().toFile(path.join(tmp, `f${String(i + k).padStart(4, '0')}.png`))));
}

const lines = [
  [0.4, "Here's my to-do app. I'll add a few tasks."],
  [11.0, "Now I'll delete the first one, buy milk."],
  [15.4, 'See? It deleted call mom instead. The wrong task gets removed.'],
];
const clips = [];
for (const [i, [, text]] of lines.entries()) {
  const f = path.join(tmp, `l${i}.aiff`);
  await run('say', ['-o', f, text]);
  clips.push(f);
}
const delays = lines.map(([t], i) => `[${i + 1}:a]adelay=${Math.round(t * 1000)}|${Math.round(t * 1000)}[a${i}]`).join(';');
const mix = `${delays};${lines.map((_, i) => `[a${i}]`).join('')}amix=inputs=${lines.length}:normalize=0,apad[aout]`;
const out = path.join(here, 'demo-bug.mp4');
await run('ffmpeg', ['-y', '-v', 'error', '-framerate', String(FPS), '-i', path.join(tmp, 'f%04d.png'), ...clips.flatMap((c) => ['-i', c]),
  '-filter_complex', mix, '-map', '0:v', '-map', '[aout]', '-t', String(DUR), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-r', '30', '-c:a', 'aac', out]);
await fs.rm(tmp, { recursive: true, force: true });
console.log(out);
