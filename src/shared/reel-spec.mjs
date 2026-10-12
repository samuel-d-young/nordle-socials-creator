// A reel spec is a short list of scenes. buildReelDoc turns it into a Nordle video document in the brand's house style:
// footage on the picture tracks, captions from the transcript, brand-styled titles and cards as timed overlay layers,
// music that ducks under the speaker. Pure: no Node imports, so the editor could use it too.
//
//   {
//     "id": "2026-11-03-reel-meet-tim", "title": "Meet Tim", "sizes": ["ig-reel-9x16"],          (default size: ig-reel-9x16)
//     "brief": {...}, "copy": { "caption": "...", "hashtags": [...], "alt": { "video": "..." } },
//     "label": "LITTLE GANNET COFFEE",                    small line over the captions during talking scenes (never over faces)
//     "grade": "warm", "denoise": true,                        applied to every footage clip
//     "sources": { "tim": { "path": "mount:footage/C9550.MP4", "transcript": "sources/transcripts/C9550.words.json" },
//                  "bed": { "path": "mount:music/Track.mp3", "type": "audio" } },
//     "captions": { "source": "tim", "maxWordsPerLine": 3, "position": "bottom-third", "fixes": { "Noodle": "Nordle" } },
//     "music": { "source": "bed", "in": 12.0, "gainDb": -12, "duckDb": -14 },
//     "scenes": [
//       { "type": "talk",  "source": "tim", "in": 12.3, "out": 17.1, "focal": {"x":0.45,"y":0.4}, "text": {"kicker":"Meet the team","headline":"Dr Tim Crofts","body":"Dentist"} },
//       { "type": "clip",  "source": "room", "in": 4, "dur": 2.4, "text": {"headline":"Digital scans","pos":"upper"} },
//       { "type": "photo", "image": "assets/photos/x.jpg", "dur": 2.6, "text": {...} },
//       { "type": "cutaway", "source": "room", "in": 3, "dur": 1.8, "at": 2.0 },               over the previous talk scene, speech carries on
//       { "type": "card",  "pattern": "statement|list|stat|quote", "dur": 2.4, "tone": "dark", "content": {...} },
//       { "type": "end",   "dur": 3.4, "content": { "lead":"...", "headline":"...", "phone":"...", "url":"...", "disclaimer":"..." } }
//     ]
//   }
// Text blocks: { kicker, headline, accent, body, pos: "upper" | "center" | "lower", tone: "dark" | "light" }.
//   optional: size (headline px), scrim: false (no darkening), scrimH (scrim height in % of the picture, default 46), scrimA (scrim opacity at the edge, hex "00".."ff", default "cc").
// "layers": [ ...document layers with a "time" ] (optional) are appended as they are: shapes, drawn diagrams, extra text.
// "endPanel": { kicker, headline, label, url, phoneLine, disclaimer, logo, at } on a clip or photo scene slides a clean closing sheet up over
//   the end of that shot (the reel ends on real footage instead of a full-screen card). Sits above the platform's covered bottom strip.
// "voiceover": { source, in?, lead?, tail?, gainDb?, out? } makes the graphics follow a recording of the owner's voice (the source needs a transcript). A card, end or photo scene
//   with "say": "the words it covers" runs from just before those words to just before the next scene's words; a layer may say "time": { say, to?, hold? }. See docs/VIDEO.md.
//   With no footage scenes at all (only card and end) the reel is motion graphics only.
// A card/end scene with "bare": true draws only its background (the pattern's text is left out) so "layers" can draw the card by hand.

import { blocks, brandRoles, toneColours, composePage, logoFor, closingCard, closingCardHeight } from './patterns.mjs';
import { findPhrase, spokenWords } from './voice-sync.mjs';

export const COVER_FRAME_SECONDS = 0.1;      // three frames at 30 fps
export class ReelSpecError extends Error {}

const ID = /^[a-z0-9][a-z0-9_-]*$/;
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

function prefixIds(layer, prefix) {
  const out = { ...layer, id: `${prefix}${layer.id}` };
  if (layer.children) out.children = layer.children.map((c) => prefixIds(c, prefix));
  return out;
}

const withTime = (layer, start, end, animate) => ({ ...layer, time: { start: r3(start), end: r3(end) }, ...(animate ? { animate } : {}) });

export function buildReelDoc(spec, { brand, platforms, transcripts = {} }) {
  if (!spec.id || !ID.test(spec.id)) throw new ReelSpecError(`spec.id must be lower-case letters, numbers, - or _ (got "${spec.id}")`);
  if (!spec.title) throw new ReelSpecError('spec.title is required');
  if (!Array.isArray(spec.scenes) || !spec.scenes.length) throw new ReelSpecError('spec.scenes needs at least one scene');
  const sizeIds = spec.sizes?.length ? spec.sizes : ['ig-reel-9x16'];
  const sizes = sizeIds.map((id) => {
    const p = platforms.presets.find((x) => x.id === id);
    if (!p) throw new ReelSpecError(`unknown size "${id}". Sizes: ${platforms.presets.filter((x) => x.kinds?.includes('video')).map((x) => x.id).join(', ')}`);
    return { id: p.id, w: p.w, h: p.h, safe: p.safe };
  });
  const size = sizes[0];
  const roles = brandRoles(brand, spec.colourway);
  const f = blocks.fonts(brand);
  const notes = [];

  // ---- sources ----
  const sources = [];
  const have = new Set();
  const addSource = (id, type, path, extra = {}) => {
    if (have.has(id)) return id;
    if (!ID.test(id)) throw new ReelSpecError(`source id "${id}" is not a valid id (lower-case letters, numbers, - or _)`);
    have.add(id);
    sources.push({ id, type, path, ...extra });
    return id;
  };
  for (const [id, s] of Object.entries(spec.sources ?? {})) {
    addSource(id, s.type ?? (/\.(mp3|wav|m4a|aac|flac)$/i.test(s.path) ? 'audio' : /\.(png|jpe?g|webp)$/i.test(s.path) ? 'image' : 'video'), s.path, {
      ...(s.transcript ? { transcript: s.transcript } : {}), ...(s.lut ? { lut: s.lut } : {}), ...(s.lutRange ? { lutRange: s.lutRange } : {}), ...(s.levels ? { levels: s.levels } : {}), ...(typeof s.exposure === 'number' ? { exposure: s.exposure } : {}), ...(s.duration ? { duration: s.duration } : {}), ...(s.credit ? { credit: s.credit } : {}), ...(s.note ? { note: s.note } : {}),
    });
  }
  let photoN = 0;
  const imageSource = (path) => {
    const existing = sources.find((s) => s.type === 'image' && s.path === path);
    return existing ? existing.id : addSource(`img-${++photoN}`, 'image', path);
  };
  const need = (alias, i) => {
    if (!have.has(alias)) throw new ReelSpecError(`scene ${i + 1}: unknown source "${alias}". Sources: ${[...have].join(', ') || '(none)'}`);
    return alias;
  };

  // ---- a voice-over: scenes (and layers) that name the words they cover are timed from the recording's word timings ----
  const vo = spec.voiceover ? { ...spec.voiceover } : null;
  const voLead = vo?.lead ?? 0.15;    // graphics arrive this long before the words they show
  const voTail = vo?.tail ?? 0.3;     // and stay this long after the last scene's words
  const voIn = vo?.in ?? 0;           // where in the recording the reel starts (skips a long lead-in)
  const voWords = vo ? spokenWords(transcripts[need(vo.source, -1)]) : [];
  if (vo && !voWords.length) throw new ReelSpecError(`the voice-over "${vo.source}" has no word timings, so the graphics cannot follow it. Add a "transcript" (a words file) to that source.`);
  const heard = (phrase, where, after) => {
    const hit = findPhrase(voWords, phrase, { after });
    if (!hit) throw new ReelSpecError(`${where}: the voice-over never says "${phrase}" (after ${r2(after)} s). Copy the words from the transcript.`);
    return { start: r3(hit.start - voIn), end: r3(hit.end - voIn), last: hit.last };
  };
  // each scene's words, in order: the next phrase is looked for after the one before
  const said = [];
  {
    let after = voIn;
    (spec.coverFrame ? [...spec.scenes, {}] : spec.scenes).forEach((sc, i) => {
      if (!sc.say) { said.push(null); return; }
      if (!vo) throw new ReelSpecError(`scene ${i + 1}: "say" needs a "voiceover" in the spec (and a source with word timings).`);
      if (!['card', 'end', 'photo'].includes(sc.type)) throw new ReelSpecError(`scene ${i + 1}: only card, end and photo scenes can say words (a talk scene is already the speech).`);
      const h = heard(sc.say, `scene ${i + 1}`, after);
      said.push(h);
      after = voWords[h.last].start + 0.001;
    });
  }
  /** How long a scene that names its words runs: until just before the next scene's words (or a short tail after its own, for the last). */
  const saidDur = (i, t, fallback) => {
    const me = said[i];
    if (!me) return fallback;
    const next = said.slice(i + 1).find(Boolean);
    const end = next ? Math.max(me.end + 0.05, next.start - voLead) : me.end + voTail;
    if (end - t < 0.8) { notes.push(`scene ${i + 1}: its words end at ${r2(me.end)} s, so it is held for 0.8 s at least.`); return 0.8; }
    return r3(end - t);
  };

  // ---- walk the scenes ----
  const v1 = [], v2 = [], layers = [], scenes = [];
  let t = 0;
  let lastTalk = null;
  const talkRanges = [];
  const footage = (c) => ({ ...(spec.grade ? { grade: spec.grade } : {}), ...(spec.denoise ? { denoise: true } : {}), ...(spec.cleanAudio ? { cleanAudio: true } : {}), ...c });
  const trans = (sc) => (sc.transition ? { transition: typeof sc.transition === 'string' ? { type: sc.transition, duration: 0.3 } : sc.transition } : {});

  /** The title text for a scene over footage: a scrim for legibility and a brand-styled block. */
  const textOver = (sc, i, start, end) => {
    const tx = sc.text;
    if (!tx || !(tx.headline || tx.kicker || tx.body)) return;
    const pos = tx.pos ?? 'upper';
    const tc = toneColours(roles, tx.tone === 'light' ? 'light' : 'dark');
    const x = blocks.sideX(size);
    const content = { kicker: tx.kicker, headline: tx.headline, accent: tx.accent, body: tx.body, emphasis: tx.emphasis, role: 'reel' };
    const kids = [
      blocks.kicker(content, f, tc),
      tx.headline ? blocks.headline({ ...content, headlineSize: tx.size }, f, tc, { base: 118, role: 'reel' }) : null,
      blocks.body(content, f, tc, { size: 42 }),
    ].filter(Boolean).map((k) => prefixIds(k, `s${i + 1}-`));
    const top = pos === 'upper';
    const anchor = pos === 'lower' ? 'bottom-left' : pos === 'center' ? 'left' : 'top-left';
    const y = pos === 'lower' ? r2(100 - (size.safe?.bottom ?? 0.2) * 100 - 20) : pos === 'center' ? 46 : r2(Math.max(11, (size.safe?.top ?? 0.13) * 100 + 1));
    const ink = roles.val(roles.ink).slice(0, 7);
    if (tx.scrim !== false) {
      const scrim = { id: `s${i + 1}-scrim`, type: 'shape', shape: 'rect', layout: { anchor: top ? 'top-left' : 'bottom-left', x: 0, y: top ? 0 : 100, w: 100, h: tx.scrimH ?? (top ? 46 : 52) }, style: { fill: { type: 'linear', angle: top ? 180 : 0, stops: [{ at: 0, color: `${ink}${tx.scrimA ?? 'cc'}` }, { at: 1, color: `${ink}00` }] } } };
      layers.push(withTime(scrim, start, end, [{ preset: 'fade-in', duration: 0.3 }, { preset: 'fade-out', duration: 0.25 }]));
    }
    const block = blocks.stack(`s${i + 1}-text`, { anchor, x, y, w: 100 - x - Math.round((size.safe?.right ?? 0.12) * 100) }, kids.map((k) => ({ ...k, style: { ...k.style, shadow: { color: '#000000aa', blur: 18, y: 3 }, ...(k.style ?? {}) } })), { gap: 22 });
    layers.push(withTime(block, start + 0.1, end, [{ preset: 'rise-in', duration: 0.5, params: { distance: 36 } }, { preset: 'fade-out', duration: 0.25 }]));
  };

  /** A branded full-screen card: a pattern's page drawn as timed layers (its background becomes a full-page shape). */
  const cardLayers = (sc, i, start, end, isEnd) => {
    const pattern = sc.pattern ?? (isEnd ? 'cta' : 'statement');
    const content = { role: 'reel', ...(sc.content ?? {}) };
    if (isEnd && content.logo === true) content.logo = logoFor(brand, sc.tone ?? 'light');
    let composed;
    try { composed = composePage({ pattern, content, brand, colourway: spec.colourway, tone: sc.tone, size, sizes, pageId: `s${i + 1}`, position: { index: isEnd ? 1 : 1, total: isEnd ? 2 : 3 } }); } catch (e) { throw new ReelSpecError(`scene ${i + 1} (${pattern}): ${e.message}`); }
    for (const n of composed.notes) notes.push(`scene ${i + 1}: ${n}`);
    const bg = { id: `s${i + 1}-card`, type: 'shape', shape: 'rect', layout: { anchor: 'top-left', x: 0, y: 0, w: 100, h: 100 }, style: { fill: composed.page.background } };
    layers.push(withTime(bg, start, end, [{ preset: 'fade-in', duration: 0.25 }, { preset: 'fade-out', duration: 0.2 }]));
    if (sc.bare) return; // only the card's background: the scene's own "layers" (spec.layers) draw the rest
    let k = 0;
    for (const l of composed.page.layers) {
      layers.push(withTime(prefixIds(l, `s${i + 1}-`), start + 0.15 + 0.08 * Math.min(k++, 4), end, [{ preset: 'rise-in', duration: 0.45, params: { distance: 30 } }, { preset: 'fade-out', duration: 0.2 }]));
    }
  };

  /**
   * The closing panel: a clean card that rises over the last seconds of a footage scene (scene.endPanel), so the reel ends on a real
   * shot with how to book, instead of a screen of flat colour. Sizes are px on the 1080-wide reference; text stays above the platform's
   * covered bottom strip. endPanel: { kicker, headline, label, url, phoneLine, disclaimer, logo (path), at (seconds into the scene) }.
   */
  const panelLayers = (sc, i, start, end) => {
    const p = sc.endPanel;
    const refH = (size.h * 1080) / size.w;
    const H = closingCardHeight(p);
    // the card sits just above the platform's covered bottom strip, or (position: 'top') just under the covered top strip when the subject is low in the picture
    const top = p.position === 'top' ? Math.round((size.safe?.top ?? 0.13) * refH + 24) : Math.round(refH - (size.safe?.bottom ?? 0.2) * refH - 24 - H);
    const at = start + (p.at ?? 0.3);
    const { panel, parts } = closingCard({ id: `s${i + 1}-end`, size, brand, tc: toneColours(roles, 'light'), f, roles, top, content: p });
    layers.push(withTime(panel, at, end, [{ preset: 'rise-in', duration: 0.5, params: { distance: 90 } }]));
    parts.forEach((l, k) => layers.push(withTime(l, at + 0.12 + 0.07 * k, end, [{ preset: 'rise-in', duration: 0.45, params: { distance: 28 } }])));
  };

  // `coverFrame` (a project path to a picture) puts the reel's own cover on its very last frames, so that frame can be chosen as the cover in the publishing service
  const sceneList = spec.coverFrame ? [...spec.scenes, { type: 'photo', title: 'Cover', image: spec.coverFrame, dur: COVER_FRAME_SECONDS, zoom: { from: 1, to: 1 }, grade: 'none' }] : spec.scenes;
  sceneList.forEach((sc, i) => {
    const sceneId = `s${i + 1}`;
    const title = sc.title ?? sc.type;
    if (sc.type === 'talk' || sc.type === 'clip') {
      const src = need(sc.source, i);
      const speed = sc.speed ?? 1;
      let inT = sc.in ?? 0, outT = sc.out;
      if (sc.type === 'talk') {
        if (outT === undefined) throw new ReelSpecError(`scene ${i + 1}: a talk scene needs "in" and "out" (whole sentences).`);
      } else {
        outT = outT ?? inT + (sc.dur ?? 2.5) * speed;
      }
      const dur = (outT - inT) / speed;
      const clip = footage({
        id: `${sceneId}-${sc.type}`, source: src, in: r3(inT), out: r3(outT), at: r3(t),
        ...(speed !== 1 ? { speed } : {}), ...(sc.type === 'clip' && !sc.audio ? { mute: true } : {}),
        ...(sc.focal ? { focal: sc.focal } : {}), ...(sc.zoom ? { zoom: sc.zoom } : {}), ...(sc.pan ? { pan: sc.pan } : {}), ...(sc.fit ? { fit: sc.fit } : {}),
        ...(sc.grade ? { grade: sc.grade } : {}), ...(sc.gainDb !== undefined ? { gainDb: sc.gainDb } : {}), ...trans(sc),
      });
      v1.push(clip);
      if (sc.type === 'talk') { lastTalk = { start: t, end: t + dur }; talkRanges.push([t, t + dur]); }
      textOver(sc, i, t, t + dur);
      if (sc.endPanel) panelLayers(sc, i, t, t + dur);
      scenes.push({ id: sceneId, title, start: r3(t), end: r3(t + dur) });
      t += dur;
    } else if (sc.type === 'photo') {
      const src = imageSource(sc.image);
      const dur = sc.say ? saidDur(i, t, 2.5) : (sc.dur ?? 2.5);
      v1.push({ id: `${sceneId}-photo`, source: src, in: 0, out: r3(dur), at: r3(t), fit: 'cover', ...(sc.focal ? { focal: sc.focal } : {}), zoom: sc.zoom ?? { from: 1, to: 1.08 }, ...(sc.pan ? { pan: sc.pan } : {}), ...(spec.grade && sc.grade !== 'none' ? { grade: sc.grade ?? spec.grade } : {}), ...trans(sc) });
      textOver(sc, i, t, t + dur);
      if (sc.endPanel) panelLayers(sc, i, t, t + dur);
      scenes.push({ id: sceneId, title, start: r3(t), end: r3(t + dur) });
      t += dur;
    } else if (sc.type === 'cutaway') {
      if (!lastTalk) throw new ReelSpecError(`scene ${i + 1}: a cutaway needs a talk scene before it.`);
      const src = need(sc.source, i);
      const speed = sc.speed ?? 1;
      const dur = sc.dur ?? 1.8;
      const start = lastTalk.start + (sc.at ?? 0);
      if (start + dur > lastTalk.end + 0.001) notes.push(`scene ${i + 1}: the cutaway runs ${r2(start + dur - lastTalk.end)} s past the end of the talking scene it covers.`);
      v2.push(footage({ id: `${sceneId}-cutaway`, source: src, in: r3(sc.in ?? 0), out: r3((sc.in ?? 0) + dur * speed), at: r3(start), mute: true, ...(speed !== 1 ? { speed } : {}), ...(sc.focal ? { focal: sc.focal } : {}), ...(sc.zoom ? { zoom: sc.zoom } : {}), ...(sc.pan ? { pan: sc.pan } : {}), ...(sc.grade ? { grade: sc.grade } : {}) }));
      textOver(sc, i, start, start + dur);
    } else if (sc.type === 'card' || sc.type === 'end') {
      const dur = sc.say ? saidDur(i, t, 2.4) : (sc.dur ?? (sc.type === 'end' ? 3.4 : 2.4));
      cardLayers(sc, i, t, t + dur, sc.type === 'end');
      scenes.push({ id: sceneId, title, start: r3(t), end: r3(t + dur) });
      t += dur;
    } else {
      throw new ReelSpecError(`scene ${i + 1}: unknown type "${sc.type}". Types: talk, clip, photo, cutaway, card, end.`);
    }
  });
  const total = r3(t);

  // small brand label over the captions while someone is talking (never on faces)
  if (spec.label && talkRanges.length) {
    talkRanges.forEach(([a, b], k) => {
      const tc = toneColours(roles, 'dark');
      layers.push(withTime({ id: `label-${k + 1}`, type: 'text', text: String(spec.label).toUpperCase(), layout: { anchor: 'top', x: 50, y: spec.labelY ?? 60, w: 80 }, style: { font: f.kickerFont, size: 26, weight: 600, letterSpacing: 0.22, color: tc.text, align: 'center', shadow: { color: '#000000aa', blur: 14, y: 2 } } }, a + 0.1, b, [{ preset: 'fade-in', duration: 0.3 }, { preset: 'fade-out', duration: 0.2 }]));
    });
  }

  // hand-made overlay layers (shapes, extra text, drawn diagrams) with their own "time": {start,end}; added on top of everything
  // a layer may say when it shows by the words it goes with: time: { say: "the words", to?: "words where it ends", hold?: seconds after, after?: seconds }
  if (Array.isArray(spec.layers)) {
    for (const l of spec.layers) {
      if (!l.time?.say) { layers.push(l); continue; }
      if (!vo) throw new ReelSpecError(`layer "${l.id}": time.say needs a "voiceover" in the spec.`);
      const a = heard(l.time.say, `layer "${l.id}"`, (l.time.after ?? 0) + voIn);
      const b = l.time.to ? heard(l.time.to, `layer "${l.id}" (to)`, voWords[a.last].start + voIn) : a;
      const { say: _s, to: _t, hold, after: _a, ...rest } = l.time;
      layers.push({ ...l, time: { ...rest, start: r3(Math.max(0, a.start - voLead)), end: r3(Math.min(total, b.end + (hold ?? 0.4))) } });
    }
  }

  // ---- tracks ----
  const tracks = [{ id: 'v1', type: 'video', name: 'Picture', clips: v1 }];
  if (v2.length) tracks.push({ id: 'v2', type: 'video', name: 'Cutaways', clips: v2 });
  if (vo) {
    const voOut = vo.out ?? r3(Math.min(voIn + total, voWords[voWords.length - 1].end + 0.3));
    if (voOut <= voIn) throw new ReelSpecError('the voice-over has no length (its "out" is not after its "in").');
    tracks.push({ id: 'vo', type: 'audio', name: 'Voice-over', clips: [{ id: 'voice', source: vo.source, in: r3(voIn), out: r3(voOut), at: 0, gainDb: vo.gainDb ?? 0 }] });
  }
  if (spec.music) {
    const m = spec.music;
    const msrc = need(m.source, -1);
    tracks.push({ id: 'music', type: 'audio', name: 'Music', clips: [{ id: 'bed', source: msrc, in: r3(m.in ?? 0), out: r3((m.in ?? 0) + total), at: 0, gainDb: m.gainDb ?? -12, fade: { in: m.fadeIn ?? 0.4, out: m.fadeOut ?? 1.2 }, ...((talkRanges.length || vo) && m.duck !== false ? { duck: { under: vo ? 'vo' : 'v1', amountDb: m.duckDb ?? -14, attack: 0.12, release: 0.45 } } : {}) }] });
  }
  // short sound effects (whooshes on word snaps and cuts): { source, at, gainDb?, dur?, in? }; the sources are audio files declared in `sources`
  if (spec.sfx?.length) {
    // clips on one track may not overlap, so effects that overlap go on further lanes (Effects, Effects 2, ...)
    const lanes = [];
    [...spec.sfx].sort((x, y) => x.at - y.at).forEach((x, i) => {
      const clip = { id: `sfx-${i + 1}`, source: need(x.source, -1), in: r3(x.in ?? 0), out: r3((x.in ?? 0) + (x.dur ?? 1)), at: r3(x.at), gainDb: x.gainDb ?? -16, ...(x.fadeOut ? { fade: { out: x.fadeOut } } : {}) };
      const end = clip.at + (clip.out - clip.in);
      let lane = lanes.find((l) => l.end <= clip.at + 0.0005);
      if (!lane) { lane = { end: 0, clips: [] }; lanes.push(lane); }
      lane.clips.push(clip); lane.end = end;
    });
    lanes.forEach((l, i) => tracks.push({ id: i ? `sfx${i + 1}` : 'sfx', type: 'audio', name: i ? `Effects ${i + 1}` : 'Effects', clips: l.clips }));
  }
  if (total < 7) notes.push(`The reel is only ${total} s long.`);
  if (total > 45) notes.push(`The reel is ${total} s long; most viewers stop long before.`);

  const timeline = { fps: 30, duration: total, tracks, scenes, ...(spec.coverFrame ? { cover: r3(total - COVER_FRAME_SECONDS / 2) } : spec.cover !== undefined ? { cover: spec.cover } : {}) };
  if (spec.captions && (talkRanges.length || vo)) timeline.captions = { source: need(spec.captions.source ?? vo?.source, -1), highlight: 'word', maxWordsPerLine: 3, position: 'bottom-third', ...spec.captions };
  if (spec.scenes.some((sc) => sc.type === 'card' || sc.type === 'end') || !v1.length) timeline.background = roles.tok(roles.ink);

  const doc = {
    schema: 'nordle.doc/0.1', id: spec.id, title: spec.title, kind: 'video', brand: brand.id,
    ...(spec.colourway ? { colourway: spec.colourway } : {}),
    sizes: sizeIds,
    ...(spec.tags ? { tags: spec.tags } : {}),
    ...(spec.brief ? { brief: spec.brief } : {}),
    copy: { ...(spec.copy ?? {}), alt: { video: spec.alt ?? spec.copy?.alt?.video ?? spec.title, ...(spec.copy?.alt ?? {}) } },
    sources, timeline, layers,
  };
  return { doc, notes };
}
