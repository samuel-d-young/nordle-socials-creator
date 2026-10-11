// Every piece of text a post shows or says: the caption, hashtags, alt text, each text layer on each page (including styled
// runs and per-size wording), a video's overlay text, and the words spoken in a video. The rule checks (packs, facts, copy)
// all read from this one list, so none of them can miss a place.

import { splitCamel } from './text.mjs';
import { shownText } from './transcript.mjs';
import { buildTimeline } from './timeline.mjs';

/** The wording of one text layer: its text, or its runs joined. */
export const layerText = (l) => (typeof l.text === 'string' ? l.text : (l.runs ?? []).map((r) => r.text).join(''));

function* walkLayers(layers, trail = []) {
  for (const l of layers ?? []) {
    yield { layer: l, trail };
    if (l.children) yield* walkLayers(l.children, [...trail, l.id]);
  }
}

/** All layers of a page, groups flattened. */
export const flatLayers = (layers) => [...walkLayers(layers)].map((x) => x.layer);

/**
 * @typedef {{scope:string, label:string, text:string, page?:string, layer?:string, size?:string, time?:{start:number,end:number}, kind:string}} Surface
 * @returns {Surface[]}
 */
export function textSurfaces(doc, { projectDir, timeline } = {}) {
  const out = [];
  const add = (s) => { if (s.text && String(s.text).trim()) out.push(s); };
  const copy = doc.copy ?? {};

  add({ scope: 'copy.caption', kind: 'caption', label: 'the caption', text: copy.caption });
  add({ scope: 'copy.cta', kind: 'cta', label: 'the call to action', text: copy.cta });
  if (copy.hashtags?.length) {
    add({ scope: 'copy.hashtags', kind: 'hashtags', label: 'the hashtags', text: copy.hashtags.map((h) => splitCamel(String(h).replace(/^#/, ''))).join('\n'), raw: copy.hashtags.join(' ') });
  }
  for (const [platform, o] of Object.entries(copy.platforms ?? {})) {
    add({ scope: 'copy.caption', kind: 'caption', label: `the ${platform} caption`, text: o.caption });
    add({ scope: 'copy.cta', kind: 'cta', label: `the ${platform} call to action`, text: o.cta });
    if (o.hashtags?.length) add({ scope: 'copy.hashtags', kind: 'hashtags', label: `the ${platform} hashtags`, text: o.hashtags.map((h) => splitCamel(String(h).replace(/^#/, ''))).join('\n'), raw: o.hashtags.join(' ') });
  }
  for (const [key, text] of Object.entries(copy.alt ?? {})) {
    add({ scope: 'copy.alt', kind: 'alt', label: key === 'video' ? 'the video’s alt text' : `the alt text for page "${key}"`, text, ...(key === 'video' ? {} : { page: key }) });
  }

  const visitLayers = (layers, ctx) => {
    for (const { layer: l, trail } of walkLayers(layers)) {
      if (l.hidden) continue;
      const where = { ...ctx, layer: l.id };
      const name = `${ctx.page ? `page "${ctx.page}", ` : 'the video overlay, '}${l.type === 'image' ? 'picture' : 'text'} "${[...trail, l.id].join('/')}"`;
      if (l.type === 'text') {
        add({ scope: 'layers.text', kind: 'layer', label: name, text: layerText(l), ...where, ...(l.time ? { time: l.time } : {}) });
        for (const [size, o] of Object.entries(l.overrides ?? {})) {
          if (typeof o.text === 'string' && !o.hidden) add({ scope: 'layers.text', kind: 'layer', label: `${name} at ${size}`, text: o.text, size, ...where });
        }
      } else if (l.type === 'image' && l.alt) {
        add({ scope: 'copy.alt', kind: 'alt', label: `the alt text of ${name}`, text: l.alt, ...where });
      }
    }
  };
  for (const p of doc.pages ?? []) visitLayers(p.layers, { page: p.id });
  visitLayers(doc.layers, {});

  if (doc.kind === 'video' && doc.timeline) {
    const tl = timeline ?? (projectDir ? buildTimeline(doc, projectDir) : null);
    for (const c of tl?.clips ?? []) {
      if (!c.audible || !c.words.length) continue;
      add({ scope: 'video.captions', kind: 'speech', label: `what is said in clip "${c.id}"`, text: shownText(c.words), time: { start: c.words[0].tlStart, end: c.words.at(-1).tlEnd } });
    }
  }
  return out;
}

/** All the words of a post in one string (for rules that ask "does the post mention X"). */
export const allText = (surfaces) => surfaces.map((s) => s.text).join('\n');
