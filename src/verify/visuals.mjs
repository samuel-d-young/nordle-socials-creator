// The pictures a person (or a fresh Claude) must look at to judge a post: the rendered pages of a carousel or graphic, or stills from a
// video at each cut, scene and B-roll moment. Stills are small JPEGs kept next to the checks so a reviewer can open them.

import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { renderedVideo } from './audio.mjs';
import { extractStill, ffmpegAvailable } from './ff.mjs';
import { flatLayers, layerText } from './surfaces.mjs';
import { clip, stamp } from './text.mjs';
import { buildTimeline, overlaysDuring, pictureClips, spokenDuring } from './timeline.mjs';

export const packetDir = (projectDir, docId) => join(projectDir, 'checks', `${docId}.packet`);

/**
 * Rendered images of a graphic or carousel at its first size: [{label, path, page, words}]. Reuses fresh renders; renders again if
 * the document is newer. Needs a browser only when it has to render.
 */
export async function pageImages(projectDir, doc, { browser, render } = {}) {
  const docFile = join(projectDir, 'docs', `${doc.id}.json`);
  const outDir = join(projectDir, 'out', doc.id);
  const size = typeof doc.sizes[0] === 'string' ? doc.sizes[0] : doc.sizes[0].id;
  const wanted = (doc.pages ?? []).map((p, i) => ({ page: p, index: i, name: `${doc.id}_${size}_${String(i + 1).padStart(2, '0')}-${p.id}.png` }));
  const fresh = wanted.every((w) => existsSync(join(outDir, w.name)) && (!existsSync(docFile) || statSync(join(outDir, w.name)).mtimeMs >= statSync(docFile).mtimeMs));
  let outputs = null;
  if (!fresh && (browser || render)) {
    const { renderDocument } = await import('../render/render.mjs');
    const r = await renderDocument(docFile, { browser, sizes: [size] });
    if (!r.errors.length) outputs = r.outputs;
  }
  const out = [];
  for (const w of wanted) {
    const path = outputs?.find((o) => o.page === w.page.id)?.path ?? join(outDir, w.name);
    if (!existsSync(path)) continue;
    const layers = flatLayers(w.page.layers).filter((l) => l.type === 'text' && !l.hidden).map(layerText);
    out.push({ label: `Page ${w.index + 1} of ${wanted.length}: "${w.page.id}" at ${size}`, path: resolve(path), page: w.page.id, words: layers.join(' | ') });
  }
  return out;
}

/** Times worth looking at in a video: the start and end of every picture clip, each B-roll shot, each piece of overlay text. */
export function videoMoments(doc, timeline) {
  const moments = [];
  const add = (t, why, clipId) => moments.push({ t: Math.max(0, Math.min(timeline.duration - 0.05, t)), why, clipId });
  for (const c of pictureClips(timeline)) {
    const dur = c.tlEnd - c.tlStart;
    const inset = Math.min(0.3, dur / 3);
    const cut = spokenDuring(timeline, c.tlStart, c.tlEnd, { except: c.id, audibleOnly: false }).length > 0 && !(c.audible && c.words.length);
    if (cut) add(c.tlStart + dur / 2, `B-roll "${c.id}" (while someone is speaking)`, c.id);
    else if (dur > 1.5) { add(c.tlStart + inset, `start of clip "${c.id}"`, c.id); add(c.tlEnd - inset, `end of clip "${c.id}"`, c.id); } else add(c.tlStart + dur / 2, `clip "${c.id}"`, c.id);
  }
  for (const l of doc.layers ?? []) if (l.time && !l.hidden) add(l.time.start + Math.min(0.4, (l.time.end - l.time.start) / 2), `overlay "${l.id}" appears`, null);
  for (const s of doc.timeline.scenes ?? []) add(s.start + 0.2, `scene "${s.id}" starts`, null);
  moments.sort((a, b) => a.t - b.t);
  const kept = [];
  for (const m of moments) if (!kept.some((k) => Math.abs(k.t - m.t) < 0.5 && k.why === m.why)) kept.push(m);
  const dedup = [];
  for (const m of kept) if (!dedup.some((k) => Math.abs(k.t - m.t) < 0.35)) dedup.push(m);
  return dedup.slice(0, 20);
}

/**
 * Stills of a video: from the rendered file if there is one (with the overlays), otherwise straight from the footage.
 * @returns {{label:string, path:string|null, time:number, words:string, overlays:string, note?:string}[]}
 */
export function videoStills(projectDir, doc, { timeline = buildTimeline(doc, projectDir) } = {}) {
  const dir = packetDir(projectDir, doc.id);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  mkdirSync(dir, { recursive: true });
  const rendered = renderedVideo(projectDir, doc.id);
  const out = [];
  let n = 0;
  for (const m of videoMoments(doc, timeline)) {
    n += 1;
    const file = join(dir, `still-${String(n).padStart(2, '0')}.jpg`);
    const pic = [...pictureClips(timeline)].reverse().find((c) => c.tlStart <= m.t && c.tlEnd > m.t);
    let ok = false;
    let note;
    if (!ffmpegAvailable()) note = 'ffmpeg is not installed here, so no still could be taken';
    else if (rendered) ok = extractStill(rendered, m.t, file);
    else if (pic?.src?.media?.exists) { ok = extractStill(pic.src.media.abs, pic.fromTl(m.t), file); note = 'taken from the footage (the video has not been rendered, so overlays are not shown)'; } else note = pic ? 'the footage is not reachable on this computer' : 'nothing is on screen here';
    const heard = spokenDuring(timeline, m.t - 1, m.t + 1, { audibleOnly: false }).map((w) => w.text).join(' ');
    const overlays = overlaysDuring(doc, m.t, m.t + 0.05).flatMap((l) => flatLayers([l]).filter((x) => x.type === 'text' && !x.hidden).map(layerText)).join(' | ');
    out.push({ label: `${stamp(m.t)}: ${m.why}`, path: ok ? resolve(file) : null, time: Math.round(m.t * 100) / 100, words: clip(heard, 200), overlays, clipId: m.clipId, ...(note ? { note } : {}) });
  }
  return out;
}
