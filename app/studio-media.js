// Looking at a post: a swipeable carousel with a page strip, or a real video player with a key-frame strip.
// Both take pins: switch the pin tool on (button or C), click a spot, write the note (the comments panel). Pins on a reel carry a
// second as well and show only near it. Keys: ← → move inside the picture when it has focus; , and . step from anywhere.

import { h, icon } from './dom.js';
import { api as http } from './api.js';
import { openCoverPicker } from './studio-cover.js';
import { thumbUrl, fileUrl, glyph, laneColor, FORMAT_LABEL, bumpPictures, notify } from './studio-ui.js';

let current = null;
/** The viewer on screen now (so keys pressed anywhere can drive it). */
export const activeViewer = () => current;

export const clock = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '0:00');
const WINDOW = 1.5; // seconds either side of its time that a pin on a video is shown

const isSpot = (c) => !c.general;
const pinNo = (all, c) => all.indexOf(c) + 1;

/** One pin button, placed by percentages inside its layer. */
function pinEl(all, c, onPin, extra = '') {
  return h('button', {
    class: `spin${c.status === 'resolved' ? ' done' : ''}${extra}`, type: 'button', style: { left: `${c.x * 100}%`, top: `${c.y * 100}%` },
    title: c.text, 'aria-label': `Comment ${pinNo(all, c)}: ${c.text}`, dataset: { comment: c.id }, onclick: (e) => { e.stopPropagation(); onPin?.(c); },
  }, h('span', {}, String(pinNo(all, c))));
}
const draftEl = (d) => h('i', { class: 'spin new', style: { left: `${d.x * 100}%`, top: `${d.y * 100}%` }, 'aria-hidden': 'true' }, h('span', {}, '+'));
const spotOf = (e, box) => { const r = box.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) }; };

// ---- a carousel (or a single picture) ----------------------------------------------------------------------------------------------

function carousel(d, post, opts) {
  const pages = d.media.pages;
  let index = 0, comments = opts.comments ?? [], pinning = false, draft = null;
  const track = h('div', { class: 'cv-track', tabindex: '0', role: 'group', 'aria-roledescription': 'carousel', 'aria-label': `${post.title}, ${pages.length} ${pages.length === 1 ? 'picture' : 'pages'}` });
  const layers = [];
  const slides = pages.map((p, i) => {
    const img = h('img', { src: thumbUrl(post.project, p.path, opts.w ?? 720), alt: p.alt || `${p.title}`, loading: i < 2 ? 'eager' : 'lazy', decoding: 'async', draggable: 'false' });
    const layer = h('div', { class: 'sp-layer' });
    layers.push(layer);
    const slide = h('figure', { class: 'cv-slide', 'aria-label': `Page ${i + 1} of ${pages.length}` }, img, layer);
    const fit = () => {
      if (!img.naturalWidth) return;
      const W = slide.clientWidth, H = slide.clientHeight, r = img.naturalWidth / img.naturalHeight;
      const bw = W / H > r ? H * r : W, bh = W / H > r ? H : W / r;
      Object.assign(layer.style, { left: `${(W - bw) / 2}px`, top: `${(H - bh) / 2}px`, width: `${bw}px`, height: `${bh}px` });
    };
    img.addEventListener('load', () => { if (i === 0 && img.naturalWidth) frame.style.setProperty('--ar', `${img.naturalWidth} / ${img.naturalHeight}`); fit(); });
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fit).observe(slide);
    layer.addEventListener('click', (e) => {
      if (!pinning) return;
      draft = { page: p.id, ...spotOf(e, layer) };
      paintPins();
      opts.onDraft?.({ ...draft });
    });
    return slide;
  });
  track.append(...slides);
  const count = h('span', { class: 'cv-count', 'aria-live': 'polite' });
  const caption = h('div', { class: 'cv-cap' });
  const prev = h('button', { class: 'cv-nav cv-prev', 'aria-label': 'Previous page', onclick: () => go(index - 1) }, icon('chevL', 18));
  const next = h('button', { class: 'cv-nav cv-next', 'aria-label': 'Next page', onclick: () => go(index + 1) }, icon('chevR', 18));
  const frame = h('div', { class: 'cv-frame' }, track, pages.length > 1 ? [prev, next] : null, pages.length > 1 ? count : null);
  const strip = pages.length > 1 ? h('div', { class: 'cv-strip', role: 'tablist', 'aria-label': 'Pages' }, pages.map((p, i) => h('button', { class: 'cv-t', role: 'tab', 'aria-label': `Page ${i + 1}: ${p.title}`, onclick: () => go(i) },
    h('img', { src: thumbUrl(post.project, p.path, 160), alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' }), h('span', {}, String(i + 1))))) : null;
  const root = h('div', { class: 'cv' }, frame, strip, caption);

  function paintPins() {
    pages.forEach((p, i) => {
      const kids = comments.filter((c) => isSpot(c) && c.status !== 'resolved' && c.page === p.id && typeof c.time !== 'number').map((c) => pinEl(comments, c, opts.onPin));
      if (draft?.page === p.id) kids.push(draftEl(draft));
      layers[i].replaceChildren(...kids);
    });
  }
  function paint() {
    count.textContent = `${index + 1} / ${pages.length}`;
    prev.disabled = index === 0;
    next.disabled = index === pages.length - 1;
    const p = pages[index];
    caption.replaceChildren(...[h('span', { class: 'cv-cap-t' }, p.title), p.alt ? h('span', { class: 'cv-cap-alt' }, p.alt) : null].filter(Boolean));
    strip?.querySelectorAll('.cv-t').forEach((b, i) => { b.classList.toggle('on', i === index); b.setAttribute('aria-selected', String(i === index)); });
    strip?.children[index]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function go(i, smooth = true) {
    index = Math.max(0, Math.min(pages.length - 1, i));
    track.scrollTo({ left: index * track.clientWidth, behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
    paint();
  }
  let raf = 0;
  track.addEventListener('scroll', () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
      if (i !== index && i >= 0 && i < pages.length) { index = i; paint(); }
    });
  }, { passive: true });
  track.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); go(index + 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); go(index - 1); }
  });
  paint();
  paintPins();
  return {
    el: root, kind: 'carousel',
    step: (n) => go(index + n), toggle: () => go(index + 1), destroy() { cancelAnimationFrame(raf); },
    get index() { return index; },
    setComments(list) { comments = list; paintPins(); },
    setPinMode(on) { pinning = on; root.classList.toggle('pinning', on); if (!on) { draft = null; paintPins(); } else root.scrollIntoView({ block: 'nearest' }); opts.onMode?.(on); },
    pinMode: () => pinning,
    draft: () => (draft ? { ...draft } : null),
    clearDraft() { draft = null; paintPins(); },
    where: () => ({ page: pages[index].id }),
    focusComment(c) {
      const i = pages.findIndex((p) => p.id === c.page);
      root.scrollIntoView({ block: 'nearest' });
      if (i >= 0) go(i);
      setTimeout(() => { const el = layers[Math.max(0, i)].querySelector(`[data-comment="${CSS.escape(c.id)}"]`); el?.classList.add('flash'); setTimeout(() => el?.classList.remove('flash'), 1600); }, 350);
    },
  };
}

// ---- a reel -------------------------------------------------------------------------------------------------------------------------

const frameCache = new Map();
const FRAMES = 8;

/** Grab small pictures at even steps through a video, using a second, muted copy of it. Cached by address. */
function extractFrames(src, onFrame, signal) {
  if (frameCache.has(src)) { frameCache.get(src).forEach((u, i) => onFrame(i, u)); return; }
  const v = document.createElement('video');
  v.muted = true; v.preload = 'auto'; v.playsInline = true; v.crossOrigin = 'anonymous';
  const canvas = document.createElement('canvas');
  const got = [];
  const fail = () => { v.removeAttribute('src'); v.load(); };
  v.addEventListener('error', fail, { once: true });
  v.addEventListener('loadedmetadata', async () => {
    const dur = v.duration;
    if (!Number.isFinite(dur) || dur <= 0) return fail();
    const ratio = v.videoWidth / Math.max(1, v.videoHeight) || 9 / 16;
    canvas.height = 128; canvas.width = Math.round(128 * ratio);
    const ctx = canvas.getContext('2d');
    for (let i = 0; i < FRAMES; i++) {
      if (signal.aborted) return fail();
      const t = Math.min(dur - 0.05, (dur * (i + 0.5)) / FRAMES);
      const ok = await new Promise((res) => {
        const timer = setTimeout(() => res(false), 5000);
        v.addEventListener('seeked', () => { clearTimeout(timer); res(true); }, { once: true });
        v.currentTime = t;
      });
      if (!ok) continue;
      try { ctx.drawImage(v, 0, 0, canvas.width, canvas.height); const url = canvas.toDataURL('image/jpeg', 0.6); got[i] = url; onFrame(i, url); } catch { return fail(); }
    }
    frameCache.set(src, got);
    fail();
  }, { once: true });
  v.src = src;
}

function reel(d, post, opts) {
  const src = fileUrl(post.project, d.media.video);
  const poster = d.media.poster ? thumbUrl(post.project, d.media.poster, opts.w ?? 720) : undefined;
  let comments = opts.comments ?? [], pinning = false, draft = null;
  const video = h('video', { class: 'vp-video', controls: true, preload: 'metadata', playsinline: true, poster, 'aria-label': `${post.title}, video`, src: poster ? src : `${src}#t=0.1` });
  const layer = h('div', { class: 'sp-layer' });
  const catcher = h('div', { class: 'sp-catch', title: 'Click to drop a pin at this moment' });
  const stage = h('div', { class: 'vp-stage' }, video, layer, catcher);
  const abort = new AbortController();
  const coverNote = h('span', { class: 'vp-cover-note' }, d.media.coverTime != null ? `Cover: ${clock(d.media.coverTime)}` : '');
  const coverBtn = h('button', { class: 'btn quiet vp-cover', type: 'button', 'data-act': 'set-cover', title: 'Use the frame you are looking at as this reel’s cover', onclick: () => setCover() }, 'Use this frame as the cover');
  const suggestBtn = h('button', { class: 'btn quiet vp-cover', type: 'button', 'data-act': 'pick-cover', title: 'See the best few frames and choose one, or let Nordle pick', onclick: async () => {
    const r = await openCoverPicker(post);
    if (r) { coverNote.textContent = `Cover: ${clock(r.time)}${r.auto ? ' (automatic)' : ''}`; video.poster = thumbUrl(post.project, r.cover, opts.w ?? 720); }
  } }, 'Suggest covers…');
  const head = h('div', { class: 'vp-head' }, h('span', { class: 'vp-time' }, '0:00 / 0:00'), h('span', { class: 'vp-hint' }, '← → seek · , . jump 5 s'), coverNote, suggestBtn, coverBtn);
  /** The frame on screen becomes the cover: the picture is retaken from the finished video and Buffer is told the frame. */
  async function setCover() {
    video.pause();
    const t = Math.round((video.currentTime || 0) * 100) / 100;
    coverBtn.disabled = true;
    try {
      const r = await http.post('/studio/cover', { uid: post.uid, time: t });
      coverNote.textContent = `Cover: ${clock(r.time)}`;
      bumpPictures();
      video.poster = thumbUrl(post.project, r.cover, opts.w ?? 720);
      notify(`Cover set to ${clock(r.time)}. Buffer will use that frame.`, { kind: 'ok' });
    } catch (e) { notify(e.message, { kind: 'error' }); }
    coverBtn.disabled = false;
  }

  const playhead = h('i', { class: 'vp-playhead' });
  const frames = Array.from({ length: FRAMES }, (_, i) => h('button', { class: 'vp-f', 'aria-label': `Jump to part ${i + 1} of ${FRAMES}`, onclick: () => { const dur = video.duration; if (Number.isFinite(dur)) { video.currentTime = (dur * (i + 0.5)) / FRAMES; video.focus(); } } }, h('span', { class: 'vp-ph' })));
  const strip = h('div', { class: 'vp-strip', role: 'group', 'aria-label': 'Key frames' }, frames, playhead);
  const marks = h('div', { class: 'vp-marks', role: 'group', 'aria-label': 'Pins in time' });
  const root = h('div', { class: 'vp' }, h('div', { class: 'vp-frame' }, stage), head, marks, strip);

  const paintTime = () => {
    head.firstChild.textContent = `${clock(video.currentTime)} / ${clock(video.duration)}`;
    if (Number.isFinite(video.duration) && video.duration > 0) playhead.style.left = `${(video.currentTime / video.duration) * 100}%`;
  };
  function paintPins() {
    const t = video.currentTime || 0;
    const near = (time) => Math.abs((time ?? 0) - t) <= WINDOW;
    const kids = comments.filter((c) => isSpot(c) && c.status !== 'resolved' && typeof c.time === 'number' && near(c.time)).map((c) => pinEl(comments, c, opts.onPin));
    if (draft && near(draft.time)) kids.push(draftEl(draft));
    layer.replaceChildren(...kids);
    const dur = video.duration;
    marks.replaceChildren(...(Number.isFinite(dur) && dur > 0 ? comments.filter((c) => typeof c.time === 'number' && c.status !== 'resolved').map((c) => h('button', {
      class: `vp-mark${c.status === 'resolved' ? ' done' : ''}`, type: 'button', style: { left: `${Math.min(100, (c.time / dur) * 100)}%` }, title: `${clock(c.time)}: ${c.text}`, 'aria-label': `Pin ${pinNo(comments, c)} at ${clock(c.time)}`,
      onclick: () => { api.focusComment(c); opts.onPin?.(c); },
    }, h('span', {}, String(pinNo(comments, c))))) : []));
  }
  video.addEventListener('timeupdate', () => { paintTime(); paintPins(); });
  video.addEventListener('seeked', paintPins);
  video.addEventListener('loadedmetadata', () => {
    paintTime(); paintPins();
    if (video.videoWidth) root.style.setProperty('--ar', `${video.videoWidth} / ${video.videoHeight}`);
  });
  catcher.addEventListener('click', (e) => {
    if (!pinning) return;
    video.pause();
    draft = { page: 'video', time: Math.round(video.currentTime * 100) / 100, ...spotOf(e, stage) };
    paintPins();
    opts.onDraft?.({ ...draft });
  });
  video.addEventListener('keydown', (e) => {
    const big = e.shiftKey ? 5 : 1;
    if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); video.currentTime = Math.min(video.duration || 0, video.currentTime + big); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); video.currentTime = Math.max(0, video.currentTime - big); }
    else if (e.key === ' ') { e.stopPropagation(); }
  });
  let started = false;
  const kick = () => {
    if (started) return;
    started = true;
    extractFrames(src, (i, url) => { const ph = frames[i]?.firstChild; if (ph) ph.replaceWith(h('img', { src: url, alt: '', draggable: 'false' })); }, abort.signal);
  };
  video.addEventListener('loadeddata', () => setTimeout(kick, 150), { once: true });
  setTimeout(kick, 1800);

  const api = {
    el: root, video, kind: 'video',
    step: (n) => { video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + n * 5)); },
    toggle: () => { if (video.paused) video.play().catch(() => {}); else video.pause(); },
    destroy() { abort.abort(); video.pause(); video.removeAttribute('src'); video.load(); },
    setComments(list) { comments = list; paintPins(); },
    setPinMode(on) { pinning = on; root.classList.toggle('pinning', on); if (on) { video.pause(); root.scrollIntoView({ block: 'nearest' }); } else { draft = null; paintPins(); } opts.onMode?.(on); },
    pinMode: () => pinning,
    draft: () => (draft ? { ...draft } : null),
    clearDraft() { draft = null; paintPins(); },
    where: () => ({ page: 'video', time: Math.round((video.currentTime || 0) * 100) / 100 }),
    focusComment(c) {
      root.scrollIntoView({ block: 'nearest' });
      video.pause();
      if (typeof c.time === 'number') video.currentTime = c.time;
      setTimeout(() => { paintPins(); const el = layer.querySelector(`[data-comment="${CSS.escape(c.id)}"]`); el?.classList.add('flash'); setTimeout(() => el?.classList.remove('flash'), 1600); }, 120);
    },
  };
  return api;
}

// ---- nothing to show yet --------------------------------------------------------------------------------------------------------------

function none(d, post) {
  const why = post.status === 'idea' ? 'This is an idea. Nothing is made yet.' : post.status === 'approved' ? 'Approved. It will be built as its date gets close.' : post.status === 'building' ? 'Being built now.' : 'No pictures were found for this post.';
  const el = h('div', { class: 'cv-none', style: { '--lane': laneColor(post.project) } },
    h('div', { class: 'cv-none-card' }, glyph(post.format, 20), h('div', { class: 'cv-none-title' }, post.title), h('div', { class: 'cv-none-why' }, `${FORMAT_LABEL[post.format] ?? post.format}. ${why}`)));
  return { el, step() {}, toggle() {}, destroy() {}, kind: 'none', setComments() {}, setPinMode() {}, pinMode: () => false, draft: () => null, clearDraft() {}, where: () => ({ page: 'cover' }), focusComment() {} };
}

/** @returns {{el:HTMLElement, kind:string, step:Function, toggle:Function, destroy:Function, setComments:Function, setPinMode:Function, pinMode:Function, draft:Function, clearDraft:Function, where:Function, focusComment:Function}} */
export function mediaViewer(d, post, opts = {}) {
  current?.destroy?.();
  const v = d.media.kind === 'video' && d.media.video ? reel(d, post, opts) : d.media.kind === 'carousel' && d.media.pages.length ? carousel(d, post, opts) : none(d, post);
  current = v;
  return v;
}
export function releaseViewer() { current?.destroy?.(); current = null; }
