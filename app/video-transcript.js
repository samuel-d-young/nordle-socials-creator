// The transcript panel: the words of the recording, with what the cut keeps and what it has taken out. Select words and press
// Delete to cut them out of the video (the rest closes up); click a struck word to bring it back. Every change is one patch,
// built by src/shared/cutlist.mjs, so it is one undo step and the picture and sound of the recording stay together.

import { h, icon, toast } from './dom.js';
import { state } from './state.js';
import { coverage, removeWordsInfo, restoreWordsInfo, sourceEnd, totalDuration, transcriptLines, wordStates } from '/src/shared/cutlist.mjs';
import { V, onV, clock, doc, seek, secs } from './video-state.js';
import { loadWords, words } from './video-data.js';
import { apply, chain } from './video-actions.js';

const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'er', 'erm', 'ah', 'hmm', 'mm', 'mmm', 'like']);
const norm = (t) => String(t).toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/** [3,4,5,9] -> [[3,5],[9,9]] */
export function runsOf(indices) {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const runs = [];
  for (const i of sorted) {
    const last = runs.at(-1);
    if (last && i === last[1] + 1) last[1] = i; else runs.push([i, i]);
  }
  return runs;
}

export function mountTranscript(root, { monitor }) {
  const search = h('input', { class: 'field vtr-search', type: 'search', placeholder: 'Search the words', 'aria-label': 'Search the words', 'data-field': 'transcript-search' });
  const count = h('span', { class: 'vtr-hits muted', 'aria-live': 'polite' });
  const prev = h('button', { class: 'btn sm icon', type: 'button', 'aria-label': 'Previous match', title: 'Previous match', onclick: () => jump(-1) }, icon('up', 14));
  const next = h('button', { class: 'btn sm icon', type: 'button', 'aria-label': 'Next match', title: 'Next match (Enter)', onclick: () => jump(1) }, icon('down', 14));
  const summary = h('p', { class: 'vtr-summary', 'aria-live': 'polite' });
  const bCut = h('button', { class: 'btn sm', type: 'button', 'data-act': 'cut-words', onclick: () => cutSelection() }, icon('trash', 14), 'Cut');
  const bBack = h('button', { class: 'btn sm', type: 'button', 'data-act': 'bring-back', title: 'Bring the selected cut words back (Enter)', onclick: () => bringBack() }, icon('undoArrow', 14), 'Bring back');
  const bFill = h('button', { class: 'btn sm', type: 'button', 'data-act': 'fillers', onclick: () => selectFillers() }, 'Select fillers');
  const bClear = h('button', { class: 'btn sm ghost', type: 'button', 'data-act': 'clear-words', onclick: () => { sel = new Set(); paint(); } }, 'Clear');
  const tools = h('div', { class: 'vtr-tools' }, bCut, bBack, bFill, bClear);
  const text = h('div', { class: 'vtr-text', tabindex: '0', role: 'group', 'aria-label': 'Transcript. Click a word to move the playhead there. Select words and press Delete to cut them. Click a struck-through word, or select it and press Enter, to bring it back.' });
  const empty = h('div', { class: 'empty vtr-empty' });
  root.append(h('div', { class: 'vtr-top' }, search, prev, next, count), summary, tools, text, empty);

  let states = [];
  let builtKey = '';
  let els = [];             // word elements by index
  let lineEls = [];
  let sel = new Set();
  let anchor = null;
  let cursor = null;
  let drag = null;
  let query = '';
  let hits = [];            // [i, j] runs
  let hitIdx = -1;
  let keptList = [];        // kept words sorted by place on the timeline, for "the word being said now"
  let nowEl = null;

  const active = () => state.route.name === 'video' && state.panel === 'transcript';

  // ---- building and painting -------------------------------------------------------------------------------------------------

  function build() {
    const key = `${words.key}|${words.list.length}`;
    if (key === builtKey) return;
    builtKey = key;
    els = [];
    lineEls = [];
    text.replaceChildren();
    sel = new Set(); anchor = cursor = null;
    if (words.status !== 'ready') return;
    const lines = transcriptLines(words.list.map((w, i) => ({ i, text: w.text, start: w.start, end: w.end, kept: true, at: w.start })));
    for (const line of lines) {
      const ts = h('button', { class: 'vtr-ts', type: 'button', tabindex: '-1', 'data-i': String(line.i), title: 'Move the playhead to this line' }, clock(line.start).replace(/\.\d+$/, ''));
      const p = h('p', { class: 'vtr-line' }, ts);
      for (let i = line.i; i <= line.j; i++) {
        const w = h('span', { class: 'tw', 'data-i': String(i), role: 'button', 'aria-pressed': 'false' }, words.list[i].text);
        els[i] = w;
        p.append(w, ' ');
      }
      lineEls.push({ line, p, ts });
      text.append(p);
    }
  }

  function refresh() {
    if (!active()) return;
    build();
    const d = doc();
    empty.classList.toggle('hidden', words.status === 'ready');
    text.classList.toggle('hidden', words.status !== 'ready');
    tools.classList.toggle('hidden', words.status !== 'ready');
    summary.classList.toggle('hidden', words.status !== 'ready');
    if (words.status !== 'ready') {
      empty.textContent = words.status === 'loading' || words.status === 'idle' ? 'Loading the words…' : words.message;
      if (words.status === 'error') empty.append(h('div', {}, h('button', { class: 'btn sm', type: 'button', onclick: () => loadWords({ force: true }) }, 'Try again')));
      return;
    }
    try { states = wordStates(d, { track: words.track, source: words.source }, words.list); } catch (e) { empty.classList.remove('hidden'); empty.textContent = e.message; text.classList.add('hidden'); return; }
    keptList = states.filter((s) => s.kept).sort((a, b) => a.at - b.at);
    paint();
  }

  function paint() {
    if (!states.length) return;
    const cutCount = states.filter((s) => !s.kept).length;
    let keptSecs = 0;
    try { keptSecs = coverage(doc(), { track: words.track, source: words.source }).reduce((a, c) => a + (c.to - c.from), 0); } catch { keptSecs = totalDuration(doc()); }
    const whole = Math.max(sourceEnd(doc(), words.source), words.list.at(-1)?.end ?? 0);
    summary.textContent = `Kept ${secs(keptSecs)} of ${secs(whole)} (${cutCount} word${cutCount === 1 ? '' : 's'} cut). The video is ${secs(totalDuration(doc()))} long.`;
    const hitSet = new Set(hits.flatMap(([a, b]) => Array.from({ length: b - a + 1 }, (_, k) => a + k)));
    states.forEach((s, i) => {
      const el = els[i];
      if (!el) return;
      const cls = `tw${s.kept ? '' : ' cut'}${sel.has(i) ? ' picked' : ''}${hitSet.has(i) ? ' hit' : ''}${cursor === i ? ' cur' : ''}`;
      if (el._cls !== cls) {
        el._cls = cls; el.className = cls;
        el.setAttribute('aria-pressed', String(sel.has(i)));
        el.title = s.kept ? `${clock(s.at)} in the video. Click to move the playhead here.` : 'Cut out. Click to bring it back.';
      }
    });
    for (const { line, p, ts } of lineEls) {
      const all = states.slice(line.i, line.j + 1);
      const keptAny = all.find((s) => s.kept);
      const cls = `vtr-line${all.every((s) => !s.kept) ? ' gone' : ''}`;
      if (p._cls !== cls) { p._cls = cls; p.className = cls; }
      const label = keptAny ? clock(keptAny.at).replace(/\.\d+$/, '') : 'cut';
      if (ts.textContent !== label) ts.textContent = label;
    }
    const fillers = fillerWords();
    bFill.textContent = `Select fillers (${fillers.length})`;
    bFill.disabled = !fillers.length;
    bFill.title = fillers.length ? 'Select every um, uh, er and "like" that is still in the video, then press Delete to cut them all at once' : 'There are no um, uh or "like" words left in the video';
    const selKept = [...sel].filter((i) => states[i]?.kept).length;
    const selCut = sel.size - selKept;
    bCut.disabled = !selKept;
    bCut.replaceChildren(icon('trash', 14), `Cut ${selKept || ''} word${selKept === 1 ? '' : 's'}`.replace('Cut  words', 'Cut words'));
    bCut.title = 'Cut the selected words out of the video (Delete). The rest closes up.';
    bBack.disabled = !selCut;
    bClear.disabled = !sel.size;
    updateNow();
    count.textContent = query ? (hits.length ? `${hitIdx >= 0 ? hitIdx + 1 : 0} of ${hits.length}` : 'No matches') : '';
    prev.disabled = next.disabled = !hits.length;
  }

  const fillerWords = () => states.filter((s) => s.kept && FILLERS.has(norm(s.text)));

  function updateNow() {
    if (!active() || !keptList.length) return;
    const t = V.playhead;
    let lo = 0, hi = keptList.length - 1, found = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (keptList[mid].at <= t + 1e-6) { found = mid; lo = mid + 1; } else hi = mid - 1; }
    const w = found >= 0 ? keptList[found] : null;
    const inside = w && t < w.at + (w.end - w.start) + 0.25;
    const el = inside ? els[w.i] : null;
    if (el === nowEl) return;
    nowEl?.classList.remove('now');
    nowEl = el;
    if (el) { el.classList.add('now'); if (V.playing) el.scrollIntoView({ block: 'nearest' }); }
  }

  // ---- selecting -------------------------------------------------------------------------------------------------------------

  const setRange = (a, b) => { const [lo, hi] = a <= b ? [a, b] : [b, a]; sel = new Set(Array.from({ length: hi - lo + 1 }, (_, k) => lo + k)); };

  text.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const ts = e.target.closest('.vtr-ts');
    if (ts) { const s = states[Number(ts.dataset.i)]; text.focus({ preventScroll: true }); if (s) { const k = states.slice(Number(ts.dataset.i)).find((x) => x.kept); if (k) seek(k.at); } return; }
    const w = e.target.closest('.tw');
    text.focus({ preventScroll: true });
    if (!w) return;
    e.preventDefault();
    const i = Number(w.dataset.i);
    if (e.shiftKey && anchor !== null) { setRange(anchor, i); cursor = i; paint(); return; }
    if (e.ctrlKey || e.metaKey) { if (sel.has(i)) sel.delete(i); else sel.add(i); anchor = cursor = i; paint(); return; }
    drag = { from: i, moved: false, alt: e.altKey };
    anchor = cursor = i;
  });
  text.addEventListener('pointerover', (e) => {
    if (!drag) return;
    const w = e.target.closest('.tw');
    if (!w) return;
    const i = Number(w.dataset.i);
    if (i !== drag.from) drag.moved = true;
    if (drag.moved) { setRange(drag.from, i); cursor = i; paint(); }
  });
  window.addEventListener('pointerup', () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.moved) return;
    const s = states[d.from];
    if (!s) return;
    if (d.alt) { sel = new Set([d.from]); paint(); monitor.playSourceAt(words.source, s.start); return; }
    if (s.kept) { sel = new Set([d.from]); paint(); seek(s.at); } else bringBack([d.from]);
  });

  text.addEventListener('keydown', (e) => {
    if (!states.length) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); cutSelection(); return; }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); bringBack(); return; }
    if (e.key === 'Escape') { if (sel.size) { e.stopPropagation(); sel = new Set(); paint(); } return; }
    if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); e.stopPropagation(); sel = new Set(states.map((s) => s.i)); paint(); return; }
    if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && !mod && !e.altKey) {
      e.preventDefault(); e.stopPropagation();
      const cur = cursor ?? (e.key === 'ArrowRight' ? -1 : states.length);
      const to = Math.min(states.length - 1, Math.max(0, cur + (e.key === 'ArrowRight' ? 1 : -1)));
      if (e.shiftKey) { anchor ??= cur; setRange(anchor, to); } else { anchor = to; sel = new Set([to]); const s = states[to]; if (s.kept) seek(s.at); }
      cursor = to;
      paint();
      els[to]?.scrollIntoView({ block: 'nearest' });
    }
  });

  // ---- cutting and bringing back ----------------------------------------------------------------------------------------------

  async function cutSelection() {
    const idx = [...sel].filter((i) => states[i]?.kept);
    if (!idx.length) { toast(sel.size ? 'Those words are already cut. Select words that are still in the video, then press Delete.' : 'Select some words first: click one, drag across several, or Shift+click the last one.', 'error'); return false; }
    const runs = runsOf(idx);
    const info = { removed: 0, notes: [] };
    const ref = { track: words.track, source: words.source };
    const ok = await apply((d) => chain(d, runs.map(([i, j]) => (dd) => { const r = removeWordsInfo(dd, ref, words.list, i, j, { ripple: true }); info.removed += r.removed; info.notes.push(...r.notes); return r.ops; })),
      `Cut ${idx.length} word${idx.length === 1 ? '' : 's'}`);
    if (ok) {
      sel = new Set();
      toast(`Cut ${secs(info.removed)} (${idx.length} word${idx.length === 1 ? '' : 's'}). Ctrl+Z brings it back.${info.notes.length ? ` ${[...new Set(info.notes)].join(' ')}` : ''}`, 'ok');
    }
    paint();
    return ok;
  }

  async function bringBack(only) {
    const idx = (only ?? [...sel]).filter((i) => states[i] && !states[i].kept);
    if (!idx.length) { toast('Select some struck-through words first, then press Enter. (Or just click one.)', 'error'); return false; }
    const info = { restored: 0, notes: [] };
    const ref = { track: words.track, source: words.source };
    const ok = await apply((d) => chain(d, runsOf(idx).map(([i, j]) => (dd) => { const r = restoreWordsInfo(dd, ref, words.list, i, j, { ripple: true }); info.restored += r.restored; info.notes.push(...r.notes); return r.ops; })),
      `Bring back ${idx.length} word${idx.length === 1 ? '' : 's'}`);
    if (ok) { sel = new Set(); toast(`Brought back ${secs(info.restored)}.${info.notes.length ? ` ${[...new Set(info.notes)].join(' ')}` : ''}`, 'ok'); }
    paint();
    return ok;
  }

  function selectFillers() {
    const f = fillerWords();
    sel = new Set(f.map((s) => s.i));
    if (f.length) { anchor = cursor = f[0].i; els[f[0].i]?.scrollIntoView({ block: 'nearest' }); }
    paint();
    text.focus({ preventScroll: true });
  }

  // ---- searching ----------------------------------------------------------------------------------------------------------------

  function runSearch() {
    query = search.value.trim();
    hits = [];
    hitIdx = -1;
    const tokens = query.toLowerCase().split(/\s+/).map(norm).filter(Boolean);
    if (tokens.length && states.length) {
      const nw = words.list.map((w) => norm(w.text));
      for (let i = 0; i + tokens.length <= nw.length; i++) {
        let ok = true;
        for (let k = 0; k < tokens.length; k++) { const t = tokens[k]; const w = nw[i + k]; if (tokens.length === 1 ? !w.includes(t) : k === tokens.length - 1 ? !w.startsWith(t) : w !== t) { ok = false; break; } }
        if (ok) hits.push([i, i + tokens.length - 1]);
      }
    }
    paint();
  }
  search.addEventListener('input', runSearch);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); jump(e.shiftKey ? -1 : 1); } });

  function jump(dir) {
    if (!hits.length) return;
    hitIdx = (hitIdx + dir + hits.length) % hits.length;
    const [a, b] = hits[hitIdx];
    setRange(a, b);
    anchor = cursor = a;
    const s = states[a];
    if (s?.kept) seek(s.at);
    paint();
    els[a]?.scrollIntoView({ block: 'center' });
  }

  // ---- following the rest of the editor --------------------------------------------------------------------------------------

  onV('words', refresh);
  onV('playhead', updateNow);

  return {
    refresh,
    hasSelection: () => sel.size > 0,
    cut: cutSelection,
    reload: () => { builtKey = ''; return loadWords({ force: true }).then(refresh); },
  };
}
