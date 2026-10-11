// The editor's state, in one place. Change it with update(); anything that cares subscribes.

export const state = {
  route: { name: 'home' },        // {name:'home'} | {name:'edit', project, doc}
  projects: [],
  fontManifest: null,
  // the open document
  project: null, docId: null, doc: null, v: 0, brand: null, sizes: [], assets: [],
  review: null, rv: 0, canUndo: false, canRedo: false, pending: 0, online: true,
  // what is on screen
  sizeId: null, pageId: null,
  sel: null,                       // {pageId, layerId}
  tool: 'select',                  // 'select' | 'comment'
  zoom: 'fit',                     // 'fit' or a number (1 = 100%)
  view: 'single',                  // 'single' | 'all'
  safe: false,
  panel: 'props',                  // 'props' | 'review' | 'copy'
  scope: 'all',                    // edit every size, or only this size
  versionView: null,               // {id, name, doc[, change]} while looking at an old version or one of Claude's changes
  autonomy: 'review',              // how far Claude may go on this post: suggest | review | apply
  takes: [],                       // Explore: alternative takes of this post [{id, label, doc}]
  focusComment: null,
  draftPin: null,                  // {pageId, x, y, layerId} while writing a new comment
  checks: null,                    // result of the last "Check"
};

const listeners = new Set();
let queued = false;

export function update(patch) {
  Object.assign(state, patch);
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; for (const fn of [...listeners]) fn(); });
}

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/** What is shown on the canvas: an old version while one is being viewed, otherwise the live document. */
export const shownDoc = () => state.versionView?.doc ?? state.doc;
export const currentPage = () => {
  const d = shownDoc();
  return d?.pages?.find((p) => p.id === state.pageId) ?? d?.pages?.[0] ?? null;
};
export const currentSize = () => state.sizes.find((s) => s.id === state.sizeId) ?? state.sizes[0] ?? null;
