// The tools Claude gets. Names start with nordle_. Each returns plain words about what happened, including whether the
// owner's autonomy setting meant the edit was applied or only suggested.

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT } from '../../tools/validate.mjs';
import { buildSetOps, toPointer } from '../shared/ops.mjs';
import { resolveToken } from '../shared/tokens.mjs';
import { PATTERNS, composePage, listPatterns } from '../shared/patterns.mjs';
import { NordleError } from './client.mjs';

export const P = { type: 'string', description: 'Project id, from nordle_list_projects.' };
export const D = { type: 'string', description: 'Document id, from nordle_list_projects.' };
const PAGE = { type: 'string', description: 'Page id (see nordle_get_doc). Needed unless the document has one page.' };
export const READ = { readOnlyHint: true };
export const EDIT = { readOnlyHint: false, destructiveHint: false };

export const enc = encodeURIComponent;
export const docPath = (a) => `/projects/${enc(a.project)}/docs/${enc(a.doc)}`;

function guide() {
  return readFileSync(join(ROOT, 'docs', 'AGENT-GUIDE.md'), 'utf8');
}

function locksIn(doc) {
  const out = [];
  const walk = (layers, page, trail) => {
    for (const l of layers ?? []) {
      if (l.lock) out.push(`layer "${l.id}" on page "${page}"`);
      if (l.children) walk(l.children, page, [...trail, l.id]);
    }
  };
  for (const p of doc.pages ?? []) { if (p.lock) out.push(`page "${p.id}" (everything on it)`); walk(p.layers, p.id, []); }
  return out;
}

function findLayer(doc, pageId, layerId) {
  const pages = pageId ? (doc.pages ?? []).filter((p) => p.id === pageId) : (doc.pages ?? []).filter((p) => JSON.stringify(p.layers).includes(`"id":"${layerId}"`));
  if (pageId && !pages.length) throw new NordleError(`There is no page "${pageId}". Pages: ${(doc.pages ?? []).map((p) => p.id).join(', ')}.`, 0);
  const hits = [];
  for (const page of pages) {
    const pi = doc.pages.indexOf(page);
    const search = (layers, base) => {
      layers.forEach((l, i) => {
        if (l.id === layerId) hits.push({ page, pageIndex: pi, layer: l, ptr: `${base}/${i}`, parentPtr: base, index: i, siblings: layers });
        if (l.children) search(l.children, `${base}/${i}/children`);
      });
    };
    search(page.layers, `/pages/${pi}/layers`);
  }
  if (!hits.length) throw new NordleError(`There is no layer "${layerId}"${pageId ? ` on page "${pageId}"` : ''}. Use nordle_get_doc to see the layer ids.`, 0);
  if (hits.length > 1) throw new NordleError(`Layer "${layerId}" exists on more than one page (${hits.map((h) => h.page.id).join(', ')}). Say which page.`, 0);
  return hits[0];
}

function pickPage(doc, pageId) {
  if (pageId) {
    const i = (doc.pages ?? []).findIndex((p) => p.id === pageId);
    if (i < 0) throw new NordleError(`There is no page "${pageId}". Pages: ${(doc.pages ?? []).map((p) => p.id).join(', ')}.`, 0);
    return { page: doc.pages[i], index: i };
  }
  if ((doc.pages ?? []).length === 1) return { page: doc.pages[0], index: 0 };
  throw new NordleError(`This document has several pages (${(doc.pages ?? []).map((p) => p.id).join(', ')}). Say which page.`, 0);
}

const dotted = (key) => key.split('.').filter(Boolean);

function outcome(r, { preview } = {}) {
  const lines = [];
  if (r.mode === 'proposed') {
    lines.push(r.noChange
      ? 'Nothing would change.'
      : 'SUGGESTED, NOT APPLIED. The owner has set this post to "suggest", so your change waits until they accept it in the editor. The post itself has not changed.');
  } else if (r.status === 'pending') {
    lines.push('APPLIED. It is flagged in the editor for the owner to accept or reject (autonomy: review).');
  } else {
    lines.push('APPLIED.');
  }
  if (r.summary?.length) lines.push('What changed:', ...r.summary.map((s) => `- ${s}`));
  if (r.changeId) lines.push(`Change id: ${r.changeId}`);
  lines.push(`Document version: ${r.v}`);
  lines.push(r.mode === 'proposed' && r.changeId && !r.noChange
    ? `To see it before the owner decides, call nordle_render with preview_change "${r.changeId}".`
    : preview ?? 'Next: call nordle_render and look at the result.');
  return lines.join('\n');
}

export async function patch(client, a, doc, ops, note) {
  if (!ops.length) return { text: 'Nothing to change: the document already has those values.' };
  const r = await client.post(`${docPath(a)}/patch`, { ops, baseVersion: doc.v, note });
  return { text: outcome(r) };
}

export async function load(client, a) { return client.get(docPath(a)); }

function groupIssues(issues) {
  const groups = new Map();
  for (const i of issues) {
    const key = [i.level, i.rule, i.page, i.layer, i.message].join('|');
    const g = groups.get(key) ?? { ...i, sizes: [] };
    if (i.size) g.sizes.push(i.size);
    groups.set(key, g);
  }
  return [...groups.values()];
}

/** @param {import('./client.mjs').NordleClient} client */
export function createTools(client) {
  return [...coreTools(client), ...pluginTools(client)];
}

function coreTools(client) {
  return [
    {
      name: 'nordle_list_projects',
      description: 'List the Nordle projects (one per brand or client) and the posts in each: id, title, kind (graphic or carousel), sizes and number of pages. Start here to find the project and document ids the other tools need.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: READ,
      async handler() {
        const { projects } = await client.get('/projects');
        return { json: projects.map((p) => ({ project: p.id, name: p.name, posts: p.docs.map((d) => ({ doc: d.id, title: d.title, kind: d.kind, pages: d.pages, sizes: d.sizes, ...(d.explore ? { take_of: d.explore.of, label: d.explore.label } : {}) })) })) };
      },
    },
    {
      name: 'nordle_get_guide',
      description: 'The working guide: the workflow, what the autonomy and lock settings mean, the document format (layers, layout, tokens, sizes) and design and writing principles. Read it once at the start of a Nordle job.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: READ,
      async handler() { return { text: guide() }; },
    },
    {
      name: 'nordle_get_brand',
      description: 'The brand kit of a project: colours and fonts (use them by token, for example $brand.colors.accent), the voice notes and banned phrases, and the motion personality. Read before designing or writing anything.',
      inputSchema: { type: 'object', properties: { project: P }, required: ['project'], additionalProperties: false },
      annotations: READ,
      async handler(a) {
        const info = await client.get(`/projects/${enc(a.project)}`);
        const b = info.brand;
        return { json: {
          name: b.name,
          colors: Object.fromEntries(Object.keys(b.colors).map((k) => [`$brand.colors.${k}`, resolveToken(`$brand.colors.${k}`, b)])),
          colourways: b.colourways ? Object.keys(b.colourways) : [],
          fonts: Object.fromEntries(Object.entries(b.fonts).map(([k, f]) => [`$brand.fonts.${k}`, `${f.family} (weights ${(f.weights ?? []).join(', ') || 'any'})`])),
          voice: b.voice ?? {},
          motion: b.motion ?? {},
          images: info.assets.map((x) => x.path),
        } };
      },
    },
    {
      name: 'nordle_get_doc',
      description: 'Read one post: its full document (pages, layers, copy), the version number, the sizes with their safe zones and caption limits, what is locked (you cannot change it), the autonomy setting for this post, how many comments and pending changes there are, and any alternative takes.',
      inputSchema: { type: 'object', properties: { project: P, doc: D }, required: ['project', 'doc'], additionalProperties: false },
      annotations: READ,
      async handler(a) {
        const d = await load(client, a);
        const takes = (await client.get(`${docPath(a)}/explore`)).takes;
        const changes = d.review.changes ?? [];
        return { json: {
          id: d.doc.id, title: d.doc.title, kind: d.doc.kind, version: d.v, autonomy: d.autonomy,
          autonomy_meaning: { suggest: 'your edits are only proposed until the owner accepts them', review: 'your edits are applied and flagged for the owner to accept or reject', apply: 'your edits are applied' }[d.autonomy],
          sizes: d.sizes.map((s) => ({ id: s.id, width: s.w, height: s.h, safe_zone_fractions: s.safe ?? null, caption_limit: s.preset?.maxCaption ?? null })),
          locked: locksIn(d.doc),
          open_comments: d.review.comments.filter((c) => c.status === 'open').length,
          pending_changes: changes.filter((c) => c.status === 'pending').length,
          approved: [...d.review.approvals].reverse().find((x) => !x.revoked) ? 'yes' : 'no',
          takes,
          images_available: d.assets.map((x) => x.path),
          document: d.doc,
        } };
      },
    },
    {
      name: 'nordle_render',
      description: 'See a page as a picture, exactly as it will be exported. Look at it after every meaningful edit. With preview_change, shows what a pending suggestion would look like without applying it.',
      inputSchema: {
        type: 'object',
        properties: {
          project: P, doc: D, page: { type: 'string', description: 'Page id. Default: the first page.' },
          size: { type: 'string', description: 'Size id such as ig-feed-4x5. Default: the first size.' },
          scale: { type: 'number', enum: [0.5, 1, 2], description: '0.5 is quicker and enough to judge layout. Default 1.' },
          format: { type: 'string', enum: ['jpg', 'png'] },
          preview_change: { type: 'string', description: 'The id of a pending suggestion to preview.' },
        },
        required: ['project', 'doc'], additionalProperties: false,
      },
      annotations: READ,
      async handler(a) {
        const r = await client.post(`${docPath(a)}/render`, { page: a.page, size: a.size, scale: a.scale, format: a.format, change: a.preview_change });
        return { text: `Page "${r.page}" at ${r.size}, ${r.w}x${r.h} px${a.preview_change ? ' (a preview of the suggestion, not yet applied)' : ''}.${r.warnings?.length ? ` Notes: ${r.warnings.join(' ')}` : ''}`, images: [{ base64: r.base64, mime: r.mime }] };
      },
    },
    {
      name: 'nordle_update_layer',
      description: 'Change properties of one layer, addressed by id. "set" maps dotted property names to values, for example {"text": "New headline", "style.size": 120, "layout.x": 10, "style.color": "$brand.colors.accent"}. "unset" lists properties to remove. With "size", the change applies to that size only (layout, style, text and hidden only). Locked layers are refused. The result says whether the change was applied or only suggested.',
      inputSchema: {
        type: 'object',
        properties: {
          project: P, doc: D, page: PAGE, layer: { type: 'string', description: 'Layer id.' },
          set: { type: 'object', description: 'Dotted property name -> new value.' },
          unset: { type: 'array', items: { type: 'string' }, description: 'Dotted property names to remove.' },
          size: { type: 'string', description: 'Size id: make this change for that size only.' },
          note: { type: 'string', description: 'A few words on why, shown to the owner.' },
        },
        required: ['project', 'doc', 'layer'], additionalProperties: false,
      },
      annotations: EDIT,
      async handler(a) {
        const d = await load(client, a);
        const ref = findLayer(d.doc, a.page, a.layer);
        const entries = [];
        const add = (key, value) => {
          const parts = dotted(key);
          if (!parts.length) throw new NordleError('A property name cannot be empty.', 0);
          if (['id', 'type'].includes(parts[0])) throw new NordleError(`"${parts[0]}" cannot be changed. Add a new layer instead.`, 0);
          if (a.size) {
            if (!['layout', 'style', 'text', 'hidden', 'animate'].includes(parts[0])) throw new NordleError(`"${parts[0]}" is the same at every size, so "size" cannot be used with it.`, 0);
            if (!d.sizes.some((s) => s.id === a.size)) throw new NordleError(`This post has no size "${a.size}". Sizes: ${d.sizes.map((s) => s.id).join(', ')}.`, 0);
          }
          const tail = toPointer(parts);
          entries.push({ pointer: a.size ? `${ref.ptr}/overrides/${a.size}${tail}` : `${ref.ptr}${tail}`, value });
        };
        for (const [k, v] of Object.entries(a.set ?? {})) add(k, v);
        for (const k of a.unset ?? []) add(k, undefined);
        if (!entries.length) throw new NordleError('Give "set" or "unset".', 0);
        return patch(client, a, d, buildSetOps(d.doc, entries), a.note ?? `Update ${a.layer}`);
      },
    },
    {
      name: 'nordle_add_layer',
      description: 'Add a layer to a page. "layer" is a layer object: {"type":"text","text":"...","layout":{"anchor":"top-left","x":8,"y":10,"w":84},"style":{"font":"$brand.fonts.display","size":120,"color":"$brand.colors.ink"}}. See nordle_get_guide for the layer types and layout rules. An id is made up if you leave it out. It goes on top unless you say position "back".',
      inputSchema: {
        type: 'object',
        properties: {
          project: P, doc: D, page: PAGE,
          layer: { type: 'object', description: 'The layer to add.' },
          position: { type: 'string', enum: ['front', 'back'], description: 'front = on top (default), back = behind everything.' },
          note: { type: 'string' },
        },
        required: ['project', 'doc', 'layer'], additionalProperties: false,
      },
      annotations: EDIT,
      async handler(a) {
        const d = await load(client, a);
        const { page, index } = pickPage(d.doc, a.page);
        const layer = structuredClone(a.layer);
        if (!layer.type) throw new NordleError('The layer needs a "type" (text, image, shape or group).', 0);
        if (!layer.id) {
          const taken = new Set(JSON.stringify(page.layers).match(/"id":"[^"]+"/g)?.map((s) => s.slice(6, -1)) ?? []);
          const base = layer.shape ?? layer.type;
          layer.id = base;
          for (let i = 2; taken.has(layer.id); i++) layer.id = `${base}-${i}`;
        }
        const path = a.position === 'back' ? `/pages/${index}/layers/0` : `/pages/${index}/layers/-`;
        return patch(client, a, d, [{ op: 'add', path, value: layer }], a.note ?? `Add ${layer.id}`);
      },
    },
    {
      name: 'nordle_remove_layer',
      description: 'Remove layers from a page by id. Prefer changing a layer to removing it. Locked layers are refused.',
      inputSchema: {
        type: 'object',
        properties: { project: P, doc: D, page: PAGE, layers: { type: 'array', items: { type: 'string' }, minItems: 1 }, note: { type: 'string' } },
        required: ['project', 'doc', 'layers'], additionalProperties: false,
      },
      annotations: EDIT,
      async handler(a) {
        const d = await load(client, a);
        const refs = a.layers.map((id) => findLayer(d.doc, a.page, id));
        // remove from the end of each list first so earlier positions stay valid
        const ops = refs.sort((x, y) => (x.parentPtr === y.parentPtr ? y.index - x.index : x.parentPtr < y.parentPtr ? -1 : 1)).map((r) => ({ op: 'remove', path: r.ptr }));
        return patch(client, a, d, ops, a.note ?? `Remove ${a.layers.join(', ')}`);
      },
    },
    {
      name: 'nordle_add_page',
      description: 'Add a page to a carousel. Optionally copy an existing page ("duplicate_of") and then edit the copy, or give a title and background. Goes at the end unless "position" (0 = first) is given.',
      inputSchema: {
        type: 'object',
        properties: {
          project: P, doc: D, title: { type: 'string' }, background: { type: 'string', description: 'A brand token like $brand.colors.paper, or a hex colour.' },
          duplicate_of: { type: 'string', description: 'Page id to copy.' }, position: { type: 'integer', minimum: 0 }, note: { type: 'string' },
        },
        required: ['project', 'doc'], additionalProperties: false,
      },
      annotations: EDIT,
      async handler(a) {
        const d = await load(client, a);
        const pages = d.doc.pages;
        const taken = new Set(pages.map((p) => p.id));
        const fresh = (base) => { let id = base; for (let i = 2; taken.has(id); i++) id = `${base}-${i}`; return id; };
        let page;
        if (a.duplicate_of) {
          const src = pages.find((p) => p.id === a.duplicate_of);
          if (!src) throw new NordleError(`There is no page "${a.duplicate_of}".`, 0);
          page = structuredClone(src);
          page.id = fresh(`${src.id}-copy`);
          delete page.lock;
          page.title = a.title ?? `${src.title ?? src.id} copy`;
        } else {
          page = { id: fresh(`page-${pages.length + 1}`), title: a.title ?? `Page ${pages.length + 1}`, background: a.background ?? pages.at(-1)?.background ?? '#ffffff', layers: [] };
        }
        if (a.duplicate_of && a.background) page.background = a.background;
        const path = Number.isInteger(a.position) ? `/pages/${Math.min(a.position, pages.length)}` : '/pages/-';
        const res = await patch(client, a, d, [{ op: 'add', path, value: page }], a.note ?? `Add page ${page.id}`);
        return { text: `New page id: "${page.id}".\n${res.text}` };
      },
    },
    {
      name: 'nordle_list_patterns',
      description: 'The layout patterns you can start a page from: cover, big statement, list, feature or menu item, big number, quote, full picture, picture and words, closing call to action. Each has slots (headline, body, image, ...) and an example. Starting from a pattern gives a well-spaced, brand-coloured, collision-free page in one step; then refine it with the layer tools.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: READ,
      async handler() { return { json: listPatterns() }; },
    },
    {
      name: 'nordle_compose_page',
      description: 'Build a whole page from a layout pattern and your words. It picks type sizes, margins, brand colours and safe-zone positions for every size in the post, fits a picture into the room the words leave, and stacks the text so it cannot collide. Adds the page to the post (at the end, or "position"), or replaces an existing page with "replace_page". Then call nordle_render and nordle_critique, and refine with nordle_update_layer. Use the brand colours: tone is light, dark, accent or alt. Only put in words and figures you were given.',
      inputSchema: {
        type: 'object',
        properties: {
          project: P, doc: D,
          pattern: { type: 'string', enum: Object.keys(PATTERNS), description: 'See nordle_list_patterns.' },
          content: { type: 'object', description: 'The slots for the pattern, e.g. {"kicker":"New","headline":"Spring menu is here","body":"Open from 7 am.","image":"assets/hero-cup.svg","imageAlt":"A cup of coffee"}. "accent" names the phrase of the headline to italicise; "emphasis":"none" turns that off.' },
          tone: { type: 'string', enum: ['light', 'dark', 'accent', 'alt'], description: 'Background mood. Default depends on the pattern.' },
          page_id: { type: 'string', description: 'Id for the new page. Default: made up from the pattern.' },
          title: { type: 'string' },
          position: { type: 'integer', minimum: 0, description: 'Where to put the new page (0 = first). Default: the end.' },
          replace_page: { type: 'string', description: 'Id of a page to replace instead of adding one.' },
          note: { type: 'string' },
        },
        required: ['project', 'doc', 'pattern', 'content'], additionalProperties: false,
      },
      annotations: EDIT,
      async handler(a) {
        const d = await load(client, a);
        const sizes = d.sizes.map((s) => ({ id: s.id, w: s.w, h: s.h, safe: s.safe }));
        const taken = new Set(d.doc.pages.map((p) => p.id));
        let pageId = a.page_id ?? a.replace_page ?? a.pattern;
        if (!a.replace_page) for (let i = 2; taken.has(pageId); i++) pageId = `${a.page_id ?? a.pattern}-${i}`;
        let composed;
        const total = d.doc.pages.length + (a.replace_page ? 0 : 1);
        const index = a.replace_page ? Math.max(0, d.doc.pages.findIndex((x) => x.id === a.replace_page)) : Number.isInteger(a.position) ? Math.min(a.position, total - 1) : total - 1;
        try { composed = composePage({ pattern: a.pattern, content: a.content, brand: d.brand, colourway: d.doc.colourway, tone: a.tone, size: sizes[0], sizes, pageId, title: a.title, position: { index, total } }); } catch (e) { throw new NordleError(e.message, 0); }
        const { page, notes } = composed;
        let ops;
        if (a.replace_page) {
          const i = d.doc.pages.findIndex((p) => p.id === a.replace_page);
          if (i < 0) throw new NordleError(`There is no page "${a.replace_page}". Pages: ${d.doc.pages.map((p) => p.id).join(', ')}.`, 0);
          if (!a.title) page.title = d.doc.pages[i].title ?? page.title;
          ops = [{ op: 'replace', path: `/pages/${i}`, value: page }];
        } else {
          const at = Number.isInteger(a.position) ? `/pages/${Math.min(a.position, d.doc.pages.length)}` : '/pages/-';
          ops = [{ op: 'add', path: at, value: page }];
        }
        const res = await patch(client, a, d, ops, a.note ?? `${a.replace_page ? 'Redesign' : 'Add'} ${a.pattern} page`);
        return { text: `Page id: "${page.id}" (pattern ${a.pattern}).${notes.length ? `\nNotes: ${notes.join(' ')}` : ''}\n${res.text}` };
      },
    },
    {
      name: 'nordle_set_copy',
      description: 'Write the post copy: caption, call to action (cta), hashtags (a list), and alt text per page (an object of page id -> text). Only the fields you give are changed; pass null to remove one. Caption limits per platform are in nordle_get_doc.',
      inputSchema: {
        type: 'object',
        properties: {
          project: P, doc: D, caption: { type: ['string', 'null'] }, cta: { type: ['string', 'null'] },
          hashtags: { type: ['array', 'null'], items: { type: 'string' } },
          alt: { type: 'object', additionalProperties: { type: ['string', 'null'] }, description: 'Page id -> alt text.' },
          note: { type: 'string' },
        },
        required: ['project', 'doc'], additionalProperties: false,
      },
      annotations: EDIT,
      async handler(a) {
        const d = await load(client, a);
        const entries = [];
        for (const k of ['caption', 'cta', 'hashtags']) if (k in a) entries.push({ pointer: `/copy/${k}`, value: a[k] ?? undefined });
        for (const [pid, text] of Object.entries(a.alt ?? {})) entries.push({ pointer: toPointer(['copy', 'alt', pid]), value: text ?? undefined });
        if (!entries.length) throw new NordleError('Give at least one of caption, cta, hashtags or alt.', 0);
        return patch(client, a, d, buildSetOps(d.doc, entries), a.note ?? 'Write the copy');
      },
    },
    {
      name: 'nordle_patch_doc',
      description: 'Edit the document with raw JSON Patch operations (add, remove, replace, move, copy, test; paths like /pages/0/layers/1/style/size). Use only when the other tools cannot do it, and read the guide first. Locked content is refused. The result says whether the change was applied or only suggested.',
      inputSchema: {
        type: 'object',
        properties: {
          project: P, doc: D, note: { type: 'string' },
          ops: { type: 'array', minItems: 1, items: { type: 'object', properties: { op: { enum: ['add', 'remove', 'replace', 'move', 'copy', 'test'] }, path: { type: 'string' }, from: { type: 'string' }, value: {} }, required: ['op', 'path'] } },
        },
        required: ['project', 'doc', 'ops'], additionalProperties: false,
      },
      annotations: EDIT,
      async handler(a) {
        const d = await load(client, a);
        return patch(client, a, d, a.ops, a.note ?? 'Edit');
      },
    },
    {
      name: 'nordle_critique',
      description: 'Grade your own design. Renders every page at every size and scores it out of 100 against the design rules (clear hierarchy, few type sizes, margins, shared alignment edges, no collisions, balance, not too empty or crowded, no orphan words, soft images, carousel consistency) plus the technical checks (contrast, safe zones, cut-off text, banned phrases, caption length, alt text). Every issue says what to do about it. Errors come first. For a carousel it also shows all the pages together as one picture so you can judge the rhythm. Do this after you have built or changed a post, fix the errors and warnings, and run it again until the verdict is "good".',
      inputSchema: { type: 'object', properties: { project: P, doc: D, sheet: { type: 'boolean', description: 'Include the picture of all pages together. Default true.' } }, required: ['project', 'doc'], additionalProperties: false },
      annotations: READ,
      async handler(a) {
        const r = await client.post(`${docPath(a)}/critique`, { sheet: a.sheet });
        const lines = [`Design score ${r.score}/100 (pass mark ${r.passScore}). Verdict: ${r.verdict === 'good' ? 'GOOD' : 'NEEDS WORK'}. ${r.counts.error} error${r.counts.error === 1 ? '' : 's'}, ${r.counts.warn} warning${r.counts.warn === 1 ? '' : 's'}, ${r.counts.info} suggestion${r.counts.info === 1 ? '' : 's'}. Document version ${r.version}.`];
        for (const i of r.issues) {
          lines.push(`[${i.level}] ${i.rule}${i.page ? ` page ${i.page}` : ''}${i.layer ? ` layer ${i.layer}` : ''}${i.sizes?.length ? ` (${i.sizes.join(', ')})` : ''}: ${i.message}${i.fix ? `\n    Fix: ${i.fix}` : ''}`);
        }
        if (!r.issues.length) lines.push('Nothing to fix.');
        else if (r.verdict !== 'good') lines.push('Fix the errors first, then the warnings, then run nordle_critique again. Suggestions are optional.');
        return { text: lines.join('\n'), images: r.sheet ? [{ base64: r.sheet.base64, mime: r.sheet.mime }] : [] };
      },
    },
    {
      name: 'nordle_check',
      description: 'The quick technical checks only: text cut off or too small or too faint, text under platform buttons, banned phrases, caption over the platform limit, missing alt text, missing fonts. nordle_critique includes all of this plus the design rules, so prefer that one.',
      inputSchema: { type: 'object', properties: { project: P, doc: D }, required: ['project', 'doc'], additionalProperties: false },
      annotations: READ,
      async handler(a) {
        const r = await client.post(`${docPath(a)}/verify`);
        const g = groupIssues(r.issues);
        const errors = g.filter((i) => i.level === 'error').length, warns = g.filter((i) => i.level === 'warn').length;
        const lines = g.map((i) => `[${i.level}] ${i.rule}${i.page ? ` page ${i.page}` : ''}${i.layer ? ` layer ${i.layer}` : ''}: ${i.message}${i.sizes.length ? ` (${[...new Set(i.sizes)].join(', ')})` : ''}`);
        return { text: `${errors} problem${errors === 1 ? '' : 's'}, ${warns} thing${warns === 1 ? '' : 's'} to look at.${lines.length ? `\n${lines.join('\n')}` : '\nAll clear.'}` };
      },
    },
    {
      name: 'nordle_get_feedback',
      description: 'What the owner has asked for: open comments (each with the page, the layer it points at and that layer’s words), replies, the approval state, and what happened to your earlier changes (accepted, rejected, still waiting). Call this when the owner mentions feedback, comments or changes they want.',
      inputSchema: { type: 'object', properties: { project: P, doc: D }, required: ['project', 'doc'], additionalProperties: false },
      annotations: READ,
      async handler(a) {
        const d = await load(client, a);
        const { text } = await client.get(`${docPath(a)}/review/handoff`);
        const changes = d.review.changes ?? [];
        const ap = [...d.review.approvals].reverse().find((x) => !x.revoked);
        return { text, json: {
          autonomy: d.autonomy, version: d.v,
          approval: ap ? { approved_version: ap.docV, still_current: ap.docV === d.v, note: ap.note ?? null } : null,
          open_comment_ids: d.review.comments.filter((c) => c.status === 'open').map((c) => c.id),
          your_changes: changes.slice(-12).map((c) => ({ id: c.id, status: c.status, mode: c.mode, note: c.note })),
        } };
      },
    },
    {
      name: 'nordle_comment',
      description: 'Leave a comment for the owner, pinned to a spot on a page (x and y are 0 to 1 across and down the page), optionally on a layer. Use it for questions and for things you noticed but should not change yourself.',
      inputSchema: {
        type: 'object',
        properties: { project: P, doc: D, page: { type: 'string' }, text: { type: 'string', minLength: 1 }, layer: { type: 'string' }, x: { type: 'number', minimum: 0, maximum: 1 }, y: { type: 'number', minimum: 0, maximum: 1 }, time: { type: 'number', minimum: 0, description: 'For a video: the second the comment is about (page is then "video").' } },
        required: ['project', 'doc', 'page', 'text'], additionalProperties: false,
      },
      annotations: EDIT,
      async handler(a) {
        const r = await client.post(`${docPath(a)}/review/comment`, { page: a.page, text: a.text, layer: a.layer, x: a.x, y: a.y, time: a.time });
        return { text: `Comment added (id ${r.id}).` };
      },
    },
    {
      name: 'nordle_reply',
      description: 'Reply to a comment, for example to say what you did about it.',
      inputSchema: { type: 'object', properties: { project: P, doc: D, comment: { type: 'string', description: 'Comment id from nordle_get_feedback.' }, text: { type: 'string', minLength: 1 } }, required: ['project', 'doc', 'comment', 'text'], additionalProperties: false },
      annotations: EDIT,
      async handler(a) { await client.post(`${docPath(a)}/review/reply`, { comment: a.comment, text: a.text }); return { text: 'Reply added.' }; },
    },
    {
      name: 'nordle_resolve',
      description: 'Mark a comment as dealt with. Do this after you have made the change it asked for (and say what you did with nordle_reply). If your change was only suggested, do not resolve the comment: the owner will.',
      inputSchema: { type: 'object', properties: { project: P, doc: D, comment: { type: 'string' } }, required: ['project', 'doc', 'comment'], additionalProperties: false },
      annotations: EDIT,
      async handler(a) { await client.post(`${docPath(a)}/review/resolve`, { comment: a.comment }); return { text: 'Comment resolved.' }; },
    },
    {
      name: 'nordle_new_doc',
      description: 'Create a new empty post in a project: a carousel (several pages) or a single graphic. Sizes are platform ids (for example ig-feed-4x5, ig-story-9x16, li-feed-4x5); the default is ig-feed-4x5. Then build it with the layer tools.',
      inputSchema: {
        type: 'object',
        properties: { project: P, title: { type: 'string', minLength: 1 }, kind: { type: 'string', enum: ['carousel', 'graphic'] }, sizes: { type: 'array', items: { type: 'string' } } },
        required: ['project', 'title'], additionalProperties: false,
      },
      annotations: EDIT,
      async handler(a) {
        const r = await client.post(`/projects/${enc(a.project)}/docs`, { title: a.title, kind: a.kind ?? 'carousel', sizes: a.sizes });
        return { text: `Created document "${r.id}" in project "${a.project}". It has one empty page called "page-1". Call nordle_get_doc to see it, then add layers.` };
      },
    },
    {
      name: 'nordle_import_image',
      description: 'Copy an image file from this computer into a project so layers can use it. Give the full path of a PNG, JPG, WebP, GIF or SVG (up to 20 MB). Returns the project path to use as a layer’s "src".',
      inputSchema: { type: 'object', properties: { project: P, file_path: { type: 'string', description: 'Full path of the image on this computer.' } }, required: ['project', 'file_path'], additionalProperties: false },
      annotations: EDIT,
      async handler(a) {
        const r = await client.uploadImage(a.project, a.file_path);
        return { text: `Imported. Use "${r.path}" as the layer's src.` };
      },
    },
    {
      name: 'nordle_save_version',
      description: 'Save a named snapshot of the post that the owner can view or restore. Do it before a big rewrite.',
      inputSchema: { type: 'object', properties: { project: P, doc: D, name: { type: 'string' }, note: { type: 'string' } }, required: ['project', 'doc'], additionalProperties: false },
      annotations: EDIT,
      async handler(a) {
        const r = await client.post(`${docPath(a)}/review/versions`, { name: a.name, note: a.note });
        return { text: `Saved as "${r.version.name}" (version of the document: ${r.version.docV}).` };
      },
    },
    {
      name: 'nordle_explore',
      description: 'Explore mode: make several alternative takes of a post. Creates copies named <doc>-take-1, -take-2 and so on (locks come with them). Then edit each take with the usual tools so they are genuinely different, and tell the owner to open Explore in the editor to pick one. Takes are scratch work: your edits to them apply directly.',
      inputSchema: {
        type: 'object',
        properties: { project: P, doc: D, count: { type: 'integer', minimum: 1, maximum: 6, description: 'How many takes. Default 3.' }, labels: { type: 'array', items: { type: 'string' }, description: 'Short names for the takes, e.g. ["Bold", "Quiet", "Playful"].' }, note: { type: 'string', description: 'The brief these takes answer.' } },
        required: ['project', 'doc'], additionalProperties: false,
      },
      annotations: EDIT,
      async handler(a) {
        const r = await client.post(`${docPath(a)}/explore`, { count: a.count ?? 3, labels: a.labels, note: a.note });
        return { text: `Made ${r.takes.length} takes:\n${r.takes.map((t) => `- ${t.id} (${t.label})`).join('\n')}\nEdit each one with the doc id above so they differ in layout, hierarchy, colour balance and type. Look at each with nordle_render.` };
      },
    },
    {
      name: 'nordle_open_editor',
      description: 'Make sure the Nordle editor is running and get its address, so you can tell the owner where to look. It opens on a post if you give one. (The editor opens in the owner’s browser; you cannot click in it.)',
      inputSchema: { type: 'object', properties: { project: P, doc: D }, required: [], additionalProperties: false },
      annotations: READ,
      async handler(a) {
        await client.connect();
        const url = `${client.baseUrl}/${a.project && a.doc ? `#/p/${enc(a.project)}/${enc(a.doc)}` : ''}`;
        return { text: `Nordle is running. Open: ${url}` };
      },
    },
  ];
}

// Feature tools live in src/mcp/tools/*.mjs. Each file default-exports  (client, helpers) => tool[]  where helpers are
// the shared bits above ({ P, D, READ, EDIT, enc, docPath, load, patch, NordleError }).
const here = dirname(fileURLToPath(import.meta.url));
const pluginFiles = readdirSync(join(here, 'tools')).filter((f) => f.endsWith('.mjs')).sort();
const pluginModules = [];
for (const f of pluginFiles) pluginModules.push((await import(pathToFileURL(join(here, 'tools', f)).href)).default);

function pluginTools(client) {
  const helpers = { P, D, READ, EDIT, enc, docPath, load, patch, NordleError };
  return pluginModules.flatMap((make) => make(client, helpers));
}
