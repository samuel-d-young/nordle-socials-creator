// What Claude is doing, in plain words (src/server/activity.mjs, GET /api/activity): the description of a request, a piece of work that starts, goes quiet and
// finishes, the grouping by post, a render that is followed to its end, and that only Claude's requests are noted. A fake clock; no network; no real Claude.
//   node --test tests/activity.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AGENT } from './helpers.mjs';
import { studio, overview } from './studio-helpers.mjs';
import { createActivity, describeRequest } from '../src/server/activity.mjs';

const doc = (video) => () => ({ video, title: video ? 'Likes are not the score' : 'Spring menu' });

test('a request from Claude is described in plain words, and a read is not worth a line', () => {
  assert.equal(describeRequest('GET', '/api/projects/p/docs/d/patch', doc(true)), null);
  assert.deepEqual(describeRequest('POST', '/api/projects/p/docs/d/patch', doc(true)), { kind: 'video', verb: 'Changing', past: 'Changed', what: 'the video', project: 'p', doc: 'd' });
  assert.equal(describeRequest('POST', '/api/projects/p/docs/d/patch', doc(false)).what, 'the design');
  assert.equal(describeRequest('POST', '/api/projects/p/video/render', doc(true)).verb, 'Rendering');
  assert.equal(describeRequest('POST', '/api/projects/p/video/render', doc(true)).job, true);
  assert.equal(describeRequest('POST', '/api/projects/p/cut/words', doc(true)).verb, 'Cutting');
  assert.equal(describeRequest('POST', '/api/projects/p/checks/record', doc(false)).verb, 'Checking');
  assert.equal(describeRequest('POST', '/api/projects/p/calendar/items', doc(false)).what, 'the plan');
  assert.equal(describeRequest('POST', '/api/projects/p/docs/d/approve', doc(false)), null, 'approving is the owner\'s, not Claude\'s: nothing to say');
  assert.equal(describeRequest('POST', '/api/projects/p/docs/d/comment', doc(false)).verb, 'Answering a comment on');
  assert.equal(describeRequest('POST', '/api/stock/get', doc(false)).what, 'a stock file');
  assert.equal(describeRequest('POST', '/api/studio/act', doc(false)), null);
});

test('a piece of work: working while requests keep coming, finished when it has been quiet, grouped by post, with its steps counted', () => {
  let t = 1_000_000;
  const a = createActivity({ lookup: doc(true), nameOf: () => 'Little Gannet Coffee', now: () => t, quietMs: 5000 });
  assert.deepEqual(a.snapshot().working, []);
  const one = a.begin('POST', '/api/projects/lg/docs/reel/patch');
  assert.equal(a.snapshot().working.length, 1, 'a request being answered is work');
  one.end(200);
  t += 2000;
  a.begin('POST', '/api/projects/lg/docs/reel/patch').end(200);       // a second edit of the same video: the same piece of work
  let s = a.snapshot();
  assert.equal(s.working.length, 1);
  assert.deepEqual([s.working[0].verb, s.working[0].what, s.working[0].title, s.working[0].projectName, s.working[0].steps], ['Changing', 'the video', 'Likes are not the score', 'Little Gannet Coffee', 2]);
  assert.equal(s.recent.length, 0);
  t += 4000;
  assert.equal(a.snapshot().working.length, 1, '4 s of quiet is not enough');
  t += 2000;
  s = a.snapshot();
  assert.equal(s.working.length, 0, 'quiet for 6 s: finished');
  assert.deepEqual([s.recent[0].past, s.recent[0].ok, s.recent[0].steps], ['Changed', true, 2]);
  assert.ok(s.recent[0].finishedAt);
  assert.ok(s.seq >= 3, 'every change of the picture moves the counter');
});

test('different posts are different pieces of work, the verb follows what Claude does now, and a failed request ends as not ok', () => {
  let t = 5_000_000;
  const a = createActivity({ lookup: doc(false), now: () => t, quietMs: 3000 });
  a.begin('POST', '/api/projects/lg/docs/one/patch').end(200);
  a.begin('POST', '/api/projects/lg/docs/two/patch').end(200);
  assert.equal(a.snapshot().working.length, 2);
  a.begin('POST', '/api/projects/lg/checks/record').end(200, { doc: 'one' });          // the post is named in what Claude sent
  const w = a.snapshot().working.find((x) => x.doc === 'one');
  assert.deepEqual([w.verb, w.steps], ['Checking', 2], 'the check is on the same post, so it is the same piece of work');
  a.begin('POST', '/api/projects/lg/docs/two/patch').end(500);
  t += 4000;
  const s = a.snapshot();
  assert.equal(s.working.length, 0);
  assert.equal(s.recent.find((x) => x.doc === 'two').ok, false);
  assert.equal(s.recent.find((x) => x.doc === 'one').ok, true);
});

test('the list of finished work is kept short, newest first', () => {
  let t = 9_000_000;
  const a = createActivity({ lookup: doc(false), now: () => t, quietMs: 1000 });
  for (let i = 0; i < 20; i++) { a.begin('POST', `/api/projects/lg/docs/d${i}/patch`).end(200); t += 2000; }
  t += 2000;
  const s = a.snapshot();
  assert.equal(s.recent.length, 12);
  assert.equal(s.recent[0].doc, 'd19');
});

test('the route: only Claude\'s changes are noted, a read is not, and the owner\'s own clicks are not Claude\'s work', async () => {
  await studio(async ({ call }) => {
    const { posts } = await overview(call);
    const post = posts.find((p) => p.docId && p.format === 'carousel');
    assert.ok(post);
    const empty = await call('/activity');
    assert.equal(empty.status, 200);
    assert.deepEqual([empty.body.working, empty.body.recent], [[], []]);
    assert.equal((await call('/activity', 'POST', {})).status, 405);
    const ops = [{ op: 'replace', path: '/title', value: 'Renamed by Claude' }];
    const base = (await call(`/projects/${post.project}/docs/${post.docId}`)).body;            // a read: nothing noted
    assert.equal((await call('/activity')).body.working.length, 0);
    const ownerEdit = await call(`/projects/${post.project}/docs/${post.docId}/patch`, 'POST', { ops: [{ op: 'replace', path: '/title', value: 'Renamed by me' }], baseVersion: base.version ?? 0 });
    assert.ok(ownerEdit.status < 500);
    assert.equal((await call('/activity')).body.working.length, 0, 'the owner\'s edit is not Claude\'s work');
    const mine = await call(`/projects/${post.project}/docs/${post.docId}`, 'GET', undefined, AGENT);
    const claude = await call(`/projects/${post.project}/docs/${post.docId}/patch`, 'POST', { ops, baseVersion: mine.body.version ?? 0 }, AGENT);
    assert.ok(claude.status < 500, JSON.stringify(claude.body).slice(0, 200));
    const now = (await call('/activity')).body;
    assert.equal(now.working.length, 1);
    assert.deepEqual([now.working[0].verb, now.working[0].doc, now.working[0].project], ['Changing', post.docId, post.project]);
    assert.ok(now.working[0].title, 'the post has a name');
    assert.ok(now.working[0].projectName, 'and so does its brand');
  });
});
