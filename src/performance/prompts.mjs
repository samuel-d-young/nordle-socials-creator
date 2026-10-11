// The REVIEW prompt: what Claude is handed (by `performance review-prompt`, the Studio's "Run a review with Claude" button, the MCP tool,
// and the optional headless run) to turn a period's numbers into direction for the next posts. Composed from the project's own files on
// every call. Nothing client-specific is written here.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { contentRules, factLines } from '../calendar/prompts.mjs';
import { isRegulated, monthReport } from '../calendar/plan.mjs';
import { addDays, weekdayName } from '../calendar/dates.mjs';
import { loadProject } from '../calendar/service.mjs';
import { reportFor, reportMarkdown } from './analyze.mjs';
import { AMENDABLE } from './review.mjs';
import { readReview } from './model.mjs';
import { lastCompletePeriod, parsePeriod } from './period.mjs';

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}...` : String(s));
const pct = (x) => `${Math.round((x ?? 0) * 100)}%`;

function strategyExcerpt(dir, max = 1800) {
  for (const name of ['STRATEGY.md', 'strategy.md']) {
    const f = join(dir, name);
    if (existsSync(f)) return clip(readFileSync(f, 'utf8').replace(/\r/g, '').trim(), max);
  }
  return null;
}

/** Items from today on, so the review can see what is already planned and which of it is still open to change. */
function upcomingLines(p, today, weeks = 8) {
  const end = addDays(today, weeks * 7);
  const items = p.cal.items.filter((i) => i.status !== 'rejected' && i.date >= today && i.date <= end).sort((a, b) => a.date.localeCompare(b.date));
  if (!items.length) return ['Nothing is planned yet.'];
  return items.map((i) => {
    const open = ['idea', 'approved'].includes(i.status) && !i.doc && !i.external;
    return `- ${i.id} | ${i.date} ${weekdayName(i.date).slice(0, 3)} | ${i.format} [${i.status}]${i.pillar ? ` {${i.pillar}}` : ''} ${clip(i.title, 70)}${i.hook ? ` | hook: ${clip(i.hook, 80)}` : ''} | ${open ? 'OPEN: you may amend' : 'LOCKED: leave alone'}`;
  });
}

/**
 * The review prompt for one period. period: '2026-11' or '2026-W45' (default: the last complete month, or week for a weekly rhythm).
 * Returns the text.
 */
export function reviewPrompt(projectDir, period, { today, window = '7d', platform } = {}) {
  const dir = resolve(projectDir);
  const p = loadProject(dir);
  const day = today ?? p.today;
  const cadenceKind = p.settings.review?.cadence === 'weekly' ? 'week' : 'month';
  const per = (period && parsePeriod(period)) || lastCompletePeriod(day, cadenceKind);
  const report = reportFor(dir, per.id, { window, platform, today: day });
  const regulated = isRegulated(p.brand, p.cal);
  const delegated = p.settings.ideaApproval === 'delegated';
  const nextMonth = addDays(`${day.slice(0, 7)}-28`, 5).slice(0, 7);
  const existing = readReview(dir, per.id);
  const strategy = strategyExcerpt(dir);
  const m = monthReport(p.cal, nextMonth);
  const o = [];

  o.push(`# Review the numbers: ${p.brand.name ?? p.id} (project "${p.id}"), ${per.label}`, '');
  o.push(`Today is ${day} (${weekdayName(day)}). You are this brand's social-media strategist. The owner asked for a review of how the posts performed ${p.settings.review?.cadence === 'weekly' ? 'each week' : 'each month'}, and for the upcoming posts to be tuned toward what worked and away from what did not, so that each review gives clear direction on what to post next. The numbers below are real copies of what the platforms showed; nothing is estimated. ${existing ? `A review of this period already exists (saved ${existing.meta.savedAt?.slice(0, 10) ?? 'earlier'}); this one replaces it.` : ''}`, '');

  o.push('## What to do', '');
  o.push(`1. Read "The numbers" below (\`nordle_performance_report\` with project "${p.id}" and period "${per.id}" gives the same as JSON, with every post's score parts). Read STRATEGY.md and brand.json in the project folder if you need more of the brand's voice, audience and pillars.`);
  o.push('2. Decide what worked, what did not, and what to do about it, using only the evidence rules below.');
  o.push(`3. Save everything in ONE call to \`nordle_performance_save_review\` (project "${p.id}", period "${per.id}") with: \`markdown\` (the review text, below), \`directions\` (three to five), \`mix\` (the pillar mix you recommend), and \`plan\` (calendar changes, below). The tool applies the plan through the calendar's own rules and writes what really happened at the end of the text.`);
  o.push('4. End your reply with two lines: the single most important direction, and what the owner has to approve.', '');

  o.push('## The review text (markdown, in this order, plain words, no jargon)', '');
  o.push('- `## What worked`: the two or three clearest wins, each with its numbers and n, and what the posts had in common.');
  o.push('- `## What did not`: the weakest posts or groups, with numbers and n, and a fair guess at why that is labelled as a guess.');
  o.push('- `## Directions`: three to five. Each starts with **Do more**, **Stop** or **Test**, then the thing, then `Evidence:` (numbers and n) and `Confidence:` (low, medium, high). A Test names what to vary, how many posts it needs, and what result would change your mind.');
  o.push('- `## Mix for next month`: the pillar shares you recommend (adding up to 100%) and how the "others" split between carousels and single posts. The monthly quota itself is the owner\'s decision: do not change it.');
  o.push('- `## Last time`: whether the previous review\'s directions were followed and whether the score moved (see below). Say "too early to tell" when it is.');
  o.push('- `## Data gaps`: what is missing or too thin, and the one thing to measure next.', '');

  o.push('## Rules of evidence (break none)', '');
  o.push('- Every number you quote comes from "The numbers". Never invent, round up, or fill a gap with a guess dressed as a figure.');
  o.push('- A group with fewer than 5 posts is **directional only**. Directional evidence supports a **Test**, never **Do more** or **Stop**, and its confidence is low.');
  o.push('- "Suggestive" (5 or more each side, 8+ points apart) can support Do more or Stop at medium confidence. Only "stronger" (10+ each side, 10+ points, p under 0.05) earns high confidence, and even then it is not proof of cause.');
  o.push('- Say "went with", never "caused". Topic, day, a boost, a holiday and luck all move a post. A single post is an anecdote. A week of 3 posts is noise: look at the trend over the history table instead.');
  o.push('- Several groupings are compared at once, so one standing out is partly chance. Prefer changes you can test next month on purpose.');
  o.push('- Scores are relative to this account\'s own history. Do not compare this brand with any other brand or with industry averages.');
  o.push('- If there are few or no numbers, say so plainly. Then the review is about what to collect and one or two cheap tests; do not manufacture trends.');
  if (regulated) o.push('- This brand advertises health services. A format that "performs" (testimonials, before-and-afters, offers without conditions, "best", "painless") is still not allowed: performance never overrides the health-advertising rules below.');
  o.push('');

  o.push('## What you may change in the calendar (the `plan` argument)', '');
  o.push('`plan` = { ideas: [ ... ], amend: [ { item, set: { ... }, because } ] }. Everything goes through the calendar\'s own checks.');
  o.push('- `ideas`: new ideas for the coming weeks, the same fields as `nordle_calendar_propose` (date, format, title, pillar, idea, hook, mediaPlan, ...). Use the open slots; do not repeat an angle already posted or planned. They arrive as ideas for the owner to approve' + (delegated ? ' (approval is delegated for this brand, so they arrive approved and will be built: they must be right).' : '.'));
  o.push(`- \`amend\`: change the ${AMENDABLE.join(', ')} of an upcoming item marked OPEN below (status idea or approved, nothing built yet). Change the hook or angle toward what worked; say why in \`because\`. An item the owner approved personally goes back to "idea" when you change it: the owner approved the old version, not the new one${delegated ? ' (only items that arrived under delegated approval stay approved)' : ''}. Say which ones in your closing line.`);
  o.push('- Items marked LOCKED (built, signed off, scheduled, posted) are never changed. The tool refuses and says so.');
  o.push('- You cannot change the settings. Put the pillar mix you recommend in `mix` ({ pillars: { <pillar id>: share, ... } adding to 1, formats?: {...}, note? }); the owner applies it with one click.', '');

  o.push('## The brand', '');
  o.push(`- Audience: ${p.brand.voice?.audience ?? 'not described: read brand.json'}`);
  const pillars = p.settings.pillars;
  o.push(pillars.length ? `- Pillars (id, name, current share): ${pillars.map((x) => `${x.id} (${x.name}) ${pct(x.share)}`).join('; ')}` : '- No pillars are set in the calendar settings.');
  o.push(`- Monthly quota: ${Object.entries(p.settings.perMonth).filter(([, v]) => v).map(([k, v]) => `${v} ${k}${v > 1 ? 's' : ''}`).join(' + ')}. ${nextMonth} so far: ${m.total} of ${m.quotaTotal} planned${m.missingTotal ? `, still to plan: ${Object.entries(m.missing).filter(([, n]) => n).map(([f, n]) => `${n} ${f}`).join(', ')}` : ''}.`);
  if (strategy) o.push('', 'From STRATEGY.md:', '', ...strategy.split('\n').map((l) => `> ${l}`));
  o.push('');

  o.push(`## Last review's directions`, '');
  if (report.followUp) {
    const f = report.followUp;
    o.push(`The previous review is ${f.review} (saved ${f.savedAt.slice(0, 10)}). Since then ${f.since.items} posts were planned: pillar shares ${Object.entries(f.since.pillarShare).map(([k, v]) => `${k} ${pct(v)}`).join(', ') || 'none'}; formats ${Object.entries(f.since.formatShare).map(([k, v]) => `${k} ${pct(v)}`).join(', ') || 'none'}. It recommended ${f.recommendedMix?.pillars ? Object.entries(f.recommendedMix.pillars).map(([k, v]) => `${k} ${pct(v)}`).join(', ') : 'no pillar mix'}. Median score then ${f.medianScoreThen ?? 'n/a'}, now ${f.medianScoreNow ?? 'n/a'}.`);
    for (const d of f.directions) o.push(`- ${d.kind}: ${d.text}${d.confidence ? ` (${d.confidence})` : ''}`);
    o.push('', 'Judge each: followed or not (from the calendar), and whether the numbers moved. Two periods rarely prove anything; say what you would watch next.');
  } else {
    o.push('There is no earlier review, so this one sets the baseline. Say what you will compare next time.');
  }
  o.push('');

  o.push('## The numbers', '', reportMarkdown(report).replace(/^# .*\n+/, '').trim(), '');
  o.push('## Already posted or planned from today', '', ...upcomingLines(p, day), '');
  o.push('## Facts you may rely on in new ideas', '', ...factLines(p.facts, 10), '');
  o.push('## Rules that always apply to ideas', '', ...contentRules({ regulated, scope: 'plan', facts: p.facts }).map((r) => `- ${r}`), '');
  return `${o.join('\n')}\n`;
}
