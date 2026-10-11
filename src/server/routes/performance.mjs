// The performance loop's API: numbers in, a report out, reviews saved. All under /api/projects/<project>/performance.
// The Studio's Insights view (app/insights.js) and Claude's MCP tools (src/mcp/tools/performance.mjs) use these routes.
// Replies are JSON; errors are { ok:false, errors:[{path,message}] } with the status.
//
// WHO MAY DO WHAT (two tokens exist; see SECURITY.md)
//   - both: read everything; add numbers by hand (POST metrics); save a review (POST reviews)
//   - only the owner (human token): import a CSV (POST import), apply a recommended pillar mix (POST reviews/<period>/apply-mix)
//   Entries added with the agent token are stamped by:"claude". Claude is told to enter only numbers the owner gave it.
//
// READ
//   GET  /performance                    -> { project, brand, brandName, today, timezone, review: <due>, entries, posts, platforms:[..], windows:['7d','28d','lifetime'] }
//   GET  /performance/report?period=2026-11|2026-W45&window=7d&platform=instagram&kind=week|month&current=1
//        default period: the last complete month (kind=week: week). current=1 uses the period that holds today.
//        -> { schema:'nordle.performance-report/0.1', project, brand, brandName, today, window, platform,
//             period:{ kind, id, from, to, label },
//             counts:{ observations, scored, tooEarly, missingNumbers, history },
//             headline:{ posts, scored, medianScore, previousPeriod, previousMedianScore, previousScored, sums:{ reach, views, plays, likes, ... }, bestFormat:{key,median,n}|null },
//             posts:[ post ],  top:[ post ],  bottom:[ post ],      (top and bottom are copies of entries of posts, best/worst first)
//             segments:{ <dimension>: { label, groups:[ group ], unknown, comparable } },     the period's scored posts
//             segmentsAll:{ ... same shape ... },                                              the whole history
//               dimension ids: pillar, format, hookType, weekday, timeOfDay, face, reelLength, captionLength, music, series, occasion
//               group = { key, n, median, mean, lowBaseline, evidence:{ level:'directional'|'none'|'suggestive'|'stronger', gap?, p?, note }, posts:[item ids] }
//             gaps:[ { kind, message, posts? } ],  caveats:[ text ],
//             followUp: null | { review, savedAt, directions, recommendedMix, since:{ from, to, items, pillarShare, formatShare }, medianScoreThen, medianScoreNow },
//             markdown: '<the plain-language summary>' }
//        post = { id (calendar item id), platform, date, time, status, format, pillar, title, hook, hookType, hookRule, hasFace (true|false|null),
//                 reelLength, reelSeconds, captionLength, captionChars, music (true|false|null), series, occasion:'occasion'|'evergreen', weekday, timeOfDay,
//                 doc, window, windowWanted, capturedAt, daysAfter, mature, metrics:{ reach, plays, ... }, by:'owner'|'claude', source, note,
//                 score (0-100 or null), rank?, headline:{ label, value, median, ratio }|null,
//                 scoreBasis:{ baselineN, lowBaseline, coverage, parts:[{ id, label, mode, value, weight, n, median, pct }], reason? },
//                 thumb: 'out/...png' (project path for /api/studio/thumb?project=&path=) | null }
//   GET  /performance/metrics[?post=<item id>]   -> { items:[ entry ] }       entry = { post, platform, publishedAt?, capturedAt, window, metrics, source, by?, note? }
//   GET  /performance/reviews                    -> { due, reviews:[ { period, kind, label, from, to, savedAt, directions:[{kind:'do-more'|'stop'|'test', text, evidence?, confidence?}],
//                                                    mix:{ pillars?, formats?, note? }|null, mixApplied, by, changes, medianScore, scoredPosts } ] }
//   GET  /performance/reviews/<period>           -> { period, markdown, meta }         404 when there is none
//   GET  /performance/due[?today=YYYY-MM-DD]     -> { configured, due, period, kind, label, dueDate, reviewed, cadence, weekday, autoReview, numbers:{published,withNumbers,missing:[ids]}, message }
//   GET  /performance/prompt?period=&window=     -> { period, prompt }                 the REVIEW prompt (what the Studio copies for Claude)
//
// WRITE
//   POST /performance/metrics  { post, platform, window?:'7d', metrics:{ reach?, plays?, ... }, publishedAt?, capturedAt?, note? }      -> { ok, entry, replaced }
//        or { entries:[ ... ] } -> { ok, added, replaced, rejected:[{input,errors}] }.  A newer capture of the same post, platform and window replaces the older.
//   POST /performance/import   (owner)  { csv:'<file text>', filename?, platform?:'instagram', window?:'7d', capturedAt?, dateOrder?:'dmy'|'mdy', columns?:{ 'Header':'reach' }, account?, yes?:false }
//        -> { ok, ...report }  report = { file, platform, window, capturedAt, dryRun, columns:{ mapped:[{header,field}], unknown:[header] }, dateOrder, rows,
//             matched:[{ row, item, itemDate, title, kind:'id'|'caption'|'caption+date'|'date+caption', score, metrics, warnings? }],
//             ambiguous:[{ row, reason, candidates:[{item,date,title,kind,score}] }], unmatched:[{ row, caption, reason, sameDay? }], skipped, warnings, written:null|{added,replaced,rejected} }
//        Without yes:true nothing is written (a dry run); send the same body again with yes:true to write what matched.
//   POST /performance/reviews  { period, markdown, directions?:[{kind,text,evidence?,confidence?}], mix?:{ pillars:{id:share} }, plan?:{ ideas?:[..], amend?:[{item,set,because}] } }
//        -> { ok, review:{period,markdown,meta}, plan, warnings }   The plan goes through the calendar service as the caller's role.
//   POST /performance/reviews/<period>/apply-mix  (owner)   -> { ok, settings, applied }

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CalendarError, loadProject } from '../../calendar/service.mjs';
import { isDate } from '../../calendar/dates.mjs';
import { WINDOWS, PerformanceError, addManualMetrics, loadMetrics, readReview, upsertEntries } from '../../performance/model.mjs';
import { defaultPeriodFor, reportFor, reportMarkdown } from '../../performance/analyze.mjs';
import { importCsvText } from '../../performance/import.mjs';
import { applyMix, reviewDue, reviewHistory, saveReview } from '../../performance/review.mjs';
import { reviewPrompt } from '../../performance/prompts.mjs';
import { mediaOf } from '../../studio/data.mjs';

/** The picture to show for a post: a page, a reel's cover, or an outside post's cover (a project path), or null. */
function thumbFor(dir, post, item) {
  try {
    if (post.doc) {
      const doc = JSON.parse(readFileSync(join(dir, 'docs', `${post.doc}.json`), 'utf8'));
      const media = mediaOf({ dir }, post.doc, doc);
      return media.pages.find((p) => p.path)?.path ?? media.cover ?? null;
    }
  } catch { /* no document or no pictures */ }
  return item?.external?.cover ?? item?.external?.slides?.[0] ?? null;
}

const fail = (sendJson, res, e) => {
  const status = e.status ?? 400;
  return sendJson(res, status, { ok: false, errors: e.errors ?? [{ path: '/', message: e.message }] });
};

export default {
  scope: 'project',
  key: 'performance',
  async handle(ctx) {
    const { req, res, url, seg, method, project, human, sendJson, readJsonBody, needHuman } = ctx;
    const rest = seg.slice(3);
    const dir = project.dir;
    const q = url.searchParams;
    const role = human ? 'human' : 'agent';

    try {
      // ---- reads ----
      if (method === 'GET' && !rest.length) {
        const p = loadProject(dir);
        const m = loadMetrics(dir, p.id);
        return sendJson(res, 200, {
          project: p.id, brand: p.brand.id ?? p.id, brandName: p.brand.name ?? p.id, today: p.today, timezone: p.timezone, review: reviewDue(dir, p.today),
          entries: m.items.length, posts: new Set(m.items.map((e) => e.post)).size, platforms: [...new Set(m.items.map((e) => e.platform))].sort(), windows: WINDOWS,
        });
      }
      if (method === 'GET' && rest[0] === 'report' && rest.length === 1) {
        const p = loadProject(dir);
        const kind = q.get('kind') === 'week' ? 'week' : 'month';
        const period = q.get('period') || defaultPeriodFor(p.today, kind, q.get('current') === '1').id;
        const window = q.get('window') || '7d';
        const report = reportFor(dir, period, { window, platform: q.get('platform') || undefined });
        const byId = new Map(p.cal.items.map((i) => [i.id, i]));
        for (const r of report.posts) r.thumb = thumbFor(dir, r, byId.get(r.id));
        const thumbs = new Map(report.posts.map((r) => [`${r.id}|${r.platform}`, r.thumb]));
        for (const r of [...report.top, ...report.bottom]) r.thumb = thumbs.get(`${r.id}|${r.platform}`) ?? null;
        return sendJson(res, 200, { ...report, markdown: reportMarkdown(report) });
      }
      if (method === 'GET' && rest[0] === 'metrics' && rest.length === 1) {
        const m = loadMetrics(dir, project.id);
        const post = q.get('post');
        return sendJson(res, 200, { items: post ? m.items.filter((e) => e.post === post) : m.items });
      }
      if (method === 'GET' && rest[0] === 'reviews' && rest.length === 1) {
        const p = loadProject(dir);
        const history = await reviewHistory(dir);
        return sendJson(res, 200, { due: reviewDue(dir, p.today), reviews: history });
      }
      if (method === 'GET' && rest[0] === 'reviews' && rest.length === 2) {
        const r = readReview(dir, rest[1]);
        if (!r) return sendJson(res, 404, { ok: false, errors: [{ path: '/', message: `There is no review for ${rest[1]}.` }] });
        return sendJson(res, 200, r);
      }
      if (method === 'GET' && rest[0] === 'due') {
        return sendJson(res, 200, reviewDue(dir, isDate(q.get('today')) ? q.get('today') : undefined));
      }
      if (method === 'GET' && rest[0] === 'prompt') {
        const p = loadProject(dir);
        const period = q.get('period') || defaultPeriodFor(p.today, p.settings.review?.cadence === 'weekly' ? 'week' : 'month').id;
        return sendJson(res, 200, { period, prompt: reviewPrompt(dir, period, { window: q.get('window') || '7d' }) });
      }

      // ---- writes ----
      if (method === 'POST' && rest[0] === 'metrics' && rest.length === 1) {
        const b = await readJsonBody(req);
        if (Array.isArray(b.entries)) {
          const r = await upsertEntries(dir, b.entries.map((e) => ({ ...e, source: 'manual' })), { role });
          return sendJson(res, 200, { ok: true, added: r.added, replaced: r.replaced, rejected: r.rejected });
        }
        const r = await addManualMetrics(dir, b, { role });
        return sendJson(res, 200, { ok: true, ...r });
      }
      if (method === 'POST' && rest[0] === 'import' && rest.length === 1) {
        needHuman();
        const b = await readJsonBody(req);
        if (typeof b.csv !== 'string' || !b.csv.trim()) throw new PerformanceError(400, 'Send { "csv": "<the text of the file>" }.');
        const report = await importCsvText(dir, b.csv, {
          platform: b.platform, window: b.window, capturedAt: b.capturedAt, dateOrder: b.dateOrder, columns: b.columns && typeof b.columns === 'object' ? b.columns : undefined,
          account: b.account, yes: b.yes === true, role: 'human', filename: typeof b.filename === 'string' ? b.filename : undefined,
        });
        return sendJson(res, 200, { ok: true, ...report });
      }
      if (method === 'POST' && rest[0] === 'reviews' && rest.length === 1) {
        const b = await readJsonBody(req);
        const r = await saveReview(dir, { period: b.period, markdown: b.markdown, directions: b.directions, mix: b.mix, plan: b.plan }, { role });
        return sendJson(res, 200, { ok: true, ...r });
      }
      if (method === 'POST' && rest[0] === 'reviews' && rest.length === 3 && rest[2] === 'apply-mix') {
        needHuman();
        await readJsonBody(req);
        return sendJson(res, 200, { ok: true, ...(await applyMix(dir, rest[1])) });
      }
    } catch (e) {
      if (e instanceof PerformanceError || e instanceof CalendarError) return fail(sendJson, res, e);
      throw e;
    }
    return false;
  },
};
