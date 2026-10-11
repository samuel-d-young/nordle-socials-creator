// The bar across the top of the editor.

import { h, icon, preserveFocus, dialog, toast } from './dom.js';
import { state, update, subscribe } from './state.js';
import { setDocValue, undo, redo, runCheck, exportPost, setAutonomy } from './doc.js';
import { activeApproval } from './review.js';
import { studioHash } from './studio.js';
import { S as studio } from './studio-store.js';
const studioLoaded = () => studio.load === 'ready';
import { cycleThemeGlobal, themeMode } from './studio-ui.js';

async function exportDialog() {
  const sizes = state.sizes;
  const boxes = sizes.map((s) => h('input', { type: 'checkbox', checked: true, value: s.id }));
  const format = h('select', { class: 'field' }, h('option', { value: 'png' }, 'PNG (sharpest)'), h('option', { value: 'jpg' }, 'JPG (smaller)'));
  const scale = h('select', { class: 'field' }, h('option', { value: '1' }, 'Normal size'), h('option', { value: '2' }, 'Double size (for sharper video or print)'));
  const out = h('div');
  let busy = false;
  await dialog({
    title: 'Export images',
    build: (body) => {
      body.append(
        h('p', { class: 'muted' }, 'Writes one image per page and size into this project’s out folder, plus a contact sheet.'),
        h('div', { class: 'group' }, h('h3', {}, 'Sizes'), sizes.map((s, i) => h('label', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' } }, boxes[i], `${s.id} · ${s.w}×${s.h}`))),
        h('div', { class: 'row' }, h('label', {}, 'Format'), h('div', { class: 'grow' }, format)),
        h('div', { class: 'row' }, h('label', {}, 'Scale'), h('div', { class: 'grow' }, scale)),
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: async (e) => {
          const btn = e.currentTarget;
          if (busy) return;
          const chosen = boxes.filter((b) => b.checked).map((b) => b.value);
          if (!chosen.length) { toast('Choose at least one size.', 'error'); return; }
          busy = true; btn.disabled = true; out.replaceChildren(h('p', { class: 'muted' }, 'Rendering…'));
          try {
            const r = await exportPost({ sizes: chosen, format: format.value, scale: Number(scale.value) });
            out.replaceChildren(...[
              h('p', {}, `${r.files.length} image${r.files.length === 1 ? '' : 's'} saved in `, h('code', {}, `projects/${state.project}/out/${state.docId}/`)),
              r.sheet ? h('p', {}, h('a', { href: `/p/${state.project}/${r.sheet}`, target: '_blank' }, 'Open the contact sheet')) : null,
              r.warnings?.length ? h('p', { class: 'muted' }, r.warnings.join(' ')) : null,
              h('div', { class: 'export-grid' }, r.files.map((f) => h('a', { href: `/p/${state.project}/${f.path}`, target: '_blank', download: f.path.split('/').pop() }, h('img', { src: `/p/${state.project}/${f.path}`, alt: '' }), `${f.page} · ${f.size}`)))].filter(Boolean));
          } catch (err) { out.replaceChildren(h('p', { class: 'badge warn' }, err.message)); }
          busy = false; btn.disabled = false;
        } }, icon('download'), 'Export')),
        out);
    },
    actions: [{ id: 'close', label: 'Close' }],
  });
}

export function mountTopbar(root) {
  let lastSig = '';

  function build() {
    const doc = state.doc;
    root.replaceChildren();
    if (!doc) return;
    const ap = activeApproval();
    const fromStudio = studioLoaded();
    const stale = ap && ap.docV !== state.v;
    const open = (state.review?.comments ?? []).filter((c) => c.status === 'open').length;
    void open;
    if (doc.kind === 'video') {
      // a video has a timeline, not pages: no sizes, zoom or safe zones here (the monitor and the Export tab have their own)
      // one plain way back: to the reel's own sheet when the editor was opened from it, else to this brand's reels
      const back = fromStudio ? studioHash() : `#/s/list?brand=${encodeURIComponent(state.project)}&fmt=reel`;
      root.append(...[
        h('a', { class: 'wordmark sm', href: '#/', title: 'Nordle Studio' }, 'Nordle', h('i', {}, '.')),
        h('a', { class: 'btn back-reels', href: back, 'data-act': 'back-to-reels', title: `${fromStudio ? 'Back to this reel in the Studio' : 'To this brand’s reels'}. Your edits are already saved.` }, icon('back'), 'Back to reels'),
        h('input', { class: 'title', value: doc.title, 'data-field': 'doc-title', title: 'Rename this video', 'aria-label': 'Title of the video', onchange: (e) => e.target.value.trim() && setDocValue('/title', e.target.value.trim(), 'Rename video') }),
        h('span', { class: 'badge' }, doc.kind),
        h('div', { class: 'dial', title: 'How far Claude may go on this video' }, h('span', { class: 'muted lbl' }, 'Claude'),
          h('div', { class: 'seg' }, [['suggest', 'Suggest', 'Claude only suggests. Nothing changes until you accept it.'], ['review', 'Review', 'Claude’s edits are applied and wait for you to accept or reject them.'], ['apply', 'Apply', 'Claude’s edits are applied.']].map(([v, l, t]) => h('button', { class: state.autonomy === v ? 'on' : '', title: t, dataset: { autonomy: v }, onclick: () => setAutonomy(v) }, l)))),
        h('div', { class: 'sp' }),
        h('button', { class: 'btn icon', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', disabled: !state.canUndo || !!state.versionView, onclick: undo }, icon('undo')),
        h('button', { class: 'btn icon', title: 'Redo (Ctrl+Y)', 'aria-label': 'Redo', disabled: !state.canRedo || !!state.versionView, onclick: redo }, icon('redo')),
        h('div', { class: 'status', title: state.online ? 'Saved on this computer as you work' : 'Lost the connection to Nordle. Is it still running?' },
          h('span', { class: `dot${!state.online ? ' off' : state.pending ? ' busy' : ''}` }), !state.online ? 'Offline' : state.pending ? 'Saving…' : 'Saved'),
        ap ? h('span', { class: `badge ${stale ? 'warn' : 'ok'}`, title: stale ? 'The video changed after it was approved' : 'Approved' }, stale ? 'Edited since approval' : 'Approved') : null,
        h('button', { class: 'btn icon', title: `Colour theme: ${themeMode()}. Click to change`, 'aria-label': 'Colour theme', onclick: () => { cycleThemeGlobal(); lastSig = ''; update({}); } }, icon(themeMode() === 'dark' ? 'moon' : themeMode() === 'light' ? 'sun' : 'system')),
        h('button', { class: 'btn primary', 'data-act': 'topbar-export', onclick: () => update({ panel: 'export' }) }, icon('download'), 'Export')].filter(Boolean));
      return;
    }
    root.append(...[
      h('a', { class: 'wordmark sm', href: '#/', title: 'Nordle Studio' }, 'Nordle', h('i', {}, '.')),
      h('a', { class: 'btn icon', href: fromStudio ? studioHash() : '#/', title: 'Back to the Studio', 'aria-label': 'Studio' }, icon('month')),
      h('button', { class: 'btn ghost icon', title: fromStudio ? 'Back to the Studio' : 'All projects', 'aria-label': fromStudio ? 'Back to the Studio' : 'All projects', onclick: () => { location.hash = fromStudio ? studioHash() : '#/projects'; } }, icon('back')),
      h('input', { class: 'title', value: doc.title, 'data-field': 'doc-title', title: 'Rename this post', onchange: (e) => e.target.value.trim() && setDocValue('/title', e.target.value.trim(), 'Rename post') }),
      h('span', { class: 'badge' }, doc.kind),
      h('div', { class: 'seg', title: 'Which size you are editing' }, state.sizes.map((s) => h('button', { class: s.id === state.sizeId && state.view === 'single' ? 'on' : '', onclick: () => update({ sizeId: s.id, view: 'single' }) }, s.id))),
      state.sizes.length > 1 ? h('button', { class: `btn${state.view === 'all' ? ' on' : ''}`, title: 'See every size side by side', onclick: () => update({ view: state.view === 'all' ? 'single' : 'all' }) }, icon('grid'), h('span', { class: 'lbl' }, 'All sizes')) : null,
      h('select', { class: 'field', style: { width: '84px' }, title: 'Zoom', onchange: (e) => update({ zoom: e.target.value === 'fit' ? 'fit' : Number(e.target.value) }) },
        [['fit', 'Fit'], [0.25, '25%'], [0.5, '50%'], [0.75, '75%'], [1, '100%'], [1.5, '150%']].map(([v, l]) => h('option', { value: v, selected: state.zoom === v }, l))),
      h('button', { class: `btn${state.safe ? ' on' : ''}`, title: 'Show the area platform buttons cover', onclick: () => update({ safe: !state.safe }) }, icon('shield'), h('span', { class: 'lbl' }, 'Safe zones')),
      h('div', { class: 'dial', title: 'How far Claude may go on this post' }, h('span', { class: 'muted lbl' }, 'Claude'),
        h('div', { class: 'seg' }, [['suggest', 'Suggest', 'Claude only suggests. Nothing changes until you accept it.'], ['review', 'Review', 'Claude’s edits are applied and wait for you to accept or reject them.'], ['apply', 'Apply', 'Claude’s edits are applied.']].map(([v, l, t]) => h('button', { class: state.autonomy === v ? 'on' : '', title: t, dataset: { autonomy: v }, onclick: () => setAutonomy(v) }, l)))),
      doc.explore
        ? h('button', { class: 'btn', title: `This is one of several takes. Go back to the original.`, onclick: () => { location.hash = `#/p/${state.project}/${doc.explore.of}`; } }, icon('back'), h('span', { class: 'lbl' }, 'Original'))
        : h('button', { class: `btn${state.view === 'explore' ? ' on' : ''}`, title: 'Alternative takes of this post, side by side', onclick: () => update({ view: state.view === 'explore' ? 'single' : 'explore' }) }, icon('grid'), h('span', { class: 'lbl' }, `Explore${state.takes.length ? ` (${state.takes.length})` : ''}`)),
      h('div', { class: 'sp' }),
      h('button', { class: 'btn icon', title: 'Undo (Ctrl+Z)', disabled: !state.canUndo || !!state.versionView, onclick: undo }, icon('undo')),
      h('button', { class: 'btn icon', title: 'Redo (Ctrl+Shift+Z)', disabled: !state.canRedo || !!state.versionView, onclick: redo }, icon('redo')),
      h('div', { class: 'status', title: state.online ? 'Saved on this computer as you work' : 'Lost the connection to Nordle. Is it still running?' },
        h('span', { class: `dot${!state.online ? ' off' : state.pending ? ' busy' : ''}` }), !state.online ? 'Offline' : state.pending ? 'Saving…' : 'Saved'),
      ap ? h('span', { class: `badge ${stale ? 'warn' : 'ok'}`, title: stale ? 'The post changed after it was approved' : 'Approved' }, stale ? 'Edited since approval' : 'Approved') : null,
      h('button', { class: 'btn', onclick: () => { update({ panel: 'copy' }); runCheck(); } }, icon('sparkle'), h('span', { class: 'lbl' }, 'Check')),
      h('button', { class: 'btn icon', title: `Colour theme: ${themeMode()}. Click to change`, 'aria-label': 'Colour theme', onclick: () => { cycleThemeGlobal(); lastSig = ''; update({}); } }, icon(themeMode() === 'dark' ? 'moon' : themeMode() === 'light' ? 'sun' : 'system')),
      h('button', { class: 'btn primary', onclick: exportDialog }, icon('download'), 'Export')].filter(Boolean));
  }

  subscribe(() => {
    if ((state.route.name !== 'edit' && state.route.name !== 'video') || !state.doc) return;
    const sig = JSON.stringify([state.route.name, state.doc.title, state.doc.kind, state.sizes.map((s) => s.id), state.sizeId, state.view, state.zoom, state.safe, state.canUndo, state.canRedo, state.online, state.pending > 0, state.autonomy, state.takes.length, state.doc.explore, studioLoaded(), activeApproval(), state.v > 0 && activeApproval()?.docV !== state.v, !!state.versionView]);
    if (sig === lastSig) return;
    lastSig = sig;
    preserveFocus(root, build);
  });
}
