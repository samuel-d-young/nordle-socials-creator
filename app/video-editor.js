// The video editor view: the monitor (top left), the side panel (Inspector, Transcript, Check, Review, Export), and the timeline
// across the bottom. This file lays them out, follows the open document, and owns the keyboard.

import { h } from './dom.js';
import { state, update, subscribe, shownDoc } from './state.js';
import { undo, redo, viewVersion, restoreVersion, viewChange, decideChange } from './doc.js';
import { mountReview } from './review.js';
import { mountMonitor } from './video-monitor.js';
import { mountTimeline } from './video-timeline.js';
import { mountToolbar, showShortcuts, zoomBy } from './video-toolbar.js';
import { mountTranscript } from './video-transcript.js';
import { mountInspector } from './video-inspector.js';
import { mountCheck } from './video-check.js';
import { mountExport } from './video-export.js';
import { V, clearSelection, lengthOf, onV, pruneSelection, seek, setV, typing } from './video-state.js';
import { check, loadWords, resetData, runCheck, scheduleCheck, stopChecks } from './video-data.js';
import { deleteSelected, nudgeSelected, selectNeighbour, splitSelected, stepFrames, stepSeconds, trimToPlayhead } from './video-actions.js';


const TABS = [['inspector', 'Inspector'], ['transcript', 'Transcript'], ['check', 'Check'], ['review', 'Review'], ['export', 'Export']];

export function mountVideoEditor(root) {
  root.classList.add('vx');
  const banner = h('div', { class: 'vx-banner hidden' });
  const monitorEl = h('section', { class: 'vx-monitor', 'aria-label': 'Monitor' });
  const tabs = h('div', { class: 'vx-tabs', role: 'tablist', 'aria-label': 'Side panel' });
  const panels = Object.fromEntries(TABS.map(([id]) => [id, h('div', { class: `vx-panel${id === 'inspector' ? '' : ' hidden'}`, role: 'tabpanel', id: `vx-panel-${id}`, 'aria-labelledby': `vx-tab-${id}`, 'data-panel': id })]));
  const side = h('aside', { class: 'vx-side', 'aria-label': 'Details' }, tabs, ...Object.values(panels));
  const timelineEl = h('section', { class: 'vx-timeline', 'aria-label': 'Timeline' });
  root.append(banner, monitorEl, side, timelineEl);

  const monitor = mountMonitor(monitorEl);
  const toolbar = mountToolbar(timelineEl);
  const timeline = mountTimeline(timelineEl, { onSource: () => setV({ mode: 'source' }) });
  const transcript = mountTranscript(panels.transcript, { monitor });
  const inspector = mountInspector(panels.inspector, { monitor, sourceMonitor: () => setV({ mode: 'source' }) });
  const checkPanel = mountCheck(panels.check);
  const review = mountReview(panels.review, { route: 'video' });
  const exporter = mountExport(panels.export);

  let on = false;
  let docKey = '';
  let lastDoc = null;
  let lastPanel = null;
  let lastTabSig = '';
  let lastFocus = null;
  let lastReviewSig = '';
  let lastV = -1;

  // ---- the tabs -----------------------------------------------------------------------------------------------------------

  function drawTabs() {
    const open = (state.review?.comments ?? []).filter((c) => c.status === 'open').length;
    const problems = check.issues.length;
    const sig = JSON.stringify([state.panel, open, problems, check.status]);
    if (sig === lastTabSig) return;
    lastTabSig = sig;
    tabs.replaceChildren(...TABS.map(([id, label]) => {
      const count = id === 'review' ? open : id === 'check' ? problems : 0;
      return h('button', {
        class: state.panel === id ? 'on' : '', type: 'button', role: 'tab', id: `vx-tab-${id}`, 'aria-selected': String(state.panel === id), 'aria-controls': `vx-panel-${id}`, tabindex: state.panel === id ? '0' : '-1', 'data-tab': id,
        onclick: () => update({ panel: id }),
        onkeydown: (e) => {
          const i = TABS.findIndex(([t]) => t === id);
          const to = e.key === 'ArrowRight' ? TABS[(i + 1) % TABS.length][0] : e.key === 'ArrowLeft' ? TABS[(i + TABS.length - 1) % TABS.length][0] : null;
          if (to) { e.preventDefault(); update({ panel: to }); queueMicrotask(() => tabs.querySelector(`[data-tab="${to}"]`)?.focus()); }
        },
      }, label, count ? h('span', { class: `count${id === 'check' ? ' warn' : ''}` }, String(count)) : null);
    }));
  }

  function onTab() {
    for (const [id, el] of Object.entries(panels)) el.classList.toggle('hidden', id !== state.panel);
    if (state.panel === 'inspector') inspector.rebuild();
    else if (state.panel === 'transcript') { loadWords().then(() => transcript.refresh()); transcript.refresh(); }
    else if (state.panel === 'check') checkPanel.rebuild();
    else if (state.panel === 'review') review.rebuild();
    else if (state.panel === 'export') exporter.open();
  }

  // ---- the banner for an old version or one of Claude's changes ---------------------------------------------------------

  function drawBanner() {
    const vv = state.versionView;
    banner.classList.toggle('hidden', !vv);
    if (!vv) { banner.replaceChildren(); return; }
    const ch = vv.change;
    if (ch) {
      const proposed = ch.mode === 'proposed';
      banner.replaceChildren(...[
        h('span', {}, proposed ? `Previewing Claude’s suggestion${ch.note ? `: ${ch.note}` : ''}` : `Claude’s change${ch.note ? `: ${ch.note}` : ''}`),
        h('div', { class: 'seg' }, [['before', proposed ? 'Now' : 'Before'], ['after', proposed ? 'With suggestion' : 'After']].map(([w, l]) => h('button', { class: ch.which === w ? 'on' : '', type: 'button', onclick: () => viewChange(ch.id, w) }, l))),
        h('span', { style: { flex: 1 } }),
        h('button', { class: 'btn sm', type: 'button', onclick: () => viewChange(null) }, 'Close'),
        ch.status === 'pending' ? h('button', { class: 'btn sm primary', type: 'button', onclick: () => decideChange(ch.id, 'accept') }, 'Accept') : null,
        ch.status === 'pending' ? h('button', { class: 'btn sm danger', type: 'button', onclick: () => decideChange(ch.id, 'reject') }, 'Reject') : null].filter(Boolean));
    } else {
      banner.replaceChildren(h('span', {}, `Viewing ${vv.name}. Read only: editing is off until you go back.`), h('span', { style: { flex: 1 } }),
        h('button', { class: 'btn sm', type: 'button', onclick: () => viewVersion(null) }, 'Back to current'),
        h('button', { class: 'btn sm primary', type: 'button', onclick: () => restoreVersion(vv.id) }, `Restore ${vv.name}`));
    }
  }

  // ---- following the document ----------------------------------------------------------------------------------------------

  function onDocChange() {
    const d = shownDoc();
    pruneSelection(d);
    if (V.playhead > lengthOf(d)) seek(lengthOf(d));
    timeline.render();
    toolbar.paint();
    monitor.onDoc();
    inspector.refresh();
    if (state.panel === 'transcript') transcript.refresh();
    // the transcript belongs to the speech source; if the document points somewhere else, load that one
    loadWords();
    if (!state.versionView) scheduleCheck();
    drawBanner();
  }

  function start() {
    docKey = `${state.project}/${state.docId}`;
    resetData();
    stopChecks();
    setV({ playhead: 0, playing: false, sel: { kind: null, ids: [] }, fit: true, mode: 'frame', sizeId: null });
    lastDoc = null; lastPanel = null; lastTabSig = ''; lastFocus = state.focusComment; lastReviewSig = ''; lastV = -1;
    document.addEventListener('keydown', onKey);
    monitor.open();
    loadWords().then(() => { timeline.render(); transcript.refresh(); });
    runCheck();
    timeline.forceRender();
  }

  function stop() {
    document.removeEventListener('keydown', onKey);
    monitor.close();
    stopChecks();
    exporter.close();
    on = false;
  }

  subscribe(() => {
    const active = state.route.name === 'video' && state.doc?.kind === 'video';
    const key = `${state.project}/${state.docId}`;
    if (active && (!on || key !== docKey)) { if (on) stop(); on = true; start(); }
    else if (!active && on) { stop(); return; }
    if (!active) return;
    if (state.panel !== lastPanel) {
      lastPanel = state.panel;
      if (!TABS.some(([id]) => id === state.panel)) { update({ panel: 'inspector' }); return; }
      onTab();
    }
    const d = shownDoc();
    if (d !== lastDoc) { lastDoc = d; onDocChange(); }
    if (state.v !== lastV) { lastV = state.v; monitor.onDoc(); }
    const rsig = JSON.stringify((state.review?.comments ?? []).map((c) => [c.id, c.time, c.status, c.x, c.y, c.text]));
    if (rsig !== lastReviewSig) { lastReviewSig = rsig; timeline.render(); monitor.onDoc(); }
    if (state.versionView?.id !== banner.dataset.v || state.versionView?.change?.which !== banner.dataset.w || state.versionView?.change?.status !== banner.dataset.s) {
      banner.dataset.v = state.versionView?.id ?? ''; banner.dataset.w = state.versionView?.change?.which ?? ''; banner.dataset.s = state.versionView?.change?.status ?? '';
      drawBanner();
    }
    drawTabs();
    // a comment chosen in the Review tab: go to the moment it is about
    if (state.focusComment !== lastFocus) {
      lastFocus = state.focusComment;
      const c = (state.review?.comments ?? []).find((x) => x.id === state.focusComment);
      if (c && typeof c.time === 'number') seek(c.time);
    }
  });

  onV('check', () => { lastTabSig = ''; drawTabs(); timeline.render(); });

  // ---- the keyboard ---------------------------------------------------------------------------------------------------------

  function onKey(e) {
    if (state.route.name !== 'video') return;
    if (typing(e.target) || document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const k = key.toLowerCase();

    if (mod && k === 'z') { e.preventDefault(); (e.shiftKey ? redo() : undo()); return; }
    if (mod && k === 'y') { e.preventDefault(); redo(); return; }
    if (key === ' ') {
      // Space plays and pauses wherever the focus is, except in the places that use it themselves (fields, links, the side panel's and dialogs' buttons)
      if (e.target.closest?.('input, select, textarea, a, summary, .vx-side button, dialog')) return;
      e.preventDefault(); monitor.togglePlay(); return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight') {
      const dir = key === 'ArrowRight' ? 1 : -1;
      e.preventDefault();
      if (mod) nudgeSelected(dir * (e.shiftKey ? 30 : 1));
      else if (e.altKey) selectNeighbour(dir);
      else if (e.shiftKey) stepSeconds(dir);
      else stepFrames(dir);
      return;
    }
    if (mod || e.altKey) return;
    if (key === 'Home') { e.preventDefault(); seek(0); return; }
    if (key === 'End') { e.preventDefault(); seek(lengthOf(shownDoc())); return; }
    if (key === 'Delete' || key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
    if (k === 's') { e.preventDefault(); splitSelected(); return; }
    if (k === 'i' || k === 'o') {
      e.preventDefault();
      if (V.mode === 'source') monitor.sourcePoint(k === 'i' ? 'in' : 'out');
      else trimToPlayhead(k === 'i' ? 'in' : 'out', { ripple: e.shiftKey });
      return;
    }
    if (key === '+' || key === '=') { e.preventDefault(); zoomBy(1.35); return; }
    if (key === '-' || key === '_') { e.preventDefault(); zoomBy(1 / 1.35); return; }
    if (key === '0') { e.preventDefault(); setV({ fit: true }); return; }
    if (key === '?') { e.preventDefault(); showShortcuts(); return; }
    if (key === 'Escape') {
      if (V.mode !== 'frame') setV({ mode: 'frame' }); else clearSelection();
    }
  }

  return { transcript, timeline, monitor };
}
