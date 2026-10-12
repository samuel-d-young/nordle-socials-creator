// The monitor. Three ways to look at the video, none of which plays footage from the camera:
//   Frame   the real picture at the playhead (footage, titles and captions drawn by the renderer), fetched when the playhead rests
//   Cut     the last rendered preview (a small video), kept in step with the playhead both ways
//   Source  the small copy (proxy) of the selected clip's footage, to find a better start or end with I and O

import { h, icon, promptBox, toast } from './dom.js';
import { api } from './api.js';
import { state, update } from './state.js';
import { addComment, whenSaved } from './doc.js';
import { V, onV, setV, doc, clock, currentSize, sizeParam, videoSizes, fileUrl, fpsOf, lengthOf, seek, select, selectedClip, snapFrame, sourceOf, toFrames, videoApi } from './video-state.js';
import { cancelJob, checkPreview, ensureProxy, preview, previewRendered, previewUrl, sourceProblems, startRender, watchJob } from './video-data.js';
import { setClipSourcePoint, setLayerField } from './video-actions.js';

export function mountMonitor(root) {
  const img = h('img', { class: 'vm-img', alt: 'The picture at the playhead, with titles and captions', draggable: 'false' });
  const video = h('video', { class: 'vm-video', playsinline: true, preload: 'auto', 'aria-label': 'Video monitor' });
  const pins = h('div', { class: 'vm-pins' });
  const note = h('div', { class: 'vm-note', role: 'status' });
  const boxLayer = h('div', { class: 'vm-boxes' });
  const frameBox = h('div', { class: 'vm-frame' }, img, video, boxLayer, pins, note);
  const stage = h('div', { class: 'vm-stage' }, frameBox);
  const time = h('span', { class: 'vm-time', 'aria-live': 'off' });
  const stale = h('span', { class: 'vm-stale hidden', role: 'status' });
  const prog = h('div', { class: 'vm-prog hidden', role: 'status' });
  const sbar = h('div', { class: 'vm-sbar hidden' });
  const modeButtons = {};
  const MODES = [['frame', 'Frame', 'The real picture at the playhead, with titles and captions'], ['cut', 'Cut', 'Play the last rendered preview'], ['source', 'Source', 'Play the footage of the selected clip to find a better start or end']];
  const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'What the monitor shows' },
    MODES.map(([id, label, title]) => (modeButtons[id] = h('button', { type: 'button', 'data-mode': id, title, 'aria-pressed': 'false', onclick: () => setV({ mode: id }) }, label))));
  const sizeSel = h('select', { class: 'field vm-size hidden', 'aria-label': 'Size shown in the monitor', title: 'Which size the monitor and the preview show', onchange: (e) => setV({ sizeId: e.target.value }) });
  const pinBtn = h('button', { class: 'btn sm', type: 'button', 'data-act': 'pin', title: 'Pin a comment on the picture at this moment', 'aria-pressed': 'false', onclick: () => { pinMode = !pinMode; paintPinBtn(); } }, icon('pin', 14), h('span', { class: 'lbl' }, 'Pin a comment'));
  const renderBtn = h('button', { class: 'btn sm primary', type: 'button', 'data-act': 'render-preview', title: 'Render a small preview of the whole video, to play it here', onclick: () => renderPreview() }, icon('film', 14), 'Render preview');
  const playBtn = h('button', { class: 'btn sm icon', type: 'button', 'data-act': 'play', title: 'Play (Space)', 'aria-label': 'Play', onclick: () => togglePlay() }, icon('playOutline', 16));
  const tbtn = (act, ic, title, fn) => h('button', { class: 'btn sm icon', type: 'button', 'data-act': act, title, 'aria-label': title, onclick: fn }, icon(ic, 16));
  const transport = h('div', { class: 'vm-transport', role: 'group', 'aria-label': 'Transport' },
    tbtn('to-start', 'toStart', 'Go to the start (Home)', () => { pause(); seek(0); }),
    tbtn('step-back', 'stepBack', 'Back one frame (Left)', () => { pause(); seek(V.playhead - 1 / fpsOf()); }),
    playBtn,
    tbtn('step-forward', 'stepForward', 'Forward one frame (Right)', () => { pause(); seek(V.playhead + 1 / fpsOf()); }),
    tbtn('to-end', 'toEnd', 'Go to the end (End)', () => { pause(); seek(lengthOf(doc())); }),
    time, stale);
  root.append(h('div', { class: 'vm-head' }, seg, sizeSel, pinBtn, h('span', { class: 'grow' }), renderBtn), stage, prog, sbar, transport);

  let pinMode = false;
  let syncing = false;
  let raf = 0;
  let videoSrc = '';            // what the video element has loaded (url) and for which mode
  let videoReady = false;
  let wantPlay = false;
  let frameTimer = null;
  let frameToken = 0;
  let lastDoc = null;
  const frames = new Map();     // `${version}|${size}|${frame}` -> data url
  const render = { job: null, percent: 0, message: '', error: '', abort: null };
  const source = { key: '', status: 'idle', message: '', progress: 0, abort: null, explicit: null };

  // ---- small helpers ---------------------------------------------------------------------------------------------------------

  function say(text, { kind = 'info', busy = false, actions = [] } = {}) {
    note.className = `vm-note ${text || busy ? 'on' : ''} ${kind}`;
    note.replaceChildren(...[busy ? h('span', { class: 'vm-spin', 'aria-hidden': 'true' }) : null, text ? h('span', { class: 'vm-note-text' }, text) : null, ...actions].filter(Boolean));
  }
  const quiet = () => say('');
  const paintPinBtn = () => { pinBtn.setAttribute('aria-pressed', String(pinMode)); pinBtn.classList.toggle('on', pinMode); frameBox.classList.toggle('pinning', pinMode); };

  function paintHead() {
    const sizes = videoSizes();
    sizeSel.classList.toggle('hidden', sizes.length < 2);
    if (sizes.length >= 2 && sizeSel.options.length !== sizes.length) sizeSel.replaceChildren(...sizes.map((s) => h('option', { value: s.id }, `${s.id} ${s.w}x${s.h}`)));
    sizeSel.value = currentSize().id;
    const s = currentSize();
    frameBox.style.setProperty('--ar', `${s.w} / ${s.h}`);
    for (const [id, b] of Object.entries(modeButtons)) { b.setAttribute('aria-pressed', String(V.mode === id)); b.classList.toggle('on', V.mode === id); }
    frameBox.dataset.mode = V.mode;
    img.style.display = (V.mode === 'frame' || (V.mode === 'source' && source.status === 'image')) && img.getAttribute('src') ? '' : 'none';
    video.style.display = (V.mode === 'cut' && videoReady) || (V.mode === 'source' && source.status === 'ready') ? '' : 'none';
    renderBtn.disabled = !!render.job;
    renderBtn.textContent = '';
    renderBtn.append(icon('film', 14), render.job ? 'Rendering…' : preview.exists ? 'Render preview again' : 'Render preview');
  }

  function paintTime() {
    const d = doc();
    if (V.mode === 'source' && source.status === 'ready') {
      time.textContent = `source ${clock(video.currentTime || 0)} / ${clock(video.duration || 0)}`;
    } else {
      time.textContent = `${clock(V.playhead)} / ${clock(d?.timeline?.duration ?? 0)} · frame ${toFrames(V.playhead, fpsOf(d))}`;
    }
    const playing = V.mode === 'source' ? !video.paused : V.playing;
    playBtn.replaceChildren(icon(playing ? 'pause' : 'playOutline', 16));
    playBtn.title = playing ? 'Pause (Space)' : 'Play (Space)';
    playBtn.setAttribute('aria-label', playBtn.title);
    // is the preview older than the edits?
    const old = V.mode === 'cut' && preview.exists && (preview.renderedV === null ? false : preview.renderedV !== state.v);
    stale.classList.toggle('hidden', !old);
    if (old) stale.textContent = 'This preview is from before your latest edits. Render it again to see them.';
  }

  // ---- Frame -------------------------------------------------------------------------------------------------------------------

  function scheduleFrame() {
    if (V.mode !== 'frame') return;
    frameToken++;           // whatever is still on its way is stale now
    frameBox.classList.add('stale');
    clearTimeout(frameTimer);
    frameTimer = setTimeout(fetchFrame, 300);
  }

  // ---- text on the picture: click a title to select it, double-click to change its words ---------------------------------------------
  const boxCache = new Map();
  let boxes = [];
  const textLayer = (id) => (doc().layers ?? []).find((l) => l.id === id) ?? null;
  function paintBoxes(list) {
    boxes = V.mode === 'frame' ? list : [];
    const sel = V.sel.kind === 'layer' ? new Set(V.sel.ids) : new Set();
    boxLayer.replaceChildren(...boxes.filter((b) => b.type === 'text' || b.type === 'group').map((b) => {
      const layer = textLayer(b.id);
      const caption = b.id.startsWith('nv-');
      if (!layer && !caption) return null;
      const editable = layer?.type === 'text' && typeof layer.text === 'string' && !layer.lock;
      const label = caption ? 'Captions come from the transcript' : editable ? `Title: ${layer.text.slice(0, 40)}` : `Title ${b.id}`;
      return h('button', {
        class: `vm-tbox${sel.has(b.id) ? ' sel' : ''}${caption ? ' cap' : ''}`, type: 'button', 'data-layer': b.id, 'data-editable': editable ? '1' : '0',
        style: { left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` },
        title: caption ? 'Captions come from the transcript: change the words in the Transcript tab.' : editable ? 'Click to select this text. Double-click to change the words.' : 'Click to select. Its settings are on the right.',
        'aria-label': label,
        onclick: (e) => { e.stopPropagation(); if (caption) { toast('Captions come from the transcript. Change the words in the Transcript tab.'); return; } select('layer', [b.id]); },
        ondblclick: (e) => { e.stopPropagation(); if (editable) editText(b, layer); else if (!caption) select('layer', [b.id]); },
      });
    }).filter(Boolean));
  }
  /** The words changed in place: a box over the title, Enter (or clicking away) keeps it, Escape leaves it as it was. */
  function editText(b, layer) {
    video.pause();
    const ta = h('textarea', { class: 'vm-edit', 'aria-label': `Words of ${layer.name ?? layer.id}`, 'data-field': 'frame-text', style: { left: `${b.x * 100}%`, top: `${b.y * 100}%`, minWidth: `${Math.max(b.w, 0.2) * 100}%`, minHeight: `${Math.max(b.h, 0.05) * 100}%` } });
    ta.value = layer.text;
    let done = false;
    const finish = (keep) => {
      if (done) return;
      done = true;
      const next = ta.value;
      ta.remove();
      if (keep && next.trim() && next !== layer.text) { try { setLayerField(layer.id, ['text'], next, `Text of ${layer.id}`); } catch (e) { toast(e.message); } }
    };
    ta.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } });
    ta.addEventListener('blur', () => finish(true));
    boxLayer.append(ta);
    ta.focus(); ta.select();
  }
  onV('sel', () => { for (const el of boxLayer.querySelectorAll('.vm-tbox')) el.classList.toggle('sel', V.sel.kind === 'layer' && V.sel.ids.includes(el.dataset.layer)); });

  async function fetchFrame() {
    if (V.mode !== 'frame') return;
    const d = doc();
    const fps = fpsOf(d);
    const t = Math.min(V.playhead, Math.max(0, lengthOf(d) - 1 / fps));
    const size = currentSize();
    const key = `${state.v}|${size.id}|${toFrames(t, fps)}`;
    const hit = frames.get(key);
    if (hit) { img.src = hit; paintBoxes(boxCache.get(key) ?? []); paintHead(); frameBox.classList.remove('stale'); frameBox.removeAttribute('aria-busy'); quiet(); return; }
    const token = ++frameToken;
    say('', { busy: true });
    frameBox.setAttribute('aria-busy', 'true');
    try {
      await whenSaved();
      if (token !== frameToken) return;
      const asked = state.v;
      const r = await api.post(videoApi('stills'), { doc: state.docId, times: [t], scale: 0.5, size: sizeParam(), boxes: true });
      if (token !== frameToken) return;     // the playhead or the document moved on while this was drawn: throw it away
      const f = r.files[0];
      const url = `data:${f.mime};base64,${f.base64}`;
      frames.set(`${asked}|${size.id}|${toFrames(t, fps)}`, url);
      boxCache.set(`${asked}|${size.id}|${toFrames(t, fps)}`, f.boxes ?? []);
      paintBoxes(f.boxes ?? []);
      if (frames.size > 40) frames.delete(frames.keys().next().value);
      img.src = url;
      paintHead();
      frameBox.classList.remove('stale');
      frameBox.removeAttribute('aria-busy');
      sourceProblems.delete('__frame');
      quiet();
    } catch (e) {
      if (token !== frameToken) return;
      frameBox.removeAttribute('aria-busy');
      frameBox.classList.remove('stale');
      say(e.message, { kind: 'error', actions: [h('button', { class: 'btn sm', type: 'button', onclick: () => { frames.clear(); fetchFrame(); } }, 'Try again')] });
    }
  }

  // ---- Cut ---------------------------------------------------------------------------------------------------------------------

  function loadPreview() {
    const url = previewUrl();
    if (videoSrc === url && videoReady) { syncVideoToPlayhead(true); return; }
    videoSrc = url;
    videoReady = false;
    video.src = url;
    video.load();
    say('Loading the preview…', { busy: true });
  }

  function syncVideoToPlayhead(force = false) {
    if (!videoReady || V.mode !== 'cut') return;
    if (force || Math.abs(video.currentTime - V.playhead) > 0.5 / fpsOf()) video.currentTime = Math.min(V.playhead, Math.max(0, (video.duration || V.playhead) - 0.01));
  }

  async function enterCut() {
    if (!preview.checked) await checkPreview();
    if (V.mode !== 'cut') return;
    if (!preview.exists) {
      videoReady = false;
      say('There is no preview of this video yet. Render one to play the cut here.', { actions: [h('button', { class: 'btn sm primary', type: 'button', onclick: () => renderPreview() }, 'Render preview')] });
      return;
    }
    loadPreview();
  }

  video.addEventListener('loadedmetadata', () => {
    if (V.mode === 'cut') { videoReady = true; quiet(); syncVideoToPlayhead(true); paintHead(); if (wantPlay) { wantPlay = false; video.play().catch(() => {}); } }
    else if (V.mode === 'source') sourceReady();
  });
  video.addEventListener('error', () => {
    if (!video.getAttribute('src')) return;
    videoReady = false;
    say(V.mode === 'cut' ? 'The preview could not be played. Render it again.' : 'The small copy of this footage could not be played.', { kind: 'error' });
  });
  video.addEventListener('play', () => { if (V.mode === 'cut') { setV({ playing: true }); loop(); } paintTime(); });
  video.addEventListener('pause', () => { if (V.mode === 'cut') { setV({ playing: false }); setV({ playhead: snapFrame(video.currentTime, fpsOf()) }); } paintTime(); });
  video.addEventListener('ended', () => { if (V.mode === 'cut') setV({ playing: false }); paintTime(); });
  video.addEventListener('seeked', () => { if (V.mode === 'source') paintSourceBar(); });
  video.addEventListener('timeupdate', () => { if (V.mode === 'source') { paintTime(); paintSourceBar(); } });

  function loop() {
    cancelAnimationFrame(raf);
    const tick = () => {
      if (V.mode !== 'cut' || video.paused) return;
      syncing = true;
      setV({ playhead: Math.min(video.currentTime, lengthOf(doc())) });
      syncing = false;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  // ---- rendering a preview ----------------------------------------------------------------------------------------------------

  async function renderPreview() {
    if (render.job) return;
    render.error = ''; render.percent = 0; render.message = 'Starting';
    paintProgress();
    try {
      await whenSaved();
      const version = state.v; // the version that is drawn: every edit so far has been saved
      const job = await startRender({ preview: true, size: sizeParam() });
      render.job = job;
      render.abort = new AbortController();
      paintProgress(); paintHead();
      const done = await watchJob(job.id, (j) => { render.percent = j.percent; render.message = j.message; paintProgress(); }, render.abort.signal);
      render.job = null;
      if (done.status === 'done') { previewRendered(version); videoSrc = ''; if (V.mode === 'cut') enterCut(); else setV({ mode: 'cut' }); toast('Preview ready. Press Space to play it.', 'ok'); }
      else if (done.status === 'cancelled') render.error = 'Cancelled.';
      else render.error = done.error || 'The preview could not be rendered.';
    } catch (e) {
      render.job = null;
      render.error = e.message;
    }
    paintProgress(); paintHead();
  }

  function paintProgress() {
    if (!render.job && !render.error) { prog.classList.add('hidden'); prog.replaceChildren(); return; }
    prog.classList.remove('hidden');
    prog.classList.toggle('error', !!render.error && !render.job);
    if (render.job) {
      prog.replaceChildren(h('progress', { max: 100, value: render.percent, 'aria-label': 'Preview render progress' }), h('span', {}, `${render.percent}% ${render.message ?? ''}`),
        h('button', { class: 'btn sm', type: 'button', onclick: () => cancelJob(render.job.id) }, 'Cancel'));
    } else {
      prog.replaceChildren(h('span', {}, render.error), h('button', { class: 'btn sm', type: 'button', onclick: () => { render.error = ''; paintProgress(); } }, 'Dismiss'));
    }
  }

  // ---- Source ---------------------------------------------------------------------------------------------------------------------

  const sourceTarget = () => {
    if (source.explicit) return { sourceId: source.explicit.sourceId, clip: null, at: source.explicit.at };
    const ref = selectedClip(doc());
    return ref ? { sourceId: ref.clip.source, clip: ref.clip, at: ref.clip.in } : null;
  };

  async function enterSource() {
    const target = sourceTarget();
    source.abort?.abort();
    if (!target) {
      video.removeAttribute('src'); video.load(); videoSrc = ''; source.status = 'idle'; source.key = '';
      say('Click a clip in the timeline first, then press Source to play its footage here.');
      paintHead(); paintSourceBar();
      return;
    }
    const s = sourceOf(doc(), target.sourceId);
    const key = `${target.sourceId}|${target.clip?.id ?? ''}|${source.explicit ? source.explicit.at : ''}`;
    if (key === source.key && (source.status === 'ready' || source.status === 'loading')) { paintHead(); paintSourceBar(); return; }
    source.key = key;
    if (!s) { say(`This clip uses "${target.sourceId}", which is not in the document's sources.`, { kind: 'error' }); return; }
    if (s.type === 'image') {
      source.status = 'image';
      video.removeAttribute('src'); video.load(); videoSrc = '';
      if (String(s.path).startsWith('mount:')) say(`This photo lives on a mount (${s.path}), which the page cannot show. Put photos in the project's assets folder.`, { kind: 'error' });
      else { img.src = fileUrl(s.path); quiet(); }
      paintHead(); paintSourceBar();
      return;
    }
    source.status = 'loading'; source.message = '';
    const ac = (source.abort = new AbortController());
    say(`Making a small copy of "${s.id}" to play…`, { busy: true });
    paintHead(); paintSourceBar();
    try {
      const url = await ensureProxy(s.id, (p) => { source.progress = p; say(`Making a small copy of "${s.id}": ${Math.round(p)}%`, { busy: true }); }, ac.signal);
      if (ac.signal.aborted || V.mode !== 'source' || source.key !== key) return;
      sourceProblems.delete(s.id);
      videoSrc = url;
      videoReady = false;
      video.src = url;
      video.load();
    } catch (e) {
      if (ac.signal.aborted) return;
      source.status = 'error';
      source.message = e.message;
      say(e.message, { kind: 'error', actions: [h('button', { class: 'btn sm', type: 'button', onclick: () => { source.key = ''; enterSource(); } }, 'Try again')] });
      paintHead(); paintSourceBar();
    }
  }

  function sourceReady() {
    const target = sourceTarget();
    source.status = 'ready';
    quiet();
    video.currentTime = Math.min(target?.at ?? 0, Math.max(0, video.duration - 0.05));
    if (source.explicit?.play) { source.explicit.play = false; video.play().catch(() => {}); }
    paintHead(); paintTime(); paintSourceBar();
  }

  function paintSourceBar() {
    const target = V.mode === 'source' ? sourceTarget() : null;
    sbar.classList.toggle('hidden', !target || source.status !== 'ready');
    if (sbar.classList.contains('hidden')) { sbar.replaceChildren(); return; }
    const dur = video.duration || 1;
    const c = target.clip;
    const pos = (t) => `${Math.min(100, Math.max(0, (t / dur) * 100))}%`;
    const range = c ? h('i', { class: 'vm-use', style: { left: pos(c.in), width: `${Math.max(0, ((c.out - c.in) / dur) * 100)}%` }, title: 'The part this clip plays' }) : null;
    let seek = sbar.querySelector('.vm-seek');
    if (!seek) {
      seek = h('input', { class: 'vm-seek', type: 'range', min: 0, step: 0.01, 'aria-label': 'Position in the source footage', oninput: (e) => { video.currentTime = Number(e.target.value); } });
      sbar.replaceChildren(h('div', { class: 'vm-track' }, h('div', { class: 'vm-use-wrap' }), seek),
        h('div', { class: 'vm-sbtns' },
          h('button', { class: 'btn sm', type: 'button', 'data-act': 'set-in', title: 'This moment becomes the start of the clip (I)', onclick: () => sourcePoint('in') }, icon('trimIn', 14), 'Start clip here'),
          h('button', { class: 'btn sm', type: 'button', 'data-act': 'set-out', title: 'This moment becomes the end of the clip (O)', onclick: () => sourcePoint('out') }, icon('trimOut', 14), 'End clip here'),
          h('button', { class: 'btn sm', type: 'button', 'data-act': 'to-clip-in', title: 'Jump to where the clip starts', onclick: () => { if (c) video.currentTime = c.in; } }, 'Go to clip start'),
          h('span', { class: 'vm-sinfo' })));
      seek = sbar.querySelector('.vm-seek');
    }
    seek.max = String(dur);
    seek.value = String(video.currentTime || 0);
    sbar.querySelector('.vm-use-wrap').replaceChildren(...(range ? [range] : []));
    sbar.querySelector('.vm-sinfo').textContent = c ? `The clip plays ${clock(c.in)} to ${clock(c.out)} of this footage.` : '';
    for (const b of sbar.querySelectorAll('[data-act="set-in"], [data-act="set-out"]')) b.disabled = !c;
  }

  async function sourcePoint(edge) {
    const target = sourceTarget();
    if (!target?.clip) { toast('Click a clip in the timeline first. I and O change its start and end.', 'error'); return false; }
    video.pause();
    return setClipSourcePoint(target.clip.id, edge, snapFrame(video.currentTime, fpsOf()));
  }

  // ---- modes, playing -------------------------------------------------------------------------------------------------------

  function pause() { video.pause(); }
  function stopVideo() { video.pause(); setV({ playing: false }); }

  function togglePlay() {
    if (V.mode === 'frame') {
      if (!preview.checked) { checkPreview().then(() => togglePlay()); return; }
      if (!preview.exists) { toast('There is no preview to play yet. Press "Render preview" and it plays here.', 'error'); return; }
      wantPlay = true;
      setV({ mode: 'cut' });
      return;
    }
    if (V.mode === 'cut' && !videoReady) { wantPlay = true; return; }
    if (video.paused) {
      if (V.mode === 'cut' && V.playhead >= lengthOf(doc()) - 1 / fpsOf()) video.currentTime = 0;
      video.play().catch((e) => toast(`The video could not start: ${e.message}`, 'error'));
    } else video.pause();
  }

  function onMode() {
    quiet();
    if (V.mode !== 'frame') boxLayer.replaceChildren();
    if (V.mode !== 'source') { source.explicit = null; source.key = ''; source.status = 'idle'; source.abort?.abort(); }
    if (V.mode !== 'cut') { videoReady = false; if (!video.paused) video.pause(); }
    if (V.mode === 'frame') { video.removeAttribute('src'); video.load(); videoSrc = ''; source.key = ''; source.status = 'idle'; fetchFrame(); }
    else if (V.mode === 'cut') { video.removeAttribute('src'); videoSrc = ''; enterCut(); }
    else enterSource();
    paintHead(); paintTime(); paintPins(); paintSourceBar();
  }
  onV('mode', onMode);
  onV('size', () => { paintHead(); scheduleFrame(); });

  onV('playhead', () => {
    paintTime();
    paintPins();
    if (syncing) return;
    if (V.mode === 'frame') scheduleFrame();
    else if (V.mode === 'cut') syncVideoToPlayhead();
  });
  onV('play', paintTime);
  // the footage is reachable again (the drive is back): ask for the picture once more
  onV('data', () => { if (V.mode === 'frame' && note.classList.contains('error')) { frames.clear(); scheduleFrame(); } });
  onV('preview', () => { paintHead(); paintTime(); });
  onV('sel', () => { if (V.mode === 'source') { source.explicit = null; enterSource(); } });

  // ---- pins (comments on a moment of the picture) --------------------------------------------------------------------------

  function paintPins() {
    const t = V.playhead;
    const list = (state.review?.comments ?? []).map((c, i) => ({ c, n: i + 1 })).filter(({ c }) => typeof c.time === 'number' && c.status !== 'resolved' && Math.abs(c.time - t) <= 0.75);
    pins.replaceChildren(...list.map(({ c, n }) => h('button', { class: 'vm-pin', type: 'button', style: { left: `${c.x * 100}%`, top: `${c.y * 100}%` }, title: c.text, 'aria-label': `Comment ${n} at ${clock(c.time)}: ${c.text}`, onclick: (e) => { e.stopPropagation(); update({ focusComment: c.id, panel: 'review' }); } }, String(n))));
  }

  frameBox.addEventListener('click', async (e) => {
    if (!pinMode || e.target.closest('.vm-pin')) return;
    const r = frameBox.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
    pinMode = false; paintPinBtn();
    video.pause();
    const at = V.playhead;
    const out = await promptBox(`Comment at ${clock(at)}`, [{ name: 'text', label: 'Comment', multiline: true, placeholder: 'What should change here?' }], { ok: 'Add comment' });
    if (out?.text.trim()) addComment({ pageId: 'video', x, y, time: at, text: out.text });
  });

  // ---- following the document --------------------------------------------------------------------------------------------------

  function onDoc() {
    paintHead(); paintTime(); paintPins();
    const d = state.doc;
    if (d === lastDoc) return;
    lastDoc = d;
    if (V.mode === 'frame') scheduleFrame();
    if (V.mode === 'source') paintSourceBar();
  }

  function open() {
    frames.clear(); videoSrc = ''; videoReady = false; source.key = ''; source.status = 'idle'; source.explicit = null;
    lastDoc = state.doc; quiet();
    checkPreview().then(() => { if (V.mode === 'cut') enterCut(); paintHead(); });
    paintHead(); paintTime(); paintPins(); onMode();
  }

  function close() {
    stopVideo();
    video.removeAttribute('src'); video.load();
    clearTimeout(frameTimer); frameToken++;
    render.abort?.abort(); source.abort?.abort();
  }

  return {
    open, close, onDoc, togglePlay, pause: stopVideo, sourcePoint,
    playSourceAt(sourceId, at) { source.explicit = { sourceId, at, play: true }; source.key = ''; if (V.mode === 'source') enterSource(); else setV({ mode: 'source' }); },
    renderPreview, paintHead,
  };
}
