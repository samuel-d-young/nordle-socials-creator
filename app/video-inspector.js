// The Inspector tab: everything about the selected clip, title, scene or track, in plain words. Each change is one patch through
// commit() (so undo, history and Claude's diffs see it); the server checks the whole document, and its message is shown if it
// refuses (for example a title that would end before it starts).

import { h, icon, preserveFocus, toast } from './dom.js';
import { state } from './state.js';
import { findClip } from '/src/shared/cutlist.mjs';
import { V, onV, clock, currentSize, doc, durationOf, fileUrl, fpsOf, layerIndex, labelOfClip, sceneIndex, secs, seek, sourceOf, trackIndex, videoApi } from './video-state.js';
import { ensureProxy, sourceProblems } from './video-data.js';
import { api } from './api.js';
import { apply, deleteSelected, moveClipTo, setClipField, setClipFields, setDocField, setLayerField, setLayerTime, setSceneEdges, setTrackName, splitSelected, toggleTrack, trimClipTo, renameScene } from './video-actions.js';

const PRESETS = ['fade-in', 'fade-out', 'rise-in', 'rise-out', 'fall-in', 'pop', 'slide-in', 'slide-out', 'wipe', 'wipe-out', 'typewriter', 'word-by-word'];
const EASES = ['linear', 'in', 'out', 'in-out', 'in-cubic', 'out-cubic', 'in-out-cubic', 'out-back'];
const CLIP_EASES = ['linear', 'in', 'out', 'in-out'];
const KF_PROPS = [['opacity', 'Opacity'], ['scale', 'Scale'], ['rotate', 'Rotation (degrees)'], ['x', 'Left-right (x, %)'], ['y', 'Up-down (y, %)'], ['w', 'Width (%)'], ['h', 'Height (%)']];
const DIRECTIONS = ['left', 'right', 'up', 'down'];
const HINT = {
  speed: 'Playing speed. 2 is twice as fast, 0.5 is half speed. Sound keeps its pitch.',
  fit: 'Cover fills the picture and crops. Contain shows the whole footage over a soft blurred copy. Fill stretches it.',
  focal: 'The point of the footage that stays in the middle of the crop (for 16:9 footage in a tall picture).',
  zoom: 'A slow push in (or pull out). 1 is the whole crop, 1.2 is 20% closer.',
  pan: 'Slide the crop across the footage over the length of the clip.',
  grade: 'A light, consistent look: neutral, soft (a hint of warmth) or warm.',
  denoise: 'Smooth camera noise (for footage shot in low light).',
  cleanAudio: 'Cut wind, crowd hum and air conditioning out of the sound. Speech is kept.',
  transition: 'How this clip comes in from the one before it.',
  gain: 'Volume change in decibels. 0 is unchanged, -6 is about half as loud.',
  duck: 'Lower this sound while another track is talking.',
};

const PARAMS = {
  'rise-in': [['distance', 'Distance (px)', 'number']], 'rise-out': [['distance', 'Distance (px)', 'number']], 'fall-in': [['distance', 'Distance (px)', 'number']],
  pop: [['from', 'Start size (1 = full)', 'number']],
  'slide-in': [['from', 'Comes in from', 'dir'], ['distance', 'Distance (px)', 'number']], 'slide-out': [['to', 'Leaves towards', 'dir'], ['distance', 'Distance (px)', 'number']],
  wipe: [['from', 'Wipes in from', 'dir']], 'wipe-out': [['from', 'Wipes out towards', 'dir']],
};

const row = (label, control, hint) => h('div', { class: 'row' }, h('label', { title: hint }, label), h('div', { class: 'grow' }, control));
const group = (title, ...kids) => h('div', { class: 'group' }, h('h3', {}, title), ...kids);
const pair = (...cells) => h('div', { class: 'vi-pair' }, cells);

function num(key, value, { min, max, step, placeholder, optional = false } = {}, onSet) {
  return h('input', {
    class: 'field num', type: 'number', step: step ?? 'any', min, max, value: value ?? '', placeholder: placeholder ?? '', 'data-field': key,
    onchange: (e) => {
      const raw = e.target.value.trim();
      if (raw === '') { if (optional) onSet(undefined); else e.target.value = value ?? ''; return; }
      const n = Number(raw);
      if (!Number.isFinite(n)) { toast('That is not a number.', 'error'); e.target.value = value ?? ''; return; }
      onSet(n);
    },
  });
}
const choose = (key, value, options, onSet, { none } = {}) => h('select', { class: 'field', 'data-field': key, onchange: (e) => onSet(e.target.value === '' ? undefined : e.target.value) },
  none ? h('option', { value: '', selected: value === undefined }, none) : null,
  options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, selected: v === value }, l); }));
const tick = (key, value, label, onSet) => h('label', { class: 'vi-check' }, h('input', { type: 'checkbox', checked: !!value, 'data-field': key, onchange: (e) => onSet(e.target.checked) }), label);
const text = (key, value, onSet, { multiline = false, placeholder = '' } = {}) => h(multiline ? 'textarea' : 'input', { class: 'field', rows: multiline ? 3 : undefined, value: value ?? '', placeholder, 'data-field': key, onchange: (e) => onSet(e.target.value) });

export function mountInspector(root, { monitor, sourceMonitor }) {
  const focalMedia = new Map(); // source id -> proxy url
  let kfLabel = null;

  const active = () => state.route.name === 'video' && state.panel === 'inspector';

  function build() {
    kfLabel = null;
    const d = doc();
    if (!d?.timeline) { root.replaceChildren(); return; }
    if (state.versionView) { root.replaceChildren(h('div', { class: 'empty' }, `Viewing ${state.versionView.name}. Go back to the current version to edit.`)); return; }
    const { kind, ids } = V.sel;
    if (kind === 'clip' && ids.length > 1) { root.replaceChildren(buildMany(d, ids)); return; }
    if (kind === 'clip') { const ref = findClip(d, ids[0]); if (ref) { root.replaceChildren(...buildClip(d, ref)); return; } }
    if (kind === 'layer') { const i = layerIndex(d, ids[0]); if (i >= 0) { root.replaceChildren(...buildLayer(d, d.layers[i], i)); return; } }
    if (kind === 'scene') { const i = sceneIndex(d, ids[0]); if (i >= 0) { root.replaceChildren(...buildScene(d, d.timeline.scenes[i])); return; } }
    if (kind === 'track') { const i = trackIndex(d, ids[0]); if (i >= 0) { root.replaceChildren(...buildTrack(d, d.timeline.tracks[i])); return; } }
    root.replaceChildren(...buildDocument(d));
  }

  // ---- nothing selected -------------------------------------------------------------------------------------------------------

  function buildDocument(d) {
    const cap = d.timeline.captions;
    const problems = [...sourceProblems.entries()];
    return [
      h('div', { class: 'vi-hint' }, h('b', {}, 'Click a clip, a title, a scene or a track'), ' in the timeline to change it here. Press ', h('kbd', {}, '?'), ' for the keyboard shortcuts.'),
      group('This video',
        row('Frame rate', h('span', {}, `${fpsOf(d)} fps`)),
        row('Length', num('doc-duration', d.timeline.duration, { min: 0.1, max: 900, step: 0.01 }, (v) => setDocField('/timeline/duration', v, 'Set the length')), 'How long the video runs. Clips stop being drawn after it.'),
        row('Sizes', h('span', {}, state.sizes.map((s) => `${s.id} (${s.w}x${s.h})`).join(', ')))),
      cap ? group('Captions',
        row('Show', tick('cap-enabled', cap.enabled !== false, 'Captions on', (v) => setDocField('/timeline/captions/enabled', v ? undefined : false, v ? 'Captions on' : 'Captions off'))),
        row('Words from', h('span', {}, cap.source)),
        row('Highlight', choose('cap-highlight', cap.highlight ?? 'word', ['word', 'line', 'none'], (v) => setDocField('/timeline/captions/highlight', v, 'Caption highlight'))),
        row('Position', choose('cap-position', cap.position ?? 'bottom-third', ['top-third', 'center', 'bottom-third'], (v) => setDocField('/timeline/captions/position', v, 'Caption position'))),
        row('Words a line', num('cap-words', cap.maxWordsPerLine ?? 4, { min: 1, max: 12, step: 1 }, (v) => setDocField('/timeline/captions/maxWordsPerLine', v, 'Caption line length')))) : null,
      group('Footage',
        (d.sources ?? []).map((s) => h('div', { class: `vi-source${sourceProblems.has(s.id) ? ' bad' : ''}` }, h('b', {}, s.id), ` ${s.type}`, h('div', { class: 'muted' }, s.path), sourceProblems.has(s.id) ? h('div', { class: 'vi-bad' }, sourceProblems.get(s.id)) : null)),
        problems.length ? null : h('p', { class: 'muted' }, 'Footage stays where it is on your drives. Nothing is copied into the project.')),
    ];
  }

  function buildMany(d, ids) {
    return group(`${ids.length} clips selected`,
      h('p', { class: 'muted' }, 'Split cuts each of them at the playhead (the ones it is inside). Delete removes them all. Click one clip to change its settings.'),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => splitSelected() }, icon('split', 14), 'Split at the playhead'), h('button', { class: 'btn danger', type: 'button', onclick: () => deleteSelected() }, icon('trash', 14), 'Delete')),
      h('ul', { class: 'vi-list' }, ids.map((id) => { const r = findClip(d, id); return h('li', {}, r ? `${labelOfClip(r.clip)} (${r.track.name ?? r.track.id}, ${clock(r.clip.at)})` : id); })));
  }

  // ---- a clip ----------------------------------------------------------------------------------------------------------------

  function buildClip(d, ref) {
    const c = ref.clip;
    const src = sourceOf(d, c.source);
    const image = src?.type === 'image';
    const audioOnly = ref.track.type === 'audio' || src?.type === 'audio';
    const dur = durationOf(c, d);
    const speed = c.speed ?? 1;
    const set = (parts, v, note) => setClipField(c.id, parts, v, note ?? `Change ${c.id}`);
    const setPoint = (parts, axis, value, current) => setClipField(c.id, parts, { x: axis === 'x' ? value : current?.x ?? 0.5, y: axis === 'y' ? value : current?.y ?? 0.5 }, `Change ${c.id}`);
    const sections = [];
    sections.push(group(labelOfClip(c),
      h('p', { class: 'muted vi-meta' }, `${audioOnly ? 'Sound' : image ? 'Photo' : 'Picture'} from "${c.source}" on track "${ref.track.name ?? ref.track.id}"${ref.track.lock ? ' (locked)' : ''}. Lasts ${secs(dur)}.`),
      sourceProblems.has(c.source) ? h('p', { class: 'vi-bad', role: 'alert' }, sourceProblems.get(c.source)) : null,
      h('div', { class: 'row vi-buttons' },
        !image ? h('button', { class: 'btn sm', type: 'button', 'data-act': 'look-source', title: 'Play the footage of this clip in the monitor to find a better start or end', onclick: () => sourceMonitor() }, icon('film', 14), 'Look at the footage') : null,
        h('button', { class: 'btn sm', type: 'button', onclick: () => seek(c.at) }, 'Playhead to start'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => splitSelected() }, icon('split', 14), 'Split here'),
        h('button', { class: 'btn sm danger', type: 'button', 'data-act': 'delete-clip', onclick: () => deleteSelected() }, icon('trash', 14), 'Delete')),
      row('Label', text('clip-note', c.note ?? '', (v) => set(['note'], v.trim() || undefined, `Label ${c.id}`), { placeholder: c.id }), 'A name to show on the timeline instead of the clip id.')));

    sections.push(group('Where it sits',
      row('Starts at', num('clip-at', c.at, { min: 0, step: 0.01 }, (v) => moveClipTo(c.id, v)), 'Where on the timeline the clip starts, in seconds. Moving never overlaps another clip.'),
      row(image ? 'Shown for' : 'Lasts', num('clip-duration', Number(dur.toFixed(3)), { min: 0.04, step: 0.01 }, (v) => trimClipTo(c.id, { out: c.in + v * speed })), image ? 'A photo can be stretched to any length.' : 'The clip is shortened or lengthened at its end.'),
      !image ? row('Source in', num('clip-in', c.in, { min: 0, step: 0.01 }, (v) => trimClipTo(c.id, { in: v })), 'Where in the footage the clip starts (seconds).') : null,
      !image ? row('Source out', num('clip-out', c.out, { min: 0.04, step: 0.01 }, (v) => trimClipTo(c.id, { out: v })), 'Where in the footage the clip ends (seconds).') : null,
      !audioOnly && !image ? row('Speed', num('clip-speed', c.speed ?? 1, { min: 0.25, max: 4, step: 0.05, optional: true, placeholder: '1' }, (v) => set(['speed'], v === 1 ? undefined : v, `Speed of ${c.id}`)), HINT.speed) : null));

    if (!audioOnly) {
      sections.push(group('Picture',
        row('Fit', choose('clip-fit', c.fit ?? 'cover', ['cover', 'contain', 'fill'], (v) => set(['fit'], v === 'cover' ? undefined : v)), HINT.fit),
        row('Focal point', focalPicker(c, src), HINT.focal),
        row('Grade', choose('clip-grade', c.grade ?? 'none', ['none', 'neutral', 'soft', 'warm'], (v) => set(['grade'], v === 'none' ? undefined : v)), HINT.grade),
        row('Denoise', tick('clip-denoise', c.denoise, 'Smooth camera noise', (v) => set(['denoise'], v ? true : undefined)), HINT.denoise)));

      const z = c.zoom ?? {};
      const pan = c.pan ?? {};
      sections.push(group('Movement',
        row('Zoom', pair(
          num('zoom-from', z.from, { min: 1, max: 4, step: 0.01, optional: true, placeholder: 'from' }, (v) => set(['zoom', 'from'], v)),
          num('zoom-to', z.to, { min: 1, max: 4, step: 0.01, optional: true, placeholder: 'to' }, (v) => set(['zoom', 'to'], v))), HINT.zoom),
        z.from !== undefined || z.to !== undefined ? row('Zoom easing', choose('zoom-ease', z.ease ?? 'linear', CLIP_EASES, (v) => set(['zoom', 'ease'], v === 'linear' ? undefined : v))) : null,
        row('Pan from', pair(
          num('pan-from-x', pan.from?.x, { min: 0, max: 1, step: 0.01, optional: true, placeholder: 'x' }, (v) => (v === undefined ? set(['pan', 'from'], undefined) : setPoint(['pan', 'from'], 'x', v, pan.from))),
          num('pan-from-y', pan.from?.y, { min: 0, max: 1, step: 0.01, optional: true, placeholder: 'y' }, (v) => (v === undefined ? set(['pan', 'from'], undefined) : setPoint(['pan', 'from'], 'y', v, pan.from)))), HINT.pan),
        row('Pan to', pair(
          num('pan-to-x', pan.to?.x, { min: 0, max: 1, step: 0.01, optional: true, placeholder: 'x' }, (v) => (v === undefined ? set(['pan', 'to'], undefined) : setPoint(['pan', 'to'], 'x', v, pan.to))),
          num('pan-to-y', pan.to?.y, { min: 0, max: 1, step: 0.01, optional: true, placeholder: 'y' }, (v) => (v === undefined ? set(['pan', 'to'], undefined) : setPoint(['pan', 'to'], 'y', v, pan.to))))),
        c.pan ? row('Pan easing', choose('pan-ease', pan.ease ?? 'linear', CLIP_EASES, (v) => set(['pan', 'ease'], v === 'linear' ? undefined : v))) : null,
        c.zoom || c.pan ? h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: () => setClipFields(c.id, [[['zoom'], undefined], [['pan'], undefined]], `Stop the movement of ${c.id}`) }, 'Remove zoom and pan')) : null));

      const tr = c.transition;
      sections.push(group('Transition in',
        row('Type', choose('tr-type', tr?.type ?? '', ['cut', 'fade', 'dip', 'slide'], (v) => (v === undefined ? set(['transition'], undefined) : set(['transition', 'type'], v)), { none: 'None' }), HINT.transition),
        tr && tr.type !== 'cut' ? row('Duration (s)', num('tr-duration', tr.duration, { min: 0.05, max: 2, step: 0.05, optional: true, placeholder: '0.4' }, (v) => set(['transition', 'duration'], v))) : null,
        tr?.type === 'slide' ? row('Comes from', choose('tr-direction', tr.direction ?? 'left', DIRECTIONS, (v) => set(['transition', 'direction'], v))) : null));
    }

    const duckOn = !!c.duck;
    const otherTracks = d.timeline.tracks.filter((t) => t.id !== ref.track.id).map((t) => t.id);
    sections.push(group('Sound',
      row('Volume (dB)', num('clip-gain', c.gainDb, { min: -60, max: 12, step: 0.5, optional: true, placeholder: '0' }, (v) => set(['gainDb'], v === 0 ? undefined : v)), HINT.gain),
      row('Mute', tick('clip-mute', c.mute, audioOnly ? 'Silence this clip' : 'Use the picture only (no sound)', (v) => set(['mute'], v ? true : undefined))),
      row('Noise reduction', tick('clip-clean-audio', c.cleanAudio, 'Cut wind and background hum', (v) => set(['cleanAudio'], v ? true : undefined)), HINT.cleanAudio),
      row('Fade (s)', pair(
        num('fade-in', c.fade?.in, { min: 0, step: 0.05, optional: true, placeholder: 'in' }, (v) => set(['fade', 'in'], v)),
        num('fade-out', c.fade?.out, { min: 0, step: 0.05, optional: true, placeholder: 'out' }, (v) => set(['fade', 'out'], v))), 'Fade the sound (and the picture, from and to black) in and out.'),
      row('Duck', tick('duck-on', duckOn, 'Lower this while another track talks', (v) => set(['duck'], v ? { under: otherTracks.find((t) => d.timeline.tracks.find((x) => x.id === t)?.type === 'video') ?? otherTracks[0], amountDb: -12 } : undefined, `Ducking of ${c.id}`)), HINT.duck),
      duckOn ? [
        row('Under track', choose('duck-under', c.duck.under, otherTracks, (v) => set(['duck', 'under'], v))),
        row('Lower by (dB)', num('duck-amount', c.duck.amountDb, { min: -60, max: 0, step: 1 }, (v) => set(['duck', 'amountDb'], v))),
        row('Timing (s)', pair(
          num('duck-attack', c.duck.attack, { min: 0, step: 0.05, optional: true, placeholder: 'attack' }, (v) => set(['duck', 'attack'], v)),
          num('duck-release', c.duck.release, { min: 0, step: 0.05, optional: true, placeholder: 'release' }, (v) => set(['duck', 'release'], v))), 'How early it ducks before the first word, and how long it takes to come back.'),
      ] : null));
    return sections;
  }

  /** A small picture of the footage: click it to say which point stays in the middle of the crop. */
  function focalPicker(c, src) {
    const size = currentSize();
    const f = c.focal ?? { x: 0.5, y: 0.5 };
    const media = h('div', { class: 'vi-focal-media' });
    const dot = h('i', { class: 'vi-dot', style: { left: `${f.x * 100}%`, top: `${f.y * 100}%` } });
    const crop = h('i', { class: 'vi-crop' });
    const box = h('div', { class: 'vi-focal', role: 'group', 'aria-label': 'Focal point picture. Click it to set the point that stays in the middle.', title: 'Click the picture to choose the point that stays in the middle of the crop' }, media, crop, dot);
    const placeCrop = (video) => {
      const ar = (video?.videoWidth || media.firstChild?.naturalWidth || 16) / (video?.videoHeight || media.firstChild?.naturalHeight || 9);
      box.style.aspectRatio = String(ar);
      const targetAr = size.w / size.h;
      const wFrac = Math.min(1, targetAr / ar), hFrac = Math.min(1, ar / targetAr);
      const cx = Math.min(1 - wFrac / 2, Math.max(wFrac / 2, f.x)), cy = Math.min(1 - hFrac / 2, Math.max(hFrac / 2, f.y));
      Object.assign(crop.style, { width: `${wFrac * 100}%`, height: `${hFrac * 100}%`, left: `${(cx - wFrac / 2) * 100}%`, top: `${(cy - hFrac / 2) * 100}%` });
    };
    const showVideo = (url) => {
      const v = h('video', { class: 'vi-focal-video', muted: true, preload: 'metadata', playsinline: true, src: url, 'aria-hidden': 'true' });
      v.muted = true;
      v.addEventListener('loadedmetadata', () => { placeCrop(v); v.currentTime = Math.min(c.in, Math.max(0, v.duration - 0.05)); });
      media.replaceChildren(v);
    };
    if (src?.type === 'image' && !String(src.path).startsWith('mount:')) {
      const pic = h('img', { src: fileUrl(src.path), alt: '', draggable: 'false' });
      pic.addEventListener('load', () => placeCrop());
      media.replaceChildren(pic);
    } else if (src?.type === 'video') {
      const have = focalMedia.get(src.id);
      if (have) showVideo(have);
      else {
        media.replaceChildren(h('button', { class: 'btn sm', type: 'button', 'data-act': 'show-footage', onclick: async (e) => {
          e.stopPropagation();
          const b = e.currentTarget; b.disabled = true; b.textContent = 'Making a small copy…';
          try { const url = await ensureProxy(src.id, (p) => { b.textContent = `Making a small copy… ${Math.round(p)}%`; }); focalMedia.set(src.id, url); showVideo(url); } catch (err) { b.disabled = false; b.textContent = 'Show the footage here'; toast(err.message, 'error'); }
        } }, 'Show the footage here'));
        api.get(videoApi(`proxy?doc=${encodeURIComponent(state.docId)}&source=${encodeURIComponent(src.id)}`)).then((r) => { if (r.ready && r.url) { focalMedia.set(src.id, r.url); if (box.isConnected) showVideo(r.url); } }).catch(() => {});
      }
    }
    placeCrop();
    box.addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      const r = box.getBoundingClientRect();
      const x = Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 100) / 100;
      const y = Math.round(Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) * 100) / 100;
      setClipField(c.id, ['focal'], { x, y }, `Focal point of ${c.id}`);
    });
    const readout = pair(
      num('focal-x', c.focal?.x, { min: 0, max: 1, step: 0.01, optional: true, placeholder: 'x' }, (v) => (v === undefined ? setClipField(c.id, ['focal'], undefined) : setClipField(c.id, ['focal'], { x: v, y: c.focal?.y ?? 0.5 }))),
      num('focal-y', c.focal?.y, { min: 0, max: 1, step: 0.01, optional: true, placeholder: 'y' }, (v) => (v === undefined ? setClipField(c.id, ['focal'], undefined) : setClipField(c.id, ['focal'], { x: c.focal?.x ?? 0.5, y: v }))));
    return h('div', {}, box, readout);
  }

  // ---- a title or shape ------------------------------------------------------------------------------------------------------

  function buildLayer(d, l, li) {
    const span = l.time.end - l.time.start;
    const set = (parts, v, note) => setLayerField(l.id, parts, v, note ?? `Change ${l.id}`);
    const out = [];
    out.push(group(`${l.type === 'text' ? 'Title' : l.type === 'group' ? 'Group' : l.type === 'image' ? 'Picture' : 'Shape'}: ${l.name ?? l.id}`,
      h('div', { class: 'row vi-buttons' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => seek(l.time.start) }, 'Playhead to start'),
        h('button', { class: 'btn sm danger', type: 'button', 'data-act': 'delete-layer', onclick: () => deleteSelected() }, icon('trash', 14), 'Delete')),
      l.type === 'text' ? row('Text', text('layer-text', l.text ?? '', (v) => set(['text'], v, `Text of ${l.id}`), { multiline: true })) : null,
      pair(
        row('On at', num('layer-start', l.time.start, { min: 0, step: 0.01 }, (v) => setLayerTime(l.id, { start: v, end: l.time.end })), 'The second it appears.'),
        row('Off at', num('layer-end', l.time.end, { min: 0.05, step: 0.01 }, (v) => setLayerTime(l.id, { start: l.time.start, end: v })), 'The second it goes away.')),
      row('Lock', tick('layer-lock', l.lock, 'Claude cannot change this', (v) => set(['lock'], v ? true : undefined, `${v ? 'Lock' : 'Unlock'} ${l.id}`)))));
    out.push(animations(d, l, li, span));
    return out;
  }

  function animations(d, l, li, span) {
    const set = (parts, v) => setLayerField(l.id, parts, v, `Animation of ${l.id}`);
    const list = l.animate ?? [];
    const presets = list.map((a, k) => ({ a, k })).filter((x) => !x.a.keyframes);
    const kfEntry = list.map((a, k) => ({ a, k })).find((x) => x.a.keyframes);
    const addPreset = choose('layer-add-preset', '', PRESETS, () => {}, { none: 'Add an animation…' });
    addPreset.onchange = (e) => {
      const preset = e.target.value;
      if (!preset) return;
      apply((dd) => {
        const i = layerIndex(dd, l.id);
        const entry = { preset, duration: preset.endsWith('-out') ? 0.4 : 0.5 };
        return dd.layers[i].animate ? [{ op: 'add', path: `/layers/${i}/animate/-`, value: entry }] : [{ op: 'add', path: `/layers/${i}/animate`, value: [entry] }];
      }, `Animate ${l.id}`);
    };
    const removeEntry = (k) => apply((dd) => {
      const i = layerIndex(dd, l.id);
      return dd.layers[i].animate.length === 1 ? [{ op: 'remove', path: `/layers/${i}/animate` }] : [{ op: 'remove', path: `/layers/${i}/animate/${k}` }];
    }, `Remove an animation of ${l.id}`);

    const presetRows = presets.map(({ a, k }) => h('div', { class: 'vi-anim', 'data-anim': String(k) },
      h('div', { class: 'vi-anim-head' }, h('b', {}, a.preset), h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': `Remove the ${a.preset} animation`, title: 'Remove this animation', onclick: () => removeEntry(k) }, icon('x', 13))),
      pair(
        row('Starts (s)', num(`anim-${k}-at`, a.at, { min: 0, step: 0.05, optional: true, placeholder: a.preset.endsWith('-out') ? 'at the end' : '0' }, (v) => set(['animate', k, 'at'], v)), 'Seconds after the title appears.'),
        row('Lasts (s)', num(`anim-${k}-duration`, a.duration, { min: 0.05, step: 0.05, optional: true, placeholder: 'default' }, (v) => set(['animate', k, 'duration'], v)))),
      row('Easing', choose(`anim-${k}-ease`, a.ease ?? '', EASES, (v) => set(['animate', k, 'ease'], v), { none: 'Brand default' })),
      (PARAMS[a.preset] ?? []).map(([key, label, type]) => row(label, type === 'dir'
        ? choose(`anim-${k}-${key}`, a.params?.[key] ?? '', DIRECTIONS, (v) => set(['animate', k, 'params', key], v), { none: 'Default' })
        : num(`anim-${k}-${key}`, a.params?.[key], { step: 'any', optional: true, placeholder: 'default' }, (v) => set(['animate', k, 'params', key], v))))));

    // keyframes: one animation entry holds them all, `t` is seconds after the title appears
    const propNow = h('select', { class: 'field', 'data-field': 'kf-prop', 'aria-label': 'Which property to keyframe' }, KF_PROPS.map(([v, lab]) => h('option', { value: v }, lab)));
    kfLabel = h('span', { class: 'muted' });
    const paintKfLabel = () => { const t = V.playhead - l.time.start; kfLabel.textContent = t >= 0 && t <= span ? `Playhead is ${Number(t.toFixed(2))} s into the title.` : 'Move the playhead onto the title to add a keyframe.'; };
    paintKfLabel();
    kfLabel._paint = paintKfLabel;
    const kfs = kfEntry ? kfEntry.a.keyframes.map((kf, m) => ({ kf, m })).sort((x, y) => x.kf.t - y.kf.t || x.m - y.m) : [];
    const kfRows = kfs.map(({ kf, m }) => h('div', { class: 'vi-kf', 'data-kf': String(m) },
      choose(`kf-${m}-prop`, kf.prop, KF_PROPS, (v) => set(['animate', kfEntry.k, 'keyframes', m, 'prop'], v)),
      num(`kf-${m}-t`, kf.t, { min: 0, step: 0.05 }, (v) => set(['animate', kfEntry.k, 'keyframes', m, 't'], v)),
      num(`kf-${m}-value`, kf.value, { step: 'any' }, (v) => set(['animate', kfEntry.k, 'keyframes', m, 'value'], v)),
      choose(`kf-${m}-ease`, kf.ease ?? '', EASES, (v) => set(['animate', kfEntry.k, 'keyframes', m, 'ease'], v), { none: 'default' }),
      h('button', { class: 'btn sm ghost', type: 'button', 'aria-label': `Delete the ${kf.prop} keyframe at ${kf.t} s`, title: 'Delete this keyframe', onclick: () => deleteKeyframe(m) }, icon('x', 13))));

    return group('Animation',
      list.length ? null : h('p', { class: 'muted' }, 'This title appears and disappears without moving. Add an animation, or keyframes to animate it yourself.'),
      presetRows,
      row('Add', addPreset),
      h('h4', { class: 'vi-sub' }, 'Keyframes'),
      h('p', { class: 'muted vi-kf-help' }, 'A keyframe sets a property to a value at a moment (seconds after the title appears). Between two keyframes of the same property it moves smoothly.'),
      kfs.length ? h('div', { class: 'vi-kfs', role: 'list' }, h('div', { class: 'vi-kf head', 'aria-hidden': 'true' }, h('span', {}, 'Property'), h('span', {}, 'At (s)'), h('span', {}, 'Value'), h('span', {}, 'Easing'), h('span')), kfRows) : null,
      h('div', { class: 'row' }, propNow, h('button', { class: 'btn sm', type: 'button', 'data-act': 'add-keyframe', onclick: () => addKeyframe(l, propNow.value, kfEntry, span) }, icon('plus', 14), 'Add keyframe at playhead')),
      kfLabel);
  }

  function keyframeDefault(l, prop) {
    if (prop === 'opacity' || prop === 'scale') return 1;
    if (prop === 'rotate') return 0;
    const lay = l.layout ?? {};
    const v = lay[prop];
    return typeof v === 'number' ? v : prop === 'w' ? 60 : prop === 'h' ? 20 : 50;
  }

  function addKeyframe(l, prop, kfEntry, span) {
    const t = Math.round((V.playhead - l.time.start) * 100) / 100;
    if (!(t >= 0 && t <= span + 1e-6)) { toast(`Move the playhead onto "${l.id}" first (it is on from ${clock(l.time.start)} to ${clock(l.time.end)}), then add the keyframe.`, 'error'); return Promise.resolve(false); }
    const value = keyframeDefault(l, prop);
    return apply((dd) => {
      const i = layerIndex(dd, l.id);
      const kf = { t, prop, value };
      const cur = dd.layers[i].animate ?? [];
      const k = cur.findIndex((a) => a.keyframes);
      if (k >= 0) return [{ op: 'add', path: `/layers/${i}/animate/${k}/keyframes/-`, value: kf }];
      // a keyframe animation needs at least two keyframes: the second holds the same value at the other end, ready to be changed
      const other = { t: t > span / 2 ? 0 : Math.round(span * 100) / 100, prop, value };
      const entry = { keyframes: [kf, other].sort((a, b) => a.t - b.t) };
      return dd.layers[i].animate ? [{ op: 'add', path: `/layers/${i}/animate/-`, value: entry }] : [{ op: 'add', path: `/layers/${i}/animate`, value: [entry] }];
    }, `Keyframe ${prop} on ${l.id}`).then((ok) => { if (ok && !kfEntry) toast('A keyframe animation needs two keyframes, so a second one was added at the other end with the same value. Change its value to animate.', 'ok'); return ok; });
  }

  function deleteKeyframe(m) {
    return apply((dd) => {
      const i = layerIndex(dd, V.sel.ids[0]);
      const k = dd.layers[i].animate.findIndex((a) => a.keyframes);
      if (k < 0) return [];
      if (dd.layers[i].animate[k].keyframes.length <= 2) {
        toast('A keyframe animation needs two keyframes, so the whole keyframe animation was removed.', 'ok');
        return dd.layers[i].animate.length === 1 ? [{ op: 'remove', path: `/layers/${i}/animate` }] : [{ op: 'remove', path: `/layers/${i}/animate/${k}` }];
      }
      return [{ op: 'remove', path: `/layers/${i}/animate/${k}/keyframes/${m}` }];
    }, 'Delete a keyframe');
  }

  // ---- a scene, a track -------------------------------------------------------------------------------------------------------

  function buildScene(d, sc) {
    return [group(`Scene: ${sc.title ?? sc.id}`,
      h('p', { class: 'muted' }, 'Scenes label the parts of the video (hook, middle, ending). Drag the edges in the timeline, or type the times here.'),
      row('Name', text('scene-title', sc.title ?? '', (v) => renameScene(sc.id, v))),
      pair(
        row('Starts', num('scene-start', sc.start, { min: 0, step: 0.01 }, (v) => setSceneEdges(sc.id, { start: v }))),
        row('Ends', num('scene-end', sc.end, { min: 0.05, step: 0.01 }, (v) => setSceneEdges(sc.id, { end: v })))),
      h('div', { class: 'row' }, h('button', { class: 'btn sm', type: 'button', onclick: () => seek(sc.start) }, 'Playhead to start'), h('button', { class: 'btn sm danger', type: 'button', onclick: () => deleteSelected() }, icon('trash', 14), 'Delete scene')))];
  }

  function buildTrack(d, t) {
    return [group(`Track: ${t.name ?? t.id}`,
      h('p', { class: 'muted' }, t.type === 'video' ? 'A picture track. The track listed last is on top; the ones below show through where it has no clip.' : 'A sound track.'),
      row('Name', text('track-name', t.name ?? '', (v) => setTrackName(t.id, v), { placeholder: t.id })),
      row('Mute', tick('track-mute', t.mute, 'Silence everything on this track', () => toggleTrack(t.id, 'mute'))),
      row('Solo', tick('track-solo', t.solo, 'Hear only this track (and other soloed ones)', () => toggleTrack(t.id, 'solo'))),
      row('Lock', tick('track-lock', t.lock, 'Nothing on this track can be edited or cut', () => toggleTrack(t.id, 'lock'))),
      h('p', { class: 'muted' }, `${t.clips.length} clip${t.clips.length === 1 ? '' : 's'}. Volume is set on each clip, with its Volume (dB) field.`))];
  }

  // ---- when to draw -----------------------------------------------------------------------------------------------------------

  let lastSig = '';
  function refresh({ force = false } = {}) {
    if (!active()) return;
    const d = doc();
    const sig = JSON.stringify([V.sel, d?.timeline, d?.layers, state.versionView?.id, [...sourceProblems.keys()], state.sizes.length]);
    if (!force && sig === lastSig) return;
    lastSig = sig;
    preserveFocus(root, build);
  }
  onV('sel', refresh);
  onV('data', refresh);
  onV('playhead', () => { kfLabel?._paint?.(); });
  return { refresh, rebuild: () => refresh({ force: true }) };
}
