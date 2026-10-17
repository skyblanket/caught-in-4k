// caught-in-4k: turn a video into something an agent can look at.
//
// An agent can see images but not video, and every image costs tokens. So we
// don't caption frames with another model (lossy); we pick the frames where the
// picture actually changed, box what changed, pack them into a few labelled
// contact sheets, line the speech up with them, and let the agent zoom into any
// time range for more detail. The agent's own vision does the understanding.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';

const LOW_W = 160;        // width of the greyscale copies used to measure change
const PIX_DELTA = 24;     // grey-level difference that counts as a changed pixel
const CELL = 8;           // change regions are found on an 8x8-pixel cell grid
const STABLE = 0.002;     // a frame has "settled" when <0.2% of pixels move next
const SHEET_W = 1536;     // contact sheets stay under the ~1568px vision limit
const FRAME_MAX = 3840;   // long edge of saved frames (native up to 4K, for sharp detail crops)
const LABEL_H = 30;

// ---------- small helpers ----------

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => { err = (err + d).slice(-4000); });
    p.on('error', (e) => reject(e.code === 'ENOENT' ? new Error(`${cmd} not found on PATH`) : e));
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} failed (${code}): ${err.trim()}`))));
  });
}

function which(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    const f = path.join(dir, cmd);
    if (dir && existsSync(f)) return f;
  }
  return null;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function fmt(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

// ---------- video ----------

async function probe(input) {
  const j = JSON.parse((await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', input])).toString());
  const v = j.streams.find((s) => s.codec_type === 'video');
  if (!v) throw new Error('no video stream in input');
  let [w, h] = [v.width, v.height];
  const rot = Number(v.tags?.rotate ?? v.side_data_list?.find((s) => s.rotation != null)?.rotation ?? 0);
  if (Math.abs(rot) % 180 === 90) [w, h] = [h, w];
  const [n, d] = (v.avg_frame_rate || v.r_frame_rate || '0/1').split('/').map(Number);
  return {
    duration: Number(j.format.duration || v.duration || 0),
    width: w,
    height: h,
    fps: d ? n / d : 0,
    hasAudio: j.streams.some((s) => s.codec_type === 'audio'),
  };
}

const lowH = (info) => Math.max(2, Math.round((LOW_W * info.height) / info.width / 2) * 2);

// One decode pass at low resolution and a few frames per second.
async function sampleLow(input, info) {
  const fps = clamp(800 / Math.max(info.duration, 1), 0.2, 5);
  const h = lowH(info);
  // Long videos are sampled every few seconds, sparser than their keyframes
  // (screen recordings put one about every second), so decoding keyframes only
  // gives the same picture for a fraction of the work.
  const keyOnly = 1 / fps >= 2 ? ['-skip_frame', 'nokey'] : [];
  const buf = await run('ffmpeg', ['-v', 'error', ...keyOnly, '-i', input, '-an',
    '-vf', `fps=${fps.toFixed(4)},scale=${LOW_W}:${h}:flags=area,format=gray`, '-f', 'rawvideo', '-']);
  const size = LOW_W * h;
  const frames = [];
  for (let i = 0; i + size <= buf.length; i += size) frames.push({ t: i / size / fps, px: buf.subarray(i, i + size) });
  return { frames, h, fps };
}

async function grabFrame(input, t, file, info) {
  const scale = info.width >= info.height ? `scale=${Math.min(FRAME_MAX, info.width)}:-2` : `scale=-2:${Math.min(FRAME_MAX, info.height)}`;
  await run('ffmpeg', ['-v', 'error', '-y', '-ss', t.toFixed(3), '-i', input, '-frames:v', '1', '-vf', scale, file]);
}

const lowFromFile = (file, h) => sharp(file).resize(LOW_W, h, { fit: 'fill' }).grayscale().raw().toBuffer();

// ---------- change measurement ----------

function changeFrac(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > PIX_DELTA) n++;
  return n / a.length;
}

// Fraction changed plus up to 3 changed regions (connected cells), largest first.
function changeRegions(a, b, w, h) {
  const cw = Math.ceil(w / CELL);
  const ch = Math.ceil(h / CELL);
  const cells = new Uint16Array(cw * ch);
  let n = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (Math.abs(a[i] - b[i]) > PIX_DELTA) { n++; cells[((y / CELL) | 0) * cw + ((x / CELL) | 0)]++; }
    }
  }
  const seen = new Uint8Array(cw * ch);
  const regions = [];
  for (let c = 0; c < cells.length; c++) {
    if (cells[c] < 2 || seen[c]) continue;
    const stack = [c];
    seen[c] = 1;
    let x0 = cw, y0 = ch, x1 = 0, y1 = 0, px = 0;
    while (stack.length) {
      const k = stack.pop();
      const cx = k % cw;
      const cy = (k / cw) | 0;
      px += cells[k];
      x0 = Math.min(x0, cx); y0 = Math.min(y0, cy); x1 = Math.max(x1, cx); y1 = Math.max(y1, cy);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
          const nk = ny * cw + nx;
          if (!seen[nk] && cells[nk] >= 2) { seen[nk] = 1; stack.push(nk); }
        }
      }
    }
    regions.push({ px, x0: (x0 * CELL) / w, y0: (y0 * CELL) / h, x1: Math.min(1, ((x1 + 1) * CELL) / w), y1: Math.min(1, ((y1 + 1) * CELL) / h) });
  }
  regions.sort((p, q) => q.px - p.px);
  // A moving mouse pointer leaves a few changed pixels at its old and new
  // spots; boxing those points the agent at nothing.
  return { frac: n / a.length, regions: regions.filter((r) => r.px >= 8).slice(0, 3) };
}

function where(r) {
  const cx = (r.x0 + r.x1) / 2;
  const cy = (r.y0 + r.y1) / 2;
  const col = cx < 0.34 ? 'left' : cx > 0.66 ? 'right' : '';
  const row = cy < 0.34 ? 'top' : cy > 0.66 ? 'bottom' : '';
  if (r.x1 - r.x0 > 0.8 && r.y1 - r.y0 > 0.8) return 'whole frame';
  return [row, col].filter(Boolean).join('-') || 'center';
}

// Keep the settled state after each burst of activity: the result of a click,
// not every letter typed on the way. A burst is a run of samples that move
// more than ACTIVE; its result is the first quiet sample after it. Slow drift
// (typing, a progress bar) is kept once it adds up to DRIFT, and continuous
// motion (camera footage) is kept whenever it moves MOTION from the last frame.
// Over budget: drop the smallest changes. Then fill long gaps that changed.
const ACTIVE = 0.0015;
const DRIFT = 0.006;
const MOTION = 0.15;
const MIN_KEEP = 0.0012;

// Near-uniform frames (black fade-ins, blank screens) carry nothing to look at.
function isBlank(px) {
  let sum = 0, sq = 0;
  for (let i = 0; i < px.length; i += 3) { sum += px[i]; sq += px[i] * px[i]; }
  const n = Math.ceil(px.length / 3);
  return sq / n - (sum / n) ** 2 < 16; // std-dev under 4 grey levels
}

function selectKeyframes(allFrames, budget, duration) {
  // Skip blank frames at the start and end (fades), but keep blanks mid-video:
  // a screen going black can be the bug.
  let a = 0, b = allFrames.length - 1;
  while (a < b && isBlank(allFrames[a].px)) a++;
  while (b > a && isBlank(allFrames[b].px)) b--;
  return selectFrom(allFrames.slice(a, b + 1), budget, duration).map((i) => i + a);
}

function selectFrom(frames, budget, duration) {
  const N = frames.length;
  if (N <= 1) return N ? [0] : [];
  const dPrev = frames.map((f, i) => (i ? changeFrac(frames[i - 1].px, f.px) : 0));
  const keep = [0];
  const mag = [Infinity];
  const tryKeep = (i, min) => {
    const d = changeFrac(frames[keep[keep.length - 1]].px, frames[i].px);
    if (d > min && i !== keep[keep.length - 1]) { keep.push(i); mag.push(d); }
  };
  let inBurst = false;
  for (let i = 1; i < N; i++) {
    const active = dPrev[i] > ACTIVE;
    const quietNext = i === N - 1 || dPrev[i + 1] <= Math.max(STABLE, ACTIVE);
    if (active) inBurst = true;
    if (inBurst && !active && quietNext) { tryKeep(i, MIN_KEEP); inBurst = false; continue; }
    if (!active && quietNext) tryKeep(i, DRIFT);
    else if (active) tryKeep(i, MOTION);
  }
  tryKeep(N - 1, MIN_KEEP);
  // Over budget: drop the frame whose removal loses least, weighing its change
  // against the gap it would leave, so big changes win but time stays covered.
  let best = keep;
  let bmag = mag;
  while (best.length > budget && best.length > 2) {
    let kMin = -1, cMin = Infinity;
    for (let k = 1; k < best.length - 1; k++) {
      const c = Math.sqrt(bmag[k]) * (frames[best[k + 1]].t - frames[best[k - 1]].t);
      if (c < cMin) { cMin = c; kMin = k; }
    }
    best = best.filter((_, k) => k !== kMin);
    bmag = bmag.filter((_, k) => k !== kMin);
  }
  const maxGap = Math.max(3, (duration / budget) * 1.5);
  while (best.length < budget) {
    let gi = -1, gap = 0;
    for (let i = 1; i < best.length; i++) {
      const g = frames[best[i]].t - frames[best[i - 1]].t;
      if (g > gap) { gap = g; gi = i; }
    }
    if (gi < 0 || gap <= maxGap) break;
    const mid = Math.round((best[gi - 1] + best[gi]) / 2);
    if (mid === best[gi - 1] || changeFrac(frames[best[gi - 1]].px, frames[mid].px) < 0.001) break;
    best.splice(gi, 0, mid);
  }
  return best;
}

// ---------- flicker ----------

// The keyframe sampler runs at a few fps and keeps settled states, so a flash
// that lasts a frame or two is invisible to it. This pass looks at every frame
// (resampled to 60 fps, tiny greyscale) for a picture that jumps and then
// returns to what it was within a few frames.
const FLICK_W = 64;
const FLICK_MAX_SECONDS = 180;

const meanDiff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length / 255; };

async function detectFlicker(input, info) {
  if (info.duration > FLICK_MAX_SECONDS) return { events: [], h: 0, note: `flicker check skipped (over ${FLICK_MAX_SECONDS}s)` };
  const fps = 60;
  const h = Math.max(2, Math.round((FLICK_W * info.height) / info.width / 2) * 2);
  const buf = await run('ffmpeg', ['-v', 'error', '-i', input, '-an', '-vf', `fps=${fps},scale=${FLICK_W}:${h}:flags=area,format=gray`, '-f', 'rawvideo', '-']);
  const size = FLICK_W * h;
  const fr = [];
  for (let i = 0; i + size <= buf.length; i += size) fr.push(buf.subarray(i, i + size));
  const hits = [];
  for (let j = 1; j < fr.length - 1; j++) {
    const jump = meanDiff(fr[j - 1], fr[j]);
    if (jump < 0.03) continue;
    for (let k = 1; k <= 4 && j + k < fr.length; k++) {
      // Back to (nearly) the frame before the jump, while frame j itself was odd.
      if (meanDiff(fr[j - 1], fr[j + k]) < jump * 0.3 && meanDiff(fr[j], fr[j + k]) > jump * 0.6) {
        hits.push({ t: j / fps, mag: jump, frames: k, before: fr[j - 1], odd: fr[j] });
        break;
      }
    }
  }
  // One event per burst: the strongest flash within 0.4s of the previous one.
  const events = [];
  for (const hit of hits) {
    const last = events[events.length - 1];
    if (last && hit.t - last.lastT < 0.4) { last.count++; last.lastT = hit.t; if (hit.mag > last.mag) Object.assign(last, { t: hit.t, mag: hit.mag, frames: hit.frames, before: hit.before, odd: hit.odd }); }
    else events.push({ ...hit, count: 1, lastT: hit.t });
  }
  events.sort((a, b) => b.mag - a.mag);
  return { events: events.slice(0, 6).sort((a, b) => a.t - b.t), h, note: hits.length ? `${hits.length} flash frame(s) in ${events.length} burst(s)` : 'no flicker found' };
}

// ---------- detail crops ----------

// On a large screen, a 512px overview tile shrinks UI text past reading. For
// keyframes whose change is localized, cut the changed area (with some
// context) out of the native-resolution frame, so the agent sees it sharp.
const DETAIL_MIN_WIDTH = 1600;
const DETAIL_MAX = 6;

function cropBox(regions, info) {
  const x0 = Math.min(...regions.map((r) => r.x0)), y0 = Math.min(...regions.map((r) => r.y0));
  const x1 = Math.max(...regions.map((r) => r.x1)), y1 = Math.max(...regions.map((r) => r.y1));
  const aspect = info.width / info.height;
  let w = clamp((x1 - x0) * 1.6 + 0.04, 0.28, 1);
  let h = clamp((y1 - y0) * 1.6 + 0.04, 0.28 * Math.min(aspect, 2), 1);
  const cx = clamp((x0 + x1) / 2, w / 2, 1 - w / 2);
  const cy = clamp((y0 + y1) / 2, h / 2, 1 - h / 2);
  return { left: Math.round((cx - w / 2) * info.width), top: Math.round((cy - h / 2) * info.height), width: Math.round(w * info.width), height: Math.round(h * info.height) };
}

async function makeDetailSheet(details, outDir) {
  const cols = 2, tw = SHEET_W / cols, th = 470;
  const rows = Math.ceil(details.length / cols);
  const W = SHEET_W, H = rows * (th + LABEL_H);
  const composites = await Promise.all(details.map(async (d, i) => ({
    input: await sharp(d.file).resize(tw - 4, th, { fit: 'contain', background: '#000' }).toBuffer(),
    left: (i % cols) * tw + 2,
    top: Math.floor(i / cols) * (th + LABEL_H) + LABEL_H,
  })));
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`;
  details.forEach((d, i) => {
    const x = (i % cols) * tw, y = Math.floor(i / cols) * (th + LABEL_H);
    svg += `<rect x="${x}" y="${y}" width="${tw}" height="${LABEL_H}" fill="#111"/>`;
    svg += `<text x="${x + 10}" y="${y + 21}" font-family="Menlo, Monaco, monospace" font-size="17" fill="#fff">${d.label}</text>`;
  });
  svg += '</svg>';
  const file = path.join(outDir, 'details-1.png');
  await sharp({ create: { width: W, height: H, channels: 3, background: '#000' } })
    .composite([...composites, { input: Buffer.from(svg), left: 0, top: 0 }])
    .png({ compressionLevel: 9 })
    .toFile(file);
  return file;
}

// ---------- drawing ----------

// A box around most of the frame (an app switch, a cut) says nothing about
// where to look, so those tiles get no boxes.
const pointsSomewhere = (regions) => regions.every((r) => (r.x1 - r.x0) * (r.y1 - r.y0) < 0.4);

function boxesSvg(regions, x, y, w, h, stroke) {
  if (!pointsSomewhere(regions)) return '';
  return regions.map((r) => {
    const bx = x + r.x0 * w - 3;
    const by = y + r.y0 * h - 3;
    return `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${((r.x1 - r.x0) * w + 6).toFixed(1)}" height="${((r.y1 - r.y0) * h + 6).toFixed(1)}" fill="none" stroke="#ff2d2d" stroke-width="${stroke}"/>`;
  }).join('');
}

// tiles: [{ file, label, regions }]
async function makeSheets(tiles, info, outDir, prefix) {
  const aspect = info.width / info.height;
  const cols = aspect >= 1 ? 3 : 5;
  const tw = Math.floor(SHEET_W / cols);
  const th = Math.round(tw / aspect);
  const rows = Math.max(1, Math.floor(1560 / (th + LABEL_H)));
  const per = cols * rows;
  const sheets = [];
  for (let s = 0; s * per < tiles.length; s++) {
    const group = tiles.slice(s * per, (s + 1) * per);
    const usedRows = Math.ceil(group.length / cols);
    const W = cols * tw;
    const H = usedRows * (th + LABEL_H);
    const composites = await Promise.all(group.map(async (tile, i) => ({
      input: await sharp(tile.file).resize(tw - 4, th, { fit: 'contain', background: '#000' }).toBuffer(),
      left: (i % cols) * tw + 2,
      top: Math.floor(i / cols) * (th + LABEL_H) + LABEL_H,
    })));
    let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`;
    group.forEach((tile, i) => {
      const x = (i % cols) * tw;
      const y = Math.floor(i / cols) * (th + LABEL_H);
      svg += `<rect x="${x}" y="${y}" width="${tw}" height="${LABEL_H}" fill="#111"/>`;
      svg += `<text x="${x + 10}" y="${y + 21}" font-family="Menlo, Monaco, monospace" font-size="17" fill="#fff">${tile.label}</text>`;
      svg += boxesSvg(tile.regions || [], x + 2, y + LABEL_H, tw - 4, th, 3);
    });
    svg += '</svg>';
    const file = path.join(outDir, `${prefix}-${s + 1}.png`);
    await sharp({ create: { width: W, height: H, channels: 3, background: '#000' } })
      .composite([...composites, { input: Buffer.from(svg), left: 0, top: 0 }])
      .png({ compressionLevel: 9, palette: false })
      .toFile(file);
    sheets.push({ file, from: group[0], to: group[group.length - 1] });
  }
  return sheets;
}

// ---------- speech ----------

function findWhisperModel() {
  if (process.env.CAUGHT_WHISPER_MODEL) return process.env.CAUGHT_WHISPER_MODEL;
  const dirs = [
    path.join(os.homedir(), '.cache', 'caught-in-4k'),
    path.join(os.homedir(), '.cache', 'whisper'),
    path.join(os.homedir(), '.cache', 'hyperframes', 'whisper', 'models'),
    '/opt/homebrew/share/whisper-cpp',
    '/usr/local/share/whisper-cpp',
  ];
  const rank = (f) => ['small', 'base', 'medium', 'large', 'tiny'].findIndex((k) => f.includes(k));
  for (const d of dirs) {
    if (!existsSync(d)) continue;
    const models = readdirSync(d).filter((f) => /^ggml-.*\.bin$/.test(f) && !f.includes('for-tests')).sort((a, b) => rank(a) - rank(b));
    if (models.length) return path.join(d, models[0]);
  }
  return null;
}

async function transcribe(input, outDir) {
  const cli = which('whisper-cli') || which('whisper-cpp');
  const model = findWhisperModel();
  if (!cli || !model) return { segments: [], note: 'not transcribed: install whisper.cpp (brew install whisper-cpp) and a ggml model, or set CAUGHT_WHISPER_MODEL' };
  const wav = path.join(outDir, 'audio.wav');
  await run('ffmpeg', ['-v', 'error', '-y', '-i', input, '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
  const base = path.join(outDir, 'transcript');
  const lang = path.basename(model).includes('.en') ? 'en' : 'auto';
  // Word-level timing (-ml 1 -sow), regrouped into short phrases, so speech
  // lands on the frames it belongs to instead of one 10-second segment.
  await run(cli, ['-m', model, '-f', wav, '-oj', '-of', base, '-np', '-l', lang, '-ml', '1', '-sow']);
  const j = JSON.parse(await fs.readFile(`${base}.json`, 'utf8'));
  await fs.rm(wav, { force: true });
  const words = (j.transcription || [])
    .map((s) => ({ from: s.offsets.from / 1000, to: s.offsets.to / 1000, text: s.text }))
    .filter((w) => w.text.trim() && !/^\s*[[(].*[\])]\s*$/.test(w.text));
  const segments = [];
  for (const w of words) {
    const cur = segments[segments.length - 1];
    const startNew = !cur || w.from - cur.to > 0.6 || /[.?!]$/.test(cur.text) || cur.text.split(' ').length >= 14;
    if (startNew) segments.push({ from: w.from, to: w.to, text: w.text.trim() });
    else { cur.to = w.to; cur.text += /^[\s]/.test(w.text) ? w.text : w.text.trim(); }
  }
  segments.forEach((s) => { s.text = s.text.replace(/\s+/g, ' ').trim(); });
  return { segments, note: `transcribed with ${path.basename(model)}` };
}

// ---------- commands ----------

function outDirFor(input, opt) {
  if (opt.out) return path.resolve(opt.out);
  const name = path.basename(input).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') || 'video';
  return path.resolve('.caught-in-4k', name);
}

async function resolveInput(input, opt) {
  if (!/^https?:\/\//i.test(input)) {
    if (!existsSync(input)) throw new Error(`file not found: ${input}`);
    return input;
  }
  if (!which('yt-dlp')) throw new Error('URL input needs yt-dlp on PATH (brew install yt-dlp), or download the video first');
  const dir = opt.out ? path.resolve(opt.out) : path.resolve('.caught-in-4k', 'downloads');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, 'source.%(ext)s');
  await run('yt-dlp', ['-q', '--no-playlist', '-f', 'bv*[height<=720]+ba/b[height<=720]/b', '--merge-output-format', 'mp4', '-o', file, input]);
  const got = readdirSync(dir).find((f) => f.startsWith('source.'));
  if (!got) throw new Error('yt-dlp did not produce a file');
  return path.join(dir, got);
}

async function watch(inputArg, opt) {
  const input = await resolveInput(inputArg, opt);
  const info = await probe(input);
  const outDir = outDirFor(inputArg.startsWith('http') ? 'url-video' : input, opt);
  // Only ever clear a folder caught-in-4k made itself (it has index.json); never
  // wipe a non-empty folder someone pointed --out at by mistake.
  if (existsSync(outDir)) {
    const entries = readdirSync(outDir);
    if (entries.includes('index.json')) {
      await fs.rm(path.join(outDir, 'frames'), { recursive: true, force: true });
      await fs.rm(path.join(outDir, 'details'), { recursive: true, force: true });
      for (const f of entries) if (/^(sheet-\d+\.png|details-\d+\.png|index\.(md|json)|transcript\.json)$/.test(f)) await fs.rm(path.join(outDir, f), { force: true });
    } else if (entries.some((f) => !/^(source\.|downloads$)/.test(f))) {
      throw new Error(`output folder is not empty and wasn't made by caught-in-4k: ${outDir}`);
    }
  }
  await fs.mkdir(path.join(outDir, 'frames'), { recursive: true });

  const budget = clamp(Number(opt.max) || Math.round(12 + (info.duration / 60) * 0.8), 2, opt.max ? 200 : 60);
  const speech = info.hasAudio && !opt['no-audio'] ? transcribe(input, outDir).catch((e) => ({ segments: [], note: `transcription failed: ${e.message}` })) : Promise.resolve({ segments: [], note: info.hasAudio ? 'audio skipped (--no-audio)' : 'no audio track' });

  const [low, flick] = await Promise.all([sampleLow(input, info), detectFlicker(input, info)]);
  const idx = selectKeyframes(low.frames, budget, info.duration);
  const keys = idx.map((i, n) => {
    const prev = n ? low.frames[idx[n - 1]] : null;
    const ch = prev ? changeRegions(prev.px, low.frames[i].px, LOW_W, low.h) : { frac: 1, regions: [] };
    return { t: low.frames[i].t, frac: ch.frac, regions: ch.regions };
  });
  // Flashes become keyframes of their own: the odd frame, boxed where it differs.
  for (const e of flick.events) {
    const ch = changeRegions(e.before, e.odd, FLICK_W, flick.h);
    keys.push({ t: e.t, frac: ch.frac, regions: ch.regions, flicker: e });
  }
  keys.sort((a, b) => a.t - b.t);
  keys.forEach((k, i) => { k.n = i + 1; });
  await pool(keys, 4, (k) => {
    k.file = path.join(outDir, 'frames', `${String(k.n).padStart(2, '0')}.png`);
    return grabFrame(input, k.t, k.file, info);
  });
  const label = (k) => `#${k.n}  ${fmt(k.t)}${k.flicker ? '  FLICKER' : ''}`;
  const sheets = await makeSheets(keys.map((k) => ({ file: k.file, label: label(k), regions: k.regions })), info, outDir, 'sheet');

  // Detail crops for large screens: flashes first, then the biggest localized changes.
  let detailsFile = null;
  const details = [];
  if (info.width >= DETAIL_MIN_WIDTH) {
    // One crop per changed region (the two biggest per frame): a union of a
    // sidebar change and a panel change would just be the whole screen again.
    const cands = keys.filter((k) => k.n > 1 && k.regions.length && pointsSomewhere(k.regions))
      .flatMap((k) => k.regions.slice(0, 2).map((r, ri) => ({ k, r, ri })))
      .sort((a, b) => (b.k.flicker ? 1 : 0) - (a.k.flicker ? 1 : 0) || b.r.px - a.r.px)
      .slice(0, DETAIL_MAX)
      .sort((a, b) => a.k.t - b.k.t || a.ri - b.ri);
    if (cands.length) {
      await fs.mkdir(path.join(outDir, 'details'), { recursive: true });
      for (const { k, r, ri } of cands) {
        const meta = await sharp(k.file).metadata();
        const box = cropBox([r], { width: meta.width, height: meta.height });
        const file = path.join(outDir, 'details', `${String(k.n).padStart(2, '0')}-${ri + 1}.png`);
        await sharp(k.file).extract(box).toFile(file);
        details.push({ file, label: `#${k.n}  ${fmt(k.t)}  detail: ${where(r)}`, k });
      }
      detailsFile = await makeDetailSheet(details, outDir);
    }
  }
  const { segments, note } = await speech;
  segments.forEach((s) => { s.to = Math.min(s.to, info.duration); });
  keys.forEach((k, i) => {
    const end = i + 1 < keys.length ? keys[i + 1].t : info.duration + 1;
    // Each phrase goes to the keyframe interval it starts in, so it appears once.
    const start = i ? k.t : -1;
    k.speech = segments.filter((s) => s.from >= start && s.from < end).map((s) => s.text).join(' ');
  });

  const rel = (f) => path.relative(outDir, f);
  const q = (s) => (/\s/.test(s) ? `"${s}"` : s);
  const md = [];
  md.push(`# caught-in-4k: ${path.basename(input)}`, '');
  md.push(`${fmt(info.duration)} long · ${info.width}×${info.height} · ${info.fps.toFixed(0)} fps · audio: ${note}`, '');
  md.push(`${keys.length} keyframes, chosen from ${low.frames.length} samples where the picture changed and settled.`, '');
  md.push('## How to read this', '');
  md.push('1. Look at the overview sheets first. Each tile is one keyframe, labelled `#n time`. Red boxes mark what changed since the previous keyframe.');
  md.push('2. Read the timeline: what changed where, and what was said around it.');
  md.push(`3. Something happens too fast or too small? Zoom with the \`zoom_video\` tool, or \`npx caught-in-4k zoom ${q(inputArg)} --from <time> --to <time>\` (seconds or m:ss).`);
  md.push('4. Full-resolution keyframes are in `frames/NN.png`.', '');
  if (flick.events.length) {
    md.push('## Flicker', '');
    md.push(`The picture flashed and snapped back (${flick.note}). Tiles marked FLICKER show the flash frame itself:`);
    for (const k of keys.filter((x) => x.flicker)) md.push(`- #${k.n} at ${fmt(k.t)}: lasted ${k.flicker.frames} frame(s) at 60 fps, ${k.flicker.count} flash(es) in this burst, ${k.regions.map(where).join(', ') || 'scattered'}`);
    md.push('');
  }
  md.push('## Overview sheets', '');
  for (const s of sheets) md.push(`- \`${rel(s.file)}\`: ${s.from.label.trim()} to ${s.to.label.trim()}`);
  if (detailsFile) {
    md.push('', '## Detail crops', '');
    md.push(`\`${rel(detailsFile)}\`: the changed areas cut from the full-resolution frames, so small UI text is readable: ${details.map((d) => `#${d.k.n}`).join(', ')}.`);
  }
  md.push('', '## Timeline', '', '| # | time | changed | where | speech |', '|---|---|---|---|---|');
  for (const k of keys) {
    const changed = k.n === 1 ? 'first frame' : k.flicker ? `FLICKER ${(k.frac * 100).toFixed(1)}%` : `${(k.frac * 100).toFixed(1)}%`;
    const wh = k.regions.map(where).join(', ') || (k.n === 1 ? '' : 'scattered');
    md.push(`| ${k.n} | ${fmt(k.t)} | ${changed} | ${wh} | ${k.speech.replace(/\|/g, '/')} |`);
  }
  if (segments.length) {
    md.push('', '## Transcript', '');
    for (const s of segments) md.push(`- [${fmt(s.from)}–${fmt(s.to)}] ${s.text}`);
  }
  md.push('');
  const indexFile = path.join(outDir, 'index.md');
  const markdown = md.join('\n');
  await fs.writeFile(indexFile, markdown);
  await fs.writeFile(path.join(outDir, 'index.json'), JSON.stringify({
    input, info, transcription: note,
    keyframes: keys.map((k) => ({ n: k.n, t: +k.t.toFixed(3), changed: +k.frac.toFixed(4), flicker: k.flicker ? { frames: k.flicker.frames, count: k.flicker.count } : undefined, regions: k.regions.map((r) => ({ where: where(r), x0: +r.x0.toFixed(3), y0: +r.y0.toFixed(3), x1: +r.x1.toFixed(3), y1: +r.y1.toFixed(3) })), frame: rel(k.file), speech: k.speech })),
    sheets: sheets.map((s) => rel(s.file)),
    details: detailsFile ? rel(detailsFile) : null,
    flicker: flick.note,
    transcript: segments,
  }, null, 2));
  return { indexFile, markdown, outDir, sheets, details: detailsFile, keys };
}

// Accepts 75, 75.5, 1:15, 1:15.5 or 0:01:15.
function parseTime(v) {
  if (v == null || v === true) return NaN;
  return String(v).split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

async function zoom(inputArg, opt) {
  const input = await resolveInput(inputArg, opt);
  const info = await probe(input);
  const from = clamp(parseTime(opt.from) || 0, 0, info.duration);
  const toArg = parseTime(opt.to);
  const to = clamp(Number.isNaN(toArg) ? from + 3 : toArg, from, info.duration);
  // count 1 means "this exact moment at full resolution", for reading small text.
  const count = clamp(Number(opt.count) || 9, 1, 16);
  const outDir = outDirFor(inputArg.startsWith('http') ? 'url-video' : input, opt);
  const tag = count === 1 ? `frame-${from.toFixed(1)}` : `zoom-${from.toFixed(1)}-${to.toFixed(1)}`;
  const dir = path.join(outDir, tag);
  await fs.mkdir(dir, { recursive: true });
  const span = Math.max(to - from, 0.001);
  const last = Math.max(0, info.duration - 0.05);
  const times = count === 1 ? [Math.min(from, last)] : Array.from({ length: count }, (_, i) => Math.min(from + (span * i) / (count - 1), last));
  const files = await pool(times, 4, async (t, i) => {
    const f = path.join(dir, `${String(i + 1).padStart(2, '0')}.png`);
    await grabFrame(input, t, f, info);
    return f;
  });
  if (count === 1) return { sheets: [{ file: files[0] }], dir, times };
  const h = lowH(info);
  const lows = await Promise.all(files.map((f) => lowFromFile(f, h)));
  const tiles = files.map((f, i) => ({
    file: f,
    label: `${fmt(times[i])}`,
    regions: i ? changeRegions(lows[i - 1], lows[i], LOW_W, h).regions : [],
  }));
  const sheets = await makeSheets(tiles, info, outDir, tag);
  return { sheets, dir, times };
}

function checkTools() {
  if (!which('ffmpeg') || !which('ffprobe')) throw new Error('ffmpeg and ffprobe are required (brew install ffmpeg, or apt install ffmpeg)');
}

export { watch, zoom, parseTime, fmt, checkTools };
