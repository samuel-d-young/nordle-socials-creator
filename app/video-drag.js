// Pointer editing on the timeline: drag a clip to move it, drag its edges to trim it, drag a title's bar or a scene boundary,
// and scrub the ruler. Everything is previewed on the element while the pointer moves (one update per animation frame) and
// sent through the cut list only when the pointer is let go, so a drag is one undo step. Alt switches snapping off, Shift ripples.

import { toast, promptBox } from './dom.js';
import { findClip } from '/src/shared/cutlist.mjs';
import { V, clipsOf, clock, doc, durationOf, fpsOf, layerIndex, lengthOf, sceneIndex, seek, select, snapFrame, sourceOf } from './video-state.js';
import { footageLength, moveClipTo, trimClipTo, setLayerTime, setSceneEdges, renameScene } from './video-actions.js';

const SNAP_PX = 7;
const DRAG_PX = 3;
const r9 = (v) => Math.round(v * 1e9) / 1e9;

/** Every time worth snapping to: the ends, the playhead, and every clip, title and scene edge except the thing being dragged. */
function snapPoints(d, skip) {
  const pts = [0, lengthOf(d), V.playhead];
  for (const { clip } of clipsOf(d)) {
    if (skip.kind === 'clip' && skip.id === clip.id) continue;
    pts.push(clip.at, clip.at + durationOf(clip, d));
  }
  for (const l of d.layers ?? []) if (l.time && !(skip.kind === 'layer' && skip.id === l.id)) pts.push(l.time.start, l.time.end);
  for (const s of d.timeline.scenes ?? []) if (!(skip.kind === 'scene' && skip.id === s.id)) pts.push(s.start, s.end);
  return pts;
}

function nearest(t, pts, thr) {
  let best = null;
  for (const p of pts) { const dist = Math.abs(p - t); if (dist <= thr && (!best || dist < best.dist)) best = { p, dist }; }
  return best;
}

/**
 * @param {{content:HTMLElement, scroller:HTMLElement, ruler:HTMLElement, geo:{HEAD:number, pps:number}, render:Function, tip:HTMLElement, snapLine:HTMLElement, onSource:Function}} o
 */
export function attachPointer({ content, scroller, ruler, geo, render, tip, snapLine, onSource }) {
  let drag = null;

  const timeAt = (clientX) => (clientX - content.getBoundingClientRect().left - geo.HEAD) / geo.pps;

  // ---- scrubbing the ruler --------------------------------------------------------------------------------------------------
  let scrubbing = false;
  ruler.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('.vt-pin')) return;
    scrubbing = true;
    ruler.setPointerCapture(e.pointerId);
    seek(timeAt(e.clientX));
    e.preventDefault();
  });
  ruler.addEventListener('pointermove', (e) => { if (scrubbing) seek(timeAt(e.clientX)); });
  const endScrub = () => { scrubbing = false; };
  ruler.addEventListener('pointerup', endScrub);
  ruler.addEventListener('pointercancel', endScrub);

  // ---- starting a drag -------------------------------------------------------------------------------------------------------
  content.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const block = e.target.closest('[data-kind]');
    if (!block) {
      // empty space: nothing selected any more
      if (e.target.closest('.vt-body')) { select(null, []); scroller.focus({ preventScroll: true }); }
      return;
    }
    const kind = block.dataset.kind;
    if (kind === 'track' || kind === 'pin' || kind === 'mark') return;
    const id = block.dataset.id;
    const edge = e.target.closest('[data-edge]')?.dataset.edge ?? null;
    const d = doc();
    const additive = e.ctrlKey || e.metaKey;

    if (kind === 'clip') {
      if (additive) { select('clip', [id], { add: true }); return; }
      if (!(V.sel.kind === 'clip' && V.sel.ids.includes(id)) && !e.shiftKey) select('clip', [id]);
    } else if (!additive) select(kind, [id]);

    const base = { kind, id, edge, startX: e.clientX, el: block, pointerId: e.pointerId, moved: false, shiftOnDown: e.shiftKey };
    if (kind === 'clip') {
      const ref = findClip(d, id);
      if (!ref) return;
      const c = ref.clip;
      const s = sourceOf(d, c.source)?.type === 'image' ? 1 : c.speed ?? 1;
      drag = { ...base, at: c.at, dur: durationOf(c, d), in: c.in, out: c.out, speed: s, locked: !!ref.track.lock, footage: footageLength(d, id) };
    } else if (kind === 'layer') {
      const l = d.layers?.[layerIndex(d, id)];
      if (!l) return;
      drag = { ...base, start: l.time.start, end: l.time.end, locked: !!l.lock };
    } else if (kind === 'scene') {
      const scenes = d.timeline.scenes ?? [];
      const i = sceneIndex(d, id);
      const sc = scenes[i];
      if (!sc) return;
      const eps = 1e-6;
      const before = scenes.find((o, j) => j !== i && Math.abs(o.end - sc.start) < eps);
      const after = scenes.find((o, j) => j !== i && Math.abs(o.start - sc.end) < eps);
      drag = { ...base, start: sc.start, end: sc.end, before: before?.id, after: after?.id };
      if (!edge) drag = null; // a scene is moved by its edges only
    }
    if (!drag) return;
    block.setPointerCapture(e.pointerId);
    block.addEventListener('pointermove', onMove);
    block.addEventListener('pointerup', onUp);
    block.addEventListener('pointercancel', onCancel);
  });

  content.addEventListener('dblclick', async (e) => {
    const block = e.target.closest('[data-kind]');
    if (!block) return;
    if (block.dataset.kind === 'scene') {
      const sc = (doc().timeline.scenes ?? []).find((s) => s.id === block.dataset.id);
      const r = await promptBox('Rename scene', [{ name: 'title', label: 'Name', value: sc?.title ?? sc?.id ?? '' }], { ok: 'Rename' });
      if (r) renameScene(block.dataset.id, r.title);
    } else if (block.dataset.kind === 'clip') {
      select('clip', [block.dataset.id]);
      onSource?.();
    }
  });

  // ---- moving ----------------------------------------------------------------------------------------------------------------
  function onMove(e) {
    if (!drag) return;
    drag.last = e;
    if (!drag.raf) drag.raf = requestAnimationFrame(frame);
  }

  function frame() {
    if (!drag) return;
    drag.raf = 0;
    const e = drag.last;
    const dx = e.clientX - drag.startX;
    if (!drag.moved && Math.abs(dx) < DRAG_PX) return;
    if (drag.locked) { if (!drag.warned) { drag.warned = true; toast(drag.kind === 'layer' ? `"${drag.id}" is locked. Unlock it first.` : 'That track is locked. Unlock it first.', 'error'); } return; }
    drag.moved = true;
    const d = doc();
    const fps = fpsOf(d);
    const pps = geo.pps;
    const useSnap = V.snap && !e.altKey;
    const thr = SNAP_PX / pps;
    const pts = useSnap ? snapPoints(d, drag) : [];
    const pick = (t) => { const n = useSnap ? nearest(t, pts, thr) : null; return n ? { t: n.p, hit: n.p } : { t: snapFrame(t, fps), hit: null }; };
    let hit = null;
    let text = '';

    if (drag.kind === 'clip' || drag.kind === 'layer') {
      const dur = drag.kind === 'clip' ? drag.dur : drag.end - drag.start;
      const t0 = drag.kind === 'clip' ? drag.at : drag.start;
      const dt = dx / pps;
      if (!drag.edge) {
        const a = pick(t0 + dt), b = pick(t0 + dt + dur);
        const useA = a.hit !== null && (b.hit === null || Math.abs(a.t - (t0 + dt)) <= Math.abs(b.t - (t0 + dt + dur)));
        const start = Math.max(0, useA || b.hit === null ? a.t : b.t - dur);
        hit = useA ? a.hit : b.hit;
        drag.result = { start, end: start + dur };
        text = `${clock(start)} to ${clock(start + dur)}`;
      } else if (drag.edge === 'l') {
        const p = pick(t0 + dt);
        const minLen = 1 / fps;
        let start = Math.max(0, Math.min(p.t, t0 + dur - minLen));
        if (drag.kind === 'clip') {
          // the source cannot start before its first frame: the head can only come back as far as the footage goes
          const back = drag.in - 0;
          start = Math.max(start, t0 - back / drag.speed);
          drag.result = { start, end: t0 + dur, in: r9(drag.in + (start - t0) * drag.speed) };
          text = `source in ${clock(drag.result.in)} to ${clock(drag.out)}`;
        } else {
          drag.result = { start, end: drag.end };
          text = `${clock(start)} to ${clock(drag.end)}`;
        }
        hit = p.hit;
      } else {
        const p = pick(t0 + dur + dt);
        let end = Math.max(p.t, t0 + 1 / fps);
        if (drag.kind === 'clip' && drag.footage !== undefined) end = Math.min(end, t0 + (drag.footage - drag.in) / drag.speed); // not past the last frame of the footage
        if (drag.kind === 'clip') {
          drag.result = { start: t0, end, out: r9(drag.in + (end - t0) * drag.speed) };
          text = `source in ${clock(drag.in)} to ${clock(drag.result.out)}`;
        } else {
          drag.result = { start: t0, end };
          text = `${clock(t0)} to ${clock(end)}`;
        }
        hit = p.hit;
      }
      drag.el.style.left = `${drag.result.start * pps}px`;
      drag.el.style.width = `${Math.max(2, (drag.result.end - drag.result.start) * pps - 1)}px`;
      drag.el.classList.add('dragging');
      text = `${text} (${Number((drag.result.end - drag.result.start).toFixed(2))} s)`;
    } else if (drag.kind === 'scene') {
      const p = pick((drag.edge === 'l' ? drag.start : drag.end) + dx / pps);
      const fpsMin = 1 / fps;
      if (drag.edge === 'l') {
        const start = Math.max(0, Math.min(p.t, drag.end - fpsMin));
        drag.result = { start, end: drag.end };
      } else {
        const end = Math.max(p.t, drag.start + fpsMin);
        drag.result = { start: drag.start, end };
      }
      hit = p.hit;
      drag.el.style.left = `${drag.result.start * pps}px`;
      drag.el.style.width = `${Math.max(2, (drag.result.end - drag.result.start) * pps - 1)}px`;
      drag.el.classList.add('dragging');
      text = `${clock(drag.result.start)} to ${clock(drag.result.end)}`;
    }
    showSnap(hit);
    showTip(`${text}${e.shiftKey && drag.kind === 'clip' ? ' · ripple' : ''}`, e);
  }

  function showSnap(t) {
    if (t === null || t === undefined) { snapLine.style.display = 'none'; return; }
    snapLine.style.display = 'block';
    snapLine.style.transform = `translateX(${geo.HEAD + t * geo.pps}px)`;
  }
  function showTip(text, e) {
    tip.textContent = text;
    tip.style.display = 'block';
    tip.style.left = `${Math.min(window.innerWidth - tip.offsetWidth - 8, e.clientX + 14)}px`;
    tip.style.top = `${e.clientY - 34}px`;
  }
  function clearHints() { snapLine.style.display = 'none'; tip.style.display = 'none'; }

  function finish() {
    const done = drag;
    drag = null;
    done.el.removeEventListener('pointermove', onMove);
    done.el.removeEventListener('pointerup', onUp);
    done.el.removeEventListener('pointercancel', onCancel);
    try { done.el.releasePointerCapture(done.pointerId); } catch { /* already released */ }
    if (done.raf) cancelAnimationFrame(done.raf);
    clearHints();
    done.el.classList.remove('dragging');
    return done;
  }

  function onCancel() { if (!drag) return; finish(); render({ force: true }); }

  async function onUp(e) {
    if (!drag) return;
    if (drag.last) { drag.last = e; frame(); } // the last position counts even if no frame was drawn since
    const done = finish();
    if (!done.moved) {
      // a plain click: Shift adds it to the selection
      if (done.kind === 'clip' && done.shiftOnDown) select('clip', [done.id], { add: true });
      render({ force: true });
      return;
    }
    const ripple = e.shiftKey;
    const r = done.result;
    if (done.kind === 'clip') {
      if (!done.edge) await moveClipTo(done.id, r.start, { ripple });
      else if (done.edge === 'l') await trimClipTo(done.id, { in: r.in }, { ripple });
      else await trimClipTo(done.id, { out: r.out }, { ripple });
    } else if (done.kind === 'layer') {
      await setLayerTime(done.id, { start: r.start, end: r.end });
    } else if (done.kind === 'scene') {
      await setSceneEdges(done.id, { start: r.start, end: r.end, neighbour: done.edge === 'l' && done.before ? { id: done.before, edge: 'end' } : done.edge === 'r' && done.after ? { id: done.after, edge: 'start' } : undefined });
    }
    render({ force: true }); // whatever happened, the element goes back to what the document says
  }
}
