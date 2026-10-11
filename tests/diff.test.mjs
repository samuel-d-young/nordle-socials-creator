// Describing a change, and taking one back exactly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../tools/validate.mjs';
import { applyOps, deepEqual } from '../src/shared/ops.mjs';
import { describeChange, computeRegions, regionOps } from '../src/shared/diff.mjs';

const sample = () => JSON.parse(readFileSync(join(ROOT, 'samples', 'little-gannet', 'docs', 'spring-menu-carousel.json'), 'utf8'));
const change = (ops, doc = sample()) => ({ before: doc, after: applyOps(doc, ops).doc });

test('describes edits to a layer in words, with the page and layer it touched', () => {
  const { before, after } = change([
    { op: 'replace', path: '/pages/0/layers/1/style/size', value: 110 },
    { op: 'replace', path: '/pages/0/layers/2/text', value: 'Fresh pours.' },
  ]);
  const d = describeChange(before, after);
  assert.equal(d.lines[0], 'cover/headline: style.size 132 → 110');
  assert.match(d.lines[1], /^cover\/sub: text "Three new pours.* → "Fresh pours\."$/);
  assert.deepEqual(d.touched, [{ page: 'cover', layer: 'headline' }, { page: 'cover', layer: 'sub' }]);
});

test('describes added and removed layers and pages, and caption changes', () => {
  const { before, after } = change([
    { op: 'add', path: '/pages/0/layers/-', value: { id: 'badge', type: 'shape', shape: 'ellipse' } },
    { op: 'remove', path: '/pages/1/layers/4' },
    { op: 'remove', path: '/pages/4' },
    { op: 'replace', path: '/copy/caption', value: 'New caption' },
  ]);
  const text = describeChange(before, after).lines.join('\n');
  assert.match(text, /Removed page "visit"/);
  assert.match(text, /cover: added shape ellipse "badge"/);
  assert.match(text, /latte: removed text "price"/);
  assert.match(text, /copy\.caption .* → "New caption"/);
});

test('describes reordering, and says nothing for no change', () => {
  const doc = sample();
  const moved = applyOps(doc, [{ op: 'move', from: '/pages/0', path: '/pages/2' }]).doc;
  assert.match(describeChange(doc, moved).lines.join(' '), /Reordered the pages/);
  const restacked = applyOps(doc, [{ op: 'move', from: '/pages/0/layers/0', path: '/pages/0/layers/3' }]).doc;
  assert.match(describeChange(doc, restacked).lines.join(' '), /stacking order/);
  assert.deepEqual(describeChange(doc, doc), { lines: [], touched: [] });
});

test('a long list of changes is cut short with a count', () => {
  const doc = sample();
  const ops = doc.pages[1].layers.flatMap((_, i) => [{ op: 'replace', path: `/pages/1/layers/${i}/layout/x`, value: 1 }]).concat(doc.pages[2].layers.map((_, i) => ({ op: 'replace', path: `/pages/2/layers/${i}/layout/x`, value: 1 })), doc.pages[3].layers.map((_, i) => ({ op: 'replace', path: `/pages/3/layers/${i}/layout/x`, value: 1 })));
  const lines = describeChange(doc, applyOps(doc, ops).doc).lines;
  assert.equal(lines.length, 15);
  assert.match(lines.at(-1), /^… and \d+ more$/);
});

test('regions take a change back exactly, for page edits, copy edits and added or removed top-level keys', () => {
  const before = sample();
  const ops = [
    { op: 'replace', path: '/pages/0/layers/1/style/size', value: 99 },
    { op: 'replace', path: '/copy/caption', value: 'x' },
    { op: 'add', path: '/colourway', value: 'night' },
    { op: 'remove', path: '/tags' },
  ];
  const after = applyOps(before, ops).doc;
  const regions = computeRegions(before, after);
  assert.deepEqual(regions.map((r) => r.key).sort(), ['page:cover', 'top:colourway', 'top:copy', 'top:tags']);
  assert.ok(deepEqual(applyOps(after, regionOps(after, regions, 'before')).doc, before));
  const redo = regionOps(before, regions, 'after');
  assert.ok(deepEqual(applyOps(before, redo).doc, after));
});

test('regions cover structural changes to the page list as one whole region', () => {
  const before = sample();
  const after = applyOps(before, [{ op: 'remove', path: '/pages/2' }]).doc;
  const regions = computeRegions(before, after);
  assert.deepEqual(regions.map((r) => r.key), ['pages']);
  assert.ok(deepEqual(applyOps(after, regionOps(after, regions, 'before')).doc, before));
});

test('taking a change back is refused when the same part has changed again', () => {
  const before = sample();
  const after = applyOps(before, [{ op: 'replace', path: '/pages/0/layers/1/style/size', value: 99 }]).doc;
  const regions = computeRegions(before, after);
  const later = applyOps(after, [{ op: 'replace', path: '/pages/0/layers/2/text', value: 'someone else' }]).doc;
  assert.throws(() => regionOps(later, regions, 'before'), (e) => e.conflict?.[0] === 'page:cover');
  const elsewhere = applyOps(after, [{ op: 'replace', path: '/pages/3/layers/1/text', value: '09' }]).doc;
  assert.ok(regionOps(elsewhere, regions, 'before').length === 1, 'edits on other pages do not get in the way');
});
