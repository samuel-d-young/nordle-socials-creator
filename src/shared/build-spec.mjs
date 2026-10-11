// A post spec is a short description of a carousel or graphic: the brief, the copy, and one layout pattern per page.
// buildDocFromSpec turns it into a Nordle document. Pure: runs in Node and in the browser.
//
//   {
//     "id": "nov-03-sensitive-teeth", "title": "Sensitive teeth", "kind": "carousel",       (kind: graphic if one page)
//     "sizes": ["ig-feed-4x5"], "colourway": "dark"?,
//     "brief": { "goal": "...", "audience": "...", "message": "...", "mustAvoid": ["..."] },
//     "copy": { "caption": "...", "hashtags": ["#x"], "cta": "..." },
//     "pages": [ { "id": "cover", "pattern": "cover", "tone": "dark"?, "title": "Cover"?, "alt": "What the page shows, for screen readers",
//                  "content": { "headline": "...", "image": "assets/photos/x.jpg", "imageAlt": "..." } }, ... ]
//   }

import { composePage } from './patterns.mjs';

export class SpecError extends Error {}

export function buildDocFromSpec(spec, { brand, platforms }) {
  if (!spec.id || !/^[a-z0-9][a-z0-9_-]*$/.test(spec.id)) throw new SpecError(`spec.id must be lower-case letters, numbers, - or _ (got "${spec.id}")`);
  if (!spec.title) throw new SpecError('spec.title is required');
  if (!Array.isArray(spec.pages) || !spec.pages.length) throw new SpecError('spec.pages needs at least one page');
  const sizeIds = spec.sizes?.length ? spec.sizes : ['ig-feed-4x5'];
  const sizes = sizeIds.map((id) => {
    const p = platforms.presets.find((x) => x.id === id);
    if (!p) throw new SpecError(`unknown size "${id}". Sizes: ${platforms.presets.map((x) => x.id).join(', ')}`);
    return { id: p.id, w: p.w, h: p.h, safe: p.safe };
  });
  const notes = [];
  const pages = [];
  const alt = {};
  const taken = new Set();
  for (const [i, ps] of spec.pages.entries()) {
    let pageId = ps.id ?? `${ps.pattern}-${i + 1}`;
    if (taken.has(pageId)) throw new SpecError(`two pages are called "${pageId}"`);
    taken.add(pageId);
    let composed;
    try {
      composed = composePage({ pattern: ps.pattern, content: ps.content ?? {}, brand, colourway: spec.colourway, tone: ps.tone, size: sizes[0], sizes, pageId, title: ps.title, position: { index: i, total: spec.pages.length } });
    } catch (e) { throw new SpecError(`page ${i + 1} (${pageId}): ${e.message}`); }
    pages.push(composed.page);
    for (const n of composed.notes) notes.push(`${pageId}: ${n}`);
    alt[pageId] = ps.alt ?? ps.content?.imageAlt ?? [ps.content?.headline, ps.content?.body].filter(Boolean).join('. ');
  }
  const copy = { ...(spec.copy ?? {}), alt: { ...(spec.copy?.alt ?? {}), ...alt } };
  const doc = {
    schema: 'nordle.doc/0.1', id: spec.id, title: spec.title,
    kind: spec.kind ?? (pages.length > 1 ? 'carousel' : 'graphic'), brand: brand.id,
    ...(spec.colourway ? { colourway: spec.colourway } : {}),
    sizes: sizeIds,
    ...(spec.tags ? { tags: spec.tags } : {}),
    ...(spec.brief ? { brief: spec.brief } : {}),
    copy, pages,
  };
  return { doc, notes };
}
