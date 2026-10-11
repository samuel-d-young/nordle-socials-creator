// A video document's timeline as the checks need it: every clip with the time it plays on the timeline, whether it can be
// heard, and the words spoken in it (from the transcript of its source), mapped onto the timeline.

import { readLocalSettings, resolveMedia } from './paths.mjs';
import { readWordsFile } from './transcript.mjs';

/**
 * @returns {null | {duration:number, fps:number, sources:Map, clips:object[], tracks:object[]}}
 * Each clip: the document's clip plus {speed, src, track, trackId, trackType, trackIndex, tlStart, tlEnd, muted, audible, words,
 * toTl(sourceSeconds), fromTl(timelineSeconds)}. words: [{text,start,end,tlStart,tlEnd,clip}] (start/end in the source).
 */
export function buildTimeline(doc, projectDir, { transcripts = true } = {}) {
  const t = doc.timeline;
  if (!t) return null;
  const local = readLocalSettings(projectDir);
  const sources = new Map();
  for (const s of doc.sources ?? []) {
    const media = resolveMedia(projectDir, s.path, local);
    let words = [];
    let wordsError = null;
    let synthetic = false;
    if (transcripts && s.transcript) {
      const tr = resolveMedia(projectDir, s.transcript, local);
      if (tr.exists) { const r = readWordsFile(tr.abs); words = r.words; wordsError = r.error; synthetic = r.synthetic; } else wordsError = `the transcript ${s.transcript} was not found`;
    }
    sources.set(s.id, { ...s, media, words, wordsError, synthetic });
  }
  const anySolo = t.tracks.some((tr) => tr.solo);
  const clips = [];
  t.tracks.forEach((track, trackIndex) => {
    for (const c of track.clips) {
      const speed = c.speed ?? 1;
      const src = sources.get(c.source);
      const tlEnd = c.at + (c.out - c.in) / speed;
      const muted = Boolean(c.mute || track.mute || (anySolo && !track.solo) || (c.gainDb ?? 0) <= -50);
      const toTl = (s) => c.at + (s - c.in) / speed;
      const fromTl = (x) => c.in + (x - c.at) * speed;
      const words = (src?.words ?? []).filter((w) => w.end > c.in && w.start < c.out)
        .map((w) => ({ ...w, tlStart: toTl(Math.max(w.start, c.in)), tlEnd: toTl(Math.min(w.end, c.out)), clip: c.id }));
      clips.push({ ...c, speed, src, track, trackId: track.id, trackType: track.type, trackIndex, tlStart: c.at, tlEnd, muted, audible: !muted && src?.type !== 'image', toTl, fromTl, words });
    }
  });
  clips.sort((a, b) => a.tlStart - b.tlStart || a.trackIndex - b.trackIndex);
  return { duration: t.duration, fps: t.fps, sources, clips, tracks: t.tracks };
}

/** Picture clips: what the viewer sees (clips on video tracks). */
export const pictureClips = (tl) => tl.clips.filter((c) => c.trackType === 'video');

/** Overlay layers (doc.layers) that are on screen at some moment of [a, b). */
export function overlaysDuring(doc, a, b) {
  return (doc.layers ?? []).filter((l) => l.time && l.time.end > a && l.time.start < b && !l.hidden);
}

/** Words heard at some moment of [a, b), from clips other than `except`. Each word has its timeline times. */
export function spokenDuring(tl, a, b, { except, audibleOnly = true } = {}) {
  const out = [];
  for (const c of tl.clips) {
    if (c.id === except) continue;
    if (audibleOnly && !c.audible) continue;
    for (const w of c.words) if (w.tlEnd > a && w.tlStart < b) out.push({ ...w, audible: c.audible, clipId: c.id });
  }
  return out.sort((x, y) => x.tlStart - y.tlStart);
}
