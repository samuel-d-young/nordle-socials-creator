// The timeline: a ruler, then one lane for problems, scenes, titles and shapes, each video track (top track first), each sound
// track and the captions. Everything is drawn as CSS blocks placed by time (waveforms and the captions are canvases), kept
// between redraws by id so a drag or a zoom never rebuilds what it is touching. Editing by pointer is in video-drag.js.

import { h } from './dom.js';
import { state, update } from './state.js';
import { wordStates } from '/src/shared/cutlist.mjs';
import { V, onV, setV, doc, clock, clipsOf, durationOf, fileUrl, fpsOf, labelOfClip, lengthOf, secs, select, seek, sourceOf } from './video-state.js';
import { check, retryProblems, sourceProblems, waveOf, words } from './video-data.js';
import { drawWave, waveColours } from './video-wave.js';
import { attachPointer } from './video-drag.js';
import { addScene, toggleTrack } from './video-actions.js';

export const HEAD = 156;
const ROW = { ruler: 36, checks: 20, scenes: 28, layer: 28, track: 60, captions: 32 };
const MIN_PPS = 6;
const maxPps = (len) => Math.max(MIN_PPS * 2, Math.min(600, 24000 / Math.max(len, 1)));
export const clampPps = (v, len) => Math.min(Math.max(v, MIN_PPS), maxPps(len));

export const geo = { HEAD, pps: 80, len: 0 };

const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const px = (n) => `${Math.round(n * 100) / 100}px`;

export function mountTimeline(root, { onSource }) {
  const help = h('p', { id: 'vt-help', class: 'vt-sr' }, 'Timeline. Click a clip to select it. Space plays and pauses. S splits the selected clip at the playhead. Delete removes it. Left and right arrows move the playhead one frame, with Shift one second. Alt with left or right selects the previous or next clip. Plus and minus zoom. Press the question mark for every shortcut.');
  const scroller = h('div', { class: 'vt-scroll', role: 'application', tabindex: '0', 'aria-label': 'Timeline', 'aria-describedby': 'vt-help' });
  const content = h('div', { class: 'vt-content' });
  const rulerBody = h('div', { class: 'vt-rbody' });
  const ruler = h('div', { class: 'vt-ruler', 'data-lane': 'ruler' }, h('div', { class: 'vt-corner' }, h('span', { class: 'vt-clock', 'aria-live': 'off' }, '0:00.00')), rulerBody);
  const playhead = h('div', { class: 'vt-playhead', 'aria-hidden': 'true' }, h('i', { class: 'vt-rhead' }));
  const snapLine = h('div', { class: 'vt-snapline', 'aria-hidden': 'true' });
  const tip = h('div', { class: 'vt-tip', role: 'status' });
  const problems = h('div', { class: 'vt-problems hidden', role: 'alert' });
  content.append(ruler, playhead, snapLine);
  scroller.append(content);
  root.append(problems, scroller, help, tip);

  const lanes = new Map();      // lane key -> {row, head, body, cache: Map, kind}
  const pinEls = new Map();     // comment id -> element
  let order = '';
  let rulerSig = '';
  let waveHold = false;
  let holdTimer = null;
  let themeStamp = 0;

  // ---- lanes -----------------------------------------------------------------------------------------------------------------

  function makeLane(key, kind, headNode, height) {
    const body = h('div', { class: 'vt-body', style: { height: px(height) } });
    const head = h('div', { class: 'vt-head' }, headNode);
    const row = h('div', { class: `vt-lane vt-lane-${kind}`, 'data-lane': key }, head, body);
    const lane = { key, kind, row, head, body, cache: new Map() };
    lanes.set(key, lane);
    return lane;
  }

  /** Keep one element per item (by key), update only what changed, and put them in order. */
  function syncItems(lane, items, keyOf, make, patch) {
    const seen = new Set();
    for (const item of items) seen.add(keyOf(item));
    for (const [k, el] of lane.cache) if (!seen.has(k)) { el.remove(); lane.cache.delete(k); }
    let cursor = lane.body.firstChild;
    for (const item of items) {
      const k = keyOf(item);
      let el = lane.cache.get(k);
      if (!el) { el = make(item); lane.cache.set(k, el); }
      patch(el, item);
      if (el === cursor) cursor = cursor.nextSibling; else lane.body.insertBefore(el, cursor);
    }
  }

  const setSig = (el, sig, fn) => { if (el._sig !== sig) { el._sig = sig; fn(); } };

  // ---- the ruler ---------------------------------------------------------------------------------------------------------------

  function drawRuler(len, fps) {
    const sig = `${geo.pps}|${len}|${fps}`;
    if (sig === rulerSig) return;
    rulerSig = sig;
    const step = STEPS.find((s) => s * geo.pps >= 74) ?? STEPS.at(-1);
    const ticks = [];
    for (let t = 0; t <= len + 1e-6; t += step) {
      const x = t * geo.pps;
      ticks.push(h('span', { class: 'vt-tick', style: { left: px(x) } }, h('b', {}, clock(t).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1'))));
      const sub = step / 5;
      if (sub * geo.pps >= 9) for (let k = 1; k < 5; k++) { const sx = (t + sub * k) * geo.pps; if (sx <= len * geo.pps) ticks.push(h('span', { class: 'vt-tick minor', style: { left: px(sx) } })); }
    }
    const frame = geo.pps / fps;
    rulerBody.style.setProperty('--frame', frame >= 6 ? px(frame) : '0px');
    rulerBody.classList.toggle('frames', frame >= 6);
    const keep = [...rulerBody.querySelectorAll('.vt-pin')];
    rulerBody.replaceChildren(...ticks, ...keep);
  }

  function drawPins() {
    const comments = (state.review?.comments ?? []).map((c, i) => ({ c, n: i + 1 })).filter(({ c }) => typeof c.time === 'number');
    const seen = new Set(comments.map(({ c }) => c.id));
    for (const [id, el] of pinEls) if (!seen.has(id)) { el.remove(); pinEls.delete(id); }
    for (const { c, n } of comments) {
      let el = pinEls.get(c.id);
      if (!el) {
        el = h('button', { class: 'vt-pin', type: 'button', 'data-kind': 'pin', onclick: () => { seek(c.time); update({ focusComment: c.id, panel: 'review' }); } });
        pinEls.set(c.id, el);
        rulerBody.append(el);
      }
      el.dataset.id = c.id;
      el.style.left = px(c.time * geo.pps);
      el.classList.toggle('done', c.status === 'resolved');
      el.textContent = String(n);
      el.title = `${clock(c.time)}: ${c.text}`;
      el.setAttribute('aria-label', `Comment ${n} at ${clock(c.time)}: ${c.text}`);
    }
  }

  // ---- waveforms -------------------------------------------------------------------------------------------------------------

  function drawClipWave(el, clip, track, d, width) {
    const canvas = el._wave;
    const src = sourceOf(d, clip.source);
    const entry = src && src.type !== 'image' ? waveOf(clip.source) : null;
    if (!entry || entry.status !== 'ready' || !entry.data.hasAudio || !entry.data.peaks.length) { canvas.style.display = 'none'; canvas.dataset.ready = ''; return; }
    canvas.style.display = '';
    const base = track.type === 'video';
    const hpx = base ? 22 : 34;
    const key = `${Math.round(width)}|${clip.in}|${clip.out}|${hpx}|${base}|${themeStamp}|${entry.data.peaks.length}`;
    if (canvas.dataset.key === key) return;
    if (waveHold && canvas.dataset.key) return; // the zoom is still moving: the old drawing stretches until it settles
    canvas.dataset.key = key;
    canvas.dataset.ready = '1';
    canvas.classList.toggle('base', base);
    drawWave(canvas, entry.data, { from: clip.in, to: clip.out, w: width, h: hpx, base, colours: waveColours(el) });
  }

  // ---- blocks ------------------------------------------------------------------------------------------------------------------

  function makeClip() {
    const wave = h('canvas', { class: 'vt-wave', 'aria-hidden': 'true' });
    const el = h('div', { class: 'vt-clip', role: 'button', tabindex: '0', 'data-kind': 'clip' },
      wave, h('span', { class: 'vt-label' }), h('span', { class: 'vt-sub' }),
      h('i', { class: 'vt-h l', 'data-edge': 'l', 'aria-hidden': 'true' }), h('i', { class: 'vt-h r', 'data-edge': 'r', 'aria-hidden': 'true' }));
    el._wave = wave; el._label = el.children[1]; el._subEl = el.children[2];
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); select('clip', [el.dataset.id], { add: e.ctrlKey || e.metaKey }); } });
    return el;
  }

  function patchClip(el, { clip, track, d, anySolo }) {
    const src = sourceOf(d, clip.source);
    const dur = durationOf(clip, d);
    const left = clip.at * geo.pps;
    const width = Math.max(3, dur * geo.pps - 1);
    const muted = !!(clip.mute || track.mute || (anySolo && !track.solo));
    const selected = V.sel.kind === 'clip' && V.sel.ids.includes(clip.id);
    const problem = sourceProblems.get(clip.source) ?? '';
    const label = labelOfClip(clip);
    const sub = `${clip.source}${clip.speed && clip.speed !== 1 ? ` · ${clip.speed}x` : ''} · ${secs(dur)}`;
    const photoUrl = src?.type === 'image' && !String(src.path).startsWith('mount:') ? fileUrl(src.path) : '';
    setSig(el, [left, width, src?.type, muted, selected, label, sub, !!track.lock, problem, photoUrl, clip.id].join('|'), () => {
      el.dataset.id = clip.id;
      el.style.left = px(left);
      el.style.width = px(width);
      el.classList.toggle('video', track.type === 'video');
      el.classList.toggle('audio', track.type === 'audio');
      el.classList.toggle('photo', src?.type === 'image');
      el.classList.toggle('muted', muted);
      el.classList.toggle('selected', selected);
      el.classList.toggle('locked', !!track.lock);
      el.classList.toggle('problem', !!problem);
      el.style.backgroundImage = photoUrl ? `linear-gradient(90deg, var(--vt-photo-wash), transparent 80%), url("${photoUrl}")` : '';
      el._label.textContent = label;
      el._subEl.textContent = sub;
      el.title = problem ? `${label}: ${problem}` : `${label} (${sub}). Drag to move, drag an edge to trim.`;
      el.setAttribute('aria-pressed', String(selected));
      el.setAttribute('aria-label', `Clip ${label}, ${track.type} track ${track.name ?? track.id}, source ${clip.source}, starts at ${clock(clip.at)}, lasts ${secs(dur)}${muted ? ', muted' : ''}${track.lock ? ', track locked' : ''}${problem ? `, problem: ${problem}` : ''}`);
    });
    drawClipWave(el, clip, track, d, width);
  }

  function makeLayer() {
    const el = h('div', { class: 'vt-layer', role: 'button', tabindex: '0', 'data-kind': 'layer' },
      h('span', { class: 'vt-label' }), h('i', { class: 'vt-h l', 'data-edge': 'l', 'aria-hidden': 'true' }), h('i', { class: 'vt-h r', 'data-edge': 'r', 'aria-hidden': 'true' }));
    el._label = el.firstChild;
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); select('layer', [el.dataset.id]); } });
    return el;
  }

  const layerName = (l) => l.name ?? (l.type === 'text' ? (l.text ?? (l.runs ?? []).map((r) => r.text).join('')).replace(/\s+/g, ' ').trim().slice(0, 40) || l.id : l.id);

  function patchLayer(el, { layer, row }) {
    const left = layer.time.start * geo.pps;
    const width = Math.max(4, (layer.time.end - layer.time.start) * geo.pps - 1);
    const selected = V.sel.kind === 'layer' && V.sel.ids.includes(layer.id);
    const name = layerName(layer);
    const kf = (layer.animate ?? []).some((a) => a.keyframes);
    setSig(el, [left, width, row, selected, name, !!layer.lock, layer.type, kf].join('|'), () => {
      el.dataset.id = layer.id;
      el.style.left = px(left);
      el.style.width = px(width);
      el.style.top = px(row * ROW.layer + 2);
      el.classList.toggle('selected', selected);
      el.classList.toggle('locked', !!layer.lock);
      el.classList.toggle('kf', kf);
      el.dataset.type = layer.type;
      el._label.textContent = name;
      el.title = `${name} (${layer.type}), ${clock(layer.time.start)} to ${clock(layer.time.end)}${layer.lock ? ', locked' : ''}`;
      el.setAttribute('aria-pressed', String(selected));
      el.setAttribute('aria-label', `${layer.type === 'text' ? 'Title' : layer.type} ${name}, ${clock(layer.time.start)} to ${clock(layer.time.end)}${layer.lock ? ', locked' : ''}`);
    });
  }

  function makeScene() {
    const el = h('div', { class: 'vt-scene', role: 'button', tabindex: '0', 'data-kind': 'scene' },
      h('i', { class: 'vt-h l', 'data-edge': 'l', 'aria-hidden': 'true' }), h('span', { class: 'vt-label' }), h('i', { class: 'vt-h r', 'data-edge': 'r', 'aria-hidden': 'true' }));
    el._label = el.children[1];
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); select('scene', [el.dataset.id]); } });
    return el;
  }

  function patchScene(el, sc, i) {
    const left = sc.start * geo.pps;
    const width = Math.max(4, (sc.end - sc.start) * geo.pps - 1);
    const selected = V.sel.kind === 'scene' && V.sel.ids.includes(sc.id);
    setSig(el, [left, width, selected, sc.title, i].join('|'), () => {
      el.dataset.id = sc.id;
      el.style.left = px(left);
      el.style.width = px(width);
      el.classList.toggle('selected', selected);
      el.classList.toggle('b', i % 2 === 1);
      el._label.textContent = sc.title ?? sc.id;
      el.title = `Scene ${sc.title ?? sc.id}, ${clock(sc.start)} to ${clock(sc.end)}. Double-click to rename; drag an edge to move the boundary.`;
      el.setAttribute('aria-pressed', String(selected));
      el.setAttribute('aria-label', `Scene ${sc.title ?? sc.id}, ${clock(sc.start)} to ${clock(sc.end)}`);
    });
  }

  function makeMark() {
    return h('button', { class: 'vt-mark', type: 'button', 'data-kind': 'mark' });
  }
  function patchMark(el, { issue, i, at }) {
    setSig(el, `${issue.level}|${issue.code}|${at}|${issue.message}|${i}`, () => {
      el.dataset.id = String(i);
      el.style.left = px(at * geo.pps);
      el.className = `vt-mark ${issue.level === 'error' ? 'error' : 'warn'}`;
      el.title = `${issue.level === 'error' ? 'Problem' : 'Warning'} at ${clock(at)}: ${issue.message}`;
      el.setAttribute('aria-label', el.title);
      el.onclick = () => { seek(at); if (issue.clip) select('clip', [issue.clip]); update({ panel: 'check' }); };
    });
  }

  // ---- the captions lane (one canvas) ---------------------------------------------------------------------------------------

  function drawCaptions(lane, d, width) {
    let canvas = lane._canvas;
    if (!canvas) { canvas = h('canvas', { class: 'vt-caps', 'aria-hidden': 'true' }); lane._canvas = canvas; lane.body.append(canvas); }
    const ready = words.status === 'ready' && words.source;
    if (!ready) { canvas.style.display = 'none'; return; }
    let states;
    try { states = wordStates(d, { track: words.track, source: words.source }, words.list); } catch { canvas.style.display = 'none'; return; }
    const sig = `${Math.round(width)}|${geo.pps}|${themeStamp}|${states.map((s) => (s.kept ? Math.round(s.at * 100) : 'x')).join(',')}`;
    canvas.style.display = '';
    if (canvas.dataset.key === sig) return;
    canvas.dataset.key = sig;
    const w = Math.max(1, Math.min(24000, Math.round(width)));
    canvas.width = w; canvas.height = ROW.captions - 6;
    canvas.style.width = px(width);
    const ctx = canvas.getContext('2d');
    const cs = getComputedStyle(canvas);
    const fill = cs.getPropertyValue('--vt-cap').trim() || '#b9b4a6';
    const ink = cs.getPropertyValue('--vt-cap-ink').trim() || '#17191b';
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    let n = 0;
    for (const s of states) {
      if (!s.kept) continue;
      const x = s.at * geo.pps;
      const wd = Math.max(1, (s.end - s.start) * geo.pps - 1);
      ctx.fillStyle = fill; ctx.fillRect(x, 0, wd, canvas.height);
      if (wd > 22) { ctx.fillStyle = ink; ctx.save(); ctx.beginPath(); ctx.rect(x, 0, wd, canvas.height); ctx.clip(); ctx.fillText(s.text, x + 3, canvas.height / 2); ctx.restore(); }
      n++;
    }
    canvas.dataset.words = String(n);
  }

  // ---- track headers ---------------------------------------------------------------------------------------------------------

  function trackHead(lane, track) {
    const selected = V.sel.kind === 'track' && V.sel.ids.includes(track.id);
    const name = track.name ?? track.id;
    const sig = [name, !!track.mute, !!track.solo, !!track.lock, selected, track.type].join('|');
    if (lane.head._sig === sig) return;
    lane.head._sig = sig;
    lane.head.dataset.kind = 'track';
    lane.head.dataset.id = track.id;
    lane.head.classList.toggle('selected', selected);
    const btn = (key, letter, label, on) => h('button', { class: `vt-tb${on ? ' on' : ''}`, type: 'button', 'data-act': key, 'aria-pressed': String(on), 'aria-label': `${label} track ${name}`, title: `${label} this track`, onclick: (e) => { e.stopPropagation(); toggleTrack(track.id, key); } }, letter);
    const nameBtn = h('button', { class: 'vt-name', type: 'button', title: `${name}: select the track to rename or change it`, onclick: () => select('track', [track.id]) },
      h('span', { class: 'vt-kind' }, track.type === 'video' ? 'Picture' : 'Sound'), h('b', {}, name));
    lane.head.replaceChildren(nameBtn, h('span', { class: 'vt-tbtns' }, btn('mute', 'M', 'Mute', !!track.mute), btn('solo', 'S', 'Solo', !!track.solo), btn('lock', 'L', 'Lock', !!track.lock)));
  }

  // ---- the whole thing -------------------------------------------------------------------------------------------------------

  function updateGeometry() {
    const d = doc();
    const len = lengthOf(d);
    const avail = Math.max(240, scroller.clientWidth - HEAD - 30);
    geo.len = len;
    geo.pps = V.fit ? clampPps(avail / Math.max(len, 1), len) : clampPps(V.pps, len);
    V.pps = geo.pps; // what is really in use (zoom buttons start from it)
    return { d, len };
  }

  function render({ force = false } = {}) {
    const d = doc();
    if (!d?.timeline) return;
    if (force) for (const lane of lanes.values()) for (const el of lane.cache.values()) el._sig = null;
    const { len } = updateGeometry();
    const fps = fpsOf(d);
    const width = len * geo.pps;
    content.style.width = px(HEAD + width + 30);
    for (const lane of lanes.values()) lane.body.style.width = px(width + 30);
    rulerBody.style.width = px(width + 30);

    const tracks = d.timeline.tracks;
    const anySolo = tracks.some((t) => t.solo);
    const rows = [];

    // problems from the checks (and footage that cannot be read)
    const marks = check.issues.map((issue, i) => ({ issue, i, at: issue.time ?? (issue.clip ? clipsOf(d).find((c) => c.clip.id === issue.clip)?.clip.at : undefined) })).filter((m) => typeof m.at === 'number');
    {
      // always there (so the lanes below do not jump when the first check finishes); it says what the check found
      const lane = lanes.get('checks') ?? makeLane('checks', 'checks', h('span', { class: 'vt-title' }, 'Problems'), ROW.checks);
      syncItems(lane, marks, (m) => `${m.i}`, makeMark, patchMark);
      lane._note ??= lane.body.appendChild(h('span', { class: 'vt-empty' }));
      const unplaced = check.issues.length - marks.length;
      const msg = check.status === 'running' && !check.issues.length ? 'Checking…' : check.status === 'error' ? 'The check could not run. See the Check tab.'
        : check.status === 'idle' ? '' : !check.issues.length ? 'No problems found.' : !marks.length ? `${check.issues.length} to look at: see the Check tab.` : unplaced > 0 ? `${unplaced} more in the Check tab.` : '';
      if (lane._note.textContent !== msg) lane._note.textContent = msg;
      lane._note.style.left = marks.length ? `${(Math.max(...marks.map((m) => m.at)) + 0.3) * geo.pps}px` : '10px';
      rows.push(lane);
    }

    // scenes
    {
      const lane = lanes.get('scenes') ?? makeLane('scenes', 'scenes', h('span', { class: 'vt-title' }, 'Scenes'), ROW.scenes);
      if (!lane._add) { lane._add = h('button', { class: 'vt-tb vt-add', type: 'button', 'aria-label': 'Add a scene at the playhead', title: 'Add a scene at the playhead (splits the scene under it)', onclick: () => addScene() }, '+'); lane.head.append(lane._add); }
      const scenes = d.timeline.scenes ?? [];
      syncItems(lane, scenes.map((sc, i) => ({ sc, i })), (s) => s.sc.id, makeScene, (el, s) => patchScene(el, s.sc, s.i));
      rows.push(lane);
    }

    // titles and shapes: overlapping ones stack in sub-rows
    {
      const layers = (d.layers ?? []).filter((l) => l.time);
      const ends = [];
      const placed = layers.map((layer) => {
        let row = ends.findIndex((e) => e <= layer.time.start + 1e-6);
        if (row < 0) { row = ends.length; ends.push(0); }
        ends[row] = layer.time.end;
        return { layer, row };
      });
      const height = Math.max(1, ends.length) * ROW.layer + 4;
      const lane = lanes.get('layers') ?? makeLane('layers', 'layers', h('span', { class: 'vt-title' }, 'Titles'), height);
      lane.body.style.height = px(height);
      lane.body.style.width = px(width + 30);
      syncItems(lane, placed, (p) => p.layer.id, makeLayer, patchLayer);
      if (!placed.length && !lane._empty) { lane._empty = h('span', { class: 'vt-empty' }, 'Titles and shapes with a time appear here.'); lane.body.append(lane._empty); }
      if (lane._empty) lane._empty.style.display = placed.length ? 'none' : '';
      rows.push(lane);
    }

    // picture tracks (the top track is listed last in the document), then sound tracks
    const picture = tracks.map((track, ti) => ({ track, ti })).filter((t) => t.track.type === 'video').reverse();
    const sound = tracks.map((track, ti) => ({ track, ti })).filter((t) => t.track.type === 'audio');
    for (const { track } of [...picture, ...sound]) {
      const key = `track:${track.id}`;
      const lane = lanes.get(key) ?? makeLane(key, track.type, h('span'), ROW.track);
      trackHead(lane, track);
      lane.row.classList.toggle('dim', anySolo && !track.solo);
      lane.row.classList.toggle('locked', !!track.lock);
      syncItems(lane, track.clips.map((clip) => ({ clip, track, d, anySolo })), (c) => c.clip.id, makeClip, patchClip);
      rows.push(lane);
    }

    // captions
    if (d.timeline.captions && d.timeline.captions.enabled !== false && words.status === 'ready') {
      const lane = lanes.get('captions') ?? makeLane('captions', 'captions', h('span', { class: 'vt-title' }, 'Captions'), ROW.captions);
      drawCaptions(lane, d, width + 30);
      rows.push(lane);
    }

    // drop lanes that are gone, and reorder when the set of lanes changed
    const keys = rows.map((l) => l.key);
    for (const [k, lane] of lanes) if (!keys.includes(k)) { lane.row.remove(); lanes.delete(k); }
    const nextOrder = keys.join('|');
    if (nextOrder !== order) {
      order = nextOrder;
      content.replaceChildren(ruler, ...rows.map((l) => l.row), playhead, snapLine);
    }

    drawRuler(len, fps);
    drawPins();
    placePlayhead();
    renderProblems();
  }

  function renderProblems() {
    const list = [...sourceProblems.entries()];
    problems.classList.toggle('hidden', !list.length);
    if (!list.length) { problems.replaceChildren(); return; }
    problems.replaceChildren(
      h('div', { class: 'vt-problem-text' }, ...list.map(([id, msg]) => h('p', {}, h('b', {}, `Footage "${id}" cannot be read. `), msg))),
      h('div', { class: 'vt-problem-fix' }, h('p', {}, 'Plug the drive in again, or correct the folder for that mount in nordle.local.json, then press Try again.'), h('button', { class: 'btn sm', type: 'button', onclick: () => retryProblems() }, 'Try again')));
  }

  // ---- the playhead -----------------------------------------------------------------------------------------------------------

  function placePlayhead() {
    const x = HEAD + V.playhead * geo.pps;
    playhead.style.transform = `translateX(${px(x)})`;
    ruler.querySelector('.vt-clock').textContent = clock(V.playhead);
  }

  function ensureVisible(t = V.playhead, { follow = false } = {}) {
    const x = HEAD + t * geo.pps;
    const left = scroller.scrollLeft;
    const view = scroller.clientWidth;
    if (x < left + HEAD + 8) scroller.scrollLeft = Math.max(0, x - HEAD - (follow ? view * 0.25 : 40));
    else if (x > left + view - 40) scroller.scrollLeft = x - view + (follow ? view * 0.45 : 80);
  }

  onV('playhead', () => { placePlayhead(); ensureVisible(V.playhead, { follow: V.playing }); });

  // ---- zoom -------------------------------------------------------------------------------------------------------------------

  let anchor = null; // {t, x}: the moment that should stay where it is on screen while the zoom changes
  onV('zoom', () => {
    const oldPps = geo.pps;
    const oldScroll = scroller.scrollLeft;
    const view = scroller.clientWidth;
    const px0 = HEAD + V.playhead * oldPps - oldScroll;
    const visible = px0 >= HEAD && px0 <= view;
    const a = anchor ?? (visible ? { t: V.playhead, x: px0 } : { t: (oldScroll + HEAD + (view - HEAD) / 2 - HEAD) / oldPps, x: HEAD + (view - HEAD) / 2 });
    anchor = null;
    waveHold = true;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => { waveHold = false; render(); }, 140);
    render();
    scroller.scrollLeft = V.fit ? 0 : Math.max(0, HEAD + a.t * geo.pps - a.x);
  });

  scroller.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const rect = scroller.getBoundingClientRect();
    anchor = { t: (e.clientX - rect.left + scroller.scrollLeft - HEAD) / geo.pps, x: e.clientX - rect.left };
    setV({ fit: false, pps: clampPps(geo.pps * (e.deltaY < 0 ? 1.18 : 1 / 1.18), geo.len) });
  }, { passive: false });

  // ---- wiring -----------------------------------------------------------------------------------------------------------------

  attachPointer({ content, scroller, ruler, geo, render, tip, snapLine, onSource });

  for (const topic of ['sel', 'data', 'words', 'check', 'flags', 'misc']) onV(topic, () => render());
  new ResizeObserver(() => { if (V.fit) render(); }).observe(scroller);
  const themeBump = () => { themeStamp++; render(); };
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', themeBump);
  new MutationObserver(themeBump).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  return { render, scroller, ensureVisible, tip, forceRender: () => render({ force: true }) };
}
