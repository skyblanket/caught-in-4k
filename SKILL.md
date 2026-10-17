---
name: caught-in-4k
description: Watch a video. Use whenever the user shares or mentions a video file or video URL (screen recording, Loom, bug repro, demo, tutorial, YouTube, .mp4/.mov/.webm) and wants you to understand, debug, copy or act on what it shows. You cannot take video directly; this turns it into a few labelled images plus a timed transcript you can read.
---

# caught-in-4k: watch a video

You can see images, not video. `caught-in-4k` picks the frames where the picture
changed, boxes what changed in red, packs them into a few labelled overview
sheets, and lines the speech up with them.

If you have the `watch_video` and `zoom_video` tools (the caught-in-4k MCP server),
use them: same steps, and the images come back in the result. Otherwise use the
CLI below.

## 1. Watch

```bash
npx -y caught-in-4k <path-or-url>
```

It prints the path of `index.md` (in `.caught-in-4k/<name>/`). Read that file, then
open every overview sheet it lists. Each tile is `#n time`. Red boxes are what
changed since the previous tile: look there first.

## 2. Zoom when a moment matters

The overview skips fast or tiny changes on purpose. When something important
happens between two tiles (a click, an error flashing, an animation), zoom:

```bash
npx -y caught-in-4k zoom <path-or-url> --from 12.0 --to 15.0 --count 9
```

Then open the zoom sheet it prints. Zoom again, narrower, until you can see it.
Full-resolution frames are in `frames/` and in each `zoom-*/` folder when you
need to read small text.

## 3. Answer from evidence

- Refer to moments by time (`at 0:14.5 the second row disappears`).
- Say what you saw versus what was said. The transcript is speech-to-text and
  can be wrong; the frames are ground truth.
- If you didn't zoom into a moment, don't claim detail about it.

## Options

- `--max 40` more or fewer keyframes (default grows with length: 12 plus about 0.8 per minute, up to 60)
- `--no-audio` skip transcription
- URLs need `yt-dlp`; speech needs `whisper-cli` (whisper.cpp) and a ggml model,
  or set `CAUGHT_WHISPER_MODEL=/path/to/ggml-*.bin`. Frames work without either.

## Install this skill

Copy this file to `~/.claude/skills/caught-in-4k/SKILL.md` (Claude Code),
`~/.codex/skills/caught-in-4k/SKILL.md` (Codex) or your agent's skills folder.
