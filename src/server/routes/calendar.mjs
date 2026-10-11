// The content calendar's API. The Studio (and Claude, through the MCP tools in src/mcp/tools/calendar.mjs) use these routes;
// all of them are under /api/projects/<project>/calendar. Every write goes through src/calendar/service.mjs, which validates
// the whole calendar and saves it atomically. Replies are JSON; errors are { ok:false, errors:[{path,message}] } with the status.
//
// WHO MAY DO WHAT. Two tokens exist: the owner's ("human", only in the served page) and Claude's ("agent").
//   - The agent can read everything, add ideas (they arrive as status "idea", or "approved" with ideaApproval "delegated" when
//     the owner has set settings.ideaApproval to "delegated"), edit an idea's fields, and link a finished post to an item.
//   - Only the human can approve, unapprove, reject, sign off, ask for changes, mark posted, change the settings, or override
//     the idea checks. A PATCH that sets such a status with the agent token is a 403 (needHuman).
//
// READ
//   GET  /calendar?from=YYYY-MM-DD&to=YYYY-MM-DD       (default: this month through the planning horizon)
//        -> { project, brand, brandName, today, timezone, range:{from,to},
//             calendar:{ schema, brand, timezone?, settings?, items:[item] },
//             effective:{ leadDays, perMonth:{reel,carousel,post,story}, autoBuild, autoPropose, horizonMonths, postTimes, pillars,
//                         regions, ideaApproval, compliance, maxBuildAttempts },
//             months:[ { month, quota, quotaTotal, total, counts, byStatus, missing, missingTotal, over, ok,
//                        pillars:[{id,name,share,target,actual,drift,state}], unassigned } ],
//             occasions:[ { id, occasion, name, date, end, kind, regions, tags, relevance, confidence, verify, advice, runUpDays, note?, caution?, source? } ],
//             lint:{ <item id>: { ok, errors:[{rule,level,message}], warnings:[...] } },     (open items only)
//             due:[ { id, mode:'build'|'revise', date } ],
//             running: null | { item, mode, since } }
//        item = { id, date, time?, format, title, pillar?, idea?, hook?, audience?, occasion?, mediaPlan?, status, origin?,
//                 ideaApproval?, doc?, external?, notes?, feedback?:[{at,by,comment,resolved?}], run?:{attempts,state,lastError?,...}, updated? }
//   GET  /calendar/due               -> { today, leadDays, autoBuild, due:[ { mode, item } ] }
//   GET  /calendar/slots?month=YYYY-MM -> { month, quota, need, slots:[ { date, time, format } ] }
//   GET  /calendar/occasions?from=&to=&regions=VIC,WA&tags=dental&minRelevance=medium -> { occasions:[...] }
//   GET  /calendar/prompt?kind=propose&month=2026-11,2026-12  or  ?kind=build&item=<id>[&revise=1] -> { kind, prompt }
//
// WRITE
//   POST /calendar/propose  { ideas:[ {date,time?,format,title,pillar?,idea,hook,audience?,occasion?,mediaPlan?} ] }
//        -> { ok:true, added:[item], rejected:[ { input, errors:[{rule,message}], warnings } ], warnings:{ <id>:[...] }, months:[report] }
//        Agent ideas are checked strictly (repeats, banned phrases, past dates, quota, pillars, health-advertising words).
//   POST /calendar/items    one item {...fields}, or { items:[...] }  -> 201 { ok:true, item|items, warnings, months }
//        The owner's items start approved (status "idea" if asked) and their check problems are warnings; the agent's start as ideas.
//        A single item that fails the checks is 422 { ok:false, errors, rejected }.
//   PATCH /calendar/items/:id  { date?, time?, format?, title?, pillar?, idea?, hook?, audience?, occasion?, mediaPlan?, notes?,
//                                status? (owner only), comment? }   (null clears a field)  -> { ok:true, item, lint }
//        POST to the same URL does the same (the server's method filter currently passes only GET/HEAD/POST/DELETE).
//        When Claude edits what an owner-approved idea says, the idea returns to "idea" so the owner approves it again.
//   POST /calendar/items/:id/approve | unapprove | reject | signoff | posted   (owner)       { comment? }          -> { ok:true, item }
//   POST /calendar/items/:id/changes (owner)  { comment }   sends a built post back; the comment is kept in item.feedback
//   POST /calendar/items/:id/link    (agent or owner) { doc }  marks the item built and points it at docs/<doc>.json
//   POST /calendar/approve-all       (owner) { month? }        approves every idea (in the month)
//   POST /calendar/settings          (owner) { leadDays?, perMonth?, autoBuild?, autoPropose?, horizonMonths?, postTimes?, pillars?,
//                                              regions?, ideaApproval?, compliance?, maxBuildAttempts?, timezone? }  null removes one
//        -> { ok:true, settings, timezone }

import { ACTIONS, CalendarError, addItems, approveAll, decide, linkDoc, loadProject, overview, runnableItems, setSettings, updateItem } from '../../calendar/service.mjs';
import { needFor, monthCounts, quotaOf, spreadSlots } from '../../calendar/plan.mjs';
import { isDate, isMonth } from '../../calendar/dates.mjs';
import { occasionsBetween } from '../../calendar/occasions.mjs';
import { buildPrompt, proposePrompt } from '../../calendar/prompts.mjs';

const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);

export default {
  scope: 'project',
  key: 'calendar',
  async handle(ctx) {
    const { req, res, url, seg, method, project, human, sendJson, readJsonBody, needHuman, HttpError } = ctx;
    const rest = seg.slice(3);
    const dir = project.dir;
    const q = url.searchParams;
    const role = human ? 'human' : 'agent';
    const itemsOf = (r) => r.added;

    try {
      // ---- reads ----
      if (method === 'GET' && !rest.length) {
        const o = overview(dir, { from: q.get('from') ?? undefined, to: q.get('to') ?? undefined, today: isDate(q.get('today')) ? q.get('today') : undefined });
        return sendJson(res, 200, o);
      }
      if (method === 'GET' && rest[0] === 'due') {
        const p = loadProject(dir);
        const day = isDate(q.get('today')) ? q.get('today') : p.today;
        return sendJson(res, 200, { today: day, leadDays: p.settings.leadDays, autoBuild: p.settings.autoBuild, due: runnableItems(p.cal, day).map(({ item, mode }) => ({ mode, item })) });
      }
      if (method === 'GET' && rest[0] === 'slots') {
        const p = loadProject(dir);
        const month = q.get('month') ?? p.today.slice(0, 7);
        if (!isMonth(month)) throw new CalendarError(400, 'month must look like 2026-11');
        const quota = quotaOf(p.cal);
        return sendJson(res, 200, { month, quota, need: needFor(quota, monthCounts(p.cal.items, month).counts), slots: spreadSlots(month, { perMonth: quota, postTimes: p.settings.postTimes, existing: p.cal.items }) });
      }
      if (method === 'GET' && rest[0] === 'occasions') {
        const p = loadProject(dir);
        const from = q.get('from') ?? `${p.today.slice(0, 7)}-01`;
        const to = q.get('to') ?? `${p.today.slice(0, 4)}-12-31`;
        if (!isDate(from) || !isDate(to)) throw new CalendarError(400, 'from and to must be dates (YYYY-MM-DD)');
        const regions = list(q.get('regions')) ?? (p.settings.regions.length ? p.settings.regions : undefined);
        return sendJson(res, 200, { occasions: occasionsBetween(from, to, { regions, tags: list(q.get('tags')), minRelevance: q.get('minRelevance') ?? undefined }) });
      }
      if (method === 'GET' && rest[0] === 'prompt') {
        const kind = q.get('kind') ?? (q.get('item') ? 'build' : 'propose');
        if (kind === 'build') {
          if (!q.get('item')) throw new CalendarError(400, 'Say which item (?item=<id>).');
          return sendJson(res, 200, { kind, prompt: buildPrompt(dir, q.get('item'), { mode: q.get('revise') ? 'revise' : undefined }) });
        }
        if (kind !== 'propose') throw new CalendarError(400, 'kind is propose or build');
        return sendJson(res, 200, { kind, prompt: proposePrompt(dir, { months: list(q.get('month')) }) });
      }

      // ---- writes ----
      if (method === 'POST' && rest[0] === 'propose' && rest.length === 1) {
        const b = await readJsonBody(req);
        if (!Array.isArray(b.ideas)) throw new CalendarError(400, 'Send { "ideas": [ ... ] }.');
        const r = await addItems(dir, b.ideas, { role, today: undefined });
        return sendJson(res, 200, { ok: true, ...r });
      }
      if (method === 'POST' && rest[0] === 'items' && rest.length === 1) {
        const b = await readJsonBody(req);
        const many = Array.isArray(b.items);
        const r = await addItems(dir, many ? b.items : [b], { role });
        if (!many && !r.added.length) return sendJson(res, 422, { ok: false, errors: r.rejected[0].errors.map((e) => ({ path: e.path ?? '/', message: e.message })), rejected: r.rejected });
        return sendJson(res, 201, { ok: true, ...(many ? { items: itemsOf(r) } : { item: r.added[0] }), warnings: r.warnings, rejected: r.rejected, months: r.months });
      }
      if (['PATCH', 'POST'].includes(method) && rest[0] === 'items' && rest.length === 2) {
        const b = await readJsonBody(req);
        // updateItem refuses (403) an agent that tries to move the item along the owner's steps
        const r = await updateItem(dir, rest[1], b, { role });
        return sendJson(res, 200, { ok: true, item: r.item, lint: r.lint });
      }
      if (method === 'POST' && rest[0] === 'items' && rest.length === 3) {
        const b = await readJsonBody(req);
        const id = rest[1], action = rest[2];
        if (action === 'link') {
          if (typeof b.doc !== 'string') throw new CalendarError(400, 'Send { "doc": "<document id>" }.');
          return sendJson(res, 200, { ok: true, ...(await linkDoc(dir, id, b.doc, { role })) });
        }
        if (!ACTIONS.includes(action)) throw new HttpError(404, 'Unknown calendar action.');
        needHuman();
        return sendJson(res, 200, { ok: true, ...(await decide(dir, id, action, { comment: b.comment })) });
      }
      if (method === 'POST' && rest[0] === 'approve-all') {
        needHuman();
        const b = await readJsonBody(req);
        const r = await approveAll(dir, { month: isMonth(b.month) ? b.month : undefined });
        return sendJson(res, 200, { ok: true, items: r.items });
      }
      if (method === 'POST' && rest[0] === 'settings') {
        needHuman();
        const b = await readJsonBody(req);
        return sendJson(res, 200, { ok: true, ...(await setSettings(dir, b)) });
      }
    } catch (e) {
      if (e instanceof CalendarError) return sendJson(res, e.status, { ok: false, errors: e.errors });
      throw e;
    }
    return false;
  },
};
