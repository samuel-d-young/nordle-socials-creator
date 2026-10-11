// Nordle editor: start-up, routing and the layout.

import { h, toast } from './dom.js';
import { api } from './api.js';
import { state, update, subscribe } from './state.js';
import { openDoc, closeDoc } from './doc.js';
import { mountCanvas } from './canvas.js';
import { mountPages, mountLayers } from './left.js';
import { mountProps } from './props.js';
import { mountReview } from './review.js';
import { mountCopy } from './copy.js';
import { mountTopbar } from './topbar.js';
import { loadProjects, renderHome } from './home.js';
import { mountStudio, showStudio, hideStudio } from './studio.js';
import { mountVideoEditor } from './video-editor.js';

const app = document.getElementById('app');

const homeView = h('div', { class: 'hidden', style: { overflow: 'auto', gridRow: '1 / span 2' } });
const studioView = h('div', { class: 'hidden', id: 'studio-root', style: { gridRow: '1 / span 2', minHeight: 0 } });
const videoView = h('div', { class: 'hidden', id: 'video-root', style: { gridRow: '2', minHeight: 0 } });
const topbar = h('div', { class: 'topbar hidden' });
const pagesSec = h('section', { class: 'sec' });
const layersSec = h('section', { class: 'sec grow' });
const canvasCol = h('main', { class: 'center' });
const panels = {
  props: h('div', { class: 'panel' }),
  review: h('div', { class: 'panel hidden' }),
  copy: h('div', { class: 'panel hidden' }),
};
const tabs = h('div', { class: 'tabs' });
const workspace = h('div', { class: 'workspace hidden' },
  h('aside', { class: 'col left' }, pagesSec, layersSec),
  canvasCol,
  h('aside', { class: 'col right' }, tabs, panels.props, panels.review, panels.copy));
app.append(topbar, workspace, videoView, homeView, studioView);
mountStudio(studioView);
mountVideoEditor(videoView);

mountTopbar(topbar);
mountPages(pagesSec);
mountLayers(layersSec);
mountCanvas(canvasCol);
const props = mountProps(panels.props);
const review = mountReview(panels.review);
const copy = mountCopy(panels.copy);
const rebuilders = { props: props.rebuild, review: review.rebuild, copy: copy.rebuild };

function drawTabs() {
  const open = (state.review?.comments ?? []).filter((c) => c.status === 'open').length;
  tabs.replaceChildren(
    h('button', { class: state.panel === 'props' ? 'on' : '', onclick: () => update({ panel: 'props' }) }, 'Properties'),
    h('button', { class: state.panel === 'review' ? 'on' : '', onclick: () => update({ panel: 'review' }) }, 'Review', open ? h('span', { class: 'count' }, String(open)) : null),
    h('button', { class: state.panel === 'copy' ? 'on' : '', onclick: () => update({ panel: 'copy' }) }, 'Copy'));
}

let lastPanel = null;
let lastSel = null;
let lastTabSig = '';
subscribe(() => {
  const editing = state.route.name === 'edit' && !!state.doc;
  const videoing = state.route.name === 'video' && !!state.doc;
  topbar.classList.toggle('hidden', !editing && !videoing);
  workspace.classList.toggle('hidden', !editing);
  videoView.classList.toggle('hidden', !videoing);
  homeView.classList.toggle('hidden', state.route.name !== 'home');
  studioView.classList.toggle('hidden', state.route.name !== 'studio');
  app.style.gridTemplateRows = editing || videoing ? '48px minmax(0, 1fr)' : '1fr';
  if (!editing) return;

  const selKey = state.sel ? `${state.sel.pageId}/${state.sel.layerId}` : null;
  if (selKey && selKey !== lastSel && state.panel !== 'props') { lastSel = selKey; update({ panel: 'props' }); return; }
  lastSel = selKey;

  const sig = JSON.stringify([state.panel, (state.review?.comments ?? []).filter((c) => c.status === 'open').length]);
  if (sig !== lastTabSig) { lastTabSig = sig; drawTabs(); }
  for (const [name, el] of Object.entries(panels)) el.classList.toggle('hidden', name !== state.panel);
  if (state.panel !== lastPanel) { lastPanel = state.panel; rebuilders[state.panel]?.(); }
});

async function route() {
  const m = /^#\/p\/([^/]+)\/([^/]+)$/.exec(location.hash);
  if (!m) {
    closeDoc();
    if (location.hash === '#/projects') {
      // the library: every project and its documents, and where new ones are made
      hideStudio();
      update({ route: { name: 'home' }, doc: null });
      try { await loadProjects(); } catch (e) { toast(e.message, 'error'); }
      renderHome(homeView);
      return;
    }
    update({ route: { name: 'studio' }, doc: null });
    showStudio(location.hash);
    return;
  }
  hideStudio();
  const [, project, docId] = m.map(decodeURIComponent);
  try {
    // a video opens in the timeline editor (app/video-editor.js), everything else in the picture editor; the route is set in the same step as the document
    lastPanel = null;
    await openDoc(project, docId, (kind) => (kind === 'video'
      ? { route: { name: 'video', project, doc: docId }, panel: 'inspector' }
      : { route: { name: 'edit', project, doc: docId }, panel: 'props' }));
  } catch (e) {
    toast(e.message, 'error');
    location.hash = '#/';
  }
}

window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', (e) => { if (state.pending > 0) { e.preventDefault(); e.returnValue = ''; } });

(async () => {
  try {
    const r = await fetch('/fonts/manifest.json');
    update({ fontManifest: (await r.json()).fonts });
    await api.get('/meta');
  } catch (e) { toast(`Could not start: ${e.message}`, 'error'); return; }
  await route();
})();

subscribe(() => { if (state.route.name === 'home') renderHome(homeView); });
