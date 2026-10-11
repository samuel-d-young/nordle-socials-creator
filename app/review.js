// The Review tab: pins (comments), saved versions, approval, and the hand-off to Claude.

import { h, icon, preserveFocus, promptBox } from './dom.js';
import { state, update, subscribe } from './state.js';
import { resolveComment, replyToComment, deleteComment, saveVersion, approve, revokeApproval, viewVersion, restoreVersion, copyForClaude, decideChange, decideAll, viewChange, addComment } from './doc.js';
import { V, clock } from './video-state.js';

const when = (iso) => new Date(iso).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export const activeApproval = () => [...(state.review?.approvals ?? [])].reverse().find((a) => !a.revoked) ?? null;

const DIAL_TEXT = {
  suggest: 'Claude only suggests. Nothing changes until you accept it.',
  review: 'Claude’s edits are applied and wait here for you to accept or reject.',
  apply: 'Claude’s edits are applied.',
};

function changesBox() {
  const all = state.review.changes ?? [];
  const pending = all.filter((c) => c.status === 'pending').reverse();
  const recent = all.filter((c) => c.status !== 'pending').slice(-4).reverse();
  const lens = state.versionView?.change;
  const item = (c) => {
    const shown = lens?.id === c.id;
    const sum = c.summary ?? [];
    return h('div', { class: `change${c.status !== 'pending' ? ' decided' : ''}`, dataset: { change: c.id } },
      h('div', { class: 'hd' }, h('span', { class: `badge${c.mode === 'proposed' ? ' warn' : ''}` }, c.mode === 'proposed' ? 'Suggestion' : 'Applied'), h('span', { class: 'grow', title: c.note }, c.note || 'Change'), h('span', { class: 'muted', style: { fontSize: '11px' } }, when(c.created))),
      h('ul', { class: 'sum' }, sum.slice(0, 3).map((l) => h('li', {}, l)), sum.length > 3 ? h('li', {}, `+${sum.length - 3} more`) : null),
      c.status === 'pending'
        ? h('div', { class: 'acts' },
          h('button', { class: `btn sm${shown ? ' on' : ''}`, onclick: () => (shown ? viewChange(null) : viewChange(c.id, 'after')) }, c.mode === 'proposed' ? 'Preview' : 'Compare'),
          h('button', { class: 'btn sm primary', onclick: () => decideChange(c.id, 'accept') }, icon('check', 13), 'Accept'),
          h('button', { class: 'btn sm danger', onclick: () => decideChange(c.id, 'reject') }, c.mode === 'proposed' ? 'Reject' : 'Reject and put back'))
        : h('div', { class: 'muted', style: { fontSize: '11px' } }, c.status === 'accepted' ? (c.auto ? 'Applied automatically' : 'Accepted') : 'Rejected'));
  };
  return h('div', { class: 'group' },
    h('h3', {}, 'Claude', pending.length > 1 ? h('span', { style: { display: 'flex', gap: '6px' } },
      h('button', { class: 'btn sm', onclick: () => decideAll('accept') }, 'Accept all'),
      h('button', { class: 'btn sm', onclick: () => decideAll('reject') }, 'Reject all')) : null),
    h('p', { class: 'muted', style: { fontSize: '11px', margin: '0 0 8px' } }, DIAL_TEXT[state.autonomy] ?? ''),
    pending.length ? pending.map(item) : h('p', { class: 'muted' }, all.length ? 'Nothing waiting for you.' : 'Nothing from Claude yet. Ask it to change something, or open the Properties tab and use the sparkle button on a layer.'),
    recent.length ? h('details', {}, h('summary', { class: 'muted', style: { cursor: 'pointer', fontSize: '12px', marginBottom: '6px' } }, `Earlier (${recent.length})`), recent.map(item)) : null);
}

/** @param {{route?:'edit'|'video'}} opts which editor this panel belongs to: pictures pin a comment on the page, a video pins it on a moment */
export function mountReview(root, { route = 'edit' } = {}) {
  const video = route === 'video';
  let filter = 'open';
  let lastSig = '';

  function build() {
    const review = state.review;
    if (!review) { root.replaceChildren(h('div', { class: 'empty' }, 'Loading…')); return; }
    const ap = activeApproval();
    const apVersion = ap && review.versions.find((v) => v.id === ap.versionId);
    const stale = ap && ap.docV !== state.v;

    // approval
    const approvalBox = h('div', { class: 'group' }, h('h3', {}, 'Approval'),
      ap
        ? h('div', {}, h('div', { class: 'row', style: { gap: '6px' } }, h('span', { class: `badge ${stale ? 'warn' : 'ok'}` }, stale ? 'Changed since approval' : 'Approved'), h('span', {}, apVersion?.name ?? ap.versionId), h('span', { class: 'muted' }, `· ${when(ap.date)}`)),
          ap.note ? h('p', { class: 'muted' }, ap.note) : null,
          h('div', { class: 'row' },
            stale ? h('button', { class: 'btn primary', onclick: async () => { const r = await promptBox('Approve the current version', [{ name: 'note', label: 'Note', placeholder: 'Optional' }], { ok: 'Approve' }); if (r) approve(r.note || undefined); } }, icon('check'), 'Approve again') : null,
            h('button', { class: 'btn', onclick: revokeApproval }, 'Withdraw approval')))
        : h('div', {}, h('p', { class: 'muted' }, 'Nobody has approved this post yet.'),
          h('button', { class: 'btn primary', onclick: async () => { const r = await promptBox('Approve this post', [{ name: 'note', label: 'Note', placeholder: 'Optional' }], { ok: 'Approve' }); if (r) approve(r.note || undefined); } }, icon('check'), 'Approve this version')));

    // versions
    const versions = h('div', { class: 'group' },
      h('h3', {}, 'Versions', h('button', { class: 'btn sm', onclick: async () => { const r = await promptBox('Save a version', [{ name: 'name', label: 'Name', value: `V${review.versions.length + 1}` }, { name: 'note', label: 'Note', placeholder: 'What changed?', multiline: true }], { ok: 'Save version' }); if (r) saveVersion({ name: r.name, note: r.note }); } }, icon('save', 14), 'Save version')),
      review.versions.length ? [...review.versions].reverse().map((v) => h('div', { class: `version${state.versionView?.id === v.id ? ' viewing' : ''}` },
        h('div', { class: 'grow' }, h('strong', {}, v.name), ap?.versionId === v.id ? h('span', { class: 'badge ok', style: { marginLeft: '6px' } }, 'approved') : null,
          h('div', { class: 'muted', style: { fontSize: '11px' } }, when(v.created), v.note ? ` · ${v.note}` : '')),
        h('button', { class: 'btn sm', onclick: () => viewVersion(state.versionView?.id === v.id ? null : v.id) }, state.versionView?.id === v.id ? 'Close' : 'View'),
        h('button', { class: 'btn sm', onclick: () => restoreVersion(v.id) }, 'Restore')))
        : h('p', { class: 'muted' }, 'Save a version before a big change so you can come back to it.'));

    // comments
    const all = review.comments;
    const shown = all.filter((c) => filter === 'all' || c.status === filter);
    const comments = h('div', { class: 'group' },
      h('h3', {}, 'Comments', h('div', { class: 'seg' }, ['open', 'resolved', 'all'].map((f) => h('button', { class: filter === f ? 'on' : '', onclick: () => { filter = f; lastSig = ''; build(); } }, f)))),
      h('div', { class: 'row' },
        video
          ? h('button', { class: 'btn', 'data-act': 'comment-here', title: 'Write a comment about the moment the playhead is on (or pin one on the picture with the pin button under it)', onclick: async () => { const at = V.playhead; const r = await promptBox(`Comment at ${clock(at)}`, [{ name: 'text', label: 'Comment', multiline: true, placeholder: 'What should change here?' }], { ok: 'Add comment' }); if (r?.text.trim()) addComment({ pageId: 'video', x: 0.5, y: 0.5, time: at, text: r.text }); } }, icon('message'), 'Comment at the playhead')
          : h('button', { class: `btn${state.tool === 'comment' ? ' on' : ''}`, onclick: () => update({ tool: state.tool === 'comment' ? 'select' : 'comment' }) }, icon('message'), state.tool === 'comment' ? 'Click the page to pin a comment' : 'Add a comment (C)'),
        h('button', { class: 'btn', title: 'Copy every open comment as text for Claude', onclick: copyForClaude }, icon('clipboard'), 'Copy for Claude')),
      shown.length ? shown.map((c) => {
        const idx = all.indexOf(c);
        const ver = c.resolvedIn && review.versions.find((v) => v.id === c.resolvedIn);
        return h('div', { class: `comment${c.status === 'resolved' ? ' resolved' : ''}${state.focusComment === c.id ? ' on' : ''}`, dataset: { comment: c.id },
          onclick: () => update({ focusComment: c.id, pageId: c.page, sel: null }) },
        h('div', { class: 'hd' }, h('span', { class: 'num-badge' }, String(idx + 1)), h('span', {}, `${c.author === 'claude' ? 'Claude' : 'You'} · ${typeof c.time === 'number' ? `at ${clock(c.time)}` : c.general ? 'whole post' : `page ${c.page}`}${c.layer ? ` · ${c.layer}` : ''}`), h('span', { style: { flex: 1 } }), h('span', {}, when(c.created))),
        h('div', {}, c.text),
        ver ? h('div', { class: 'muted', style: { fontSize: '11px', marginTop: '4px' } }, `Fixed in ${ver.name}`) : null,
        (c.replies ?? []).map((r) => h('div', { class: 'reply' }, h('strong', {}, r.author === 'claude' ? 'Claude' : 'You'), ': ', r.text)),
        h('div', { class: 'row', style: { marginTop: '6px', marginBottom: 0 } },
          h('button', { class: 'btn sm', onclick: (e) => { e.stopPropagation(); resolveComment(c.id, c.status !== 'resolved'); } }, icon('check', 13), c.status === 'resolved' ? 'Reopen' : 'Resolve'),
          h('button', { class: 'btn sm', onclick: async (e) => { e.stopPropagation(); const r = await promptBox('Reply', [{ name: 'text', label: 'Reply', multiline: true }], { ok: 'Reply' }); if (r?.text.trim()) replyToComment(c.id, r.text); } }, 'Reply'),
          h('button', { class: 'btn sm danger', onclick: (e) => { e.stopPropagation(); deleteComment(c.id); } }, icon('trash', 13))));
      }) : h('p', { class: 'muted' }, all.length ? 'Nothing here.' : video ? 'No comments yet. Move the playhead to the moment, then use the button above, or pin one on the picture.' : 'No comments yet. Press C, then click the page where something should change.'));

    root.replaceChildren(changesBox(), approvalBox, comments, versions);
    if (state.focusComment) root.querySelector(`[data-comment="${CSS.escape(state.focusComment)}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  subscribe(() => {
    if (state.route.name !== route || !state.doc || state.panel !== 'review') return;
    const sig = JSON.stringify([state.review, state.v, state.focusComment, state.tool, state.versionView?.id, state.versionView?.change?.which, filter, state.autonomy]);
    if (sig === lastSig) return;
    lastSig = sig;
    preserveFocus(root, build);
  });
  return { rebuild: () => { lastSig = ''; build(); } };
}
