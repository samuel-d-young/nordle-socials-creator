// What the video editor asks the server for, kept in one place: waveforms, the words of the recording, the plan check, the
// export formats, the preview file, and the small copies (proxies) of footage. Nothing here touches the document.

import { api } from './api.js';
import { state } from './state.js';
import { whenSaved } from './doc.js';
import { doc, emitV, fileUrl, sourceOf, videoApi } from './video-state.js';
import { speechSource } from '/src/shared/cutlist.mjs';

const enc = encodeURIComponent;

// ---- waveforms --------------------------------------------------------------------------------------------------------------

const waves = new Map();       // key -> {status:'loading'|'ready'|'error', data?, message?}
export const sourceProblems = new Map(); // source id -> what is wrong with that file, in words
let active = 0;
const queue = [];
function pump() {
  while (active < 2 && queue.length) {
    const job = queue.shift();
    active++;
    job().finally(() => { active--; pump(); });
  }
}
const waveKey = (s) => `${state.project}/${state.docId}/${s.id}/${s.path}`;

/** The waveform entry of a source, starting the load the first time it is asked for. Pictures have none. */
export function waveOf(sourceId) {
  const s = sourceOf(doc(), sourceId);
  if (!s || s.type === 'image') return null;
  const key = waveKey(s);
  let e = waves.get(key);
  if (e) return e;
  e = { status: 'loading', data: null, message: '' };
  waves.set(key, e);
  queue.push(async () => {
    try {
      e.data = await api.get(videoApi(`waveform?doc=${enc(state.docId)}&source=${enc(s.id)}&per=0.02`));
      e.status = 'ready';
      sourceProblems.delete(s.id);
    } catch (err) {
      e.status = 'error';
      e.message = err.message;
      sourceProblems.set(s.id, err.message);
    }
    emitV('data');
  });
  pump();
  return e;
}

/** Forget what failed (the drive is plugged in again) and ask again. */
export function retryProblems() {
  for (const [k, e] of waves) if (e.status === 'error') waves.delete(k);
  sourceProblems.clear();
  emitV('data');
}

export function resetData() {
  waves.clear();
  sourceProblems.clear();
  words.key = ''; words.status = 'idle'; words.list = [];
  check.status = 'idle'; check.issues = [];
  preview.checked = false; preview.exists = false;
  proxies.clear();
}

// ---- the words of the recording ---------------------------------------------------------------------------------------------

export const words = { key: '', status: 'idle', source: null, track: null, list: [], message: '' };

/** Load the transcript of the speech source once; the kept/cut state of each word is worked out on the page from the document. */
export async function loadWords({ force = false } = {}) {
  const d = doc();
  const source = speechSource(d);
  const key = `${state.project}/${state.docId}/${source}/${sourceOf(d, source)?.transcript ?? ''}`;
  if (!force && words.key === key && words.status !== 'error') return words;
  words.key = key;
  if (!source) {
    Object.assign(words, { status: 'none', source: null, track: null, list: [], message: 'No recording in this video has a transcript, so there are no words to cut. Give a source a "transcript" (word timings from any transcription tool) and its words appear here.' });
    emitV('words');
    return words;
  }
  Object.assign(words, { status: 'loading', source, message: '' });
  emitV('words');
  try {
    await whenSaved();
    const r = await api.post(`/projects/${enc(state.project)}/cut/words`, { doc: state.docId });
    if (words.key !== key) return words;
    Object.assign(words, { status: 'ready', source: r.source, track: r.track, list: r.words.map((w) => ({ text: w.text, start: w.start, end: w.end, skip: !!w.skip })), message: '' });
  } catch (e) {
    if (words.key !== key) return words;
    Object.assign(words, { status: 'error', list: [], message: e.message });
  }
  emitV('words');
  return words;
}

// ---- the plan check -----------------------------------------------------------------------------------------------------------

export const check = { status: 'idle', issues: [], ok: true, seconds: 0, message: '', version: -1 };
let checkTimer = null;
let checkToken = 0;

export async function runCheck() {
  const token = ++checkToken;
  check.status = 'running';
  emitV('check');
  try {
    await whenSaved();
    const r = await api.post(videoApi('check'), { doc: state.docId });
    if (token !== checkToken) return;
    check.issues = r.summary?.issues ?? r.issues ?? [];
    check.ok = !!r.ok;
    check.seconds = r.summary?.seconds ?? 0;
    check.status = 'ready';
    check.version = state.v;
    check.message = '';
  } catch (e) {
    if (token !== checkToken) return;
    check.status = 'error';
    check.message = e.message;
  }
  emitV('check');
}

/** Check again shortly after the last edit (the plan only reads the document, so this is quick). */
export function scheduleCheck(ms = 900) {
  clearTimeout(checkTimer);
  checkTimer = setTimeout(() => { if (state.pending > 0) { scheduleCheck(400); return; } runCheck(); }, ms);
}
export const stopChecks = () => { clearTimeout(checkTimer); checkToken++; };

// ---- export formats ---------------------------------------------------------------------------------------------------------

let formatsPromise = null;
export function loadFormats() {
  formatsPromise ??= api.get(videoApi('formats')).then((r) => r.formats).catch((e) => { formatsPromise = null; throw e; });
  return formatsPromise;
}

// ---- render jobs ------------------------------------------------------------------------------------------------------------------

/** Start a render (a preview, or an export in some format) and return its job. The saved document is what gets drawn, so wait for saves first. */
export async function startRender(options) {
  await whenSaved();
  const r = await api.post(videoApi('render'), { doc: state.docId, ...options });
  return r.job;
}

/** Follow a job until it ends (done, failed or cancelled), telling `onProgress` about each step. Resolves with the final job. */
export async function watchJob(id, onProgress, signal) {
  for (;;) {
    const j = (await api.get(videoApi(`jobs/${enc(id)}?wait=1`))).job;
    onProgress?.(j);
    if (j.status !== 'running') return j;
    if (signal?.aborted) return j;
  }
}

export const cancelJob = (id) => api.post(videoApi(`jobs/${enc(id)}/cancel`), {}).catch(() => {});

// ---- the rendered preview -------------------------------------------------------------------------------------------------------

export const preview = { checked: false, exists: false, stamp: 0, renderedV: null, files: [] };
export const previewPath = () => `out/${state.docId}/${state.docId}.preview.mp4`;
export const previewUrl = () => `${fileUrl(previewPath())}?v=${preview.stamp}`;

/** What is in the post's out/ folder: is there a rendered preview (`out/<doc>/<doc>.preview.mp4`), and which exports exist. */
export async function checkPreview() {
  try {
    const r = await api.get(videoApi(`outputs?doc=${enc(state.docId)}`));
    preview.files = r.files;
    const mine = r.files.find((f) => f.path === previewPath());
    preview.exists = !!mine;
    if (mine) preview.stamp = mine.modified;
  } catch { preview.exists = false; preview.files = []; }
  preview.checked = true;
  emitV('preview');
  return preview.exists;
}

export function previewRendered(version) {
  preview.exists = true; preview.checked = true; preview.stamp = Date.now(); preview.renderedV = version;
  emitV('preview');
}

// ---- proxies: small copies of footage a page can play --------------------------------------------------------------------------

const proxies = new Map(); // source id -> url once ready

/**
 * The url of a browser-playable copy of a source, making it first if it is not there. onProgress gets 0 to 100.
 * Rejects with the server's own words (an unplugged drive says which drive and how to fix it).
 */
export async function ensureProxy(sourceId, onProgress, signal) {
  const have = proxies.get(sourceId);
  if (have) return have;
  let r = await api.post(videoApi('proxy'), { doc: state.docId, source: sourceId });
  while (!r.ready) {
    if (signal?.aborted) throw new Error('Cancelled');
    onProgress?.(r.progress ?? 0, r.job?.message);
    const jobId = r.job?.id ?? r.job;
    const j = (await api.get(videoApi(`jobs/${enc(jobId)}?wait=1`))).job;
    if (j.status === 'failed' || j.status === 'cancelled') throw new Error(j.error || 'The small copy could not be made.');
    if (j.status === 'done') { r = { ready: true, url: j.result?.url }; break; }
    r = { ready: false, progress: j.percent, job: j };
  }
  onProgress?.(100);
  proxies.set(sourceId, r.url);
  return r.url;
}
