// Buffer's sent posts -> Nordle's numbers (src/performance/from-buffer.mjs), the listed platforms (src/publish/platforms.mjs), and the
// "edited after its video was made" check (src/studio/data.mjs videoOutdated). Fictional brand, made-up numbers, no network.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../tools/validate.mjs';
import { newCalendar, saveCalendar } from '../src/calendar/model.mjs';
import { bufferTotals, importBufferMetrics, mapNumbers, matchPosts } from '../src/performance/from-buffer.mjs';
import { loadMetrics } from '../src/performance/model.mjs';
import { PLATFORMS, listPlatforms, savePlatformKey } from '../src/publish/platforms.mjs';
import { loadSettings, waitWords } from '../src/publish/store.mjs';
import { videoOutdated } from '../src/studio/data.mjs';

const work = mkdtempSync(join(tmpdir(), 'nordle-buffer-insights-'));
process.env.NORDLE_PUBLISH_DIR = join(work, 'settings');
mkdirSync(process.env.NORDLE_PUBLISH_DIR, { recursive: true });
after(() => rmSync(work, { recursive: true, force: true }));

let n = 0;
function brand(items, posts) {
  const dir = join(work, `brand-${++n}`);
  cpSync(join(ROOT, 'samples', 'little-gannet'), dir, { recursive: true, filter: (s) => !/[\\/](out|sources)([\\/]|$)/.test(s) });
  saveCalendar(dir, { ...newCalendar('little-gannet'), timezone: 'Australia/Melbourne', items });
  mkdirSync(join(dir, 'performance'), { recursive: true });
  writeFileSync(join(dir, 'performance', 'buffer-posts.json'), JSON.stringify({ schema: 'nordle.bufferposts/0.1', pulledAt: '2026-10-10T00:00:00.000Z', posts }));
  return dir;
}
const item = (o) => ({ status: 'posted', pillar: 'drinks', idea: 'x', format: 'reel', title: `Post ${o.id}`, ...o, ...(o.publish ? { publish: { adapter: 'buffer', at: '2026-10-01T00:00:00.000Z', ...o.publish, targets: o.publish.targets.map((t) => ({ ok: true, ...t })) } } : {}) });
const sent = (o) => ({ channelId: 'c1', service: 'instagram', status: 'sent', metricsUpdatedAt: '2026-10-09T01:00:00.000Z', ...o });

test('Buffer numbers are renamed to Nordle\'s, and a ratio is never copied', () => {
  assert.deepEqual(mapNumbers({ reactions: 4, comments: 1, shares: 2, saves: 3, follows: 0, views: 120, reach: 90, engagementRate: 0.07 }),
    { likes: 4, comments: 1, shares: 2, saves: 3, follows: 0, views: 120, reach: 90 });
  assert.deepEqual(mapNumbers({}), {});
  assert.deepEqual(mapNumbers({ reach: -1, views: 'x' }), {}, 'a negative or non-number is dropped');
});

test('a sent post is tied to its calendar item by the id Buffer gave, else only by a unique time that day; stories are left out', () => {
  const items = [
    item({ id: 'a', date: '2026-10-05', time: '18:00', publish: { targets: [{ channel: 'c1', remoteId: 'bp-1' }, { channel: 'c1#story', remoteId: 'bp-story' }] } }),
    item({ id: 'b', date: '2026-10-06', time: '09:00' }),
    item({ id: 'c', date: '2026-10-07', time: '09:00' }),
    item({ id: 'd', date: '2026-10-07', time: '09:10' }),
  ];
  const posts = [
    sent({ id: 'bp-1', dueAt: '2026-10-05T07:00:00.000Z' }),
    sent({ id: 'bp-story', dueAt: '2026-10-05T07:00:00.000Z' }),
    sent({ id: 'bp-time', dueAt: '2026-10-05T22:00:00.000Z' }),   // 09:00 on 6 Oct in Melbourne: only item b is there
    sent({ id: 'bp-two', dueAt: '2026-10-06T22:02:00.000Z' }),    // 09:02 on 7 Oct: items c AND d are within 30 minutes, so it is not guessed
    sent({ id: 'bp-none', dueAt: '2026-10-08T03:00:00.000Z' }),
  ];
  const r = matchPosts(posts, items, 'Australia/Melbourne');
  assert.equal(r.matched.get('bp-1'), 'a');
  assert.equal(r.matched.get('bp-time'), 'b');
  assert.equal(r.matched.has('bp-two'), false);
  assert.equal(r.matched.has('bp-none'), false);
  assert.equal(r.matched.has('bp-story'), false);
  assert.equal(r.unmatched, 2);
  assert.equal(r.skippedStories, 1);
});

test('importing writes one lifetime entry per post and platform, skips all-zero results, and can run twice', async () => {
  const dir = brand([item({ id: 'a', date: '2026-10-05', time: '18:00', publish: { targets: [{ channel: 'c1', remoteId: 'bp-1' }, { channel: 'c2', remoteId: 'bp-2' }, { channel: 'c3', remoteId: 'bp-3' }] } }),
    item({ id: 'z', date: '2026-10-06', time: '09:00', publish: { targets: [{ channel: 'c1', remoteId: 'bp-zero' }] } })], [
    sent({ id: 'bp-1', channelId: 'c1', dueAt: '2026-10-05T07:00:00.000Z', sentAt: '2026-10-05T07:01:00.000Z', m: { views: 100, reach: 60, reactions: 5 } }),
    sent({ id: 'bp-2', channelId: 'c2', service: 'instagram', dueAt: '2026-10-05T07:00:00.000Z', m: { views: 300, reach: 200, reactions: 9 } }),   // a second Instagram channel: the bigger one stands for the post
    sent({ id: 'bp-3', channelId: 'c3', service: 'facebook', dueAt: '2026-10-05T07:00:00.000Z', m: { views: 40, reach: 30 } }),
    sent({ id: 'bp-zero', dueAt: '2026-10-06T22:00:00.000Z', m: { views: 0, reach: 0, reactions: 0 } }),
  ]);
  const r = await importBufferMetrics(dir, { today: '2026-10-10' });
  assert.equal(r.ok, true);
  assert.equal(r.withNumbers, 3, 'the all-zero post is not a measurement');
  assert.equal(r.entries, 2);
  const items = loadMetrics(dir).items;
  assert.deepEqual(items.map((e) => `${e.post}|${e.platform}|${e.window}|${e.source}`).sort(), ['a|facebook|lifetime|buffer', 'a|instagram|lifetime|buffer']);
  assert.equal(items.find((e) => e.platform === 'instagram').metrics.views, 300);
  const again = await importBufferMetrics(dir, { today: '2026-10-11' });
  assert.equal(again.added, 0);
  assert.equal(again.replaced, 2);
  assert.equal(loadMetrics(dir).items.length, 2);
});

test('totals come straight from the pull for the last N days, with no calendar item needed', () => {
  const dir = brand([], [
    sent({ id: '1', dueAt: '2026-10-09T01:00:00.000Z', sentAt: '2026-10-09T01:00:00.000Z', m: { views: 100, reach: 50, reactions: 4 } }),
    sent({ id: '2', service: 'facebook', dueAt: '2026-10-08T01:00:00.000Z', sentAt: '2026-10-08T01:00:00.000Z', m: { views: 20, reach: 10 } }),
    sent({ id: '3', dueAt: '2026-10-07T01:00:00.000Z', sentAt: '2026-10-07T01:00:00.000Z', m: {} }),
    sent({ id: '4', dueAt: '2026-06-01T01:00:00.000Z', sentAt: '2026-06-01T01:00:00.000Z', m: { views: 999 } }),
  ]);
  const t = bufferTotals(dir, { days: 28, now: Date.parse('2026-10-10T00:00:00.000Z') });
  assert.equal(t.posts, 3, 'the June post is outside 28 days');
  assert.equal(t.withNumbers, 2);
  assert.equal(t.metrics.views, 120);
  assert.equal(t.metrics.likes, 4);
  assert.equal(t.byService.instagram.posts, 2);
  assert.equal(t.byService.facebook.metrics.reach, 10);
  assert.equal(t.hasPull, true);
});

test('listed platforms: a key is saved, never returned, can be replaced and forgotten; a bad one is refused', () => {
  assert.ok(PLATFORMS.length >= 5 && PLATFORMS.every((p) => p.posting === false), 'listed, and honest that none can post yet');
  assert.ok(PLATFORMS.some((p) => p.id === 'sprout'));
  assert.equal(listPlatforms().every((p) => !p.configured), true);
  assert.throws(() => savePlatformKey('sprout', 'short'), /does not look like an API key/);
  assert.throws(() => savePlatformKey('nope', 'abcdefghijkl'), /no listed platform/);
  const saved = savePlatformKey('sprout', 'sk_live_abcdef123456');
  assert.equal(saved.configured, true);
  assert.equal(saved.keyHint, '3456');
  assert.equal(JSON.stringify(listPlatforms()).includes('abcdef123456'), false, 'the key is never in what the window is told');
  assert.equal(loadSettings().platforms.sprout.token, 'sk_live_abcdef123456', 'it is kept in the private settings file');
  assert.equal(savePlatformKey('sprout', null).configured, false);
  assert.equal(loadSettings().platforms?.sprout, undefined);
});

test('a wait is said in hours and minutes, never seconds (1583 seconds is 27 minutes)', () => {
  assert.equal(waitWords(1583), '27 minutes');
  assert.equal(waitWords(60), '1 minute');
  assert.equal(waitWords(3600), '1 hour');
  assert.equal(waitWords(3900), '1 hour 5 minutes');
  assert.equal(waitWords(7320), '2 hours 2 minutes');
  assert.equal(waitWords(5), '1 minute', 'less than a minute rounds up to one');
});

test('a reel is out of date only when something other than its words changed after the video was made', () => {
  const dir = join(work, 'outdated');
  mkdirSync(join(dir, 'history'), { recursive: true });
  mkdirSync(join(dir, 'out'), { recursive: true });
  const video = join(dir, 'out', 'r.mp4');
  writeFileSync(video, 'x');
  utimesSync(video, new Date('2026-10-08T00:00:00Z'), new Date('2026-10-08T00:00:00Z'));
  const log = (...entries) => writeFileSync(join(dir, 'history', 'r.jsonl'), `${entries.map((e) => JSON.stringify(e)).join('\n')}\n`);
  const project = { dir };
  log({ v: 1, ts: '2026-10-07T00:00:00Z', ops: [{ op: 'replace', path: '/tracks/0/clips/0/in', value: 2 }] });
  assert.equal(videoOutdated(project, 'r', 'out/r.mp4'), false, 'an edit before the video was made');
  log({ v: 1, ts: '2026-10-09T00:00:00Z', ops: [{ op: 'replace', path: '/copy/caption', value: 'new words' }, { op: 'replace', path: '/title', value: 't' }] });
  assert.equal(videoOutdated(project, 'r', 'out/r.mp4'), false, 'only the words changed');
  log({ v: 1, ts: '2026-10-09T00:00:00Z', ops: [{ op: 'replace', path: '/tracks/0/clips/0/in', value: 3 }] });
  assert.equal(videoOutdated(project, 'r', 'out/r.mp4'), true, 'the picture changed after the video');
  assert.equal(videoOutdated(project, 'missing', 'out/r.mp4'), false, 'no history, nothing to say');
});
