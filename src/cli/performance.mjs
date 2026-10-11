// node nordle.mjs performance <command> ...   the numbers loop: import what the platforms report, see what worked, review, tune the plan.
// <project> is a project folder or an id under projects/. See docs/PERFORMANCE.md.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CalendarError, listProjects, loadProject, resolveProject } from '../calendar/service.mjs';
import { isDate } from '../calendar/dates.mjs';
import { METRIC_KEYS, PerformanceError, addManualMetrics } from '../performance/model.mjs';
import { defaultPeriodFor, reportFor, reportMarkdown } from '../performance/analyze.mjs';
import { importCsvFile } from '../performance/import.mjs';
import { applyMix, reviewDue, reviewHistory, saveReview } from '../performance/review.mjs';
import { reviewPrompt } from '../performance/prompts.mjs';
import { parsePeriod } from '../performance/period.mjs';

const out = (s = '') => console.log(s);
const err = (s) => console.error(s);

const USAGE = `performance <command> ...

  import <project> <file.csv> [--window 7d|28d|lifetime] [--platform instagram] [--captured YYYY-MM-DD] [--yes]
         [--date-order dmy|mdy] [--map "Header=reach,Other=saves"] [--account name] [--json]
         Match an export (Meta Business Suite, Buffer ...) to the calendar's posts. A dry run unless --yes; rows that match
         nothing, or more than one post, are listed and never guessed.
  add <project> <item id> --platform instagram [--window 7d] [--published D] [--captured D] [--note ..] --reach N --plays N --likes N
         --comments N --shares N --saves N --follows N [--views --impressions --profile-visits --link-clicks --watch-time-sec
         --avg-watch-sec --completion-rate --dm-starts --swipes]      type in one post's numbers
  report <project> [--month [YYYY-MM] | --week [YYYY-Www]] [--current] [--window 7d] [--platform p] [--json]
         how the posts did (default: the last complete month; --current = the one that holds today)
  review-prompt <project> [period] [--window 7d]      print the prompt that asks Claude for the review
  save-review <project> <period> --file review.md [--extra plan.json]   store a review you wrote (extra: { directions, mix, plan })
  due [project | --all]                               is a review due?  (settings: calendar settings <project> --review monthly|weekly)
  history <project>                                   saved reviews, with the median score of each period
  apply-mix <project> <period>                        apply a review's recommended pillar mix to the settings (owner only)

Global: --today YYYY-MM-DD (pretend it is that day), --json.`;

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
const camel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const nf = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 1 });
const str = (v) => (v === true || v === undefined ? undefined : String(v));
const dayOf = (flags, p) => {
  if (flags.today !== undefined) { if (!isDate(flags.today)) throw new PerformanceError(400, '--today must be a date like 2026-11-03'); return flags.today; }
  return p?.today;
};

function printImport(r, flags) {
  if (flags.json) { out(JSON.stringify(r, null, 2)); return; }
  out(`${r.file ?? 'the file'}: platform ${r.platform}, window ${r.window}, numbers captured ${r.capturedAt}${r.dateOrder ? `; dates: ${r.dateOrder}` : ''}`);
  out(`columns understood: ${r.columns.mapped.map((c) => `${c.header} -> ${c.field}`).join(', ') || 'none'}`);
  if (r.columns.unknown.length) out(`columns ignored: ${r.columns.unknown.join(', ')}`);
  for (const w of r.warnings) out(`note: ${w}`);
  out(`${r.rows} rows: ${r.matched.length} matched, ${r.ambiguous.length} ambiguous, ${r.unmatched.length} not on the calendar${r.skipped.length ? `, ${r.skipped.length} skipped` : ''}`);
  if (r.matched.length) {
    out('', 'MATCHED');
    for (const m of r.matched) {
      out(`  row ${String(m.row).padEnd(3)} ${m.kind.padEnd(12)} ${m.item}  "${m.title}"  ${Object.entries(m.metrics).slice(0, 5).map(([k, v]) => `${k} ${nf.format(v)}`).join(', ')}`);
      for (const w of m.warnings ?? []) out(`          ! ${w}`);
    }
  }
  if (r.ambiguous.length) {
    out('', 'AMBIGUOUS (not written: decide which post it is, then fix the file or type the numbers with `performance add`)');
    for (const a of r.ambiguous) {
      out(`  row ${a.row}: ${a.reason}${a.caption ? `  "${a.caption.slice(0, 60)}"` : ''}`);
      for (const c of a.candidates) out(`          could be ${c.item} (${c.date}, ${c.kind})`);
    }
  }
  if (r.unmatched.length) {
    out('', `NOT ON THE CALENDAR (${r.unmatched.length}; nothing written for these)`);
    for (const u of r.unmatched.slice(0, 15)) out(`  row ${u.row}: ${u.caption ? `"${u.caption.slice(0, 60)}" ` : ''}${u.published ? `(${u.published}) ` : ''}${u.reason}${u.sameDay ? ` [same day: ${u.sameDay.join(', ')}]` : ''}`);
    if (r.unmatched.length > 15) out(`  ... ${r.unmatched.length - 15} more (use --json for all)`);
  }
  out();
  if (r.dryRun) out(r.matched.length ? `Dry run: nothing was written. Run it again with --yes to write the ${r.matched.length} matched row${r.matched.length > 1 ? 's' : ''}.` : 'Dry run: nothing matched, so there is nothing to write.');
  else out(`Written: ${r.written.added} new, ${r.written.replaced} replaced${r.written.rejected ? `, ${r.written.rejected} refused` : ''}.`);
}

function printDue(d) {
  out(`${d.project}: ${d.message}`);
  if (d.configured && d.due) out(`  next: node nordle.mjs performance review-prompt ${d.project} ${d.period}   (or Studio > Insights > Run a review with Claude)`);
}

export default {
  name: 'performance',
  usage: 'performance <import|add|report|review-prompt|due|history ...>',
  summary: 'import post numbers, see what worked, review and tune the plan',
  async run(args) {
    const [cmd, ...rest] = args;
    const { flags, pos } = parse(rest);
    try {
      switch (cmd) {
        case 'import': {
          const guard = ownerOnly('import numbers from a file');
          if (guard) return guard;
          if (!pos[1]) { err('Usage: performance import <project> <file.csv> [--window 7d] [--yes]'); return 2; }
          const proj = resolveProject(pos[0]);
          const columns = flags.map && flags.map !== true ? Object.fromEntries(String(flags.map).split(',').map((kv) => { const i = kv.lastIndexOf('='); return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()]; })) : undefined;
          const r = await importCsvFile(proj.dir, pos[1], {
            window: str(flags.window), platform: str(flags.platform), capturedAt: str(flags.captured), dateOrder: str(flags['date-order']), columns, account: str(flags.account),
            yes: !!flags.yes, role: 'human', today: dayOf(flags),
          });
          printImport(r, flags);
          return r.matched.length || !r.rows ? 0 : 1;
        }
        case 'add': {
          if (!pos[1]) { err('Usage: performance add <project> <item id> --platform instagram --reach 1200 --likes 80 ...'); return 2; }
          const proj = resolveProject(pos[0]);
          const metrics = {};
          for (const k of METRIC_KEYS) {
            const flag = Object.keys(flags).find((f) => camel(f) === k);
            if (flag !== undefined) metrics[k] = flags[flag] === true ? '' : flags[flag];
          }
          const unknown = Object.keys(flags).filter((f) => !METRIC_KEYS.includes(camel(f)) && !['platform', 'window', 'published', 'captured', 'note', 'today', 'json'].includes(f));
          if (unknown.length) { err(`Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.map((u) => `--${u}`).join(', ')}`); return 2; }
          const r = await addManualMetrics(proj.dir, { post: pos[1], platform: str(flags.platform) ?? 'instagram', window: str(flags.window) ?? '7d', metrics, publishedAt: str(flags.published), capturedAt: str(flags.captured), note: str(flags.note) }, { role: isAgentRun() ? 'agent' : 'human', today: dayOf(flags, loadProject(proj.dir)) });
          out(`${r.replaced ? 'replaced' : 'saved'}: ${r.entry.post} on ${r.entry.platform}, ${r.entry.window}: ${Object.entries(r.entry.metrics).map(([k, v]) => `${k} ${nf.format(v)}`).join(', ')}`);
          return 0;
        }
        case 'report': {
          if (!pos[0]) { err('Usage: performance report <project> [--month [YYYY-MM] | --week [YYYY-Www]]'); return 2; }
          const proj = resolveProject(pos[0]);
          const p = loadProject(proj.dir);
          const day = dayOf(flags, p);
          const kind = flags.week ? 'week' : 'month';
          const given = str(flags.week) ?? str(flags.month) ?? str(flags.period);
          const period = given ?? defaultPeriodFor(day, kind, !!flags.current).id;
          if (!parsePeriod(period)) { err(`"${period}" is not a period (use 2026-11 or 2026-W45).`); return 2; }
          const report = reportFor(proj.dir, period, { window: str(flags.window), platform: str(flags.platform), today: day });
          out(flags.json ? JSON.stringify(report, null, 2) : reportMarkdown(report));
          return 0;
        }
        case 'review-prompt': {
          if (!pos[0]) { err('Usage: performance review-prompt <project> [period]'); return 2; }
          const proj = resolveProject(pos[0]);
          out(reviewPrompt(proj.dir, pos[1], { today: dayOf(flags), window: str(flags.window) }));
          return 0;
        }
        case 'save-review': {
          if (!pos[1] || !flags.file || flags.file === true) { err('Usage: performance save-review <project> <period> --file review.md [--extra plan.json]'); return 2; }
          const proj = resolveProject(pos[0]);
          const extra = flags.extra && flags.extra !== true ? JSON.parse(readFileSync(resolve(String(flags.extra)), 'utf8')) : {};
          const r = await saveReview(proj.dir, { period: pos[1], markdown: readFileSync(resolve(String(flags.file)), 'utf8'), directions: extra.directions, mix: extra.mix, plan: extra.plan }, { role: isAgentRun() ? 'agent' : 'human', today: dayOf(flags) });
          out(`saved reviews/${r.review.period}.md`);
          for (const w of r.warnings) out(`note: ${w}`);
          return 0;
        }
        case 'due': {
          const projects = flags.all || !pos[0] ? listProjects() : [resolveProject(pos[0])];
          const day = dayOf(flags);
          let any = false;
          for (const proj of projects) {
            const d = reviewDue(proj.dir, day);
            if (flags.json) { out(JSON.stringify(d)); continue; }
            if (!d.configured && (flags.all || !pos[0])) continue;
            printDue(d);
            any = true;
          }
          if (!any && !flags.json) out('No project has a review rhythm set. Choose one: node nordle.mjs calendar settings <project> --review monthly');
          return 0;
        }
        case 'history': {
          if (!pos[0]) { err('Usage: performance history <project>'); return 2; }
          const proj = resolveProject(pos[0]);
          const h = await reviewHistory(proj.dir);
          if (flags.json) { out(JSON.stringify(h, null, 2)); return 0; }
          if (!h.length) { out('No reviews saved yet.'); return 0; }
          for (const r of h) {
            out(`${r.period.padEnd(9)} saved ${r.savedAt.slice(0, 10)}  median score ${r.medianScore ?? '-'} (n=${r.scoredPosts})${r.mixApplied ? '  mix applied' : r.mix ? '  mix recommended' : ''}`);
            for (const d of r.directions) out(`    ${d.kind.padEnd(7)} ${d.text}${d.confidence ? ` [${d.confidence}]` : ''}`);
          }
          return 0;
        }
        case 'apply-mix': {
          const guard = ownerOnly('change the pillar mix');
          if (guard) return guard;
          if (!pos[1]) { err('Usage: performance apply-mix <project> <period>'); return 2; }
          const proj = resolveProject(pos[0]);
          const r = await applyMix(proj.dir, pos[1]);
          out(`pillar shares now: ${r.settings.pillars.map((x) => `${x.id} ${Math.round((x.share ?? 0) * 100)}%`).join(', ')}`);
          return 0;
        }
        default:
          out(USAGE);
          return !cmd || cmd === 'help' || cmd === '--help' ? 0 : 2;
      }
    } catch (e) {
      if (e instanceof PerformanceError || e instanceof CalendarError) { err(`performance: ${e.message}`); return e.status === 403 ? 3 : 1; }
      throw e;
    }
  },
};
