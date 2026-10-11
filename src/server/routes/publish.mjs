// Publishing API (root scope, /api/publish/...). The Studio's Publish panel and Claude's two read tools use it.
// Who may do what: Claude's token may list adapters, describe one and make a plan (no network, nothing is sent). Everything that
// sends, saves a key or touches the outside world is the owner's: 403 for the agent token. Tokens are never in any reply.
// Words: an ACCOUNT is a login (a Buffer API key; a brand picks which one it publishes through), a CHANNEL is one place inside an
// account (an Instagram profile, a Facebook page). A brand posts to several channels; a channel belongs to one brand.
//
//   GET  /api/publish/adapters                -> { adapters:[ {
//          id, name, configured, needs:[text], note,
//          channels:[{id,name,service}]                     every channel the connected accounts offer (the owner's token: loaded live, cached 10 minutes per
//                                                           account; the agent's token: the lists saved by the last connection test, no network),
//          accounts:[{id,label,configured,lastTestedAt,lastTestOk?,channels:[{id,name,service}],error?}],
//          brands:{<project>:{account:<accountId>|null, channels:[{id,name,service,formats,enabled,offsetMinutes,hashtags}]}},
//          selected:{<project>:<first channel id>}, options:{mediaBaseUrl?, schedulingType?, saveToDraft?} } ] }
//   GET  /api/publish/platforms               -> { platforms:[{id,name,posting:false,note,configured,savedAt,keyHint}] }   Sprout Social, Hootsuite and others: a key can be saved, but Nordle does not post through them yet
//   POST /api/publish/platforms (owner) { id, token|null } -> { ok, platform }   save or forget one key (never returned)
//   GET  /api/publish/buffer-totals?project=&days=28 -> { pulledAt, days, posts, withNumbers, metrics:{views,reach,likes,...}, byService }   the brand's own totals from the Buffer pull (no calendar item needed)
//        POST sync-posts also fills metrics.json (Insights) from the pull and returns { metrics:{ matched, unmatched, entries, added, replaced } }
//   GET  /api/publish/describe?adapter=buffer -> one of those
//   POST /api/publish/plan  { adapter, uids:['<project>:<calendar item id>', ...] }   or   { adapter, project?, month:'2026-11' }
//                           optional: times:{<uid>:'2026-11-12 18:30' | 'now'}, channels:{<uid>:[channelId,...]} (only these channels, for this plan)
//                           stories:[<uid>,...] also make a Story of each of these posts on every Instagram and Facebook channel (a reel's video, else the first picture); keys end in #story
//        -> { planId, adapter, expires (ISO, 15 minutes), items:[ ONE PER POST PER CHANNEL: { uid, key ('<uid>#<channelId>', or the uid when there is
//             no channel), project, docId, title, when (UTC ISO, the calendar time plus the channel's offsetMinutes), whenLocal,
//             channel:{id,name,service}|null, channelName, account (id|null), accountLabel, caption (hashtags removed when the channel says so),
//             media:[project-relative paths in posting order], blockers:[text], blockerCodes:[code], warnings:[text], ready,
//             overridable (only the owner's per-post override stands in the way), format, status, adapter } ],
//             summary:{ ready, blocked } }   A brand with no account or no channel gets ONE blocked item (channel null) saying what to connect.
//   POST /api/publish/run   (owner) { planId, only?:[uid or key], override?:{<uid or key>:true}, times?:{<uid>:'2026-11-12 18:30'} }
//        -> { results:[ { uid, key, channel:{id,name,service}|null, ok, message, scheduledAt, remoteId } ],
//             posts:[ { uid, status:'scheduled'|'exported'|'partial'|'failed', done, total } ], stopped?, warnings? }
//        A post becomes calendar status "scheduled" only when every channel of the plan has gone; until then item.publish.targets
//        lists each channel's result, and a later run redoes only the channels that failed.
//   POST /api/publish/settings (owner) { adapter, account?, label?, token?, organizationId?, remove?, brand?, useAccount?,
//                                        channels?:{<project>:[{id,name?,service?,formats?,enabled?,offsetMinutes?,hashtags?}|id]}, mediaBaseUrl?, options? }
//        -> { ok, configured, accounts:[{id,label,configured,lastTestedAt}], brands:{...}, cleared? }   (token: null clears the key; a bare token is account "default")
//   POST /api/publish/check-scheduled (owner) {uids:[..]}  -> { ok, results:[{uid,title,status,targets:[{channel,remoteId,state,dueAt}],missing:[channel]}], requests, rate, incomplete? }
//        asks Buffer (read only) whether each scheduled post is still there; state is Buffer's own (scheduled, sent, ...) or 'missing' (deleted there)
//   POST /api/publish/unschedule (owner) {uid, channels?:[..]}  -> { ok, status, removed }   takes missing channels back so the post can be scheduled again (all channels when none are named)
//   POST /api/publish/sync-posts (owner) {project}  -> { ok, fetched, total, requests, rate, pulledAt, incomplete? }   pulls the posts the brand has sent, with results (a few requests)
//   GET  /api/publish/best-times?project=&count=  -> { ok, pulledAt, analysis, suggestions:[{iso,label,lift,n,confidence,reason}] }   when to post, from those posts (local files only)
//   GET  /api/publish/auto-schedule         -> { enabled, daysAhead, stories, recent:[{uid,title,at,ok,message}], problems:[{uid,message,tries,stopped,nextTry}], pausedUntil }
//   POST /api/publish/auto-schedule (owner) { enabled?, daysAhead? (1 to 30, default 7), stories?, now? }   the owner's standing instruction: signed-off posts whose slot is within
//        daysAhead go to Buffer on their own (src/publish/auto.mjs; off until the owner turns it on). `now:true` looks straight away and says what it did ({ran}).
//   POST /api/publish/test-hosting (owner)               -> { ok, message }   puts a small file in the owner's bucket and reads it back from the public address
//   POST /api/publish/test     (owner) { adapter, account? }  -> { ok, message, account?, channels? }   asks the adapter whether the account can connect
//                                                    (the only call besides run that reaches the outside world), and remembers the channels it sees
// Errors: { ok:false, errors:[{path,message}] } with the status.

import { loadSettings, readAllowance, resolveSettings } from '../../publish/store.mjs';
import { autoScheduleTick, autoStatus, saveAutoSettings } from '../../publish/auto.mjs';
import { checkScheduled, readSentPosts, syncSentPosts, unscheduleMissing } from '../../publish/remote.mjs';
import { analyseTimes, suggestSlots } from '../../performance/best-time.mjs';
import { listPlatforms, savePlatformKey } from '../../publish/platforms.mjs';
import { bufferTotals, importBufferMetrics } from '../../performance/from-buffer.mjs';
import { loadProject } from '../../calendar/service.mjs';
import { PublishError, buildPlan, describeAdapter, getAdapter, listAdapters, publicPlan, runPlan, saveSettingsFor, testAdapter, testHosting } from '../../publish/index.mjs';

export default {
  scope: 'root',
  key: 'publish',
  async handle(ctx) {
    const { seg, method, url, req, res, store, human, sendJson, readJsonBody, needHuman, need } = ctx;
    const sub = seg[1];
    const role = human ? 'human' : 'agent';
    try {
      if (sub === 'adapters') { need(method === 'GET', 405, 'GET only.'); return sendJson(res, 200, { adapters: await listAdapters({ live: human }) }); }
      if (sub === 'platforms') {
        // the listed platforms (Sprout Social and others): which have a key saved, never the key. POST (owner) saves or forgets one: { id, token|null }.
        if (method === 'GET') return sendJson(res, 200, { platforms: listPlatforms() });
        need(method === 'POST', 405, 'GET or POST only.');
        needHuman();
        const b = await readJsonBody(req);
        return sendJson(res, 200, { ok: true, platform: savePlatformKey(b.id, b.token === null ? null : b.token) });
      }
      if (sub === 'describe') { need(method === 'GET', 405, 'GET only.'); return sendJson(res, 200, await describeAdapter(getAdapter(url.searchParams.get('adapter') ?? ''), { live: human })); }
      if (sub === 'plan') {
        need(method === 'POST', 405, 'POST only.');
        const b = await readJsonBody(req);
        const plan = await buildPlan(store, { adapter: getAdapter(b.adapter), uids: b.uids, project: typeof b.project === 'string' ? b.project : undefined, month: b.month, times: b.times, channels: b.channels, stories: b.stories, role, via: 'studio' });
        return sendJson(res, 200, publicPlan(plan));
      }
      if (sub === 'run') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        const b = await readJsonBody(req);
        return sendJson(res, 200, await runPlan(store, { planId: b.planId, only: b.only, override: b.override, times: b.times, role, via: 'studio' }));
      }
      if (sub === 'auto-schedule') {
        if (method === 'GET') return sendJson(res, 200, { ok: true, ...autoStatus() });
        need(method === 'POST', 405, 'GET or POST only.');
        needHuman();
        const b = await readJsonBody(req);
        const saved = saveAutoSettings(b, role);
        let ran;
        if (b.now === true) ran = await autoScheduleTick(store);                // the owner asked for a look right now
        else if (saved.enabled) ctx.autoScheduler?.kick(1000);                  // just turned on (or changed): look soon
        return sendJson(res, 200, { ok: true, ...autoStatus(), ...(ran ? { ran } : {}) });
      }
      if (sub === 'settings') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        const b = await readJsonBody(req);
        return sendJson(res, 200, saveSettingsFor(b.adapter, b, role));
      }
      if (sub === 'check-scheduled') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        const b = await readJsonBody(req);
        return sendJson(res, 200, await checkScheduled(store, { uids: b.uids, role }));
      }
      if (sub === 'unschedule') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        const b = await readJsonBody(req);
        return sendJson(res, 200, await unscheduleMissing(store, { uid: b.uid, channels: b.channels, role }));
      }
      if (sub === 'sync-posts') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        const b = await readJsonBody(req);
        const synced = await syncSentPosts(store, { project: b.project, role, force: b.force === true });
        // the same pull also fills the numbers Insights reads (metrics.json), for every post that can be tied to one calendar item
        let metrics = null;
        try { const pr = store.project(String(b.project ?? '')); if (pr) metrics = await importBufferMetrics(pr.dir); } catch (e) { metrics = { ok: false, message: e.message }; }
        return sendJson(res, 200, { ...synced, ...(metrics ? { metrics } : {}) });
      }
      if (sub === 'buffer-totals') {
        // the brand's own totals for the last N days, straight from the pull (local files only)
        need(method === 'GET', 405, 'GET only.');
        const project = store.project(url.searchParams.get('project') ?? '');
        need(project, 404, 'No such project.');
        return sendJson(res, 200, { ok: true, ...bufferTotals(project.dir, { days: Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 28)) }) });
      }
      if (sub === 'best-times') {
        need(method === 'GET', 405, 'GET only.');
        const project = store.project(url.searchParams.get('project') ?? '');
        need(project, 404, 'No such project.');
        const got = readSentPosts(project.dir);
        const analysis = got.posts.length ? analyseTimes(got.posts, { timeZone: loadProject(project.dir).timezone }) : null;
        return sendJson(res, 200, { ok: true, pulledAt: got.pulledAt, allowance: readAllowance(resolveSettings(loadSettings(), 'buffer', project.id).account?.id), analysis, suggestions: analysis ? suggestSlots(analysis, { count: Math.min(8, Number(url.searchParams.get('count')) || 4) }) : [] });
      }
      if (sub === 'test-hosting') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        await readJsonBody(req);
        return sendJson(res, 200, await testHosting());
      }
      if (sub === 'test') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        const b = await readJsonBody(req);
        return sendJson(res, 200, await testAdapter(b.adapter, typeof b.account === 'string' ? b.account : undefined, role));
      }
    } catch (e) {
      if (e instanceof PublishError) return sendJson(res, e.status, { ok: false, errors: [{ path: '/', message: e.message }] });
      throw e;
    }
    return false;
  },
};
