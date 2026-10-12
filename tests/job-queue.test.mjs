// "Build it now" while Claude is already making a post: the request waits in line and starts by itself, one at a time. Nothing real is started: the work is a pretend job
// that finishes when the test says so.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { anyJobRunning, clearJobs, jobStatus, queuePosition, startJob } from '../src/calendar/jobs.mjs';

beforeEach(() => clearJobs());

const gate = () => { let go; const p = new Promise((r) => { go = r; }); return { p, go }; };
const tick = () => new Promise((r) => setImmediate(r));

test('a second request while Claude is busy waits in line, in order, and starts when the one before ends', async () => {
  const order = [];
  const a = gate(), b = gate(), c = gate();
  const job = (name, g) => () => { order.push(`start ${name}`); return g.p.then(() => ({ ran: [{ outcome: 'built' }] })); };
  assert.equal(startJob('/p', 'build', job('a', a), { item: 'a' }).started, true);
  const second = startJob('/p', 'build', job('b', b), { item: 'b' });
  const third = startJob('/p', 'build', job('c', c), { item: 'c' });
  assert.deepEqual([second.started, second.queued, second.position], [false, true, 1]);
  assert.equal(third.position, 2);
  assert.deepEqual(jobStatus('/p').queue.map((q) => [q.item, q.position]), [['b', 1], ['c', 2]]);
  assert.equal(queuePosition('/p', 'c'), 2);
  assert.equal(queuePosition('/p', 'nope'), 0);
  await tick();
  assert.deepEqual(order, ['start a'], 'only one at a time');
  a.go(); await tick(); await tick(); await tick();
  assert.deepEqual(order, ['start a', 'start b'], 'b starts by itself when a ends');
  assert.deepEqual(jobStatus('/p').queue.map((q) => q.item), ['c']);
  b.go(); await tick(); await tick(); await tick();
  assert.deepEqual(order, ['start a', 'start b', 'start c']);
  c.go(); await tick(); await tick(); await tick();
  assert.equal(anyJobRunning(), false);
  assert.deepEqual(jobStatus('/p').queue, []);
  assert.equal(jobStatus('/p').last.item, 'c');
});

test('asking again for the same post does not queue it twice; the job that is running is not queued behind itself; the line has a limit; a failed job does not stop the line', async () => {
  const a = gate();
  const ran = [];
  startJob('/p', 'build', () => a.p, { item: 'a' });
  assert.equal(startJob('/p', 'build', () => a.p, { item: 'a' }).alreadyRunning, true);
  const b1 = startJob('/p', 'build', () => { ran.push('b'); throw new Error('boom'); }, { item: 'b' });
  const b2 = startJob('/p', 'build', () => { ran.push('b-again'); }, { item: 'b' });
  assert.deepEqual([b1.position, b2.queued, b2.already, b2.position], [1, true, true, 1]);
  for (let i = 0; i < 19; i++) startJob('/p', 'build', () => {}, { item: `x${i}` });
  const full = startJob('/p', 'build', () => {}, { item: 'one-too-many' });
  assert.equal(full.full, true);
  assert.equal(full.queued, false);
  a.go();
  for (let i = 0; i < 80; i++) await tick();
  assert.deepEqual(ran, ['b'], 'b ran once, failed, and the line went on');
  assert.equal(jobStatus('/p').queue.length, 0);
  assert.equal(anyJobRunning(), false);
});

test('a different project has its own line', () => {
  const a = gate();
  startJob('/one', 'build', () => a.p, { item: 'a' });
  assert.equal(startJob('/two', 'build', () => a.p, { item: 'b' }).started, true);
  a.go();
});
