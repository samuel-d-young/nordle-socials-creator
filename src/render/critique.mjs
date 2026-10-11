// Grading a design: the rules a good social post follows, measured on the rendered page. Claude uses this to check its own
// work and the editor shows it to the owner. Thresholds live in data/design-rubric.json.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, projectFor } from '../../tools/validate.mjs';
import { checkDocumentCopy, checkRenderedPage } from './checks.mjs';
import { renderDocument } from './render.mjs';
import { resolveSizes } from './context.mjs';

let rubricCache;
export const loadRubric = () => (rubricCache ??= JSON.parse(readFileSync(join(ROOT, 'data', 'design-rubric.json'), 'utf8')));

const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (r, g, b) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);

/** Mean and spread of the brightness behind a rectangle. A big spread means a busy background. */
export function backdropStats(png, rect, scale = 1) {
  const x0 = Math.max(0, Math.floor(rect.x * scale)), y0 = Math.max(0, Math.floor(rect.y * scale));
  const x1 = Math.min(png.width, Math.ceil((rect.x + rect.w) * scale)), y1 = Math.min(png.height, Math.ceil((rect.y + rect.h) * scale));
  if (x1 <= x0 || y1 <= y0) return null;
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 3000)));
  let n = 0, sum = 0, sq = 0;
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
    const i = (png.width * y + x) << 2;
    const v = lum(png.data[i], png.data[i + 1], png.data[i + 2]);
    n += 1; sum += v; sq += v * v;
  }
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
}

const area = (r) => Math.max(0, r.w) * Math.max(0, r.h);
const overlap = (a, b) => area({ w: Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h: Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) });
const lineBox = (l) => (l.fixedH || !l.boxRect ? l.rect : { x: l.rect.x, w: l.rect.w, y: l.boxRect.y, h: l.boxRect.h });
const firstFamily = (stack) => String(stack ?? '').split(',')[0].replace(/["']/g, '').trim();

/** Design issues for one page at one size. `layers` is what the in-page inspector reported. */
export function critiquePage({ rubric: R = loadRubric(), size, page, layers, backdrop, scale = 1 }) {
  const issues = [];
  const W = size.w, H = size.h, u = W / 1080;
  const add = (level, rule, layer, message, fix) => issues.push({ level, rule, source: 'design', size: size.id, page: page.id, layer: layer ?? null, message, fix });
  const ref = (l) => l.fontSize / u;

  if (!layers.length) { add('error', 'empty-page', null, 'This page has nothing on it.', 'Add a headline and something to look at.'); return issues; }

  const texts = layers.filter((l) => l.type === 'text' && l.rect && l.rect.w > 0 && l.opacity !== 0 && l.text);
  const canvasArea = W * H;
  const isBackground = (l) => area(l.boxRect) > R.density.backgroundShapeFraction * canvasArea;
  const visuals = layers.filter((l) => (l.type === 'image' || l.type === 'shape') && l.boxRect && l.opacity !== 0);

  // hierarchy: one thing should clearly come first
  const step = R.typeScale.sizeStepPx;
  const sizes = [...new Set(texts.map((l) => Math.round(ref(l) / step) * step))].sort((a, b) => b - a);
  const headline = texts.reduce((best, l) => (!best || ref(l) > ref(best) ? l : best), null);
  if (texts.length >= 2 && sizes.length >= 2 && sizes[0] / sizes[1] < R.hierarchy.minRatio) {
    add('warn', 'hierarchy', headline.id, `The biggest text is only ${(sizes[0] / sizes[1]).toFixed(1)}× the next size, so nothing clearly comes first.`,
      `Make "${headline.id}" at least ${R.hierarchy.minRatio}× bigger than the next text, or make the next text smaller.`);
  } else if (texts.length >= 2 && sizes.length === 1) {
    add('info', 'flat-hierarchy', null, 'All the text is the same size.', 'Make the headline much bigger than the supporting text.');
  }
  if (headline && ref(headline) < R.hierarchy.headlinePx && page.layers.length > 1 && texts.length >= 2) {
    add('info', 'weak-headline', headline.id, `The biggest text is only ${Math.round(ref(headline))} px; a headline usually needs ${R.hierarchy.headlinePx} px or more to read at a glance.`, `Raise "${headline.id}" to ${R.hierarchy.headlinePx} px or more.`);
  }

  // few sizes, few fonts
  if (sizes.length > R.typeScale.maxSizes) add('warn', 'type-scale', null, `${sizes.length} different text sizes (${sizes.join(', ')} px). More than ${R.typeScale.maxSizes} looks unplanned.`, 'Merge sizes that are close, so there are two to four distinct steps.');
  const families = [...new Set(texts.map((l) => firstFamily(l.family)))];
  if (families.length > R.typeScale.maxFamilies) add('warn', 'type-families', null, `${families.length} different fonts on one page (${families.join(', ')}).`, 'Use the brand\'s display font and body font only.');

  // margins and alignment
  for (const l of texts) {
    if (l.ignoreSafe) continue;
    const r = l.rect;
    const m = Math.min(r.x / W, (W - r.x - r.w) / W, r.y / H, (H - r.y - r.h) / H) * 100;
    if (m < R.margins.minPct) add('warn', 'tight-margin', l.id, `"${l.id}" is only ${Math.max(0, m).toFixed(1)}% from the edge of the picture.`, `Move it in so there is at least ${R.margins.minPct}% of space around it.`);
  }
  const edge = (l) => (/center/.test(l.align) ? l.rect.x + l.rect.w / 2 : /right|end/.test(l.align) ? l.rect.x + l.rect.w : l.rect.x);
  const xs = texts.map((l) => ({ id: l.id, x: edge(l) })).sort((a, b) => a.x - b.x);
  const clusters = [];
  for (const p of xs) {
    const last = clusters[clusters.length - 1];
    if (last && p.x - last.at <= (R.alignment.clusterPct / 100) * W) last.ids.push(p.id); else clusters.push({ at: p.x, ids: [p.id] });
  }
  if (clusters.length > R.alignment.maxEdges) {
    add('warn', 'alignment', null, `Text lines up along ${clusters.length} different vertical lines (${clusters.map((c) => c.ids.join('+')).join('; ')}). Fewer shared edges looks tidier.`, 'Align most of the text to one left edge (or all to the centre).');
  }

  // collisions, and text on busy backgrounds
  for (let i = 0; i < texts.length; i++) for (let j = i + 1; j < texts.length; j++) {
    const a = texts[i], b = texts[j];
    // tight display type has a glyph box taller than its line; two lines collide when their LINE boxes do
    const ra = lineBox(a), rb = lineBox(b);
    const ov = overlap(ra, rb);
    if (ov / Math.min(area(ra), area(rb)) > R.overlap.textTextMaxFraction) {
      add('error', 'text-collision', `${a.id}`, `"${a.id}" and "${b.id}" overlap.`, `Move one of them, or make the text smaller or shorter so they have room.`);
    }
  }
  for (const t of texts) {
    for (const v of visuals) {
      if (isBackground(v)) continue;
      const ov = overlap(t.rect, v.boxRect);
      if (ov < 0.1 * area(t.rect)) continue;
      if (v.type === 'shape' && ov / area(t.rect) >= R.overlap.textInsideShape) continue; // a label on a button or badge
      const stats = backdrop ? backdropStats(backdrop, t.rect, scale) : null;
      if (stats && stats.std > R.overlap.busyStdDev) {
        add('warn', 'busy-background', t.id, `"${t.id}" sits on a busy part of "${v.id}", which makes it hard to read.`, 'Move the text to a calm area, add a plain shape behind it, or darken or lighten the image there.');
      }
    }
  }

  // balance and how full the page is
  let wx = 0, wy = 0, wsum = 0;
  const grid = 30, cells = new Set();
  const mark = (r) => {
    for (let gy = Math.max(0, Math.floor((r.y / H) * grid)); gy <= Math.min(grid - 1, Math.floor(((r.y + r.h) / H) * grid)); gy++) {
      for (let gx = Math.max(0, Math.floor((r.x / W) * grid)); gx <= Math.min(grid - 1, Math.floor(((r.x + r.w) / W) * grid)); gx++) cells.add(gy * grid + gx);
    }
  };
  for (const t of texts) { const a = area(t.rect); wx += (t.rect.x + t.rect.w / 2) * a; wy += (t.rect.y + t.rect.h / 2) * a; wsum += a; mark(t.rect); }
  for (const v of visuals) {
    if (isBackground(v)) continue;
    const a = area(v.boxRect) * 0.7; wx += (v.boxRect.x + v.boxRect.w / 2) * a; wy += (v.boxRect.y + v.boxRect.h / 2) * a; wsum += a; mark(v.boxRect);
  }
  if (wsum > 0) {
    const ox = (wx / wsum - W / 2) / W, oy = (wy / wsum - H / 2) / H;
    if (Math.abs(ox) > R.balance.maxOffsetX) add('info', 'balance', null, `Most of the visual weight sits to the ${ox < 0 ? 'left' : 'right'}.`, 'Fine if it is deliberate. Otherwise move or enlarge something on the other side.');
    if (Math.abs(oy) > R.balance.maxOffsetY) add('info', 'balance', null, `Most of the visual weight sits at the ${oy < 0 ? 'top' : 'bottom'}.`, 'Fine if it is deliberate. Otherwise give the other half something to look at.');
  }
  const coverage = cells.size / (grid * grid);
  if (coverage < R.density.minCoverage) add('warn', 'too-empty', null, `The page is very empty (${Math.round(coverage * 100)}% used).`, 'Make the headline or the image bigger, or add the missing piece of content.');
  if (coverage > R.density.maxCoverage) add('warn', 'too-crowded', null, `The page is crowded (${Math.round(coverage * 100)}% used).`, 'Remove something, shorten the text, or make things smaller to give the rest room.');

  // the words themselves
  if (headline && headline.lineWidths?.length > R.text.maxHeadlineLines) {
    add('warn', 'long-headline', headline.id, `The headline runs to ${headline.lineWidths.length} lines.`, 'Shorten it, or make it narrower in size so it fits in four lines or fewer.');
  }
  for (const t of texts) {
    const w = t.lineWidths ?? [];
    if (w.length >= 2 && !/balance/.test(t.textWrap ?? '') && w[w.length - 1] / Math.max(...w) < R.text.widowRatio) {
      add('warn', 'widow', t.id, `The last line of "${t.id}" is a short orphan (a word or two alone).`, 'Turn on "balance" for this text, reword it, or change its width.');
    }
    if (w.length >= 1 && ref(t) < R.hierarchy.headlinePx && t.text.length / w.length > R.text.maxCharsPerLine) {
      add('info', 'long-lines', t.id, `"${t.id}" has long lines (about ${Math.round(t.text.length / w.length)} characters). Short lines are easier to read.`, 'Make the text box narrower.');
    }
  }
  const small = texts.filter((l) => ref(l) < R.text.smallPx);
  if (small.length > R.text.maxSmallLayers) add('info', 'small-text', null, `${small.length} pieces of small text. On a phone, few people read small text.`, 'Cut the small text down to what is essential.');

  // pictures
  for (const v of visuals) {
    if (v.type !== 'image' || v.vector || !v.naturalW) continue;
    if (v.boxRect.w * scale > v.naturalW * 1.05 / R.images.minScale) {
      add('warn', 'soft-image', v.id, `"${v.id}" will look soft: the file is ${v.naturalW} px wide but is shown ${Math.round(v.boxRect.w * scale)} px wide.`, 'Use a larger picture, or show this one smaller.');
    }
  }
  return issues;
}

const CTA = /\b(book|call|visit|follow|swipe|shop|order|dm|message|learn|sign|join|come|tap|link|find|save|share|try|get|see you|reserve|contact|enquire|email|subscribe|download|click)\b/i;

/** Issues that only show across the pages of a carousel at one size. */
export function critiqueSet({ rubric: R = loadRubric(), size, doc, pages }) {
  const issues = [];
  if (pages.length < 2) return issues;
  const W = size.w, u = size.w / 1080;
  const add = (level, rule, page, layer, message, fix) => issues.push({ level, rule, source: 'design', size: size.id, page, layer, message, fix });
  const heads = pages.map(({ page, layers }) => {
    const texts = layers.filter((l) => l.type === 'text' && l.rect && l.text);
    const h = texts.reduce((best, l) => (!best || l.fontSize > best.fontSize ? l : best), null);
    return h ? { page: page.id, layer: h.id, left: (h.rect.x / W) * 100, px: h.fontSize / u, centered: /center/.test(h.align) } : null;
  });
  const left = heads.filter((h) => h && !h.centered);
  if (left.length >= 3) {
    const min = Math.min(...left.map((h) => h.left)), max = Math.max(...left.map((h) => h.left));
    if (max - min > R.consistency.marginTolerancePct) {
      add('warn', 'inconsistent-margins', left.find((h) => h.left === max).page, left.find((h) => h.left === max).layer,
        `Headlines start at different distances from the edge across the pages (${min.toFixed(1)}% to ${max.toFixed(1)}%).`, 'Give every headline the same left margin so the pages feel like a set.');
    }
  }
  const inner = heads.slice(1, -1).filter(Boolean);
  if (inner.length >= 2) {
    const lo = Math.min(...inner.map((h) => h.px)), hi = Math.max(...inner.map((h) => h.px));
    if (hi / lo - 1 > R.consistency.headlineSizeTolerance) {
      const odd = inner.find((h) => h.px === lo);
      add('warn', 'inconsistent-headlines', odd.page, odd.layer, `The middle pages use headline sizes from ${Math.round(lo)} to ${Math.round(hi)} px.`, 'Use one headline size for the middle pages.');
    }
    if (heads[0] && heads[0].px < 0.9 * (inner.map((h) => h.px).sort((a, b) => a - b)[Math.floor(inner.length / 2)])) {
      add('info', 'weak-cover', heads[0].page, heads[0].layer, 'The cover headline is smaller than the headlines inside. The cover has to be the strongest page.', 'Make the cover headline the biggest.');
    }
  }
  const last = pages[pages.length - 1];
  const lastText = last.layers.filter((l) => l.type === 'text').map((l) => l.text ?? '').join(' ');
  if (pages.length >= 3 && !CTA.test(lastText) && !doc.copy?.cta) {
    add('info', 'no-closing-cta', last.page.id, null, 'The last page does not say what to do next.', 'End with one clear action: visit, book, follow, message.');
  }
  return issues;
}

/** Checks that need no rendering: brand tokens and the copy. */
export function critiqueStatic({ rubric: R = loadRubric(), doc }) {
  const issues = [];
  const add = (level, rule, page, layer, message, fix) => issues.push({ level, rule, source: 'design', size: null, page, layer, message, fix });
  const raw = [];
  const fonts = [];
  const colourOk = (v) => typeof v !== 'string' || v.startsWith('$brand.') || v === 'transparent';
  const visit = (layers, pageId) => {
    for (const l of layers ?? []) {
      const styles = [l.style, ...(l.runs ?? []).map((r) => r.style), ...Object.values(l.overrides ?? {}).map((o) => o.style)].filter(Boolean);
      for (const s of styles) {
        for (const v of [s.color, typeof s.fill === 'string' ? s.fill : undefined, s.stroke?.color, s.shadow?.color]) if (v !== undefined && !colourOk(v)) raw.push(`${pageId}/${l.id}`);
        if (s.font && !String(s.font).startsWith('$brand.fonts.')) fonts.push(`${pageId}/${l.id}`);
      }
      visit(l.children, pageId);
    }
  };
  for (const p of doc.pages ?? []) {
    if (typeof p.background === 'string' && !colourOk(p.background)) raw.push(`${p.id} background`);
    visit(p.layers, p.id);
  }
  visit(doc.layers, 'overlay');
  if (raw.length) add('info', 'raw-colour', null, null, `${new Set(raw).size} place${new Set(raw).size === 1 ? '' : 's'} use a raw colour instead of a brand colour (${[...new Set(raw)].slice(0, 3).join(', ')}).`, 'Use brand colour tokens such as $brand.colors.accent so a colour change reaches everywhere.');
  if (fonts.length) add('warn', 'off-brand-font', null, null, `${new Set(fonts).size} layer${new Set(fonts).size === 1 ? '' : 's'} use a font that is not one of the brand's (${[...new Set(fonts)].slice(0, 3).join(', ')}).`, 'Use $brand.fonts.display or $brand.fonts.body.');
  const caption = doc.copy?.caption?.trim();
  if (caption && caption.split('\n')[0].length > R.caption.hookChars) add('info', 'caption-hook', null, 'copy', `The caption's first line is ${caption.split('\n')[0].length} characters. Feeds cut it off at about ${R.caption.hookChars}, so the hook may be lost.`, 'Put the point of the caption in the first sentence and keep that sentence short.');
  if (caption && !doc.copy?.cta && !CTA.test(caption)) add('info', 'caption-cta', null, 'copy', 'The caption does not ask the reader to do anything.', 'End with one clear call to action.');
  return issues;
}

const FIX_FOR_CHECK = {
  contrast: 'Use a darker or lighter brand colour for the text, or put a plain shape behind it.',
  'text-cut-off': 'Move the text in, or make it smaller or its box wider.',
  'text-overflow': 'Make the box wider or the text shorter.',
  'safe-zone': 'Move the text away from the top, bottom and sides that the platform covers (turn on Safe zones to see them).',
  'text-small': 'Make it at least 24 px, ideally 30 or more.',
  'image-alt': 'Describe the image in its alt text, or set alt to "" if it is only decoration.',
  'banned-phrase': 'Reword it without that phrase.',
  'caption-length': 'Shorten the caption, call to action or hashtags.',
  'alt-missing': 'Write alt text for this page in the Copy tab.',
  'no-caption': 'Write the caption.',
  font: 'Use a font the brand has installed, or tell the owner this font is missing.',
  'off-canvas': 'Move the layer back onto the picture or delete it.',
};

/** Same issue on several sizes becomes one entry that lists the sizes. */
function group(issues) {
  const map = new Map();
  for (const i of issues) {
    const key = [i.source, i.level, i.rule, i.page, i.layer, i.message].join('|');
    const g = map.get(key) ?? { ...i, sizes: [] };
    if (i.size) g.sizes.push(i.size);
    delete g.size;
    map.set(key, g);
  }
  return [...map.values()].map((g) => ({ ...g, sizes: [...new Set(g.sizes)] }));
}

export function scoreOf(issues, R = loadRubric()) {
  const penalty = issues.reduce((sum, i) => sum + R.scoring[i.level], 0);
  const score = Math.max(0, 100 - penalty);
  const errors = issues.filter((i) => i.level === 'error').length;
  return { score, verdict: errors === 0 && score >= R.scoring.passScore ? 'good' : 'needs-work', passScore: R.scoring.passScore };
}

/**
 * Render the document and grade it: design rules plus the technical checks, with a score. This is Claude's self-review.
 * @returns {Promise<{id:string, kind:string, score:number, verdict:string, passScore:number, counts:object, issues:object[], pages:number, sizes:string[]}>}
 */
export async function critiqueDocument(file, opts = {}) {
  const R = loadRubric();
  // a brand that owns three fonts (say a serif, a script and a sans) is allowed to use all three
  const brandFonts = Object.keys(projectFor(file).brand?.fonts ?? {}).length;
  if (brandFonts > R.typeScale.maxFamilies) R.typeScale = { ...R.typeScale, maxFamilies: brandFonts };
  const raw = [];
  const bySize = new Map();
  const rendered = await renderDocument(file, {
    ...opts, inspect: true,
    onPage: (p) => {
      raw.push(...checkRenderedPage(p).map((i) => ({ ...i, source: 'check', fix: FIX_FOR_CHECK[i.rule] })));
      raw.push(...critiquePage({ rubric: R, ...p }));
      if (!bySize.has(p.size.id)) bySize.set(p.size.id, { size: p.size, pages: [] });
      bySize.get(p.size.id).pages.push({ page: p.page, layers: p.layers });
    },
  });
  const { ctx } = rendered;
  if (rendered.errors.length || rendered.skipped) {
    return { id: ctx.doc.id, kind: ctx.doc.kind, skipped: rendered.skipped, issues: rendered.errors.map((e) => ({ level: 'error', rule: 'document', source: 'check', page: null, layer: e.path, message: e.message, sizes: [] })), score: 0, verdict: 'needs-work', passScore: R.scoring.passScore, counts: { error: rendered.errors.length, warn: 0, info: 0 }, pages: 0, sizes: [], outputs: [] };
  }
  for (const { size, pages } of bySize.values()) raw.push(...critiqueSet({ rubric: R, size, doc: ctx.doc, pages }));
  raw.push(...critiqueStatic({ rubric: R, doc: ctx.doc }));
  raw.push(...rendered.warnings.map((message) => ({ level: 'warn', rule: 'font', source: 'check', size: null, page: null, layer: null, message, fix: FIX_FOR_CHECK.font })));
  raw.push(...checkDocumentCopy({ doc: ctx.doc, brand: ctx.brand, sizes: resolveSizes(ctx.doc, ctx.platforms) }).map((i) => ({ ...i, source: 'check', fix: FIX_FOR_CHECK[i.rule] })));
  raw.push(...ctx.issues.filter((i) => i.level === 'warn').map((i) => ({ level: 'warn', rule: 'document', source: 'check', size: null, page: null, layer: i.path, message: i.message })));

  const issues = group(raw).sort((a, b) => ({ error: 0, warn: 1, info: 2 }[a.level] - { error: 0, warn: 1, info: 2 }[b.level]));
  const counts = { error: 0, warn: 0, info: 0 };
  for (const i of issues) counts[i.level] += 1;
  return {
    id: ctx.doc.id, kind: ctx.doc.kind, ...scoreOf(issues, R), counts, issues, pages: ctx.doc.pages.length, sizes: [...bySize.keys()],
    outputs: rendered.outputs, ctx,
  };
}
