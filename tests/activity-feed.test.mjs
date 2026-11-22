// The Claude box's outside sources: the shared feed file, calendar changes in words, `nordle` commands, media replaced on disk, the job line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeItemChange, noteCalendarChange, noteDone, readFeed, requestScope, startWork, trimFeed } from '../src/activity/feed.mjs';
import { describeCli } from '../src/activity/cli.mjs';
import { mediaChange, watchMedia } from '../src/activity/watch.mjs';
import { createActivity } from '../src/server/activity.mjs';
import { createActivitySources } from '../src/server/activity-sources.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'nordle-feed-'));
const withFeed = (fn) => {
  const dir = tmp();
  const file = join(dir, 'feed.jsonl');
  const old = process.env.NORDLE_ACTIVITY_FEED;
  process.env.NORDLE_ACTIVITY_FEED = file;
  try { return fn(file, dir); } finally { if (old === undefined) delete process.env.NORDLE_ACTIVITY_FEED; else process.env.NORDLE_ACTIVITY_FEED = old; rmSync(dir, { recursive: true, force: true }); }
};

test('feed: off inside node --test unless a file is named', () => {
  const old = process.env.NORDLE_ACTIVITY_FEED;
  delete process.env.NORDLE_ACTIVITY_FEED;
  try { assert.equal(noteDone({ project: 'x', verb: 'a', past: 'b', what: 'c' }), false); } finally { if (old !== undefined) process.env.NORDLE_ACTIVITY_FEED = old; }
});

test('feed: a start is working until its end, then recent; a dead process without an end did not finish', () => withFeed((file) => {
  const w = startWork({ project: 'gannet', item: 'reel-1', title: 'Reel one', kind: 'render', verb: 'Rendering', past: 'Rendered', what: 'the video' });
  let f = readFeed({ file });
  assert.equal(f.working.length, 1);
  assert.equal(f.working[0].title, 'Reel one');
  assert.equal(f.working[0].verb, 'Rendering');
  w.end(true);
  f = readFeed({ file });
  assert.equal(f.working.length, 0);
  assert.equal(f.recent[0].past, 'Rendered');
  assert.equal(f.recent[0].ok, true);
  appendFileSync(file, `${JSON.stringify({ id: 'fdead', pid: 999999, at: new Date().toISOString(), ev: 'start', project: 'gannet', verb: 'Building', past: 'Built', what: 'the video' })}\n`);
  f = readFeed({ file, isAlive: () => false });
  assert.equal(f.working.length, 0);
  assert.equal(f.recent.find((x) => x.id === 'fdead').ok, false);
}));

test('feed: bad lines are skipped and ids that are not ids are dropped', () => withFeed((file) => {
  writeFileSync(file, 'not json\n{"nope":1}\n');
  noteDone({ project: '../etc', item: 'ok-item', verb: 'Changing', past: 'Changed', what: 'the post' });
  const f = readFeed({ file });
  assert.equal(f.recent.length, 1);
  assert.equal(f.recent[0].project, '');
  assert.equal(f.recent[0].item, 'ok-item');
}));

test('feed: trimming keeps the newest lines', () => withFeed((file) => {
  const big = `${JSON.stringify({ id: 'fx', pid: 1, at: '2026-01-01T00:00:00Z', ev: 'once', verb: 'a', past: 'b', what: 'c'.repeat(200) })}\n`;
  writeFileSync(file, big.repeat(6000));
  noteDone({ project: 'gannet', verb: 'Changing', past: 'Changed', what: 'the last one' });
  assert.equal(trimFeed({ file }), true);
  assert.equal(readFeed({ file }).recent[0].what, 'the last one');
}));

test('calendar changes in words', () => {
  const b = { id: 'a', title: 'A', date: '2026-11-22', time: '18:00', status: 'built', external: { caption: 'one' } };
  assert.equal(describeItemChange(b, { ...b, status: 'scheduled', publish: {} }).past, 'Scheduled');
  assert.equal(describeItemChange({ ...b, status: 'scheduled' }, { ...b, status: 'signed-off' }).past, 'Unscheduled');
  const moved = describeItemChange(b, { ...b, date: '2026-12-20' });
  assert.equal(moved.past, 'Moved');
  assert.match(moved.what, /Sun 20 Dec, 18:00/);
  assert.equal(describeItemChange(b, { ...b, external: { caption: 'two' } }).past, 'Changed the caption of');
  assert.equal(describeItemChange(b, { ...b, updated: 'now', build: { step: 2 } }), null);
  assert.equal(describeItemChange(null, b).past, 'Added');
  assert.equal(describeItemChange(b, null).past, 'Took off');
});

test('calendar: noted from scripts and automatic work, not from the owner\'s clicks or Claude\'s own requests', () => withFeed((file, dir) => {
  const pdir = join(dir, 'gannet');
  const before = { items: [{ id: 'a', title: 'A', date: '2026-11-22', time: '18:00', status: 'built' }] };
  const after = { items: [{ id: 'a', title: 'A', date: '2026-11-22', time: '18:00', status: 'signed-off' }] };
  assert.equal(requestScope.run({ role: 'human' }, () => noteCalendarChange(pdir, before, after)), 0);
  assert.equal(requestScope.run({ role: 'agent' }, () => noteCalendarChange(pdir, before, after)), 0);
  assert.equal(noteCalendarChange(pdir, JSON.stringify(before), after), 1);
  const r = readFeed({ file }).recent[0];
  assert.equal(r.project, 'gannet');
  assert.equal(r.item, 'a');
  assert.equal(r.past, 'Signed off');
  // a big batch is one line
  const many = (s) => ({ items: Array.from({ length: 9 }, (_, i) => ({ id: `i${i}`, title: `T${i}`, date: '2026-11-22', status: s })) });
  assert.equal(noteCalendarChange(pdir, many('built'), many('signed-off')), 1);
  assert.match(readFeed({ file }).recent[0].what, /9 posts/);
}));

test('nordle commands: what they do, and read-only ones say nothing', () => {
  assert.equal(describeCli('doctor', []), null);
  assert.equal(describeCli('publish', ['plan', 'buffer', 'gannet:reel-1']), null);
  const run = describeCli('publish', ['run', 'buffer', 'gannet:reel-1', '--yes'], { root: tmp() });
  assert.equal(run.project, 'gannet');
  assert.equal(run.item, 'reel-1');
  assert.equal(run.kind, 'publish');
  const reel = describeCli('reel', ['projects/gannet', 'projects/gannet/specs/reel-2.json', '--render'], { root: tmp() });
  assert.equal(reel.verb, 'Rendering');
  assert.equal(reel.what, 'the video');
  assert.equal(reel.project, 'gannet');
  assert.equal(reel.doc, 'reel-2');
});

test('media changes: only a post\'s own finished files', () => {
  assert.deepEqual(mediaChange('gannet/external/reel-1/reel.mp4'), { project: 'gannet', area: 'external', id: 'reel-1', video: true });
  assert.equal(mediaChange('gannet/out/doc-1/cover.jpg').video, false);
  assert.equal(mediaChange('gannet/external/reel-1/reel.mp4.steady.mp4'), null);
  assert.equal(mediaChange('gannet/external/reel-1/reel.pre-wb.mp4'), null);
  assert.equal(mediaChange('gannet/assets/x/reel.mp4'), null);
  assert.equal(mediaChange('gannet/calendar.json'), null);
});

test('media changes: reading a file is not a change, writing one is', () => {
  const now = 10_000_000;
  let event = null;
  let stat = null;
  const seen = [];
  const w = watchMedia(['root'], (c) => seen.push(c), {
    now: () => now,
    statFn: () => { if (!stat) throw new Error('ENOENT'); return stat; },
    watchFn: (_root, _o, cb) => { event = () => cb('change', 'gannet/out/doc-1/cover.png'); return { on() {}, close() {} }; },
  });
  stat = { mtimeMs: now - 3600000, ctimeMs: now - 3600000, atimeMs: now };
  event();
  assert.equal(seen.length, 0, 'only read');
  stat = null;
  event();
  assert.equal(seen.length, 0, 'already gone');
  stat = { mtimeMs: now - 500, ctimeMs: now - 500, atimeMs: now };
  event();
  assert.equal(seen.length, 1, 'written');
  stat = { mtimeMs: now - 3600000, ctimeMs: now - 500, atimeMs: now };
  event();
  assert.equal(seen.length, 2, 'an older file copied or renamed into place');
  w.close();
});

test('sources: a media change on disk shows with the post\'s title; the owner\'s own upload does not', () => {
  const dir = tmp();
  try {
    const pdir = join(dir, 'gannet');
    mkdirSync(pdir, { recursive: true });
    writeFileSync(join(pdir, 'calendar.json'), JSON.stringify({ items: [{ id: 'reel-1', title: 'Reel one' }] }));
    const store = { roots: [dir], scan: () => [], project: (p) => (p === 'gannet' ? { dir: pdir, doc: () => null } : null) };
    let fire = null;
    let t = 1_000_000;
    const activity = createActivity({ now: () => t, quietMs: 7000, extra: () => sources.extra() });
    const sources = createActivitySources({ store, activity, watch: true, now: () => t, watchFn: (_roots, cb) => { fire = cb; return { close() {} }; } });
    fire({ project: 'gannet', area: 'external', id: 'reel-1', video: true });
    let s = activity.snapshot();
    assert.equal(s.working.length, 1);
    assert.equal(s.working[0].title, 'Reel one');
    assert.equal(s.working[0].what, 'the video');
    assert.equal(s.working[0].source, 'outside');
    t += 8000;
    s = activity.snapshot();
    assert.equal(s.working.length, 0);
    assert.equal(s.recent[0].past, 'Changed');
    sources.noteHuman('gannet');
    fire({ project: 'gannet', area: 'external', id: 'reel-1', video: true });
    assert.equal(activity.snapshot().working.length, 0);
    sources.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('sources: the feed is merged into the box, newest first', () => withFeed((file) => {
  const store = { roots: [], scan: () => [], project: () => null };
  const activity = createActivity({ extra: () => sources.extra() });
  const sources = createActivitySources({ store, activity, feedFile: file });
  noteDone({ project: 'gannet', item: 'reel-1', title: 'Reel one', verb: 'Changing', past: 'Changed the caption of', what: 'the post' });
  const s = activity.snapshot();
  assert.equal(s.recent[0].past, 'Changed the caption of');
  assert.equal(s.recent[0].title, 'Reel one');
}));
