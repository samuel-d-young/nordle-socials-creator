// node nordle.mjs calendar <command> ...   plan the next months of posts, approve the ideas, build them as the date nears.
// <project> is a project folder or an id under projects/. See docs/CALENDAR.md.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ROOT } from '../../tools/validate.mjs';
import { addItems, approveAll, decide, linkDoc, listProjects, loadProject, overview, resolveProject, runnableItems, setSettings, CalendarError } from '../calendar/service.mjs';
import { FORMATS, ideaLint, lintCalendar, spreadSlots, needFor, monthCounts, quotaOf } from '../calendar/plan.mjs';
import { addMonths, isDate, isMonth, monthEnd, monthOf, monthStart, weekdayName } from '../calendar/dates.mjs';
import { occasionsBetween } from '../calendar/occasions.mjs';
import { buildPrompt, proposePrompt } from '../calendar/prompts.mjs';
import { runAll, runDue, runPropose } from '../calendar/run.mjs';

const out = (s = '') => console.log(s);
const err = (s) => console.error(s);

const USAGE = `calendar <command> [project] ...

  status [project]                       each month against its quota, what is due, what is waiting for you
  list <project> [--month YYYY-MM] [--status s] [--json]
  add <project> --date D --format reel|carousel|post|story --title T [--pillar p --idea .. --hook .. --occasion .. --media ..]
  add <project> --file ideas.json        one idea or a list (also: propose). New ideas start as "idea".
        --approved   the owner's own items start approved       --delegated   ideas arrive approved ("go ahead, I'll review later")
        --force      keep an idea even if the checks refuse it (owner only)
  approve <project> <item|--all-ideas [--month M]>   reject <project> <item> [--comment ..]   unapprove <project> <item>
  signoff <project> <item>     changes <project> <item> --comment "what to change"     posted <project> <item>
  link <project> <item> <doc>            point an item at its finished post
  settings <project> [--lead-days N --auto-build on|off --auto-propose on|off --auto-revise on|off --regions VIC,WA --per-month reel=8,carousel=3,post=2
                      --post-times 12:00,18:00 --idea-approval owner|delegated --horizon N --pillars id:Name:0.3,... --compliance ahpra --timezone Zone
                      --review weekly|monthly|off --review-weekday monday --auto-review on|off]    (the performance review rhythm: docs/PERFORMANCE.md)
  slots <project> <YYYY-MM>              the free, evenly spread slots that would fill the month
  due <project>                          what the runner would build today
  occasions [project] [--from D --to D --regions VIC,WA --tags dental --min-relevance medium]
  lint <project> [item]                  the checks on every open idea (or one)
  prompt <project> [item | --month YYYY-MM[,YYYY-MM]] [--revise]   print the prompt Claude is given
  run [project | --all] [--yes] [--dry-run] [--propose] [--limit N] [--item id] [--timeout-min N]
  watch [project] [--backlog] [--every S]   print one line the moment the owner sends a post back (for an open Claude session to act on); reads only
  schedule-install [--time HH:MM] [--all | project]   prints the Windows Task Scheduler and cron lines. Registers nothing.

Global: --today YYYY-MM-DD (pretend it is that day), --json (where it helps).`;

function parse(args) {
  const flags = {}, pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq > 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); continue; }
    const key = a.slice(2);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; i++; }
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

function today(flags, p) {
  if (flags.today !== undefined) { if (!isDate(flags.today)) throw new CalendarError(400, '--today must be a date like 2026-11-03'); return flags.today; }
  return p?.today;
}

function readIdeas(flags) {
  let data;
  if (flags.file) data = JSON.parse(readFileSync(resolve(String(flags.file)), 'utf8'));
  else if (flags.json && flags.json !== true) data = JSON.parse(String(flags.json));
  else return [{
    date: flags.date, time: flags.time, format: flags.format, title: flags.title, pillar: flags.pillar, idea: flags.idea, hook: flags.hook,
    audience: flags.audience, occasion: flags.occasion, mediaPlan: flags.media ?? flags['media-plan'], notes: flags.notes,
    ...(flags['reel-style'] || flags['reel-seconds'] ? { reel: { ...(flags['reel-style'] ? { style: String(flags['reel-style']) } : {}), ...(flags['reel-seconds'] ? { seconds: Number(flags['reel-seconds']) } : {}) } } : {}),
  }];
  return Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : Array.isArray(data.ideas) ? data.ideas : [data];
}

const line = (it) => `${it.date}${it.time ? ` ${it.time}` : '      '}  ${it.format.padEnd(8)} ${it.status.padEnd(10)} ${it.id}${it.title ? `  ${it.title}` : ''}`;
const pad = (s, n) => String(s).padEnd(n);

function monthLine(r) {
  const parts = FORMATS.filter((f) => r.quota[f] || r.counts[f]).map((f) => `${f} ${r.counts[f]}/${r.quota[f]}`);
  const miss = FORMATS.filter((f) => r.missing[f]).map((f) => `${r.missing[f]} ${f}`);
  return `  ${r.month}  ${pad(`${r.total}/${r.quotaTotal}`, 6)} ${parts.join('  ')}${miss.length ? `   to plan: ${miss.join(', ')}` : '   full'}`;
}

function printIssues(id, lint) {
  for (const e of lint.errors) out(`    error ${e.rule}: ${e.message}`);
  for (const w of lint.warnings) out(`    warn  ${w.rule}: ${w.message}`);
  void id;
}

function status(flags, pos) {
  const projects = pos[0] ? [resolveProject(pos[0])] : listProjects();
  if (!projects.length) { out('No projects found.'); return 0; }
  for (const proj of projects) {
    const p = loadProject(proj.dir);
    const day = today(flags, p);
    const o = overview(proj.dir, { today: day });
    const e = o.effective;
    out(`${p.id}${p.brand.name ? ` (${p.brand.name})` : ''}   today ${o.today}   autoBuild ${e.autoBuild ? 'on' : 'off'}, autoPropose ${e.autoPropose ? 'on' : 'off'}, lead ${e.leadDays} days, ideas ${e.ideaApproval === 'delegated' ? 'approved on delegation' : 'approved by the owner'}${e.regions.length ? `, ${e.regions.join('/')}` : ''}`);
    for (const r of o.months) out(monthLine(r));
    const by = {};
    for (const it of p.cal.items) by[it.status] = (by[it.status] ?? 0) + 1;
    out(`  items: ${Object.entries(by).map(([k, v]) => `${v} ${k}`).join(', ') || 'none'}`);
    const waiting = p.cal.items.filter((i) => i.status === 'idea').length, signoff = p.cal.items.filter((i) => i.status === 'built').length;
    if (waiting) out(`  waiting for you: ${waiting} idea${waiting > 1 ? 's' : ''} to approve`);
    if (signoff) out(`  waiting for you: ${signoff} built post${signoff > 1 ? 's' : ''} to sign off`);
    if (o.due.length) out(`  due now (${e.autoBuild ? 'the runner will build' : 'autoBuild is off'}): ${o.due.map((d) => `${d.id}${d.mode === 'revise' ? ' (revise)' : ''}`).join(', ')}`);
    if (o.running) out(`  running: ${o.running.mode} ${o.running.item ?? ''} since ${o.running.since}`);
  }
  return 0;
}

async function add(flags, pos, name) {
  const proj = resolveProject(pos[0]);
  const p = loadProject(proj.dir);
  const ideas = readIdeas(flags);
  const agent = isAgentRun();
  if (agent && (flags.approved || flags.delegated || flags.force)) {
    err('Only the owner can approve ideas or override the checks. Leave --approved, --delegated and --force out: ideas start as "idea" (or approved, if the owner has delegated approval in the settings).');
    return 3;
  }
  const r = await addItems(proj.dir, ideas, {
    role: agent ? 'agent' : 'human', today: today(flags, p), delegated: !!flags.delegated, force: !!flags.force,
    status: agent ? undefined : flags.approved || flags.delegated ? 'approved' : 'idea',
    strict: true,          // the same checks as the Studio and the MCP tools; --force (owner only) keeps an idea they refuse
  });
  for (const it of r.added) {
    out(`added ${line(it)}`);
    for (const w of r.warnings[it.id] ?? []) out(`    ${w.overridden ? 'overridden' : 'warn'} ${w.rule}: ${w.message}`);
  }
  for (const rej of r.rejected) {
    out(`REFUSED ${rej.input?.date ?? '?'} ${rej.input?.format ?? '?'} "${rej.input?.title ?? '?'}"`);
    for (const e of rej.errors) out(`    ${e.rule ?? e.path}: ${e.message}`);
  }
  for (const m of r.months) out(monthLine(m));
  void name;
  return r.rejected.length && !r.added.length ? 1 : 0;
}

async function decideCmd(action, flags, pos) {
  const guard = ownerOnly(action === 'approve' ? 'approve ideas' : action === 'reject' ? 'reject items' : action === 'signoff' ? 'sign posts off' : `${action} an item`);
  if (guard) return guard;
  const proj = resolveProject(pos[0]);
  if (action === 'approve' && flags['all-ideas']) {
    const r = await approveAll(proj.dir, { month: flags.month === true ? undefined : flags.month });
    out(`approved ${r.items.length} idea${r.items.length === 1 ? '' : 's'}`);
    for (const it of r.items) out(`  ${line(it)}`);
    return 0;
  }
  if (!pos[1]) { err(`Usage: calendar ${action} <project> <item id>`); return 2; }
  const r = await decide(proj.dir, pos[1], action, { comment: flags.comment === true ? undefined : flags.comment });
  out(`${action}: ${line(r.item)}`);
  return 0;
}

async function settings(flags, pos) {
  const proj = resolveProject(pos[0]);
  const patch = {};
  if (flags['lead-days'] !== undefined) patch.leadDays = Number(flags['lead-days']);
  if (flags.horizon !== undefined) patch.horizonMonths = Number(flags.horizon);
  if (flags['max-attempts'] !== undefined) patch.maxBuildAttempts = Number(flags['max-attempts']);
  for (const [flag, key] of [['auto-build', 'autoBuild'], ['auto-propose', 'autoPropose'], ['auto-revise', 'autoRevise']]) {
    if (flags[flag] === undefined) continue;
    const v = onOff(flags[flag]);
    if (v === null) { err(`--${flag} takes on or off`); return 2; }
    patch[key] = v;
  }
  if (flags.regions !== undefined) patch.regions = flags.regions === true || flags.regions === 'none' ? null : String(flags.regions).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  if (flags['post-times'] !== undefined) patch.postTimes = String(flags['post-times']).split(',').map((s) => s.trim()).filter(Boolean);
  if (flags['idea-approval'] !== undefined) patch.ideaApproval = String(flags['idea-approval']);
  if (flags.compliance !== undefined) patch.compliance = flags.compliance === true || flags.compliance === 'none' ? null : String(flags.compliance).split(',').map((s) => s.trim()).filter(Boolean);
  if (flags.timezone !== undefined) patch.timezone = String(flags.timezone);
  if (flags['per-month'] !== undefined) {
    patch.perMonth = Object.fromEntries(String(flags['per-month']).split(',').map((kv) => kv.split('=')).map(([k, v]) => [k.trim(), Number(v)]));
  }
  if (flags.review !== undefined || flags['review-weekday'] !== undefined || flags['auto-review'] !== undefined) {
    const cur = loadProject(proj.dir).cal.settings?.review ?? {};
    const next = { ...cur };
    if (flags.review !== undefined) { if (['off', 'none', 'false'].includes(String(flags.review))) { for (const k of Object.keys(next)) delete next[k]; } else next.cadence = String(flags.review); }
    if (flags['review-weekday'] !== undefined) next.weekday = String(flags['review-weekday']).toLowerCase();
    if (flags['auto-review'] !== undefined) {
      const v = onOff(flags['auto-review']);
      if (v === null) { err('--auto-review takes on or off'); return 2; }
      next.autoReview = v;
    }
    patch.review = Object.keys(next).length ? next : null;
  }
  if (flags.pillars !== undefined) {
    patch.pillars = String(flags.pillars).split(',').filter(Boolean).map((s) => {
      const [id, name, share] = s.split(':');
      return { id: id.trim(), name: (name ?? id).trim(), ...(share !== undefined ? { share: Number(share) } : {}) };
    });
  }
  if (Object.keys(patch).length) {
    const guard = ownerOnly('change the calendar settings');
    if (guard) return guard;
    const r = await setSettings(proj.dir, patch);
    out('settings saved');
    out(JSON.stringify(r.settings, null, 2));
    return 0;
  }
  out(JSON.stringify(loadProject(proj.dir).settings, null, 2));
  return 0;
}

function schedule(flags, pos) {
  const time = flags.time && flags.time !== true ? String(flags.time) : '06:00';
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) { err('--time must look like 06:00'); return 2; }
  const node = process.execPath;
  const script = resolve(ROOT, 'nordle.mjs');
  const target = pos[0] ? ` "${resolveProject(pos[0]).dir}"` : ' --all';
  const win = `"${node}" "${script}" calendar run${target}`;
  out(`These lines are only printed. Nothing has been registered, and nothing runs until you run one yourself.`);
  out('');
  out('Windows (Task Scheduler), once a day. Paste into a command prompt. conhost --headless stops a console window flashing up on screen:');
  out('');
  out(`  schtasks /Create /SC DAILY /ST ${time} /TN "Nordle calendar" /TR "conhost.exe --headless ${win.replace(/"/g, '\\"')}" /F`);
  out('');
  out('Without conhost (a console window appears while it runs):');
  out('');
  out(`  schtasks /Create /SC DAILY /ST ${time} /TN "Nordle calendar" /TR "${win.replace(/"/g, '\\"')}" /F`);
  out('');
  out('Check it, run it now, or remove it:');
  out('');
  out('  schtasks /Query /TN "Nordle calendar" /V /FO LIST');
  out('  schtasks /Run /TN "Nordle calendar"');
  out('  schtasks /Delete /TN "Nordle calendar" /F');
  out('');
  const [h, m] = time.split(':').map(Number);
  out('macOS / Linux (cron), once a day. Add with `crontab -e`:');
  out('');
  out(`  ${m} ${h} * * *  cd "${ROOT}" && "${node}" nordle.mjs calendar run${target} >> "$HOME/.nordle-calendar.log" 2>&1`);
  out('');
  out('The run only builds a project that has autoBuild on (node nordle.mjs calendar settings <project> --auto-build on). Each run is logged under <project>/history/calendar-runs/.');
  return 0;
}

async function run(flags, pos) {
  const common = {
    yes: !!flags.yes, dryRun: !!flags['dry-run'], log: out,
    ...(flags.limit ? { limit: Number(flags.limit) } : {}), ...(flags.item ? { itemId: String(flags.item) } : {}),
    ...(flags['timeout-min'] ? { timeoutMs: Number(flags['timeout-min']) * 60000 } : {}), ...(flags.model ? { model: String(flags.model) } : {}),
  };
  const dayFlag = flags.today !== undefined ? today(flags) : undefined;
  // a due performance review is mentioned; it is written headlessly only when the project's settings.review.autoReview is on (or --review)
  const reviewLines = async (dir) => {
    if (!dir) return false;
    const { reviewStep } = await import('../performance/run.mjs');
    const r = await reviewStep(dir, { today: dayFlag, yes: !!flags.review, dryRun: !!flags['dry-run'], log: out, ...(common.timeoutMs ? { timeoutMs: common.timeoutMs } : {}), ...(common.model ? { model: common.model } : {}) });
    for (const l of r.lines) out(l);
    return r.failed;
  };
  const show = (r) => {
    if (!r.enabled) { out(`${r.project}: ${r.reason}`); return; }
    if (r.locked) { out(`${r.project}: another run is in progress (since ${r.locked.started}${r.locked.item ? `, building ${r.locked.item}` : ''}).`); return; }
    if (r.dryRun) {
      for (const d of r.dryRun) { out(`${r.project}: would ${d.id ? `${d.mode} ${d.id}` : 'propose ideas'} with:`); out(`  ${d.command.join(' ')}`); out(`  prompt ${d.promptChars} characters (see: calendar prompt ${r.project} ${d.id ?? ''})`); }
      return;
    }
    if (r.skipped) { out(`${r.project}: ${r.skipped}`); return; }
    if (!r.ran.length) { out(`${r.project}: nothing to do (${r.due ? `${r.due.length} due` : `${r.months?.length ?? 0} months short`}).`); return; }
    for (const x of r.ran) out(`${r.project}: ${x.id ?? 'propose'} ${x.outcome}${x.doc ? ` -> ${x.doc}` : ''}${x.added ? `, ${x.added.length} ideas` : ''}${x.error ? `: ${x.error}` : ''}`);
  };
  let failed = false;
  if (flags.all || !pos[0]) {
    for (const r of await runAll({ ...common, today: dayFlag })) {
      if (r.error) { out(`${r.project}: ${r.error}`); continue; }
      show(r.built); if (flags.propose || r.proposed.enabled || r.proposed.ran?.length) show(r.proposed);
      failed ||= r.built.ran.some((x) => ['failed', 'timeout', 'signed-out'].includes(x.outcome)) || r.proposed.ran?.some((x) => x.outcome !== 'proposed');
      failed = (await reviewLines(listProjects().find((x) => x.id === r.project)?.dir)) || failed;
    }
    return failed ? 1 : 0;
  }
  const proj = resolveProject(pos[0]);
  const built = await runDue({ ...common, projectDir: proj.dir, today: dayFlag });
  show(built);
  failed = built.ran.some((x) => ['failed', 'timeout', 'signed-out'].includes(x.outcome));
  if (flags.propose || loadProject(proj.dir).settings.autoPropose) {
    const proposed = await runPropose({ ...common, projectDir: proj.dir, today: dayFlag });
    show(proposed);
    failed ||= proposed.ran.some((x) => x.outcome !== 'proposed');
  }
  failed = (await reviewLines(proj.dir)) || failed;
  return failed ? 1 : 0;
}

export default {
  name: 'calendar',
  usage: 'calendar <status|list|add|approve|reject|slots|due|prompt|run|schedule-install ...>',
  summary: 'plan months of posts, approve ideas, build them as the date nears',
  async run(args) {
    const [cmd, ...rest] = args;
    const { flags, pos } = parse(rest);
    try {
      switch (cmd) {
        case 'status': return status(flags, pos);
        case 'list': {
          const proj = resolveProject(pos[0]);
          const p = loadProject(proj.dir);
          let items = p.cal.items;
          if (flags.month && flags.month !== true) items = items.filter((i) => monthOf(i.date) === flags.month);
          if (flags.status && flags.status !== true) items = items.filter((i) => i.status === flags.status);
          if (flags.json) out(JSON.stringify(items, null, 2)); else { for (const it of items) out(line(it)); if (!items.length) out('No items.'); }
          return 0;
        }
        case 'add':
        case 'propose': {
          if (!pos[0]) { err('Usage: calendar add <project> --date D --format F --title T   or   calendar add <project> --file ideas.json'); return 2; }
          return await add(flags, pos, cmd);
        }
        case 'approve': case 'reject': case 'unapprove': case 'signoff': case 'changes': case 'posted':
          return await decideCmd(cmd, flags, pos);
        case 'link': {
          if (!pos[1]) { err('Usage: calendar link <project> <item id> <doc id>   (an imported item with no document of its own: calendar link <project> <item id>, once its files are replaced)'); return 2; }
          const r = await linkDoc(resolveProject(pos[0]).dir, pos[1], pos[2]);
          out(`linked: ${line(r.item)}${r.item.doc ? `  doc ${r.item.doc}` : '  (imported post, back for review)'}`);
          return 0;
        }
        case 'settings': return await settings(flags, pos);
        case 'slots': {
          const proj = resolveProject(pos[0]);
          const p = loadProject(proj.dir);
          const month = pos[1];
          if (!isMonth(month)) { err('Usage: calendar slots <project> <YYYY-MM>'); return 2; }
          const quota = quotaOf(p.cal);
          const need = needFor(quota, monthCounts(p.cal.items, month).counts);
          const slots = spreadSlots(month, { perMonth: quota, postTimes: p.settings.postTimes, existing: p.cal.items });
          out(`${month}: need ${FORMATS.filter((f) => need[f]).map((f) => `${need[f]} ${f}`).join(', ') || 'nothing'}`);
          for (const s of slots) out(`  ${s.date} ${weekdayName(s.date).slice(0, 3)} ${s.time} ${s.format}`);
          if (flags.json) out(JSON.stringify(slots));
          return 0;
        }
        case 'due': {
          const proj = resolveProject(pos[0]);
          const p = loadProject(proj.dir);
          const day = today(flags, p);
          const q = runnableItems(p.cal, day);
          out(`today ${day}, lead ${p.settings.leadDays} days, autoBuild ${p.settings.autoBuild ? 'on' : 'off'}`);
          for (const { item, mode } of q) out(`  ${mode.padEnd(6)} ${line(item)}`);
          if (!q.length) out('  nothing is due');
          return 0;
        }
        case 'occasions': {
          const p = pos[0] ? loadProject(resolveProject(pos[0]).dir) : null;
          const day = today(flags, p) ?? new Date().toISOString().slice(0, 10);
          const from = flags.from && flags.from !== true ? flags.from : monthStart(monthOf(day));
          const to = flags.to && flags.to !== true ? flags.to : monthEnd(addMonths(monthOf(day), 2));
          const regions = flags.regions && flags.regions !== true ? String(flags.regions).split(',').map((s) => s.trim().toUpperCase()) : p?.settings.regions;
          const list = occasionsBetween(from, to, { regions: regions?.length ? regions : undefined, tags: flags.tags && flags.tags !== true ? String(flags.tags).split(',') : undefined, minRelevance: flags['min-relevance'] && flags['min-relevance'] !== true ? flags['min-relevance'] : undefined });
          if (flags.json) { out(JSON.stringify(list, null, 2)); return 0; }
          for (const o of list) out(`${o.date}${o.end !== o.date ? ` to ${o.end}` : ''}  ${o.name}  [${o.kind}; ${o.regions.join('/')}; ${o.relevance}; ${o.confidence}${o.verify ? '; VERIFY' : ''}; ${o.advice}]`);
          if (!list.length) out('No occasions in that range.');
          return 0;
        }
        case 'lint': {
          const proj = resolveProject(pos[0]);
          const p = loadProject(proj.dir);
          const day = today(flags, p);
          const all = lintCalendar(p.cal, { brand: p.brand, facts: p.facts, today: day, regions: p.settings.regions });
          const ids = pos[1] ? [pos[1]] : Object.keys(all);
          let bad = 0;
          for (const id of ids) {
            const item = p.cal.items.find((i) => i.id === id);
            if (!item) { err(`No item "${id}".`); return 1; }
            const l = pos[1] ? ideaLint(item, { brand: p.brand, facts: p.facts, existing: p.cal.items, today: day, cal: p.cal, strict: true, regions: p.settings.regions }) : all[id];
            if (!l.errors.length && !l.warnings.length) continue;
            out(line(item));
            printIssues(id, l);
            bad += l.errors.length;
          }
          if (!bad) out('No errors.');
          return bad ? 1 : 0;
        }
        case 'prompt': {
          const proj = resolveProject(pos[0]);
          const p = loadProject(proj.dir);
          const day = today(flags, p);
          if (pos[1]) out(buildPrompt(proj.dir, pos[1], { today: day, mode: flags.revise ? 'revise' : undefined }));
          else out(proposePrompt(proj.dir, { today: day, months: flags.month && flags.month !== true ? String(flags.month).split(',') : undefined }));
          return 0;
        }
        case 'run': return await run(flags, pos);
        case 'watch': {
          const { watchSentBack } = await import('../calendar/watch.mjs');
          await watchSentBack({ project: pos[0] ? resolveProject(pos[0]).id : undefined, every: flags.every ? Number(flags.every) : 3, backlog: !!flags.backlog });
          return 0;
        }
        case 'schedule-install': return schedule(flags, pos);
        default:
          out(USAGE);
          return !cmd || cmd === 'help' || cmd === '--help' ? 0 : 2;
      }
    } catch (e) {
      if (e instanceof CalendarError) { err(`calendar: ${e.message}`); return e.status >= 500 ? 1 : e.status === 403 ? 3 : 1; }
      throw e;
    }
  },
};
