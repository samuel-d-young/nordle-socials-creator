// Edits are JSON Patch with exact inverses; locks are checked by comparing before and after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../tools/validate.mjs';
import { applyOps, PatchError, deepEqual, getAt, hasAt, setOp, lockViolations, parsePointer, toPointer, isPrefix } from '../src/shared/ops.mjs';

const sample = () => JSON.parse(readFileSync(join(ROOT, 'samples', 'little-gannet', 'docs', 'spring-menu-carousel.json'), 'utf8'));

test('pointers round-trip, including ~ and /', () => {
  assert.deepEqual(parsePointer('/a~1b/c~0d/0'), ['a/b', 'c~d', '0']);
  assert.equal(toPointer(['a/b', 'c~d', 0]), '/a~1b/c~0d/0');
  assert.deepEqual(parsePointer(''), []);
});

test('prototype pollution paths are refused', () => {
  for (const p of ['/__proto__/x', '/a/constructor/b', '/prototype']) assert.throws(() => parsePointer(p), PatchError);
  assert.throws(() => applyOps({}, [{ op: 'add', path: '/__proto__/polluted', value: 1 }]), PatchError);
  assert.equal({}.polluted, undefined);
});

test('add, replace and remove work on objects and arrays, and undo exactly', () => {
  const doc = { a: { b: 1 }, list: [10, 20, 30] };
  const ops = [
    { op: 'replace', path: '/a/b', value: 2 },
    { op: 'add', path: '/a/c', value: 3 },
    { op: 'add', path: '/list/1', value: 15 },
    { op: 'add', path: '/list/-', value: 40 },
    { op: 'remove', path: '/list/0' },
    { op: 'remove', path: '/a/c' },
  ];
  const { doc: after, inverse } = applyOps(doc, ops);
  assert.deepEqual(after, { a: { b: 2 }, list: [15, 20, 30, 40] });
  assert.deepEqual(doc, { a: { b: 1 }, list: [10, 20, 30] }, 'the input is not modified');
  assert.deepEqual(applyOps(after, inverse).doc, doc);
});

test('add over an existing key behaves like replace and undoes', () => {
  const { doc, inverse } = applyOps({ a: 1 }, [{ op: 'add', path: '/a', value: 2 }]);
  assert.deepEqual(doc, { a: 2 });
  assert.deepEqual(applyOps(doc, inverse).doc, { a: 1 });
});

test('move and copy work, including within one array, and undo exactly', () => {
  const start = { list: ['a', 'b', 'c', 'd'], o: { x: 1 } };
  const m = applyOps(start, [{ op: 'move', from: '/list/0', path: '/list/2' }]);
  assert.deepEqual(m.doc.list, ['b', 'c', 'a', 'd']);
  assert.deepEqual(applyOps(m.doc, m.inverse).doc, start);
  const c = applyOps(start, [{ op: 'copy', from: '/o', path: '/o2' }, { op: 'copy', from: '/list/1', path: '/list/-' }]);
  assert.deepEqual(c.doc, { list: ['a', 'b', 'c', 'd', 'b'], o: { x: 1 }, o2: { x: 1 } });
  assert.deepEqual(applyOps(c.doc, c.inverse).doc, start);
});

test('a failing operation changes nothing and says which one failed', () => {
  const doc = { a: [1, 2] };
  for (const ops of [
    [{ op: 'replace', path: '/nope', value: 1 }],
    [{ op: 'remove', path: '/a/5' }],
    [{ op: 'add', path: '/a/9', value: 1 }],
    [{ op: 'add', path: '/a/x', value: 1 }],
    [{ op: 'test', path: '/a/0', value: 99 }],
    [{ op: 'move', from: '/a', path: '/a/0' }],
    [{ op: 'frobnicate', path: '/a' }],
    [{ op: 'replace', path: '/a/0', value: 5 }, { op: 'remove', path: '/zzz' }],
  ]) assert.throws(() => applyOps(doc, ops), PatchError);
  try { applyOps(doc, [{ op: 'replace', path: '/a/0', value: 5 }, { op: 'remove', path: '/zzz' }]); } catch (e) { assert.equal(e.opIndex, 1); assert.match(e.message, /operation 2/); }
  assert.deepEqual(doc, { a: [1, 2] });
});

test('setOp chooses add, replace or remove from what is there', () => {
  const doc = { a: { b: 1 } };
  assert.equal(setOp(doc, '/a/b', 2).op, 'replace');
  assert.equal(setOp(doc, '/a/c', 2).op, 'add');
  assert.equal(setOp(doc, '/a/b', undefined).op, 'remove');
  assert.equal(setOp(doc, '/a/zzz', undefined), null);
  assert.ok(hasAt(doc, '/a/b') && !hasAt(doc, '/a/q'));
  assert.equal(getAt(doc, '/a/b'), 1);
});

test('fuzz: 300 random edits to the sample carousel all undo exactly', () => {
  let seed = 12345;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const pointers = (node, base = '', out = []) => {
    out.push(base);
    if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) pointers(v, `${base}/${String(k).replace(/~/g, '~0').replace(/\//g, '~1')}`, out);
    return out;
  };
  for (let n = 0; n < 300; n++) {
    const doc = sample();
    const ps = pointers(doc).filter((p) => p !== '');
    const ops = [];
    let cur = doc;
    for (let k = 0; k < 1 + Math.floor(rand() * 4); k++) {
      const p = pick(pointers(cur).filter((x) => x !== ''));
      const kind = pick(['replace', 'remove', 'add', 'move', 'copy']);
      const parentPtr = p.slice(0, p.lastIndexOf('/'));
      const op = kind === 'replace' ? { op: 'replace', path: p, value: pick([1, 'x', null, [], { z: 1 }]) }
        : kind === 'remove' ? { op: 'remove', path: p }
        : kind === 'add' ? { op: 'add', path: `${parentPtr}/${Array.isArray(getAt(cur, parentPtr || '/schema') ?? 0) ? '-' : 'extra'}`, value: pick([1, 'x', { q: [1] }]) }
        : { op: kind, from: p, path: `${pick(pointers(cur).filter((x) => x !== '' && !x.startsWith(`${p}/`)))}/-` };
      try { cur = applyOps(cur, [op]).doc; ops.push(op); } catch { /* an impossible random edit: skip it */ }
    }
    void ps;
    const original = sample();
    const { doc: after, inverse } = applyOps(original, ops);
    assert.ok(deepEqual(applyOps(after, inverse).doc, original), `edit ${n} did not undo: ${JSON.stringify(ops)}`);
  }
});

test('touched paths overlap by ancestry', () => {
  assert.ok(isPrefix('/pages/0', '/pages/0/layers/1'));
  assert.ok(isPrefix('/pages/0/layers/1', '/pages/0'));
  assert.ok(!isPrefix('/pages/0/layers/1', '/pages/0/layers/10'));
});

test('locks: a locked layer cannot be changed, moved to nothing, or removed with its parent', () => {
  const before = sample();
  before.pages[0].layers[1].lock = true; // headline on the cover
  const change = (ops) => lockViolations(before, applyOps(before, ops).doc);

  assert.deepEqual(change([{ op: 'replace', path: '/pages/0/layers/0/text', value: 'Free to edit' }]), []);
  assert.equal(change([{ op: 'replace', path: '/pages/0/layers/1/style/size', value: 99 }]).length, 1);
  assert.equal(change([{ op: 'remove', path: '/pages/0/layers/1' }]).length, 1);
  assert.equal(change([{ op: 'remove', path: '/pages/0' }]).length, 1);
  assert.equal(change([{ op: 'replace', path: '/pages/0/layers/1/lock', value: false }]).length, 1);
  assert.deepEqual(change([{ op: 'move', from: '/pages/0/layers/1', path: '/pages/0/layers/3' }]), [], 'reordering a locked layer does not change it');
  assert.deepEqual(change([{ op: 'add', path: '/pages/0/layers/0', value: { id: 'new', type: 'text', text: 'hi' } }]), []);
});

test('locks: a locked page protects everything on it, and a locked group protects its children', () => {
  const doc = sample();
  doc.pages[1].lock = true;
  const r1 = lockViolations(doc, applyOps(doc, [{ op: 'replace', path: '/pages/1/layers/3/text', value: 'x' }]).doc);
  assert.equal(r1.length, 1);
  assert.equal(r1[0].layer, null);
  const video = JSON.parse(readFileSync(join(ROOT, 'samples', 'little-gannet', 'docs', 'behind-the-roast-reel.json'), 'utf8'));
  video.layers[0].lock = true; // the lower-third group
  const r2 = lockViolations(video, applyOps(video, [{ op: 'replace', path: '/layers/0/children/0/text', value: 'Someone else' }]).doc);
  assert.equal(r2.length, 1);
  assert.equal(r2[0].layer, 'lower-third');
});
