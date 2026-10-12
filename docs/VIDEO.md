# Video in Nordle

A video post is a document with `kind: "video"`. Nordle draws it to an mp4 with the ffmpeg that is already on the computer
(never bundled) and the same HTML renderer as every other post (for titles, shapes and captions). No Remotion.

```
node nordle.mjs video check   <doc>                      problems in the cut, instantly, nothing drawn
node nordle.mjs video stills  <doc> --at 1.5,3.0         real frames (footage + titles + captions) at those seconds
node nordle.mjs video sheet   <doc>                      a few frames per scene + the words said in it  -> out/<doc>/sheet.png
node nordle.mjs video render  <doc> [--preview] [--from 2 --to 10] [--format mp4|webm|gif|prores]   -> out/<doc>/<doc>.<ext>, <doc>-cover.jpg, sheet.png
node nordle.mjs video probe   <file | mount:name/path>   what is really inside a media file
node nordle.mjs video proxy   <doc> [--source id] [--force]   small copies of the footage that a browser can play and scrub
```

`--preview` is 540x960 at half the frame rate (several times faster; written as `<doc>.preview.mp4`). `--from/--to` render part of
the timeline. MCP tools: `nordle_render_video` (starts a job; `format` picks the kind of file) / `nordle_video_status` (waits for news),
`nordle_video_stills`, `nordle_video_sheet`, `nordle_video_check`, `nordle_probe_media`. Routes: `/api/projects/<p>/video/...` (render,
formats, jobs, stills, sheet, check, probe, mounts, ls, image, proxy, waveform, outputs). Finished files are served from `out/` with Range support,
so a `<video>` can seek.

## Export formats

`format` is `mp4` (the default), `webm`, `gif` or `prores`. The file is `out/<doc>/<doc>.<ext>` (`mp4`, `webm`, `gif`, `mov`); a preview or
a part of the timeline keeps its name with the extension of its format (`<doc>.preview.webm`, `<doc>.2.0-5.0s.gif`). The finished job
says `format` and `file` as well as `files`.

| format | made of | notes |
|---|---|---|
| `mp4` | H.264 (crf 18) + AAC 192k | what the platforms take; faststart |
| `webm` | VP9 (crf 31) + Opus 128k | for the web; the Opus pre-skip leaves the audio stream starting 7 ms early in the container, which players apply: the sound still lands with the picture |
| `gif` | palettegen/paletteuse, 15 fps, 256 colours, no sound | at most 30 s (a plain message says so, before any work; use `--from/--to` for a part), at most 540 px wide by default (`--max-width`, route `maxWidth`, tool `max_width`; never enlarged). No cover or contact sheet (take one with `video sheet`) |
| `prores` | ProRes 422 HQ (`prores_ks` profile 3, 10-bit 4:2:2) + 16-bit PCM, in a `.mov` | for editing in Resolve or Premiere; large files |

The sound is the same separate -14 LUFS WAV in every format that has sound, joined by ffmpeg in the last pass, so picture and sound start
together (tested for mp4, webm and ProRes: the beep starts with the flash to within a millisecond, limit 12 ms). ffmpeg is never bundled, so
what can be made depends on the installed build: the encoders are listed once (`ffmpeg -encoders`) and a missing one gives a plain message
naming it (and the route `GET video/formats` says which formats are available). mp4 needs only `libx264` and `aac`, webm `libvpx-vp9` and
`libopus`, ProRes `prores_ks` and `pcm_s16le`, GIF `gif`; the "essentials" builds of ffmpeg have all of them.

## Proxies and waveforms (for the timeline in the browser)

A 4K All-Intra camera file cannot be played in a page, and footage on a mount is not served at all. `video proxy` (or the route) makes a small
copy that can: H.264, about 540 px on the short side (never enlarged), a keyframe at least every half second, AAC 96k, faststart, in
`<project>/.proxies/<sha1 of source path + mtime + size>.mp4`. The footage itself is only read. **A time in the proxy is the same time in the
source**: the frame rate and timestamps are not changed (a proxy is within one frame of the source's length). The name changes when the source
file does, so a stale proxy is never used; the new one is made on the next ask and the old one (with its note and waveform) is deleted when it
is done. It is written to a `.part` file and renamed when complete. At most two proxies are made at once; the rest wait. Renders always read
the original, never the proxy. Pictures need no proxy; music and other sound-only files get a sound-only mp4.

Routes (all under `/api/projects/<p>/video/`, same token rules as the others):

- `POST proxy {doc?, source}`: `source` is a source id in `doc`, or a path (a project path or `mount:name/path`). Already made: `200
  {ready:true, progress:100, key, url}`. Otherwise a job (kind `proxy`) starts: `202 {ready:false, progress, key, job}`; poll `jobs/<id>?wait=`
  (it ends `done` with `result.url`) or `GET proxy`. Asking twice shares one job.
- `GET proxy?doc=&source=` -> `{ready, progress (0 to 100), url?, error?, job?}`; `error` is why the last attempt failed. `GET jobs?kind=proxy`
  lists proxy jobs; `POST jobs/<id>/cancel` stops one.
- The `url` (`/p/<project>/.proxies/<40 hex>.mp4`) is served with Range support and the usual sandbox headers. Only that name pattern is
  served from `.proxies`: not the notes, waveforms or half-made files beside it, nothing else, and still never `history/` or `review/`.
  Paths that leave the project or the mount (`..`, drive letters, backslashes, links out) are refused with a 422.
- `GET waveform?doc=&source=&per=0.05` -> `{duration, per, peaks:[0..1], hasAudio, speech?}`. `peaks[i]` is the loudest sample (3 decimals) in
  `[i*per, (i+1)*per)` seconds of the source's own time. The sound is decoded once by ffmpeg to mono 8 kHz and reduced while it streams in (a
  long source is never held in memory); it is read from the proxy when there is a fresh one (far less to read than camera footage). There are
  at most 20000 peaks: a longer source gets a larger `per` than asked for (the answer says which). The cache `<hash>.peaks.json` is kept at the
  finest step that fits (0.01 s up to 200 s) and any `per` that is a multiple of it is answered exactly. `speech: [{start,end}]` appears only
  when the source has a transcript: the stretches its words cover, gaps under 0.35 s closed up (an unreadable transcript leaves `speech`
  out and says why in `transcriptProblem`). A source with no sound answers `hasAudio:false, peaks:[]`.

## Footage stays where it is: mounts

Never copy footage into a project. `<project>/nordle.local.json` (machine-only, not shared) maps a name to a folder:

```json
{ "mounts": { "footage": "D:/Shoots/Clinic", "music": "D:/Music" } }
```

A source then says `"path": "mount:footage/Clip001.mp4"`. Paths that leave the mount (`..`, drive letters, backslashes, links that
point outside) are refused. A missing mount or an unplugged drive gives a message that says how to fix it. Photos and logos are
ordinary project paths (`assets/photo.jpg`). `node tools/validate.mjs --media` checks that mounted files exist.

## A minimal reel

```json
{
  "schema": "nordle.doc/0.1", "id": "hello", "title": "Hello", "kind": "video", "brand": "my-brand",
  "sizes": ["ig-reel-9x16", "tiktok-9x16"],
  "sources": [
    { "id": "talk", "type": "video", "path": "mount:footage/talk.mp4", "transcript": "mount:footage/talk.words.json" },
    { "id": "shop", "type": "video", "path": "mount:footage/shopfront.mp4" },
    { "id": "bed",  "type": "audio", "path": "mount:music/bed.wav" }
  ],
  "timeline": {
    "fps": 30, "duration": 12,
    "tracks": [
      { "id": "v1", "type": "video", "clips": [
        { "id": "hook", "source": "talk", "in": 2.4, "out": 8.0, "at": 0, "focal": { "x": 0.45, "y": 0.4 }, "zoom": { "from": 1, "to": 1.08 } },
        { "id": "rest", "source": "talk", "in": 9.1, "out": 15.0, "at": 5.6, "transition": { "type": "dip", "duration": 0.3 } } ] },
      { "id": "v2", "type": "video", "clips": [
        { "id": "cutaway", "source": "shop", "in": 4, "out": 6, "at": 3, "mute": true, "pan": { "from": { "x": 0.3, "y": 0.5 }, "to": { "x": 0.7, "y": 0.5 } } } ] },
      { "id": "music", "type": "audio", "clips": [
        { "id": "bed", "source": "bed", "in": 0, "out": 11.5, "at": 0, "gainDb": -12, "fade": { "in": 0.5, "out": 1.5 },
          "duck": { "under": "v1", "amountDb": -12, "attack": 0.1, "release": 0.4 } } ] }
    ],
    "scenes": [ { "id": "hook", "title": "Hook", "start": 0, "end": 3 }, { "id": "rest", "title": "Rest", "start": 3, "end": 11.5 } ],
    "captions": { "source": "talk", "highlight": "word", "maxWordsPerLine": 3, "position": "bottom-third", "fixes": { "Noodle": "Nordle" } }
  },
  "layers": [
    { "id": "title", "type": "text", "text": "Hello there", "time": { "start": 0.3, "end": 2.6 },
      "layout": { "anchor": "top-left", "x": 8, "y": 18, "w": 80 },
      "style": { "font": "$brand.fonts.display", "size": 110, "weight": 700, "color": "$brand.colors.paper", "shadow": { "color": "#000000aa", "blur": 18, "y": 3 } },
      "animate": [ { "preset": "rise-in", "duration": 0.5 }, { "preset": "fade-out", "duration": 0.25 } ] }
  ]
}
```

## Voice-over reels and motion-graphics-only reels

A reel does not need footage. `card` and `end` scenes plus hand-made `layers` (animated type, panels, rules) make a reel of motion graphics only: no sources at all.

To make the graphics follow a **voice-over** (a recording of the owner's own voice; Nordle never makes a voice up), add the recording as an audio source with a words file and name it:

```json
{
  "sources": { "vo": { "path": "mount:voice/tips.wav", "type": "audio", "transcript": "sources/transcripts/tips.words.json" } },
  "voiceover": { "source": "vo", "in": 0.8, "lead": 0.15, "tail": 0.3 },
  "captions": { "maxWordsPerLine": 3 },
  "scenes": [
    { "type": "card", "pattern": "statement", "say": "small batches", "content": { "headline": "Small batches" } },
    { "type": "card", "pattern": "stat", "say": "three steps", "content": { "number": "3", "label": "steps" } },
    { "type": "end", "say": "come and see us", "content": { "headline": "Come and see us" } }
  ]
}
```

- `say` is the words the scene covers, copied from the transcript (case and punctuation do not matter; `"first ... last"` runs from the first words to the last). Phrases are found in order, so a phrase said twice is found where the scene order expects it.
- A scene starts when the one before ends and runs until `lead` seconds (default 0.15) before the next scene's words, so the graphics are on screen as the words are said. The last scene holds for `tail` seconds (default 0.3) after its words. A scene is held at least 0.8 s.
- `in` is where in the recording the reel starts (skips a long lead-in). The voice goes on its own `Voice-over` audio track, music ducks under it, and captions follow it.
- A layer can be timed the same way: `"time": { "say": "roasted ... order", "to": "optional later words", "hold": 0.4 }`.
- If a phrase is not in the transcript, the build stops and names it. If the source has no word timings, it stops and says so.
- `node nordle.mjs reel <project> <spec> --sheet` reads the words file itself; nothing needs to be passed.

In the Studio this is the **Made from** choice on a reel (Create page and the idea editor): **Auto**, **Cut from footage**, **Motion graphics only**, **Motion graphics with a voice-over**, plus what it uses and about how long (`item.reel` on the calendar item).

## How the timeline is read

- Times are seconds; the picture is cut on exact frames at `timeline.fps`. A clip lasts `(out - in) / speed`; for a photo, `out - in`.
- **Tracks.** Several video tracks may overlap: the highest track (listed last) is the picture, lower ones continue underneath.
  A cutaway on `v2` over a speaker on `v1` therefore shows the cutaway while the speaker's sound and captions carry on.
  Where no clip covers the timeline the result is the `timeline.background` (a colour, brand token or gradient) or black, and a
  black gap is flagged. A reel of only text and shapes: one empty video track, a `background`, and `layers`.
- **Sound.** Every unmuted clip with sound is mixed (video clips too). Per clip: `gainDb`, `fade`, `mute`, `speed` (pitch kept). Track `mute`/`solo`.
  `duck` lowers the clip while the named track is talking, by exactly `amountDb`, reaching it `attack` seconds *before* the first
  word and returning over `release`. The mix is set to **-14 LUFS** (true peak -1.5), 48 kHz, and muxed as a separate WAV so there is no
  AAC priming offset (tested: picture and sound start together within 12 ms).

## Clip fields

| field | meaning |
|---|---|
| `id`, `source`, `in`, `out`, `at` | which source, which part, where on the timeline |
| `speed` 0.25 to 4 | speed (sound keeps its pitch) |
| `fit` | `cover` (default), `contain` (whole picture over a soft blurred copy), `fill` |
| `focal {x,y}` 0 to 1 | the point kept in the middle of the 9:16 crop of 16:9 footage (clamped to the picture) |
| `zoom {from,to,ease}` | Ken Burns; 1 = whole crop, 1.2 = 20% closer. Only `from` = pull out. Works on photos |
| `pan {from:{x,y},to:{x,y},ease}` | the crop window slides across the source; default start is `focal` |
| `grade` | `none`, `neutral` (a little contrast and colour), `warm` |
| `denoise` | smooth camera noise |
| `transition {type,duration,direction}` | how this clip comes in over its first `duration` s: `cut`, `fade` (cross-dissolve), `dip` (through black), `slide` (`direction` left/right/up/down). Sound is never changed |
| `gainDb`, `mute`, `fade {in,out}`, `duck {under,amountDb,attack,release}` | sound (and `fade` also fades the picture from/to black) |

`ease` is `linear` (default), `in`, `out` or `in-out`. Zoom and pan only apply to `fit: cover`.

## Captions

`timeline.captions`: `source` (a source with a `transcript`), `highlight` (`word`, `line`, `none`), `maxWordsPerLine` (default 4),
`position` (`top-third`, `center`, `bottom-third`), `style` (overrides the brand's `captionStyle`), `highlightColor`, `animate`
(quick pop on each new line), `fixes` (`{"heard": "shown"}`). Only words from the part of the source that actually plays are shown,
moved to where they play. A word can also carry its own `fix` (or `skip: true`) in the transcript file.

Transcripts are word timings from any tool: `{"words":[{"text","start","end"}]}`, a bare list, or faster-whisper style
`{"segments":[{"words":[{"w","s","e"}]}]}`. Captions are placed inside the safe area of every size in the document with the same
pixel shape (the largest margins win: bottom 22% and right 15% for a reel plus TikTok).

## Titles, shapes, images: `layers` with `time`

Any layer type from the graphics format (`text`, `image`, `shape`, `group`) with `time {start,end}`. Per-size `overrides` work. Layers
that sit under the platform buttons, or run off the picture, are reported by the render (`overlay-unsafe`, `overlay-offscreen`).
Give titles a `shadow` or put a gradient `shape` behind them: a plain white title vanishes on a light wall.

`animate: [{ "preset", "at", "duration", "ease", "params" }]` (several allowed; `at` is seconds after the layer starts; exit presets
default to ending when the layer ends). Presets:

`fade-in`, `fade-out`, `rise-in` (`params.distance`, px), `rise-out`, `fall-in`, `pop` (`params.from` start scale, default 0.7),
`slide-in` / `slide-out` (`params.from` or `to`: `left` `right` `up` `down`; `params.distance` px), `wipe` / `wipe-out`
(`params.from`), `typewriter` (letter by letter), `word-by-word`. Eases: `linear in out in-out in-cubic out-cubic in-out-cubic out-back`
(default: the brand's `motion.ease`). Or keyframes: `{"keyframes":[{"t","prop","value","ease"}]}` with `prop` one of `opacity`, `scale`,
`rotate`, `x`, `y`, `w`, `h` (x, y, w, h in % of the canvas). Animations belong to top-level layers (a group animates as one).

## Checks the plan makes (also `video check`)

Blocking: a source or mount that is missing, a clip past the end of its footage, overlapping clips on one track. Warnings and errors
that do not stop the render: a **speaker cut in the middle of a word** (`speech-cut-word`, error), **cut before the sentence ends**
(`speech-cut-sentence`) or **starting mid-sentence** (`speech-start-sentence`), a black gap, a title under the platform buttons, an
unknown animation preset, a transcript that does not cover the clip, a file whose length differs from the document.

## Cutting: keeps, bring back, trim, split, and cutting by words

All editing of a timeline is one module, `src/shared/cutlist.mjs` (pure, no imports, so it runs in Node **and in the browser**). Its
functions take the document and return JSON Patch operations (they never change the document or write anything); the editor, the
command line and Claude all send those operations through the same validated patch, so locks, history, undo and the owner's autonomy
setting apply as for any edit. Errors are `CutError` with a `code` (`overlap`, `edge`, `past-footage`, `locked`, `everything`, ...) and a
message in plain English.

**The model.** What a track plays of a source is its *kept ranges* (`coverage`). Cutting words takes a range out of the clips that
play it (a clip is shortened, split in two, or removed); bringing it back puts a clip with that range back where it belongs in source
order, copying the look of the clip next to it. The two are inverses: remove then restore gives back the same coverage and the same length.

- **Frame grid.** Everything a cut creates lands on whole frames of `timeline.fps`; no clip gets a length under one frame. Clips are
  moved by exact amounts, never re-rounded, so a document whose times sit between frames (milliseconds typed by hand) stays valid:
  neighbours still meet exactly, which is what the validator checks. A document made on the grid stays on it. (Speed other than 1: the
  clip's `in` / `out` follow the frame-aligned timeline position, so they may fall between frames of the footage.)
- **Ripple** (the default for removing, bringing back and deleting): the later clips *on that track* close up or move later. Scenes,
  the cover time and overlay layers (titles, shapes) after the change move by the same amount, so a title stays on the words it was
  over. A scene that sat wholly inside the cut goes; a title inside the cut is taken out (and the result says so); one that straddles the
  cut is shortened. Without ripple nothing moves and a gap is left (`removeSourceRange`), or the move must land in free space (`moveClip`).
- **In step.** Another track that plays the same source (the picture and the sound of one recording, or a picture-only copy) is cut
  and restored the same way, so picture and sound stay together. Clips of other sources on other tracks (cutaways, music) are not moved.
  `timeline.duration` follows the clips when it matched their end; if something else still runs to the old end (a music bed), the video
  stays that long and the result carries a note ("trim it to close up the end").
- **Zoom and pan** are divided where a clip is split (by the cut, or by `splitClip`) so the picture does not jump where the parts
  meet, eases included. A restored clip holds the neighbour's framing instead of restarting its motion. A fade in and a transition
  stay with the first part, a fade out with the last.
- **Cutting everything** (nothing of the source left on the track) is refused: there would be nothing to bring back from. Delete the
  clips if you want an empty track. A locked track (`lock: true`) is never edited.

**By words.** A transcript is a list of words (`{text, start, end}`, from `src/video/words.mjs`); a person or Claude picks a range by
word number. `snapCut` turns the selection into cut points that never cut a word: the cut starts in the quiet *after* the previous word
(at most `maxPad` = 0.12 s after it, else the middle of the gap) and ends in the quiet *before* the next word, both on whole frames
(the middle frame when the gap is narrower than a frame, which the speech check tolerates to half a frame). At the very start of the
recording the cut begins at 0; at the very end it runs to the end of the footage. Bringing words back restores the word and the quiet
around it, but for the last words only a short quiet after them, not all the footage that followed. `wordStates` says which words are
still played and where; `transcriptLines` groups them into sentences for display.

```js
import { removeWords, restoreWords, wordStates, totalDuration } from './src/shared/cutlist.mjs';
const ref = { track: 'v1', source: 'talk' };
const ops = removeWords(doc, ref, words, 12, 20);            // words 12 to 20 inclusive; ripple by default
const next = applyOps(doc, ops).doc;                          // src/shared/ops.mjs
```

| function | what it returns |
|---|---|
| `clipDuration(clip, doc?)` | seconds on the timeline, `(out - in) / speed`; a photo: `out - in` (pass the document) |
| `findClip(doc, id)` | `{trackIndex, clipIndex, track, clip}` or `null` |
| `splitClip(doc, id, t)` | ops: the clip keeps its id and first part, a new `<id>-b` (then -c ...) starts at `t` |
| `trimClip(doc, id, {in?, out?, at?}, {ripple=false, sourceDuration?})` | ops; head trim keeps the tail in place unless ripple |
| `moveClip(doc, id, at, {ripple=false})` | ops; no overlap unless ripple pushes the following clips |
| `deleteClip(doc, id, {ripple=true})` | ops |
| `coverage(doc, {track, source})` | `[{from, to, clipId, at}]` source ranges played, sorted, merged when continuous |
| `removeSourceRange(doc, {track, source, from, to}, {ripple=true})` | ops (`removeSourceRangeInfo` -> `{ops, removed, notes}`) |
| `restoreSourceRange(doc, {track, source, from, to}, {ripple=true})` | ops, `[]` if already kept (`...Info` -> `{ops, restored, notes}`) |
| `wordStates(doc, {track, source}, words)` | `[{i, text, start, end, kept, at}]` (`at`: timeline seconds, `null` when cut) |
| `snapCut(words, from, to, {fps, maxPad=0.12, start, end})` | `{from, to}` in source seconds |
| `removeWords / restoreWords(doc, {track, source}, words, i, j, {ripple, fps, maxPad})` | ops (`...Info` also gives `from`, `to`, `removed`/`restored`, `notes`) |
| `totalDuration(doc)` | seconds the timeline runs: the end of the last clip |
| `transcriptLines(states)`, `speechSource(doc)`, `defaultTrack(doc, source)` | helpers for lists and defaults |

**Command line.** `node nordle.mjs cut words <project> <doc> --source talk` prints the transcript numbered, with what is kept and cut,
and the length of the video. Then `cut <project> <doc> --source talk remove 12-20` (or `restore 12-20`), `split <clip> <seconds>`,
`trim <clip> --in s --out s --at s [--ripple]`, `move <clip> <seconds>`, `delete <clip>`. `--no-ripple` leaves a gap, `--dry-run` prints
the operations and changes nothing, `--check` runs the cut check afterwards. When the editor is running and serves that project the
change goes through it (as an edit made through the agent path, so autonomy applies); otherwise the document file is written the
way the editor writes it (validated, atomically, with a history entry).

**For Claude.** `nordle_cut_list` (the numbered transcript, kept and cut, and the length) and `nordle_cut_words` (`from`, `to`,
`restore?`, `ripple?`): a normal patch with `baseVersion`. After cutting, run `nordle_video_check` and look with `nordle_video_stills` at
each seam. The editor's transcript panel reads `POST /api/projects/<p>/cut/words {doc, source?, track?}` (the words, whether each is kept, where
it lands, and the lines).

**Measured (STOP 4b gate, `tests/cut-gate.test.mjs`).** A synthetic two-minute recording of 330 words in 32 sentences, with a flash and a
click together every 4 s; whole sentences deleted until the cut list says 45.000 s. Full render: **45.000 s, 1350 frames**, every kept
flash on exactly its frame, each click 2.9 ms from its flash (the measuring step; limit 20), every kept sentence starting within 3.4 ms of
where the cut list puts it, audio and video start times both 0. The plan finds no cut through a word and no gap.

## Editing in the editor

A video document (`kind: "video"`) opens in the timeline editor (`#/p/<project>/<doc>`, or "Open in editor" on a video post in the Studio).
The picture editor's pages strip and canvas are not there; the top bar (undo, redo, back to the Studio, Claude's dial, the approval badge) is.
Everything is an ordinary patch through `commit()`, so undo and redo, the history, locks, Claude's suggestions (the dial), versions, comments
and approvals work as for a picture. The editor only builds the operations; `src/shared/cutlist.mjs` makes them and the server checks them.

**Layout.** The monitor (top left), the side panel (right: **Inspector**, **Transcript**, **Check**, **Review**, **Export**) and the timeline
(across the bottom). At 1280 px and at 1920 px wide nothing scrolls sideways; the timeline zooms to fit the video.

**The timeline.** A ruler (click or drag it to put the playhead on a frame; comment pins sit on it and a click goes to that moment), then a
lane for problems (from the check), scenes, titles and shapes (overlays with a `time`: overlapping ones stack), each picture track (the track
listed last is on top, so it is drawn first), each sound track, and the captions (one block per word the cut still plays; read only). Clips are
blocks showing their label (`note`, else the id), source and length; a clip whose source has sound shows its waveform (a canvas, drawn from the
`waveform` route and kept per zoom), tinted where the transcript says someone is speaking. Track headers carry M (mute), S (solo) and L (lock),
written to the track; other tracks dim while one is soloed. (The document has no per-track gain: volume is `gainDb` on each clip.) Zoom with the
buttons, `+` `-` `0`, or Ctrl and the mouse wheel; a long list of tracks scrolls under headers that stay put.

| key / action | does |
|---|---|
| Space | play or pause the monitor (not while typing in a field, or in the side panel's buttons) |
| Left, Right | playhead one frame; with Shift one second; Home, End: the ends |
| S | split the selected clip (or clips) at the playhead |
| Delete, Backspace | remove the selected clip, title or scene. Clips close the gap when **Ripple delete** is on (the toolbar button says which) |
| I, O | start or end the selected clip at the playhead (Shift ripples); in the Source monitor: at the moment you are looking at |
| Ctrl + Left, Right | nudge the selected clip a frame (with Shift 30 frames) |
| Alt + Left, Right | select the previous or next clip on the track |
| Ctrl + Z, Ctrl + Y | undo, redo (the whole of one drag, cut or split is one step) |
| + / - / 0 | zoom in, out, fit |
| `?` | the same list in a dialog |
| drag a clip | move it; it snaps to whole frames, to other clips', titles' and scenes' edges and to the playhead (Alt turns snapping off, Shift ripples). Moving onto another clip is refused with a plain message |
| drag a clip's edge | trim it (a tooltip shows the source in and out); a photo stretches to any length; a clip cannot be pulled past the end of its footage |
| Ctrl + click | add a clip to the selection (delete, split and nudge then work on all of them) |
| double-click a clip, a scene | look at its footage in the Source monitor; rename the scene |
| drag a title's bar, its edges, a scene's edge | when it is on; scene boundaries that touch move together |

**Cutting by words** (Transcript tab). The words of the recording (`POST cut/words`, loaded once; whether each is kept is worked out on the page
from the document, so it follows every edit and undo). Click a word to put the playhead where it is said; Shift+click or drag to select a
range, Ctrl+click to add words; **Delete** cuts the selection (the rest closes up: exactly `removeWords`, one undo step); a struck-through word
comes back when you click it, or select struck words and press **Enter** (`restoreWords`). The line above the words says "Kept 7.9 s of 12 s (1 word
cut)". The search box highlights words (several words match as a phrase; Enter goes to the next). **Select fillers (n)** selects every
um, uh, er, ah, hmm and "like" still in the video so one Delete takes them all out (one undo step). Alt+click plays the footage from that word.
With the keyboard: Left and Right move through the words (Shift extends), Ctrl+A selects all, Delete, Enter, Escape.

**Inspector.** For a clip: label, where it starts, how long, source in and out, speed, fit, a focal point (click the small picture, or type
it; the dashed box is the crop), zoom and pan with easing, grade, denoise, transition, volume, mute, fade and duck. For a title: its text,
when it is on and off, and **Animation**: presets (add, remove, start, length, easing, distance and direction) and keyframes (`{t, prop, value, ease}`;
`t` is seconds after the title appears). "Add keyframe at playhead" picks opacity, scale, rotation, x, y, width or height; a keyframe animation
needs two keyframes, so the first one also adds a matching one at the other end (change its value to animate). A speed that would run the clip into
the next is refused before it is sent; any other bad value gets the server's message. For a scene: name and times. For a track: name, mute, solo, lock.

**The monitor** never plays camera files: only finished renders and small copies.

- **Frame** (the default): when the playhead has rested for 300 ms the real picture at that time (footage, titles and captions, from the `stills`
  route, about a second at most) is shown, with a spinner while it loads. An answer for a time or an edit that has since moved on is thrown away.
- **Cut**: the last rendered preview (`out/<doc>/<doc>.preview.mp4`, found with `GET video/outputs`), played in a `<video>`, in step with the playhead
  both ways. **Render preview** starts a render job with progress; the monitor loads the result when it is done. After an edit it says the preview is older.
- **Source**: the selected clip's footage, as its small copy (made on the spot, with progress, if it is missing). Its bar shows the part the clip plays;
  I and O (or the buttons) set the clip's start and end to the moment on screen. Pictures just show the photo.
- **Pin a comment** drops a pin on the picture at this moment (`time` on the comment); pins show on the ruler and on the monitor near their time.

**Check** lists what `video check` finds (also marked on the timeline); click one to go there. It runs again by itself shortly after each edit.
**Export** offers `mp4`, `webm`, `gif` and `prores`; one this computer cannot make is greyed out with the reason (`GET video/formats`). A render job shows
its progress and ends with a download link; earlier exports are listed.

**Trouble.** Footage that cannot be read (an unplugged drive, a mount that is gone) is named at the top of the timeline with the server's message and
how to fix it; **Try again** asks again once the drive is back. Two people (or Claude) editing at once: an edit made against an old version that cannot be
merged is refused, the page says so and loads the latest. Looking at an old version or one of Claude's changes is read only, with a banner.

**Not there on purpose**: a pen tool, several cameras, colour grading, compositing in the browser (the Frame is
drawn by the renderer, so scrubbing costs about a second a picture), per-track gain, moving a clip between tracks by dragging, and linked trim
(picture and sound of one recording are cut together by the word tools, not by dragging one clip).

`GET /api/projects/<p>/video/outputs?doc=<id>` lists the finished video files of a post (`out/<doc>/`): `{files:[{name, path, kind: 'preview'|'export', ext, bytes, modified}]}`.

## Performance (this computer, 24 cores)

Footage is read only where the timeline uses it (`-ss` before `-i`), each clip's sound once, never fully into memory. The picture is made
one small intermediate per clip, four at a time, while the overlay and the sound are made at once; a last pass joins them. Titles and
captions are drawn only on the frames where something changes (a typical 27 s reel: 806 frames, ~200 drawn).

- 26.9 s reel from 4K 10-bit 4:2:2 All-Intra footage on a network drive, 11 clips, captions, titles, fades, zoom, photo: **47 s**.
- 18.5 s reel from synthetic sources: 21 s full, 11 s preview. `video stills` takes about 1 s per frame; `video sheet` 3 s.

Notes: HDR or log footage is not tone-mapped (it will look flat); frame-rate conversion repeats frames (25 -> 30 fps); the tmp folder
(`os.tmpdir()`) is cleaned after every run. Set `NORDLE_KEEP_TEMP=1` to keep it for debugging.
