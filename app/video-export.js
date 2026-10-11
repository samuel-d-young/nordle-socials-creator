// The Export tab: make the finished video as MP4, WebM, GIF or ProRes. What this computer cannot make is greyed out and says why
// (the answer comes from ffmpeg's own list of encoders). The render runs as a job: progress, cancel, and a link to the file.

import { h, icon } from './dom.js';
import { state } from './state.js';
import { onV, setV, sizeParam, videoSizes, fileUrl, secs } from './video-state.js';
import { cancelJob, checkPreview, loadFormats, preview, startRender, watchJob } from './video-data.js';

const BLURB = {
  mp4: 'What the platforms take. H.264 picture, AAC sound.',
  webm: 'For the web. VP9 picture, Opus sound.',
  gif: 'A silent looping picture, up to 30 seconds, at most 540 pixels wide.',
  prores: 'For editing in Resolve or Premiere. Very large files.',
};

export function mountExport(root) {
  const exp = { formats: null, loadError: '', job: null, format: '', percent: 0, message: '', result: null, error: '', abort: null };
  const active = () => state.route.name === 'video' && state.panel === 'export';

  async function start(f) {
    if (exp.job) return;
    Object.assign(exp, { format: f.id, percent: 0, message: 'Starting', result: null, error: '' });
    paint();
    try {
      const job = await startRender({ format: f.id, size: sizeParam() });
      exp.job = job;
      exp.abort = new AbortController();
      paint();
      const done = await watchJob(job.id, (j) => { exp.percent = j.percent; exp.message = j.message; paint(); }, exp.abort.signal);
      exp.job = null;
      if (done.status === 'done') { exp.result = { ...done.result, seconds: done.seconds, format: done.result?.format ?? f.id }; await checkPreview(); }
      else exp.error = done.status === 'cancelled' ? 'Cancelled.' : done.error || 'The video could not be made.';
    } catch (e) {
      exp.job = null;
      exp.error = e.message;
    }
    paint();
  }

  function paint() {
    if (!active()) return;
    const f = exp.formats;
    const sizes = videoSizes();
    const earlier = preview.files.filter((x) => x.kind === 'export' && x.path !== exp.result?.file);
    root.replaceChildren(
      h('div', { class: 'group' },
        h('h3', {}, 'Export'),
        h('p', { class: 'muted' }, 'Draws the finished video from the saved cut at full size, with the same renderer as the preview. It can take a minute or two for a long video.'),
        sizes.length > 1 ? h('div', { class: 'row' }, h('label', { for: 'vex-size' }, 'Size'), h('div', { class: 'grow' }, h('select', { id: 'vex-size', class: 'field', onchange: (e) => setV({ sizeId: e.target.value || null }) },
          sizes.map((s) => h('option', { value: s.id, selected: s.id === (sizeParam() ?? sizes[0].id) }, `${s.id} ${s.w}x${s.h}`))))) : null,
        exp.loadError ? h('p', { class: 'badge warn' }, exp.loadError) : null,
        f ? h('div', { class: 'vex-formats' }, f.map((x) => h('div', { class: `vex-format${x.available ? '' : ' off'}` },
          h('button', { class: `btn${x.id === 'mp4' ? ' primary' : ''}`, type: 'button', 'data-format': x.id, disabled: !x.available || !!exp.job, onclick: () => start(x), title: x.available ? `Make ${x.label}` : x.problem },
            icon('download', 14), `Export ${x.id === 'prores' ? 'ProRes' : x.id.toUpperCase()}`),
          h('div', { class: 'vex-what' }, BLURB[x.id] ?? x.label, x.available ? null : h('div', { class: 'vex-why' }, `Not available on this computer: ${x.problem}`))))) : h('p', { class: 'muted' }, 'Looking at what this computer can make…')),
      earlier.length ? h('div', { class: 'group' }, h('h3', {}, 'Already made'),
        earlier.map((x) => h('div', { class: 'vex-file' }, h('a', { href: fileUrl(x.path), download: x.name, 'data-file': x.name }, x.name),
          h('span', { class: 'muted' }, ` ${(x.bytes / 1048576).toFixed(1)} MB, ${new Date(x.modified).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`)))) : null,
      exp.job || exp.error || exp.result ? h('div', { class: 'group' },
        h('h3', {}, 'Result'),
        exp.job ? h('div', { class: 'vm-prog', role: 'status' }, h('progress', { max: 100, value: exp.percent, 'aria-label': `${exp.format} export progress` }), h('span', {}, `${exp.percent}% ${exp.message ?? ''}`), h('button', { class: 'btn sm', type: 'button', onclick: () => cancelJob(exp.job.id) }, 'Cancel')) : null,
        exp.error ? h('p', { class: 'badge warn vex-error', role: 'alert' }, exp.error) : null,
        exp.result ? h('div', { class: 'vex-done', role: 'status' },
          h('p', {}, h('b', {}, 'Done. '), `${secs(exp.result.seconds ?? 0)} to make.`),
          h('p', {}, h('a', { class: 'btn primary', href: fileUrl(exp.result.file), download: exp.result.file.split('/').pop(), 'data-download': exp.result.file }, icon('download', 14), `Download ${exp.result.file.split('/').pop()}`),
            ' ', h('a', { class: 'btn', href: fileUrl(exp.result.file), target: '_blank', rel: 'noopener' }, icon('external', 14), 'Open')),
          h('p', { class: 'muted' }, h('code', {}, `projects/${state.project}/${exp.result.file}`))) : null) : null);
  }

  async function open() {
    paint();
    checkPreview().then(paint);
    if (!exp.formats) {
      try { exp.formats = await loadFormats(); exp.loadError = ''; } catch (e) { exp.loadError = e.message; }
      paint();
    }
  }

  onV('size', paint);
  return { open, paint, close: () => exp.abort?.abort() };
}
