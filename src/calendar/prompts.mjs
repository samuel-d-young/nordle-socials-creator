// The two prompts that drive the planning loop. They are what an in-editor "Design it" button, `nordle calendar prompt`, and the
// scheduled runner (src/calendar/run.mjs) hand to Claude:
//   proposePrompt  fill a month (or three) with ideas that the owner will approve, edit or reject
//   buildPrompt    build one approved idea into a finished, checked post (or revise one the owner sent back)
// They are composed from the project's own files on every call, so they are always current. Nothing client-specific is written
// here: names, voice, facts and pillars come from the project.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../../tools/validate.mjs';
import { PATTERNS } from '../shared/patterns.mjs';
import { CalendarError, loadProject } from './service.mjs';
import { reelPromptLines, reelSizeOf } from '../shared/reel-options.mjs';
import { DEFAULT_RISK_WORDS, FORMATS, bannedPhrasesOf, isRegulated, monthReport, spreadSlots } from './plan.mjs';
import { addDays, addMonths, diffDays, monthEnd, monthName, monthOf, monthStart, weekdayName } from './dates.mjs';
import { occasionsBetween } from './occasions.mjs';
import { industryRules } from '../brand/industry.mjs';

// The checks a post of each kind must pass come from the verification module. It belongs to another part of Nordle, so if it is
// missing or changes shape the prompt still works, with a plain list.
let requiredChecks = (doc) => [
  { check: 'technical', by: ['auto'] }, { check: 'compliance', by: ['auto'] }, { check: 'facts', by: ['auto'] }, { check: 'copy', by: ['designer'] },
  { check: 'media-match', by: ['auto', 'designer', 'reviewer'] }, { check: 'brief', by: ['reviewer'] },
  ...(doc.kind === 'video' ? [{ check: 'speech-cuts', by: ['auto', 'reviewer'] }, { check: 'broll', by: ['designer', 'reviewer'] }, { check: 'audio', by: ['auto'] }] : [{ check: 'design', by: ['auto'] }]),
];
try { const m = await import('../verify/store.mjs'); if (typeof m.requiredChecks === 'function') requiredChecks = m.requiredChecks; } catch { /* keep the plain list */ }

const here = dirname(fileURLToPath(import.meta.url));
const fwd = (p) => String(p).replace(/\\/g, '/');
const list = (xs, none = 'none given') => (xs?.length ? xs.join('; ') : none);
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}...` : String(s));

// ---- what the install can do -------------------------------------------------------------------------------------------

/** Names of the extra nordle_* tools installed (src/mcp/tools/*.mjs), grouped by the file they come from. */
export function pluginToolNames(dir = join(here, '..', 'mcp', 'tools')) {
  const out = {};
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.mjs') && !x.startsWith('_')).sort()) {
    const names = [...readFileSync(join(dir, f), 'utf8').matchAll(/name:\s*'(nordle_[a-z0-9_]+)'/g)].map((m) => m[1]);
    if (names.length) out[f.replace(/\.mjs$/, '')] = [...new Set(names)];
  }
  return out;
}
const namesMatching = (re, groups = pluginToolNames()) => Object.entries(groups).flatMap(([group, names]) => (group === 'calendar' || group === 'performance' ? [] : names.filter((n) => re.test(n))));

/** The rules every brief shares, as bullet lines. Health practices get the health-advertising rules too. */
export function contentRules({ regulated, scope = 'build', facts, brand }) {
  const rules = [
    ...industryRules(brand),
    'Never invent a fact about the business: phone numbers, addresses, prices, opening hours, staff names or titles, statistics, awards. If it is not in facts.json (with a source), on the practice\'s own website, or in the footage transcripts, leave it out.',
    'Nothing goes public from here. You make ideas and drafts; the owner approves and posts.',
    ...(scope === 'build' ? [
      'A caption must be true of the photo or clip it sits on, and a piece of on-screen text must be true of the media behind it.',
      'A speaker is never cut off mid-sentence. B-roll must make sense for what is being said at that moment.',
    ] : []),
  ];
  if (regulated) {
    rules.push(
      'Health advertising (Australia, AHPRA and National Law s133): no testimonials or reviews used in advertising; no before-and-after claims; none of "best", "painless", "guaranteed", "cure", "safe", "no risk"; no unreasonable expectations of benefit; no pressure; no inducement or offer without its full conditions; no statistics you cannot source; nothing that encourages unnecessary treatment.',
      `Cosmetic and implant content carries the general risk wording the practice already uses${facts?.riskStatement?.text ? `: "${clip(facts.riskStatement.text, 260)}"` : ''}. Never state implant healing or treatment time periods.`,
      'No identifiable patients (staff, rooms, equipment and exteriors only) and no children\'s faces.',
    );
  }
  return rules;
}

/**
 * A compact view of facts.json for a prompt (nordle.facts/0.1: names, phones, addresses, hours, staff, services, prices, approved
 * CTAs and stats, banned claims, the risk statement). Sources stay in the file; the prompt says every entry has one. Older or
 * looser shapes ({facts:[{key,value,source}]} or a flat object) are shown as key: value.
 */
export function factLines(facts, max = 14) {
  if (!facts) return ['No facts.json yet: treat every claim about the business as unknown and leave it out.'];
  const lines = [];
  const take = (label, rows, fmt, cap = max, sep = '; ') => {
    if (!Array.isArray(rows) || !rows.length) return;
    const shown = rows.slice(0, cap).map(fmt).filter(Boolean);
    lines.push(`- ${label}: ${shown.join(sep)}${rows.length > cap ? ` (+${rows.length - cap} more in facts.json)` : ''}`);
  };
  const structured = ['names', 'phones', 'addresses', 'hours', 'staff', 'services', 'approvedStats', 'approvedCtas', 'riskStatement', 'prices', 'websites', 'social'].some((k) => k in facts);
  if (structured) {
    take('Names', facts.names, (x) => x);
    take('Phone', facts.phones, (x) => `${x.label ? `${x.label} ` : ''}${x.number}`);
    take('Address', facts.addresses, (x) => `${x.label ? `${x.label}: ` : ''}${x.text}`);
    take('Hours', facts.hours, (x) => `${x.text}${x.label ? ` (${x.label})` : ''}`);
    take('Websites', facts.websites, (x) => x.url);
    take('Social', facts.social, (x) => `${x.platform} ${x.handle}`);
    take('Staff (names and titles exactly as given)', facts.staff, (x) => `${x.name}, ${x.title}`, 16);
    take('Services', facts.services, (x) => (typeof x === 'string' ? x : x.name), 30, ', ');
    take('Prices', facts.prices, (x) => `${x.label ? `${x.label} ` : ''}${x.text}`);
    take('Approved calls to action', facts.approvedCtas, (x) => `"${x}"`, 8);
    take('Approved figures', facts.approvedStats, (x) => x.text, 12);
    take('Never claim', facts.bannedClaims, (x) => `"${x}"`, 30, ', ');
    if (facts.riskStatement?.text) lines.push(`- Risk wording: "${clip(facts.riskStatement.text, 220)}" (carried by posts that mention ${(facts.riskStatement.appliesTo ?? DEFAULT_RISK_WORDS).join(', ')})`);
    if (facts.notes) lines.push(`- Notes: ${clip(facts.notes, 300)}`);
    lines.push('- Every entry above has a source in facts.json. Anything not listed is unknown: leave it out.');
    return lines;
  }
  const rows = Array.isArray(facts) ? facts : Array.isArray(facts.facts) ? facts.facts : Object.entries(facts).filter(([k]) => !k.startsWith('$') && k !== 'schema').map(([k, v]) => ({ key: k, ...(v && typeof v === 'object' && !Array.isArray(v) ? v : { value: v }) }));
  for (const r of rows.slice(0, 40)) {
    const key = r.key ?? r.id ?? r.name ?? '';
    const value = r.value !== undefined ? (typeof r.value === 'string' ? r.value : JSON.stringify(r.value)) : JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !['key', 'id', 'name', 'source'].includes(k))));
    lines.push(`- ${key}: ${clip(value, 140)}${r.source ? ` (source: ${clip(r.source, 60)})` : ''}`);
  }
  if (rows.length > 40) lines.push(`- ...and ${rows.length - 40} more in facts.json`);
  return lines.length ? lines : ['facts.json is empty.'];
}

/**
 * The project's own build helpers in specs/ (a script whose first comment line says how to run it: `// node projects/x/specs/_go.mjs <doc id>`).
 * Brand projects keep a house look that a plain `nordle build` drops, so a brief must send Claude to the helper, not the stock command.
 * @returns {{file:string, usage:string}[]}
 */
export function projectHelpers(projectDir) {
  const dir = join(resolve(projectDir), 'specs');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => /^(_?go(-[a-z0-9]+)?|make|build)\.(mjs|sh)$/.test(x)).sort()) {
    let usage = '';
    try { usage = readFileSync(join(dir, f), 'utf8').split(/\r?\n/).slice(0, 4).map((l) => l.replace(/^\s*(\/\/|#)\s*/, '')).find((l) => /^(node|sh)\s/.test(l)) ?? ''; } catch { /* unreadable: list the file without usage */ }
    out.push({ file: f, usage: usage.trim() });
  }
  return out;
}

const itemLine = (it) => `- ${it.date} ${it.format} [${it.status}]${it.pillar ? ` {${it.pillar}}` : ''} ${it.title}${it.hook ? ` | hook: ${clip(it.hook, 90)}` : ''}`;

function brandLines(brand, facts) {
  const v = brand.voice ?? {};
  return [
    `Audience: ${v.audience ?? 'not described yet: read brand.json and STRATEGY.md before you decide'}`,
    `Tone: ${list(v.tone)}`,
    `Do: ${list(v.do)}`,
    `Do not: ${list(v.dont)}`,
    `Banned words and phrases: ${list(bannedPhrasesOf(brand, facts), 'none')}`,
    ...(brand.links?.handle ? [`Handle: ${brand.links.handle}`] : []),
  ];
}

function pillarLines(p, month) {
  const rep = monthReport(p.cal, month);
  if (!p.settings.pillars.length) return ['No pillars are set in the calendar settings. Read STRATEGY.md (if there is one) and keep the mix varied: education, behind the scenes, people, seasonal.'];
  return rep.pillars.map((x) => `- ${x.id} (${x.name}${p.settings.pillars.find((q) => q.id === x.id)?.about ? `: ${p.settings.pillars.find((q) => q.id === x.id).about}` : ''}): about ${Math.round((x.share ?? 0) * 100)}% = ${x.target} of ${rep.quotaTotal}; ${x.actual} planned`);
}

// ---- propose -----------------------------------------------------------------------------------------------------------

/**
 * The prompt that asks Claude to fill the calendar. months: ['2026-11', ...] (default: the planning horizon, months that
 * still have a gap). Returns the text.
 */
export function proposePrompt(projectDir, { months, today, nordleRoot = ROOT } = {}) {
  const p = loadProject(projectDir);
  const day = today ?? p.today;
  let want = months?.length ? months : [];
  if (!want.length) {
    for (let i = 0; i < p.settings.horizonMonths; i++) { const m = addMonths(monthOf(day), i); if (monthReport(p.cal, m).missingTotal > 0) want.push(m); }
    if (!want.length) want = [monthOf(day)];
  }
  want = [...new Set(want)].sort();
  const regions = p.settings.regions;
  const regulated = isRegulated(p.brand, p.cal);
  const delegated = p.settings.ideaApproval === 'delegated';
  const first = monthStart(want[0]), last = monthEnd(want.at(-1));
  const closed = occasionsBetween(first, last, { regions: regions.length ? regions : ['AU'] }).filter((o) => ['closed', 'respectful'].includes(o.advice));
  const avoidFor = (m) => {
    const dates = [];
    for (let d = monthStart(m); d <= monthEnd(m); d = addDays(d, 1)) if (d < day) dates.push(d);
    for (const o of closed) for (let d = o.date; d <= o.end; d = addDays(d, 1)) if (monthOf(d) === m) dates.push(d);
    return dates;
  };

  const out = [];
  out.push(`# Plan the next posts: ${p.brand.name ?? p.id} (project "${p.id}")`, '');
  out.push(`Today is ${day} (${weekdayName(day)}). You are the planner for this brand's social calendar. Propose post ideas for ${want.map(monthName).join(', ')}. ${delegated ? 'The owner has delegated approval: ideas you propose arrive already approved and will be built when their date comes within the lead time, so they must be right.' : 'The owner approves, edits or rejects every idea in the Studio; nothing is built until they approve it.'} You write ideas only: no designs, no captions, no posting.`, '');
  out.push('## How to deliver', '');
  out.push(`Call \`nordle_calendar_propose\` with project "${p.id}" and \`ideas\`, a list of: { date (YYYY-MM-DD), time (optional HH:MM), format (reel | carousel | post | story), title, pillar, idea, hook, audience (optional), occasion (optional), mediaPlan }.`);
  out.push('- `idea`: one or two sentences: what it says, why this audience cares, and what makes it true.');
  out.push('- `hook`: the first line or first second, under about 125 characters, a reason to stop scrolling.');
  out.push('- `mediaPlan`: the photos or clips that will carry it. Check `assets/catalog.json` and `sources/catalog.json` and name real entries; do not plan a shot that does not exist.');
  out.push('- `reel` (reels only, optional): how it is made, `{ style: "footage" | "motion" | "voiceover", uses: [...], seconds }`. Use `motion` for a reel made only of animated graphics (no footage), and `voiceover` for animated graphics timed to a voice-over the owner has recorded (only if the project has one with word timings). Leave it out for an ordinary reel cut from footage. Honour any reel choices the owner asked for below.');
  out.push('- `guidance` (optional): only when the owner gave you extra information to steer a post, copy it onto that idea in their words.');
  out.push('- If a call refuses an idea it says why (a repeat, a banned phrase, a date in the past, a month already full, a pillar that is not defined). Fix that idea or drop it; do not argue with the check. Warnings are for you to weigh.');
  out.push('- Fill each month to its quota using the open slots as a start; move one a day or two to land on an occasion. Finish with three lines: ideas per month, occasions used, anything the owner has to decide.', '');
  out.push('## What a good idea is', '');
  out.push('- Specific: one concrete thing this audience understands in a second (a question they really ask, a myth, a how-to, a real room, a real piece of equipment, a real routine). Never generic ("5 reasons to smile", "why oral health matters").');
  out.push('- True: from facts.json, the practice\'s own website, or what the catalogued photos and clips really show. No figures, prices, hours, names or promises that are not given.');
  out.push('- Useful to this audience at this time of year, riding an occasion only when it genuinely fits it.');
  out.push('- Different from everything already posted or planned (below): a new angle and a new hook, not a reworded repeat.', '');
  out.push('## The brand', '', ...brandLines(p.brand, p.facts).map((l) => `- ${l}`));
  out.push('- Read for depth if you need it: brand.json, facts.json, assets/catalog.json, sources/catalog.json and STRATEGY.md in the project folder.', '');
  out.push('## Facts you may rely on', '', ...factLines(p.facts), '');

  for (const m of want) {
    const rep = monthReport(p.cal, m);
    const quotaText = FORMATS.filter((f) => rep.quota[f]).map((f) => `${rep.quota[f]} ${f}${rep.quota[f] > 1 ? 's' : ''}`).join(' + ');
    out.push(`## ${monthName(m)}: ${rep.total} of ${rep.quotaTotal} planned`, '');
    out.push(`Quota: ${quotaText} = ${rep.quotaTotal}. Still to plan: ${FORMATS.filter((f) => rep.missing[f]).map((f) => `${rep.missing[f]} ${f}`).join(', ') || 'nothing'}.`);
    out.push('Pillars:', ...pillarLines(p, m));
    const slots = spreadSlots(m, { perMonth: rep.quota, postTimes: p.settings.postTimes, avoidDates: avoidFor(m), existing: p.cal.items });
    out.push(slots.length ? `Open slots (a suggestion, dates and formats):\n${slots.map((s) => `- ${s.date} ${weekdayName(s.date).slice(0, 3)} ${s.time} ${s.format}`).join('\n')}` : 'No open slots: the month is full.', '');
  }

  const occ = occasionsBetween(first, last, { regions: regions.length ? regions : undefined });
  out.push(`## Occasions in range${regions.length ? ` (${regions.join(', ')} and national)` : ' (all regions listed; set calendar settings.regions to narrow this)'}`, '');
  out.push('Entries marked VERIFY are approximate or announced each year: you may plan around them, but the post must not state the date until the owner has confirmed it. Respect the advice: "respectful" and "closed" days are not for promotion.');
  for (const o of occ.filter((x) => x.relevance !== 'low' || x.kind === 'school')) {
    out.push(`- ${o.date}${o.end !== o.date ? ` to ${o.end}` : ''} ${o.name} [${o.kind}; ${o.regions.join('/')}; relevance ${o.relevance}; ${o.confidence}${o.verify ? '; VERIFY' : ''}; ${o.advice}]${o.caution ? ` ${clip(o.caution, 200)}` : o.note ? ` ${clip(o.note, 160)}` : ''}`);
  }
  const lowKeep = occ.filter((x) => x.relevance === 'low' && x.kind !== 'school');
  if (lowKeep.length) out.push(`- also dated (low relevance): ${lowKeep.map((o) => `${o.date} ${o.name}`).join('; ')}`);
  out.push('');

  const recent = p.cal.items.filter((i) => i.status !== 'rejected' && i.date >= addDays(day, -90)).sort((a, b) => a.date.localeCompare(b.date));
  const shownRecent = recent.length > 70 ? recent.slice(-70) : recent;
  out.push('## Already posted or planned (do not repeat these angles or hooks)', '', ...(recent.length ? shownRecent.map(itemLine) : ['Nothing yet.']), ...(recent.length > 70 ? [`(${recent.length - 70} earlier ones left out; nordle_calendar_get has them all)`] : []), '');
  out.push('## Rules that always apply', '', ...contentRules({ regulated, scope: 'plan', facts: p.facts, brand: p.brand }).map((r) => `- ${r}`), '');
  return `${out.join('\n')}\n`;
}

// ---- build -------------------------------------------------------------------------------------------------------------

const SIZE_FOR = { reel: 'ig-reel-9x16', story: 'ig-story-9x16', carousel: 'ig-feed-4x5', post: 'ig-feed-4x5' };

/**
 * The prompt that asks Claude to build one calendar item into a finished post.
 * mode 'build' (an approved idea) or 'revise' (the owner sent the post back; default chosen from the item's status).
 */
/**
 * What Claude is told about the owner's media libraries (Stock window): it uses them itself while it builds, own folders first, so the owner never has to pick files.
 * Nothing for a post that uses no media (a motion-graphics reel) or when there are none.
 */
export function stockLines(stock, item) {
  if (!stock || (!stock.own?.length && !stock.online?.length)) return [];
  if (item?.format === 'reel' && ['motion', 'voiceover'].includes(item.reel?.style)) return [];
  const kinds = (l) => (l.kinds ?? []).join(', ');
  const out = ['', "## The owner's media libraries (use them yourself)", ''];
  out.push('The owner has set up libraries in the Stock window. Search them yourself while you build; do not ask which files to use.');
  for (const l of stock.own ?? []) out.push(`- OWN FOLDER, use first: "${l.name}" (\`${l.id}\`, ${kinds(l)}), the owner's own footage and stock.`);
  for (const l of stock.online ?? []) out.push(`- Online, only for a shot the owner's own material cannot cover: "${l.name}" (\`${l.id}\`, ${kinds(l)})${l.license ? `, licence: ${l.license}` : ''}.`);
  out.push(`Search with \`nordle_stock_search\` (library, kind, words from the idea) and bring a file in with \`nordle_stock_get\`; it lands in the project under \`assets/stock/\` with its licence written down. A file brought in is catalogued as "not looked at yet": look at it (a still or a frame) and write what it really shows into the catalog before you put it on a post, and never use one you have not looked at. Prefer the owner's own footage and photos in the project catalogs, then their own folders, then online libraries.`);
  return out;
}

export function buildPrompt(projectDir, itemId, { mode, today, nordleRoot = ROOT, stock = null } = {}) {
  const p = loadProject(projectDir);
  const item = p.cal.items.find((i) => i.id === itemId);
  if (!item) throw new CalendarError(404, `There is no calendar item "${itemId}".`);
  const how = mode ?? (item.status === 'changes' && item.doc ? 'revise' : 'build');
  const day = today ?? p.today;
  const regulated = isRegulated(p.brand, p.cal);
  const docId = item.doc ?? item.id;
  const cli = `node "${fwd(join(nordleRoot, 'nordle.mjs'))}"`;
  const proj = fwd(resolve(projectDir));
  const kind = item.format === 'reel' ? 'video' : item.format === 'carousel' ? 'carousel' : 'graphic';
  const checks = requiredChecks({ kind: kind === 'video' ? 'video' : kind });
  const checkList = checks.map((c) => `${c.check} (${c.by.join(' + ')})`).join(', ');
  const groups = pluginToolNames();
  const videoTools = namesMatching(/video|reel|clip|transcri|cut|music|footage|source|broll|caption|probe|media/, groups);
  // tools that record or run checks; the video ones only matter for a reel
  const verifyTools = namesMatching(/verif|record|review|catalog|media_match|uniqueness|fact|video_check/, groups).filter((n) => item.format === 'reel' || !/video/.test(n));
  const videoGuide = existsSync(join(nordleRoot, 'docs', 'VIDEO.md')) ? ' Read docs/VIDEO.md in the Nordle folder first.' : '';
  const setBrief = Object.values(groups).flat().includes('nordle_set_brief');
  const staticTools = ['nordle_get_brand', 'nordle_get_doc', 'nordle_compose_page', 'nordle_update_layer', 'nordle_set_copy', 'nordle_render', 'nordle_critique', 'nordle_check'];

  const out = [];
  out.push(`# ${how === 'revise' ? 'Revise' : 'Build'} the ${item.format}: "${item.title}"`, '');
  out.push(`Brand: ${p.brand.name ?? p.id} (project "${p.id}"). Calendar item \`${item.id}\`, planned for ${item.date} (${weekdayName(item.date)})${item.time ? ` at ${item.time}` : ''}, pillar ${item.pillar ?? 'unassigned'}. Today is ${day}${diffDays(day, item.date) >= 0 ? `, ${diffDays(day, item.date)} day(s) before it goes out` : ''}. The owner ${how === 'revise' ? 'sent this post back with changes' : 'approved this idea'}; you are the designer. ${how === 'revise' ? 'Change the existing post, do not start again.' : 'Make a finished, checked post.'} You never post, approve or sign off anything.`, '');

  out.push('## The brief', '');
  const brief = [['Idea', item.idea], ['Hook', item.hook], ['Audience', item.audience ?? p.brand.voice?.audience], ['Occasion', item.occasion], ['Media plan', item.mediaPlan], ['Extra guidance from the owner (follow it)', item.guidance], ['Notes', item.notes]].filter(([, v]) => v);
  out.push(...brief.map(([k, v]) => `- ${k}: ${v}`));
  out.push(...reelPromptLines(item));
  if (how === 'revise') {
    const open = (item.feedback ?? []).filter((f) => !f.resolved).map((f) => `(${f.at.slice(0, 10)}) ${f.comment}`);
    for (const l of String(item.notes ?? '').split('\n')) if (/^Changes requested:/i.test(l)) open.push(l.replace(/^Changes requested:\s*/i, ''));   // how the Studio records it when there is no review file
    out.push('', '### What the owner asked to change', '', ...(open.length ? open.map((c) => `- ${c}`) : ['- (no written comment: read the open pins with nordle_get_feedback)']));
    out.push('Also call `nordle_get_feedback` for the pins and comments on the document, answer each with `nordle_reply`, and `nordle_resolve` the ones you fixed.');
  }
  out.push(...stockLines(stock, item));
  out.push('', '## Read first', '');
  out.push('- `nordle_get_guide` (once), `nordle_get_brand`, and in the project folder: brand.json, facts.json, `assets/catalog.json` and `sources/catalog.json` (what each photo and clip really shows), STRATEGY.md if present.');
  out.push('- Voice: ' + brandLines(p.brand, p.facts).slice(0, 5).join(' | '));
  out.push('- Use only facts.json for anything about the business (with a source). Use only media that has a catalog entry whose description supports the words you put on it.', '');

  out.push('## Toolchain', '');
  const specFile = join(resolve(projectDir), 'specs', `${docId}.json`);
  const haveSpec = existsSync(specFile);
  const helpers = projectHelpers(projectDir);
  if (how === 'revise') {
    out.push('Make the smallest change that does what the owner asked, and leave everything else exactly as it is: same words, same photos, same timing wherever they did not ask for a change. Do not rebuild the post from scratch.');
    out.push(`If a request cannot be met truthfully with what is in this project (for example the photo or clip asked for is not in \`assets/catalog.json\` or \`sources/catalog.json\`, or the wording would break a rule below), do NOT invent or substitute something that is not true: answer that comment with \`nordle_reply\`, saying exactly what is missing and what you would need, leave it open (do not resolve it), and still make every other change you can.`);
  }
  if (item.format === 'reel') {
    out.push(`This is a video post (document kind "video", size ${reelSizeOf(item)}).`);
    if (how === 'revise' && haveSpec) {
      out.push(`Its reel spec is \`${proj}/specs/${docId}.json\`. Edit the spec (for example the clip's start time, speed, crop or the photo behind a card), then rebuild it with the reel command, never with \`build\`:`);
      out.push('```', `${cli} reel "${proj}" "${proj}/specs/${docId}.json" --render`, '```');
      out.push('Look at the stills it writes (and the sheet) yourself. A pinned note at a time in the video (for example "0:02") means that moment of the finished reel.');
    }
    if (videoTools.length && how === 'revise') {
      out.push(`Video tools installed here: ${videoTools.join(', ')}.${videoGuide} Footage comes only from the catalogued sources (never invent a clip), music only from the owner's library mount. Keep the document id "${docId}" and its brief as they are.`);
    } else if (videoTools.length && item.reel?.style && item.reel.style !== 'footage') {
      out.push(`Video tools installed here: ${videoTools.join(', ')}.${videoGuide} This reel is made of motion graphics (see the reel style above), so write a reel spec of \`card\` and \`end\` scenes with animated layers (header of src/shared/reel-spec.mjs) and build it with the reel command, never with \`build\`:`);
      out.push('```', `${cli} reel "${proj}" "${proj}/specs/${docId}.json" --sheet`, '```');
      if (setBrief) out.push('Write the brief first with nordle_set_brief (goal, audience, message, must-avoid).');
      out.push(`Make the document id "${docId}" and set its \`brief.calendarItem\` to "${item.id}" and \`brief.postDate\` to "${item.date}". Look at the sheet it writes.`);
    } else if (videoTools.length) {
      out.push(`Video tools installed here: ${videoTools.join(', ')}.${videoGuide} Read their descriptions and \`nordle_get_guide\`, then cut real footage from the catalogued sources: transcribe, choose whole sentences, add word-timed captions, cutaways that fit what is being said, music only from the owner's library mount.`);
      if (setBrief) out.push(`Write the brief first with nordle_set_brief (goal, audience, message, must-avoid).`);
      out.push(`Make the document id "${docId}" and set its \`brief.calendarItem\` to "${item.id}" and \`brief.postDate\` to "${item.date}".`);
    } else {
      out.push(`There are no video tools in this copy of Nordle yet. Do NOT improvise a reel by other means. Set the item's notes to say a reel cannot be built here (use nordle_calendar_update), and stop.`);
    }
  } else if (helpers.length) {
    out.push(`This is a ${item.format === 'carousel' ? 'carousel' : 'single graphic'} (size ${SIZE_FOR[item.format] ?? 'ig-feed-4x5'}). This project has a house look that a plain \`build\` DROPS (and overwrites the saved document with), so do NOT run \`nordle build\` on it. The project's own helper scripts build it:`);
    out.push(...helpers.map((hp) => `- \`specs/${hp.file}\`${hp.usage ? `: \`${hp.usage}\`` : ''}`));
    out.push(`Read the first lines of the helper that covers this post, edit ${haveSpec ? `its spec \`${proj}/specs/${docId}.json\`` : `(or write) its spec \`${proj}/specs/${docId}.json\``} and any page content the owner asked about, and rebuild by running the helper with the document id "${docId}" (from the Nordle folder, \`node\` only). Look at every page of the sheet it writes.`);
    if (!haveSpec) out.push(`Spec shape (see src/shared/build-spec.mjs and the other specs in that folder): { "id": "${docId}", "title": "...", "kind": "${kind === 'carousel' ? 'carousel' : 'graphic'}", "sizes": ["${SIZE_FOR[item.format] ?? 'ig-feed-4x5'}"], "brief": { ..., "calendarItem": "${item.id}", "postDate": "${item.date}" }, "copy": { "caption": "...", "cta": "...", "hashtags": ["#..."] }, "pages": [ ... ] }. Patterns: ${Object.keys(PATTERNS).join(', ')}.`);
  } else {
    out.push(`This is a ${item.format === 'carousel' ? 'carousel' : 'single graphic'} (size ${SIZE_FOR[item.format] ?? 'ig-feed-4x5'}). ${haveSpec ? `Edit its spec \`${proj}/specs/${docId}.json\`` : `Write a post spec to \`${proj}/specs/${docId}.json\``}, then build it:`);
    out.push('```', `${cli} build "${proj}" "${proj}/specs/${docId}.json" --sheet`, '```');
    out.push(`Spec shape (see src/shared/build-spec.mjs): { "id": "${docId}", "title": "...", "kind": "${kind === 'carousel' ? 'carousel' : 'graphic'}", "sizes": ["${SIZE_FOR[item.format] ?? 'ig-feed-4x5'}"], "brief": { "goal": "...", "audience": "...", "message": "...", "mustAvoid": [...], "calendarItem": "${item.id}", "postDate": "${item.date}" }, "copy": { "caption": "...", "cta": "...", "hashtags": ["#..."] }, "pages": [ { "id": "cover", "pattern": "cover", "alt": "...", "content": { "headline": "...", "image": "assets/photos/x.jpg", "imageAlt": "..." } } ] }`);
    out.push(`Patterns: ${Object.keys(PATTERNS).join(', ')}. Putting \`brief.calendarItem\` in the spec links the item for you. Refine with ${staticTools.join(', ')}; look at every page with nordle_render. ${item.format === 'carousel' ? 'Put a real photo on every slide but the last, and make each caption match its photo.' : ''}`.trim());
    out.push('Caption: the hook inside the first ~125 characters, one call to action, hashtags last.');
  }
  out.push('');

  out.push('## Designer self-check (you, before you say done)', '');
  out.push(`The post is not done until these have passed at its final version: ${checkList}.`);
  out.push(`- \`node "${fwd(join(nordleRoot, 'tools', 'validate.mjs'))}" "${proj}/docs/${docId}.json" --assets\` reports 0 errors, nordle_critique scores 88 or more with no errors, and you have LOOKED at every page or frame and judged it against the brief.`);
  out.push('- Every photo and clip has a catalog entry and its description supports the words on it. Every figure, name and claim traces to facts.json or the footage.');
  out.push('- Caption and on-screen text are true, on-brand, free of banned phrases and of anything in the rules below.');
  if (kind === 'video') out.push('- No speaker is cut mid-sentence; cutaways fit the words; audio levels are sane.');
  out.push(`- Record each check you really performed as by "designer", ${verifyTools.length ? `using ${verifyTools.join(', ')}` : 'using the check-recording tool if this install has one'}. Never record a check you did not do.`, '');

  out.push('## Independent review (a fresh pair of eyes)', '');
  out.push(`Start a separate reviewer with the Agent tool, in a fresh context: give it only the project id, the document id "${docId}", the brief above and the rules below, not your reasoning. It looks at the rendered result (or frames) itself, checks the words against the media and the brief, and records its checks as by "reviewer". Fix everything it finds, then have it look again (at most two rounds). If you cannot start a reviewer, say so in the item's notes and in your final message: never record reviewer checks yourself.`, '');

  out.push('## Rules that always apply', '', ...contentRules({ regulated, facts: p.facts, brand: p.brand }).map((r) => `- ${r}`), '');
  out.push('## Finish', '');
  out.push(`- The item must point at the finished document and be marked built: building through the spec does this, otherwise call \`nordle_calendar_link\` with project "${p.id}", item "${item.id}", doc "${docId}".`);
  out.push('- Do not approve, reject, sign off or change the status of anything else. The owner signs off.');
  out.push('- End with a short report: what you made, the critique score, which checks passed, and anything you were not sure of (say so plainly).');
  return `${out.join('\n')}\n`;
}
