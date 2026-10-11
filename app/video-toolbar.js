// The bar above the timeline: the editing buttons (each with its key in the tooltip), the zoom, and one plain line about how long
// the video is and which platform lengths it fits.

import { h, icon, dialog } from './dom.js';
import { state } from './state.js';
import { V, onV, setV, doc, secs, toFrames, fpsOf } from './video-state.js';
import { deleteSelected, splitSelected, trimToPlayhead } from './video-actions.js';
import { clampPps, geo } from './video-timeline.js';

const LIMITS = [15, 30, 60, 90];

/** "18.5 s long. Fits under 30, 60 and 90 s (not under 15 s). Instagram Reel 9:16 allows up to 180 s." */
export function lengthLine(d, sizes = state.sizes) {
  const len = d?.timeline?.duration ?? 0;
  const fits = LIMITS.filter((n) => len <= n);
  const over = LIMITS.filter((n) => len > n);
  const list = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a.at(-1)}` : String(a[0]));
  const parts = [`${secs(len)} long (${toFrames(len, fpsOf(d))} frames at ${fpsOf(d)} fps).`];
  parts.push(fits.length ? `Fits under ${list(fits)} s${over.length ? ` (not under ${list(over)} s)` : ''}.` : `Longer than ${LIMITS.at(-1)} s.`);
  const limits = [];
  let tooLong = false;
  for (const s of sizes) {
    const max = s.preset?.maxDuration;
    if (!max) continue;
    const name = s.preset?.name ?? s.id;
    if (len > max) { tooLong = true; limits.push(`${name} allows up to ${max} s, so this is ${secs(len - max)} too long.`); } else limits.push(`${name} allows up to ${max} s.`);
  }
  return { text: [...parts, ...limits].join(' '), tooLong };
}

export const SHORTCUTS = [
  ['Space', 'Play or pause the monitor'],
  ['Left / Right', 'Playhead back or forward one frame (Shift: one second)'],
  ['Home / End', 'Playhead to the start or the end'],
  ['S', 'Split the selected clip at the playhead'],
  ['Delete or Backspace', 'Remove the selected clip, title or scene (clips close the gap when "Ripple delete" is on)'],
  ['I / O', 'Start or end the selected clip at the playhead (in the Source monitor: at the moment you are looking at). Shift ripples'],
  ['Ctrl + Left / Right', 'Nudge the selected clip one frame (Shift: one second)'],
  ['Alt + Left / Right', 'Select the previous or next clip on the track'],
  ['Ctrl + Z, Ctrl + Y', 'Undo, redo'],
  ['+ / - / 0', 'Zoom the timeline in, out, or to fit'],
  ['Ctrl + mouse wheel', 'Zoom the timeline around the pointer'],
  ['Drag a clip', 'Move it. It snaps to frames, to other clips, to titles and to the playhead. Alt turns snapping off, Shift ripples'],
  ['Drag a clip edge', 'Trim it (a photo stretches). Shift ripples'],
  ['Ctrl + click', 'Add a clip to the selection'],
  ['Double-click a clip', 'Look at its footage in the Source monitor'],
  ['Double-click a scene', 'Rename it'],
  ['Escape', 'Back to the frame view'],
];

export function showShortcuts() {
  return dialog({
    title: 'Keyboard and mouse',
    build: (body) => body.append(h('dl', { class: 'vt-keys' }, SHORTCUTS.flatMap(([k, v]) => [h('dt', {}, h('kbd', {}, k)), h('dd', {}, v)]))),
    actions: [{ id: 'close', label: 'Close', primary: true }],
  });
}

/** Zoom the timeline by a factor, keeping what is under the playhead where it is. */
export function zoomBy(factor) { setV({ fit: false, pps: clampPps(geo.pps * factor, geo.len) }); }

export function mountToolbar(root) {
  const line = h('p', { class: 'vt-length' });
  const btn = (act, ic, label, title, onclick, extra = {}) => h('button', { class: 'btn sm', type: 'button', 'data-act': act, title, 'aria-label': title, onclick, ...extra }, icon(ic, 14), h('span', { class: 'lbl' }, label));
  const split = btn('split', 'split', 'Split', 'Split the selected clip at the playhead (S)', () => splitSelected());
  const del = btn('delete', 'trash', 'Delete', 'Remove the selected clip, title or scene (Delete)', () => deleteSelected());
  const ripple = btn('ripple', 'ripple', 'Ripple delete', '', () => setV({ ripple: !V.ripple }), { 'aria-pressed': 'true' });
  const snap = btn('snap', 'magnet', 'Snap', '', () => setV({ snap: !V.snap }), { 'aria-pressed': 'true' });
  const trimIn = btn('trim-in', 'trimIn', 'Start here', 'Start the selected clip at the playhead (I)', () => trimToPlayhead('in'));
  const trimOut = btn('trim-out', 'trimOut', 'End here', 'End the selected clip at the playhead (O)', () => trimToPlayhead('out'));
  const zoomOut = btn('zoom-out', 'zoomOut', '', 'Zoom the timeline out (-)', () => zoomBy(1 / 1.35));
  const zoomIn = btn('zoom-in', 'zoomIn', '', 'Zoom the timeline in (+)', () => zoomBy(1.35));
  const fit = btn('zoom-fit', 'fit', 'Fit', 'Fit the whole video in the window (0)', () => setV({ fit: true }));
  const keys = btn('keys', 'keys', '', 'Keyboard and mouse shortcuts (?)', () => showShortcuts());
  const group = (label, ...kids) => h('div', { class: 'vt-group', role: 'group', 'aria-label': label }, kids);
  root.append(h('div', { class: 'vt-bar' },
    h('div', { class: 'vt-tools', role: 'toolbar', 'aria-label': 'Timeline tools' },
      group('Cutting', split, del, ripple, trimIn, trimOut),
      group('Snapping', snap),
      group('Zoom', zoomOut, fit, zoomIn),
      keys),
    line));

  function paint() {
    const d = doc();
    if (!d?.timeline) return;
    const hasSel = !!V.sel.kind;
    const clipSel = V.sel.kind === 'clip';
    split.disabled = !clipSel;
    del.disabled = !hasSel || V.sel.kind === 'track';
    trimIn.disabled = trimOut.disabled = !clipSel;
    ripple.setAttribute('aria-pressed', String(V.ripple));
    ripple.classList.toggle('on', V.ripple);
    const rippleText = V.ripple
      ? 'Ripple delete is on: deleting a clip closes the gap. Click to leave a gap instead. (Hold Shift while dragging to ripple a move or trim.)'
      : 'Ripple delete is off: deleting a clip leaves a gap. Click to close gaps. (Hold Shift while dragging to ripple a move or trim.)';
    ripple.title = rippleText;
    ripple.setAttribute('aria-label', rippleText);
    snap.setAttribute('aria-pressed', String(V.snap));
    snap.classList.toggle('on', V.snap);
    const snapText = V.snap ? 'Snapping is on: clips snap to frames, other clips and the playhead. Click to turn it off. (Hold Alt while dragging to skip it once.)' : 'Snapping is off except to whole frames. Click to turn it on.';
    snap.title = snapText;
    snap.setAttribute('aria-label', snapText);
    const l = lengthLine(d);
    line.textContent = l.text;
    line.classList.toggle('warn', l.tooLong);
  }
  paint();
  for (const topic of ['sel', 'flags', 'misc']) onV(topic, paint);
  return { paint };
}
