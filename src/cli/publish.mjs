// node nordle.mjs publish <command> ...   hand finished posts to an export folder or to Buffer. See docs/PUBLISHING.md.
// Only the owner schedules: `run` and `settings` need the owner's own machine (they are refused when NORDLE_AGENT_RUN=1, which is
// set inside Claude's headless runs), and `run` also needs --yes. `adapters` and `plan` are read-only previews.
// Words: an ACCOUNT is a login (a Buffer API key; each brand picks the account it publishes through); a CHANNEL is one place inside an
// account (an Instagram profile, a Facebook page). A brand can post to several channels.

import { readFileSync } from 'node:fs';
import { Store } from '../server/store.mjs';
import { projectRoots, resolveProject } from '../calendar/service.mjs';
import { PublishError, buildPlan, describeAdapter, getAdapter, listAdapters, publicPlan, runPlan, saveSettingsFor, testAdapter } from '../publish/index.mjs';
import { readAudit } from '../publish/store.mjs';
import { checkScheduled, readSentPosts, syncSentPosts } from '../publish/remote.mjs';
import { describeSync, planSync, runSync } from '../publish/sync.mjs';
import { importBufferMetrics } from '../performance/from-buffer.mjs';
import { analyseTimes, suggestSlots } from '../performance/best-time.mjs';
import { loadProject } from '../calendar/service.mjs';

const out = (s = '') => console.log(s);
const err = (s) => console.error(s);

const USAGE = `publish <command> ...

  adapters                                     what is connected: accounts, each brand's account and channels
  plan <adapter> <uid>...                      what would go out, to which channel, when, and what blocks it. uid = <project>:<calendar item id>
  plan <adapter> --project <id> --month YYYY-MM    every calendar item of a month (omit --project for all projects)
        --time <uid>=2026-11-12T18:30          a different time for one post (the brand's own time) [repeatable]
        --only-channels <uid>=<id>+<id>        leave the other channels out of this plan [repeatable]       --json
  run <planId> --yes [--only uid|uid#channel,...] [--override uid,...] [--time <uid>=...]    schedule what the plan says is ready (owner only)
  run <adapter> <uid>... | --project <id> --month YYYY-MM --yes     plan and run in one go
  settings <adapter> [--account <id>] [--label "Name"] [--token-stdin | --clear-token] [--organization <id>]     a login (without --account: "default")
                     [--remove-account <id>]                                    delete a login nothing uses
                     [--brand <project> --use-account <id|none>]                which login a brand publishes through
                     [--channel <project>=<channel id>[,formats=reel+post][,offset=15][,hashtags=strip][,enabled=off][,name=..]]...   a brand's channels (repeat per channel)
                     [--channel <project>=none]                                 remove all of a brand's channels
                     [--media-base-url https://...] [--scheduling automatic|notification] [--draft on|off]
                     [--test]                                                   ask the account (--account) whether it connects, and list its channels
  log <project> [--limit 30]                   what was sent, by whom, with what result
  sync <project> [--yes] [--include-unknown] [--include-stale]    make Buffer match Nordle: move posts to Nordle's times, delete the ones Nordle does not mean to send
                                               (owner only; without --yes it only shows what it would do)
  sync-posts <project>                         pull what the brand's channels have sent, with results, from Buffer (owner only; a few requests)
  best-times <project> [--json]                when to post, from those posts (run sync-posts first; reads local files only)
  check-scheduled <uid>...                     is each scheduled post still in Buffer? (owner only; read only)

The API key is read from standard input (echo KEY | node nordle.mjs publish settings buffer --account gannet --label "Little Gannet" --token-stdin),
never from an argument. Posts must be signed off. Exit codes: 0 fine, 1 failed or refused, 2 usage, 3 an owner-only step was refused.`;

const REPEAT = new Set(['channel', 'time', 'only-channels']);
function parse(args) {
  const flags = {}, pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const eq = a.indexOf('=');
    let key = a.slice(2), value;
    if (eq > 0 && !REPEAT.has(a.slice(2, eq))) { key = a.slice(2, eq); value = a.slice(eq + 1); }
    else if (eq > 0) { key = a.slice(2, eq); value = a.slice(eq + 1); }
    else if (args[i + 1] !== undefined && !args[i + 1].startsWith('--')) value = args[++i];
    else value = true;
    if (REPEAT.has(key)) (flags[key] ??= []).push(value); else flags[key] = value;
  }
  return { flags, pos };
}

const isAgentRun = () => process.env.NORDLE_AGENT_RUN === '1';
const ownerOnly = (what) => {
  if (!isAgentRun()) return null;
  err(`Only the owner can ${what}. This command was started by one of Claude's runs (NORDLE_AGENT_RUN is set), so it is refused.`);
  return 3;
};
const onOff = (v) => (v === true || /^(on|true|yes|1)$/i.test(String(v)) ? true : /^(off|false|no|0)$/i.test(String(v)) ? false : null);
const pairs = (list, what) => Object.fromEntries((list ?? []).map((kv) => { const i = String(kv).indexOf('='); if (i < 1) throw new PublishError(400, `${what} takes <name>=<value>, got "${kv}".`); return [String(kv).slice(0, i), String(kv).slice(i + 1)]; }));
const split = (v) => (v && v !== true ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : undefined);
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

/** --channel gannet=ch_fb,hashtags=strip,offset=10,formats=reel+post,enabled=off  (repeat per channel) -> { gannet: [ {id:'ch_ig'}, {...} ] } */
export function parseChannelFlags(list) {
  const out = {};
  for (const spec of list ?? []) {
    const i = String(spec).indexOf('=');
    if (i < 1) throw new PublishError(400, `--channel takes <project>=<channel id>[,key=value...], got "${spec}".`);
    const project = String(spec).slice(0, i);
    const [id, ...rest] = String(spec).slice(i + 1).split(',');
    out[project] ??= [];
    if (id === 'none' || id === '') { out[project] = []; continue; }
    const entry = { id };
    for (const kv of rest) {
      const j = kv.indexOf('=');
      if (j < 1) throw new PublishError(400, `"${kv}" in --channel should look like hashtags=strip.`);
      const k = kv.slice(0, j), v = kv.slice(j + 1);
      if (k === 'formats') entry.formats = v.split('+').filter(Boolean);
      else if (k === 'offset' || k === 'offsetMinutes') entry.offsetMinutes = Number(v);
      else if (k === 'hashtags') entry.hashtags = v;
      else if (k === 'enabled') entry.enabled = onOff(v);
      else if (k === 'name' || k === 'service') entry[k] = v;
      else throw new PublishError(400, `Unknown channel setting "${k}" (formats, offset, hashtags, enabled, name, service).`);
    }
    out[project].push(entry);
  }
  return out;
}

const store = () => new Store({ roots: projectRoots() });

function printPlan(plan) {
  out(`Plan ${plan.planId} for ${plan.adapter}: ${plan.summary.ready} ready, ${plan.summary.blocked} blocked. Expires ${plan.expires}.`);
  for (const it of plan.items) {
    out(`${it.ready ? 'READY  ' : 'BLOCKED'}  ${(it.whenLocal ?? 'no date').padEnd(40)} ${String(it.format ?? '?').padEnd(8)} ${clip(it.title, 30).padEnd(30)} ${it.uid}${it.channel ? `  -> ${it.channel.name ?? it.channel.id}${it.channel.service ? ` [${it.channel.service}]` : ''}` : ''}${it.accountLabel ? `  (${it.accountLabel})` : ''}`);
    for (const b of it.blockers) out(`           blocked: ${b}${it.overridable ? '   (the owner may override this post)' : ''}`);
    for (const w of it.warnings) out(`           warning: ${w}`);
  }
}

function printResults(r) {
  for (const x of r.results) out(`${x.ok ? 'OK    ' : 'FAILED'}  ${x.uid}${x.channel ? ` -> ${x.channel.name ?? x.channel.id}` : ''}  ${x.message}${x.scheduledAt ? `  [${x.scheduledAt}]` : ''}${x.remoteId ? `  id ${x.remoteId}` : ''}`);
  for (const p of r.posts ?? []) out(`${p.status.toUpperCase().padEnd(9)} ${p.uid}  ${p.done} of ${p.total} channel${p.total === 1 ? '' : 's'}`);
  for (const w of r.warnings ?? []) out(`note: ${w}`);
  if (r.stopped) out(`Stopped early: ${r.stopped}`);
}

async function planFrom(flags, pos, role) {
  const adapter = getAdapter(pos[0]);
  const uids = pos.slice(1);
  const channels = Object.fromEntries(Object.entries(pairs(flags['only-channels'], '--only-channels')).map(([uid, v]) => [uid, String(v).split('+').filter(Boolean)]));
  return buildPlan(store(), {
    adapter, uids: uids.length ? uids : undefined,
    project: flags.project && flags.project !== true ? (resolveProject(flags.project).id) : undefined,
    month: flags.month && flags.month !== true ? flags.month : undefined,
    times: pairs(flags.time, '--time'), channels: Object.keys(channels).length ? channels : undefined, role, via: 'cli',
  });
}

export default {
  name: 'publish',
  usage: 'publish <adapters|plan|run|settings|log ...>',
  summary: 'hand signed-off posts to an export folder or Buffer (owner only)',
  async run(args) {
    const [cmd, ...rest] = args;
    const { flags, pos } = parse(rest);
    const role = isAgentRun() ? 'agent' : 'human';
    try {
      switch (cmd) {
        case 'adapters': {
          for (const a of await listAdapters({ live: false })) {
            out(`${a.id}  ${a.configured ? 'connected' : 'not connected'}  ${a.name}`);
            for (const n of a.needs) out(`    needs: ${n}`);
            for (const acc of a.accounts) out(`    account ${acc.id}  "${acc.label}"  ${acc.configured ? 'key saved' : 'no key'}${acc.lastTestedAt ? `  tested ${acc.lastTestedAt}${acc.lastTestOk === false ? ' (failed)' : ''}` : ''}${acc.channels.length ? `  ${acc.channels.length} channel${acc.channels.length === 1 ? '' : 's'}` : ''}`);
            for (const [project, b] of Object.entries(a.brands)) {
              out(`    brand ${project}  ${b.account ? `account ${b.account}` : 'no account'}`);
              for (const c of b.channels) out(`        ${c.name ?? c.id}${c.service ? ` [${c.service}]` : ''}  id ${c.id}  ${c.enabled ? 'on' : 'OFF'}  ${c.formats.join('+')}${c.offsetMinutes ? `  offset ${c.offsetMinutes} min` : ''}${c.hashtags === 'strip' ? '  no hashtags' : ''}`);
            }
            if (a.options.mediaBaseUrl) out(`    media web address: ${a.options.mediaBaseUrl}`);
          }
          return 0;
        }
        case 'plan': {
          if (!pos[0] || (!pos[1] && !flags.month)) { err('Usage: publish plan <adapter> <uid>...   or   publish plan <adapter> --project <id> --month YYYY-MM'); return 2; }
          const plan = await planFrom(flags, pos, role);
          if (flags.json) out(JSON.stringify(publicPlan(plan), null, 2)); else printPlan(publicPlan(plan));
          return 0;
        }
        case 'run': {
          const guard = ownerOnly('schedule posts');
          if (guard) return guard;
          if (!pos[0]) { err('Usage: publish run <planId> --yes   or   publish run <adapter> <uid>... --yes'); return 2; }
          if (!flags.yes) { err('This sends posts to the adapter. Look at the plan first (publish plan ...), then add --yes to run it.'); return 2; }
          let planId = pos[0];
          if (!/^pl_/.test(planId)) {
            const plan = await planFrom(flags, pos, role);
            printPlan(publicPlan(plan));
            planId = plan.planId;
            if (!plan.summary.ready && !flags.override) { err('Nothing is ready to send.'); return 1; }
          }
          const override = Object.fromEntries((split(flags.override) ?? []).map((u) => [u, true]));
          const r = await runPlan(store(), { planId, only: split(flags.only), override, times: pairs(flags.time, '--time'), role, via: 'cli' });
          printResults(r);
          return r.results.every((x) => x.ok) ? 0 : 1;
        }
        case 'settings': {
          if (!pos[0]) { err('Usage: publish settings <adapter> [--account id --label name --token-stdin] [--brand project --use-account id] [--channel project=id ...] [--media-base-url url] [--test]'); return 2; }
          const changing = flags['token-stdin'] || flags['clear-token'] || flags.account !== undefined || flags.label !== undefined || flags['remove-account'] || flags.brand !== undefined || flags['use-account'] !== undefined || flags.channel || flags['media-base-url'] !== undefined || flags.scheduling !== undefined || flags.draft !== undefined || flags.organization !== undefined || flags.test;
          if (changing) { const guard = ownerOnly('change publishing settings'); if (guard) return guard; }
          const body = {};
          if (flags.account !== undefined && flags.account !== true) body.account = flags.account;
          if (flags.label !== undefined && flags.label !== true) body.label = flags.label;
          if (flags['token-stdin']) body.token = readFileSync(0, 'utf8').trim();
          if (flags['clear-token']) body.token = null;
          if (flags.organization !== undefined) body.organizationId = flags.organization === true ? null : flags.organization;
          if (flags['remove-account'] && flags['remove-account'] !== true) body.remove = flags['remove-account'];
          if (flags.brand !== undefined || flags['use-account'] !== undefined) { body.brand = flags.brand; body.useAccount = flags['use-account'] === 'none' ? null : flags['use-account']; }
          if (flags.channel) body.channels = parseChannelFlags(flags.channel);
          const options = {};
          if (flags['media-base-url'] !== undefined) options.mediaBaseUrl = flags['media-base-url'] === true ? null : flags['media-base-url'];
          if (flags.scheduling !== undefined) options.schedulingType = flags.scheduling;
          if (flags.draft !== undefined) { const v = onOff(flags.draft); if (v === null) { err('--draft takes on or off'); return 2; } options.saveToDraft = v; }
          if (Object.keys(options).length) body.options = options;
          if (Object.keys(body).length) {
            const r = saveSettingsFor(pos[0], body, 'human');
            out(`saved (${r.configured ? 'connected' : 'not connected yet'})`);
            if (r.cleared?.length) out(`channels cleared for: ${r.cleared.join(', ')} (they belonged to the account it used before)`);
          }
          if (flags.test) {
            const t = await testAdapter(pos[0], flags.account && flags.account !== true ? flags.account : undefined, 'human');
            out(`${t.ok ? 'OK' : 'FAILED'}  ${t.message}`);
            for (const c of t.channels ?? []) out(`    channel ${c.id}  ${c.name} [${c.service}]`);
            if (!t.ok) return 1;
          }
          const a = await describeAdapter(getAdapter(pos[0]), { live: false });
          out(JSON.stringify({ id: a.id, configured: a.configured, needs: a.needs, accounts: a.accounts.map(({ id, label, configured, lastTestedAt }) => ({ id, label, configured, lastTestedAt })), brands: a.brands, options: a.options }, null, 2));
          return 0;
        }
        case 'sync': {
          const refused = ownerOnly('change what is in Buffer'); if (refused) return refused;
          if (!pos[0]) { err('Usage: publish sync <project> [--yes] [--include-unknown] [--include-stale]'); return 2; }
          const dir = resolveProject(pos[0]).dir;
          const plan = await planSync(dir, { role: 'human', includeUnknown: !!flags['include-unknown'], includeStale: !!flags['include-stale'] });
          out(describeSync(plan));
          out(`(${plan.requests} request${plan.requests === 1 ? '' : 's'} to read Buffer)`);
          if (!plan.actions.length) { out('Nothing to change.'); return 0; }
          if (!flags.yes) { out(`
That is ${plan.actions.length} change${plan.actions.length === 1 ? '' : 's'} in Buffer. Nothing was changed: add --yes to do it.`); return 0; }
          const r = await runSync(dir, plan, { role: 'human' });
          out(`
Done: ${r.done.length} changed${r.failed.length ? `, ${r.failed.length} FAILED` : ''}.`);
          for (const f of r.failed) out(`  FAILED  ${f.kind} ${f.channel}  ${f.error}`);
          return r.failed.length ? 1 : 0;
        }
        case 'sync-posts': {
          const refused = ownerOnly('pull posts from Buffer'); if (refused) return refused;
          if (!pos[0]) { err('Usage: publish sync-posts <project>'); return 2; }
          const r = await syncSentPosts(store(), { project: resolveProject(pos[0]).id, role: 'human' });
          out(`Pulled ${r.fetched} posts (${r.total} kept) in ${r.requests} request${r.requests === 1 ? '' : 's'}.${r.incomplete ? ` Not everything: ${r.incomplete}.` : ''}`);
          {
            try {
              const m = await importBufferMetrics(resolveProject(pos[0]).dir);
              out(`Insights: ${m.matched} of ${m.withNumbers} posts with numbers matched a calendar item (${m.added} added, ${m.replaced} updated); ${m.unmatched} were made outside Nordle and stay in the totals only.`);
            } catch (e) { err(`Could not fill Insights from the pull: ${e.message}`); }
          }
          for (const [k, v] of Object.entries(r.rate ?? {})) out(`  allowance ${k}: ${v.left} of ${v.limit} left`);
          return 0;
        }
        case 'best-times': {
          if (!pos[0]) { err('Usage: publish best-times <project> [--json]'); return 2; }
          const dir = resolveProject(pos[0]).dir;
          const got = readSentPosts(dir);
          if (!got.posts.length) { err('Nothing has been pulled yet: run  publish sync-posts <project>  first.'); return 1; }
          const a = analyseTimes(got.posts, { timeZone: loadProject(dir).timezone });
          if (flags.json) { out(JSON.stringify({ ...a, suggestions: suggestSlots(a) }, null, 2)); return 0; }
          out(`${a.counts.used} of ${a.counts.posts} posts used, ${a.counts.channels} channels, ${a.counts.from?.slice(0, 10)} to ${a.counts.to?.slice(0, 10)} (${a.timeZone}). Pulled ${got.pulledAt ?? '?'}.`);
          out('By weekday:'); for (const d of a.weekday) out(`  ${d.label}  n=${String(d.n).padStart(3)}  ${d.lift ?? '-'}x  (${d.lo ?? '-'} to ${d.hi ?? '-'})  ${d.verdict}`);
          out('By hour:'); for (const d of a.hour) out(`  ${d.label.padStart(6)}  n=${String(d.n).padStart(3)}  ${d.lift}x  (${d.lo} to ${d.hi})  ${d.verdict}`);
          out('Best combinations:'); for (const c of a.combos.slice(0, 8)) out(`  ${c.label.padEnd(12)}  n=${String(c.n).padStart(3)}  ${c.lift}x  (${c.lo} to ${c.hi})  ${c.verdict}`);
          out('Next good times:'); for (const x of suggestSlots(a)) out(`  ${x.iso}  ${x.reason}`);
          for (const c of a.caveats) out(`note: ${c}`);
          return 0;
        }
        case 'check-scheduled': {
          const refused = ownerOnly('ask Buffer what is scheduled'); if (refused) return refused;
          if (!pos.length) { err('Usage: publish check-scheduled <uid>...'); return 2; }
          const r = await checkScheduled(store(), { uids: pos, role: 'human' });
          for (const x of r.results) out(`${x.missing.length ? 'GONE   ' : 'there  '} ${x.uid}  ${x.targets.map((t) => `${t.channel}:${t.state}`).join('  ')}`);
          if (!r.results.length) out('None of those posts is scheduled in Buffer.');
          if (r.incomplete) out(`note: ${r.incomplete}, so a post may show as unknown.`);
          return 0;
        }
        case 'log': {
          if (!pos[0]) { err('Usage: publish log <project> [--limit N]'); return 2; }
          const lines = readAudit(resolveProject(pos[0]).dir, flags.limit && flags.limit !== true ? Number(flags.limit) : 30);
          for (const l of lines) out(`${l.at}  ${l.ok ? 'ok    ' : 'FAILED'}  ${l.adapter}${l.account ? `/${l.account}` : ''}  ${l.uid ?? ''}${l.channel ? ` -> ${l.channel}` : ''}  ${l.message ?? ''}`);
          if (!lines.length) out('Nothing has been sent from this project.');
          return 0;
        }
        default:
          out(USAGE);
          return !cmd || cmd === 'help' || cmd === '--help' ? 0 : 2;
      }
    } catch (e) {
      if (e instanceof PublishError) { err(`publish: ${e.message}`); return e.status === 403 ? 3 : 1; }
      throw e;
    }
  },
};
