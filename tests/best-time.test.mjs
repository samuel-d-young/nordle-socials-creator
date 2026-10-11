// When to post: the maths on invented posts (nothing real, nothing sent). Each post is judged against its own channel's usual result,
// small samples are labelled as such, middle-of-the-night slots need strong evidence, and the suggestions are real moments still ahead.
//   node --test tests/best-time.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyseTimes, hourLabel, localParts, suggestSlots } from '../src/performance/best-time.mjs';
import { zonedToUtc } from '../src/publish/plan.mjs';

const TZ = 'Australia/Melbourne';
const NOW = Date.parse('2026-10-06T02:00:00Z');   // Tue 6 Oct 2026, 1 pm in Melbourne

/** A post sent at a time on the Melbourne clock (daylight saving included) with the given results. */
let n = 0;
const post = (channelId, date, hhmm, reach, er) => {
  const utc = zonedToUtc(date, hhmm, TZ);
  return { id: `p${++n}`, channelId, service: 'instagram', sentAt: utc.toISOString(), dueAt: utc.toISOString(), m: { reach, engagementRate: er } };
};

test('local time: the weekday and hour are read on the brand\'s own clock, not UTC', () => {
  assert.deepEqual(localParts('2026-10-05T23:30:00Z', TZ), { dow: 1, hour: 10, minute: 30 }, '10:30 am on Tuesday in Melbourne, still Monday in UTC');
  assert.equal(hourLabel(0), '12 am');
  assert.equal(hourLabel(12), '12 pm');
  assert.equal(hourLabel(18, 30), '6:30 pm');
});

test('a slot that does better than the channel usually does scores above 1, one that does worse scores below, with the number of posts behind it', () => {
  const posts = [];
  for (let i = 1; i <= 8; i++) {
    posts.push(post('a', `2026-09-${String(i).padStart(2, '0')}`, '18:00', 300 + i, 6));   // evenings: three times the reach
    posts.push(post('a', `2026-09-${String(i + 8).padStart(2, '0')}`, '12:00', 100 + i, 2));
  }
  const a = analyseTimes(posts, { timeZone: TZ, now: NOW });
  const six = a.hour.find((h) => h.hour === 18), noon = a.hour.find((h) => h.hour === 12);
  assert.ok(six.lift > 1.2 && noon.lift < 0.8, `evening ${six.lift}, noon ${noon.lift}`);
  assert.equal(six.n, 8);
  assert.equal(six.verdict, 'better');
  assert.equal(noon.verdict, 'worse');
  assert.ok(six.lo <= six.lift && six.lift <= six.hi, 'the range holds the number');
  assert.equal(a.counts.used, 16);
});

test('each post is compared with its own channel: a channel with ten times the audience does not drown a small one', () => {
  const posts = [];
  for (let i = 1; i <= 8; i++) {
    posts.push(post('big', `2026-09-${String(i).padStart(2, '0')}`, '12:00', 10000 + i * 10, 3));    // always the same at noon
    posts.push(post('small', `2026-09-${String(i).padStart(2, '0')}`, '12:00', 100 + i, 3));
    posts.push(post('small', `2026-09-${String(i + 8).padStart(2, '0')}`, '19:00', 200 + i, 6));       // the small page does twice as well in the evening
    posts.push(post('big', `2026-09-${String(i + 8).padStart(2, '0')}`, '19:00', 10000 + i * 10, 3));
  }
  const a = analyseTimes(posts, { timeZone: TZ, now: NOW });
  const noon = a.hour.find((h) => h.hour === 12), eve = a.hour.find((h) => h.hour === 19);
  assert.ok(eve.lift > noon.lift, 'the evening still wins: the small page\'s gain is counted');
  assert.ok(noon.lift < 1 && eve.lift > 1 && eve.lift < 2, `noon ${noon.lift}, evening ${eve.lift}`);
});

test('few posts are labelled thin, and a recent post whose results have not settled is left out', () => {
  const posts = [post('a', '2026-09-01', '09:00', 500, 9), post('a', '2026-09-02', '09:00', 520, 9), post('a', '2026-09-03', '10:00', 100, 1), post('a', '2026-09-04', '10:00', 100, 1)];
  posts.push({ ...post('a', '2026-10-05', '12:00', 9999, 99), sentAt: new Date(NOW - 3 * 3600000).toISOString() });   // three hours ago
  const a = analyseTimes(posts, { timeZone: TZ, now: NOW });
  assert.equal(a.counts.used, 4);
  assert.equal(a.counts.tooNew, 1);
  assert.ok(a.hour.every((h) => h.verdict === 'thin' || h.n >= 4));
  assert.ok(a.caveats.some((c) => /Only 4 posts/.test(c)), 'it says plainly that this is a hint');
  assert.deepEqual(suggestSlots(a, { now: NOW }), [], 'with this little evidence it suggests nothing');
});

test('suggestions are real moments ahead on the brand\'s clock, rounded to the quarter hour; the middle of the night needs strong evidence', () => {
  const posts = [];
  for (let i = 1; i <= 10; i++) {
    posts.push(post('a', `2026-08-${String(i * 3 - 2).padStart(2, '0')}`, '18:10', 400 + i, 7));    // varying days; check the Thursdays below
    posts.push(post('a', `2026-08-${String(i * 3 - 1).padStart(2, '0')}`, '12:00', 100 + i, 2));
    posts.push(post('a', `2026-08-${String(i * 2).padStart(2, '0')}`, '02:00', 900 + i, 12));   // a few big posts at 2 am
  }
  const a = analyseTimes(posts, { timeZone: TZ, now: NOW });
  const slots = suggestSlots(a, { now: NOW, count: 6 });
  assert.ok(slots.length > 0, 'something is suggested');
  for (const s of slots) {
    assert.ok(Date.parse(s.iso) >= NOW + 20 * 60000, 'in the future, not within twenty minutes');
    const p = localParts(s.iso, TZ);
    assert.equal(p.minute % 15, 0, 'a quarter hour');
    assert.match(s.reason, /× a typical post, from \d+ posts/);
    assert.ok(['clear', 'likely', 'guess'].includes(s.confidence));
  }
  assert.deepEqual(slots.map((s) => s.iso), [...slots.map((s) => s.iso)].sort(), 'soonest first');
  const night = slots.filter((s) => localParts(s.iso, TZ).hour < 6);
  assert.ok(night.every((s) => s.confidence === 'clear'), 'a 2 am slot is only offered on clear evidence');
});

test('no posts at all is an empty answer, not an error', () => {
  const a = analyseTimes([], { timeZone: TZ, now: NOW });
  assert.equal(a.counts.used, 0);
  assert.deepEqual(a.combos, []);
  assert.deepEqual(suggestSlots(a, { now: NOW }), []);
  assert.deepEqual(suggestSlots(null), []);
});
