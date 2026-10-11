// "Copy for Claude": the review comments of one document as plain text Claude can act on.

const snippet = (s, n = 70) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function findLayer(layers, id) {
  for (const l of layers ?? []) {
    if (l.id === id) return l;
    const inner = l.children && findLayer(l.children, id);
    if (inner) return inner;
  }
  return null;
}

/** 7.4 seconds -> "0:07" */
export const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const layerWords = (l) => (l ? l.text ?? (l.runs ?? []).map((r) => r.text).join('') ?? '' : '');

export function reviewMarkdown({ projectId, doc, v, review }) {
  const approval = [...review.approvals].reverse().find((a) => !a.revoked);
  const lines = [];
  lines.push(`# Nordle feedback: ${doc.title}`);
  lines.push('');
  lines.push(`Document: projects/${projectId}/docs/${doc.id}.json (version ${v}, ${doc.kind}, sizes ${doc.sizes.map((s) => (typeof s === 'string' ? s : s.id)).join(', ')})`);
  if (approval) {
    const ver = review.versions.find((x) => x.id === approval.versionId);
    lines.push(`Approval: approved as ${ver?.name ?? approval.versionId}${approval.docV === v ? ' (still current)' : ` (the document has changed since: it was version ${approval.docV}, now ${v})`}`);
  } else {
    lines.push('Approval: not approved');
  }
  lines.push('');
  const open = review.comments.filter((c) => c.status === 'open');
  const done = review.comments.filter((c) => c.status === 'resolved');
  lines.push(`## Open comments (${open.length})`);
  if (!open.length) lines.push('None.');
  open.forEach((c, i) => {
    const page = doc.pages?.find((p) => p.id === c.page);
    const layer = c.layer ? findLayer(page?.layers, c.layer) : null;
    const spot = `${Math.round(c.x * 100)}% across, ${Math.round(c.y * 100)}% down`;
    const where = typeof c.time === 'number' ? `the video at ${clock(c.time)} (${spot})` : c.general ? `the whole post (page "${c.page}")` : `page "${c.page}"${page?.title ? ` (${page.title})` : ''} at ${spot}`;
    const on = c.layer ? `, on layer "${c.layer}"${layerWords(layer) ? ` ("${snippet(layerWords(layer))}")` : ''}` : '';
    lines.push(`${i + 1}. [${c.id}] ${where}${on}${c.size ? `, size ${c.size}` : ''}: ${c.text}`);
    for (const r of c.replies ?? []) lines.push(`   - ${r.author} replied: ${r.text}`);
  });
  if (done.length) {
    lines.push('');
    lines.push(`## Resolved (${done.length})`);
    for (const c of done) lines.push(`- [${c.id}] page "${c.page}": ${snippet(c.text, 90)}${c.resolvedIn ? ` (fixed in ${review.versions.find((x) => x.id === c.resolvedIn)?.name ?? c.resolvedIn})` : ''}`);
  }
  lines.push('');
  lines.push('When you have made the changes, resolve each comment you handled.');
  return lines.join('\n');
}
