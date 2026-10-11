// The pictures the Studio shows are drawn again a few seconds after a document changes, once however many changes came.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutoRender } from '../src/server/autorender.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fakePool = (calls, { fail = false } = {}) => ({ use: async (fn) => { calls.push('draw'); if (fail) throw new Error('boom'); return fn({}); } });

test('a burst of changes is drawn once, after the last one', async () => {
  const calls = [];
  const done = [];
  const a = createAutoRender({ use: async () => { calls.push('draw'); } }, { delayMs: 60, onDone: (f) => done.push(f) });
  for (let i = 0; i < 5; i++) { a.schedule('doc-a.json'); await wait(10); }
  assert.equal(calls.length, 0, 'nothing yet: the changes are still coming');
  await wait(200);
  assert.equal(calls.length, 1);
  assert.deepEqual(done, ['doc-a.json']);
});

test('different documents are drawn separately, an export cancels the pending draw, and a failure is only logged', async () => {
  const calls = [];
  const logged = [];
  const a = createAutoRender(fakePool(calls), { delayMs: 40 });
  a.schedule('one.json'); a.schedule('two.json'); a.cancel('two.json');
  await wait(150);
  assert.equal(calls.length, 1, 'only one.json was drawn');
  const b = createAutoRender(fakePool([], { fail: true }), { delayMs: 20, log: (m) => logged.push(m) });
  b.schedule('bad.json');
  await wait(100);
  assert.match(logged[0], /autorender: bad\.json: boom/);
});
