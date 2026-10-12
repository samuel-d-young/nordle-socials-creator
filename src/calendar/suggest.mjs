// Options for the next posts, worked out from what Nordle already knows about a brand, so the "Create" page can offer something concrete at once:
//   - the brand's own facts (its team and its services become "Meet ..." and "What to expect: ..." posts; nothing is invented),
//   - the occasions in the month (awareness days, seasons) that are fine to post on,
//   - the monthly mix still missing (reels, carousels, posts) and the themes (pillars) that are behind,
//   - what worked, once results are connected: the formats and themes that scored best on this account's own history.
// These are SKELETONS (a title, a one-line idea, a format, a date, and why). They are honest starting points the owner picks from; Claude writes
// the real hooks and builds the posts when they are approved. Nothing here writes to the calendar: the Studio adds the ones the person ticks.

import { loadProject } from './service.mjs';
import { DEFAULT_WEEKDAYS, FORMATS, monthCounts, needFor, quotaTotal, similarity, spreadSlots } from './plan.mjs';
import { addDays, addMonths, monthEnd, monthName, monthOf, monthStart } from './dates.mjs';
import { occasionsBetween } from './occasions.mjs';
import { buildRows, MIN_N, segmentRows } from '../performance/analyze.mjs';
import { proposePrompt } from './prompts.mjs';

export const STYLES = [
  { id: 'team', label: 'Meet the team', hint: 'The people behind the brand', formats: ['reel', 'post'], pillar: /team|people|meet|staff|culture/i },
  { id: 'educate', label: 'Explain something', hint: 'What it is, what to expect', formats: ['carousel', 'reel'], pillar: /educ|explain|learn|how|guide|tips/i },
  { id: 'faq', label: 'Answer a question', hint: 'One real question, answered', formats: ['reel', 'carousel'], pillar: /educ|faq|question|advice/i },
  { id: 'behind', label: 'Behind the scenes', hint: 'How things are really done', formats: ['reel', 'post'], pillar: /behind|process|day|story/i },
  { id: 'seasonal', label: 'Seasons and occasions', hint: 'Dates worth a post', formats: ['post', 'reel'], pillar: /season|occasion|calendar|event/i },
  { id: 'community', label: 'Community and local', hint: 'Your area and what you support', formats: ['post', 'carousel'], pillar: /communit|local|values|charity/i },
  { id: 'invite', label: 'A gentle invitation', hint: 'A soft call to book, call or visit', formats: ['post', 'carousel'], pillar: /promo|offer|service|book|spotlight|invite/i },
];
const STYLE = Object.fromEntries(STYLES.map((s) => [s.id, s]));

const nameOf = (x) => (typeof x === 'string' ? x : x?.name ?? '');
const lc = (s) => String(s ?? '').toLowerCase();

/** What each style can say, from the brand's own facts. Every line is generic enough to be true, and says where a real detail must come from. */
function topicsFor(style, ctx) {
  const { facts, brandName } = ctx;
  const staff = (facts?.staff ?? []).filter((s) => s?.name);
  const services = (facts?.services ?? []).map(nameOf).filter(Boolean);
  switch (style) {
    case 'team':
      return staff.length
        ? [...staff.map((s) => ({ title: `Meet ${s.name}`, idea: `A short, warm introduction to ${s.name}${s.title ? `, ${s.title}` : ''}: what a normal day looks like and what they enjoy about the work. Only details ${s.name} has agreed to share.`, hook: `Meet ${s.name}.` })),
          ...staff.slice(0, 4).map((s) => ({ title: `A day with ${s.name}`, idea: `Follow ${s.name} through one ordinary part of their day, with simple captions. Only what ${s.name} is happy to show.`, hook: `A day with ${s.name}.` }))]
        : [{ title: 'Meet the team', idea: `Introduce one person at ${brandName} by name and role (from facts.json), what they do each day, and what they enjoy. Only details they have agreed to share.`, hook: 'Meet the people behind the name.' }];
    case 'educate':
      return services.length
        ? [...services.map((sv) => ({ title: `${sv}: what to expect`, idea: `Explain ${sv} in plain words: what happens, what to ask, how to prepare. Informational only, with no promises about results.`, hook: `What actually happens with ${lc(sv)}?` })),
          ...services.slice(0, 6).map((sv) => ({ title: `Questions about ${lc(sv)}`, idea: `Answer the three questions customers ask most about ${sv}, one slide or one sentence each. Informational only.`, hook: `Three questions about ${lc(sv)}.` }))]
        : [{ title: 'A plain-words explainer', idea: `Pick the one thing customers ask ${brandName} about most and explain it simply, step by step. Informational only.`, hook: 'Here is the simple version.' }];
    case 'faq':
      return [{ title: 'Your question, answered', idea: `Take one real question a customer asked ${brandName} recently and answer it in under 30 seconds, in the brand's own voice.`, hook: 'A question we get all the time.' },
        { title: 'Myth or fact?', idea: 'Name one common belief about the business\'s field and say what is true, with nothing that cannot be backed up.', hook: 'Myth or fact?' }];
    case 'behind':
      return [{ title: 'Behind the scenes', idea: `Show how a normal day starts at ${brandName}: the place, the people, the preparation. No customers identifiable.`, hook: 'How a normal day starts here.' },
        { title: 'How it is made', idea: `Follow one job from start to finish at ${brandName}, in order, with simple captions.`, hook: 'Start to finish, in order.' }];
    case 'seasonal':
      return (ctx.occasions ?? []).map((o) => ({ title: o.name, idea: `Tie in with ${o.name} (${o.date}) in a way that is true to ${brandName}.${o.caution ? ` Care: ${o.caution}` : ''} Say where the date comes from.`, hook: `${o.name}.`, date: o.date, occasion: o.id ?? o.name }));
    case 'community':
      return [{ title: 'Thank you, locals', idea: `Say a real thank-you to the community around ${brandName}: a milestone, a local group, an event. Only what is true.`, hook: 'Thank you.' }, { title: 'Our local area', idea: `Highlight something real in ${brandName}'s area: a local event, club, cause or business it genuinely supports. Name only what is true.`, hook: 'Why we love working here.' }];
    case 'invite':
      return [{ title: 'A reminder from us', idea: `A short, friendly reminder of what ${brandName} offers and how to get in touch, from facts.json only. One call to action.`, hook: 'A friendly reminder.' }, { title: 'Book your next visit', idea: `A gentle invitation to get in touch with ${brandName}, using only the contact details and calls to action in facts.json. One call to action, no pressure and no promises.`, hook: 'When you are ready, we are here.' }];
    default: return [];
  }
}

/**
 * The formats and themes that did best on this account's own history, once results exist.
 * Themes and openings are compared by Nordle's score, which already measures a post against others of its own format. Formats cannot be, so they are
 * compared by what share of the people reached saved, shared, commented or liked: a rate that means the same on a reel and on a carousel.
 */
export function learnFrom(projectDir, { today } = {}) {
  let rows;
  try { rows = buildRows(projectDir, { window: '7d', today }).rows.filter((r) => r.score !== null); } catch { return null; }
  if (rows.length < MIN_N) return { connected: false, posts: rows.length, needed: MIN_N };
  const seg = segmentRows(rows);
  const best = (dim) => {
    const g = (seg[dim]?.groups ?? []).filter((x) => x.n >= 2 && x.key !== '(no pillar)');
    const top = g[0];
    if (!top || g.length < 2) return null;
    const rest = g.slice(1);
    const restMedian = rest.reduce((t, x) => t + x.median * x.n, 0) / rest.reduce((t, x) => t + x.n, 0);
    return { key: top.key, n: top.n, median: top.median, rest: Math.round(restMedian), evidence: top.evidence?.level ?? 'directional', ahead: top.median - restMedian, unit: 'score' };
  };
  const rate = (r) => { const m = r.metrics ?? {}; const reach = Number(m.reach ?? m.views ?? 0); return reach > 0 ? ((m.likes ?? 0) + (m.comments ?? 0) + (m.shares ?? 0) + (m.saves ?? 0)) / reach : null; };
  const byFormat = new Map();
  for (const r of rows) { const v = rate(r); if (v !== null) (byFormat.get(r.format) ?? byFormat.set(r.format, []).get(r.format)).push(v); }
  const med = (xs) => { const a = [...xs].sort((x, y) => x - y); const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  const fmts = [...byFormat].filter(([, v]) => v.length >= 2).map(([key, v]) => ({ key, n: v.length, med: med(v) })).sort((x, y) => y.med - x.med);
  let format = null;
  if (fmts.length >= 2) {
    const rest = fmts.slice(1);
    const restMed = rest.reduce((t, x) => t + x.med * x.n, 0) / rest.reduce((t, x) => t + x.n, 0);
    format = { key: fmts[0].key, n: fmts[0].n, median: Math.round(fmts[0].med * 1000) / 10, rest: Math.round(restMed * 1000) / 10, ratio: restMed > 0 ? fmts[0].med / restMed : null, ahead: restMed > 0 ? (fmts[0].med / restMed - 1) * 100 : 0, unit: '% of people reached engaged', evidence: 'directional' };
  }
  const ranked = [...rows].sort((a, b) => b.score - a.score);
  return {
    connected: true, posts: rows.length,
    format, pillar: best('pillar'), hookType: best('hookType'),
    top: ranked.slice(0, 3).map((r) => ({ id: r.id, title: r.title ?? r.id, score: Math.round(r.score), format: r.format, pillar: r.pillar ?? null })),
  };
}

const sayLearned = (l) => {
  if (!l?.connected) return null;
  const bits = [];
  if (l.format && l.format.ratio >= 1.25) bits.push(`${l.format.key} (format): ${l.format.median}% of the people reached engaged, against ${l.format.rest}% for the rest`);
  for (const [label, g] of [['theme', l.pillar], ['opening', l.hookType]]) if (g && g.ahead >= 5) bits.push(`${g.key} (${label}) scored ${g.median} against ${g.rest} for the rest`);
  return bits.length ? `On your own results, ${bits.join('; ')}.` : null;
};

/**
 * @param {string} projectDir
 * @param {{ month?: string, count?: number, decide?: boolean, formats?: string[], styles?: string[], learn?: boolean, prompt?: string, today?: string, regions?: string[] }} [o]
 */
export function suggestOptions(projectDir, o = {}) {
  const p = loadProject(projectDir);
  const today = o.today ?? p.today;
  const month = /^\d{4}-\d{2}$/.test(o.month ?? '') ? o.month : monthOf(addMonths(monthOf(today), 1));
  const quota = p.settings.perMonth;
  const have = monthCounts(p.cal.items, month);
  const need = needFor(quota, have.counts);
  const needTotal = Object.values(need).reduce((t, n) => t + n, 0);
  const formatsAsked = (o.formats ?? []).filter((f) => FORMATS.includes(f));
  const stylesAsked = (o.styles ?? []).filter((s) => STYLE[s]);
  const count = Math.max(1, Math.min(30, Math.round(o.decide || !o.count ? (needTotal || quotaTotal(quota) || 8) : Number(o.count))));
  const learned = o.learn === false ? null : learnFrom(projectDir, { today });
  const learnedLine = sayLearned(learned);

  // how many of each format: asked for, or what the month is missing, leaning toward the format that has done best
  let want = {};
  if (formatsAsked.length) formatsAsked.forEach((f, i) => { want[f] = Math.floor(count / formatsAsked.length) + (i < count % formatsAsked.length ? 1 : 0); });
  else {
    const base = Object.fromEntries(FORMATS.map((f) => [f, need[f] ?? 0]));
    const total = Object.values(base).reduce((t, n) => t + n, 0);
    if (total === 0) { const q = quota; const qt = quotaTotal(q) || 1; for (const f of FORMATS) base[f] = Math.round(((q[f] ?? 0) / qt) * count); }
    const scale = count / (Object.values(base).reduce((t, n) => t + n, 0) || 1);
    want = Object.fromEntries(FORMATS.map((f) => [f, Math.round(base[f] * scale)]));
    let diff = count - Object.values(want).reduce((t, n) => t + n, 0);
    const lean = learned?.format && learned.format.ratio >= 1.25 && FORMATS.includes(learned.format.key) ? learned.format.key : (FORMATS.find((f) => want[f] > 0) ?? 'reel');
    want[lean] = (want[lean] ?? 0) + diff;
    if (want[lean] < 0) { want[lean] = 0; }
    // the format that did clearly best gets a bigger share (about a fifth of the month moves to it); the quota only sets the starting point
    if (learned?.format && learned.format.ratio >= 1.25 && lean === learned.format.key) {
      let shift = Math.max(1, Math.round(count * 0.2));
      for (const f of Object.keys(want).filter((x) => x !== lean).sort((a, b) => want[b] - want[a])) { while (shift > 0 && want[f] > 1) { want[f]--; want[lean]++; shift--; } }
    }
  }
  for (const f of FORMATS) if (!want[f] || want[f] < 0) delete want[f];

  // dates: free weekdays in the month, not in the past, not on a day the calendar should stay quiet
  const quiet = occasionsBetween(monthStart(month), monthEnd(month), { regions: p.settings.regions.length ? p.settings.regions : ['AU'] }).filter((x) => ['closed', 'respectful'].includes(x.advice));
  const avoid = [];
  for (let d = monthStart(month); d <= monthEnd(month); d = addDays(d, 1)) if (d <= today) avoid.push(d);
  for (const x of quiet) for (let d = x.date; d <= x.end; d = addDays(d, 1)) avoid.push(d);
  const wanted = Object.fromEntries(FORMATS.map((f) => [f, (have.counts[f] ?? 0) + (want[f] ?? 0)]));
  const slots = spreadSlots(month, { perMonth: wanted, weekdays: DEFAULT_WEEKDAYS, postTimes: p.settings.postTimes, avoidDates: avoid, existing: p.cal.items });
  const freeSlots = { ...Object.fromEntries(FORMATS.map((f) => [f, slots.filter((s) => s.format === f)])) };

  // topics, interleaved across the styles so a month is varied; a style that did well on your own results comes up more often
  const occasions = occasionsBetween(monthStart(month), monthEnd(month), { regions: p.settings.regions, minRelevance: 'high' }).filter((x) => x.advice === 'post-ok' || !x.advice).filter((x) => x.date > today);
  const ctx = { facts: p.facts, brandName: p.brand.name ?? p.id, occasions };
  const styles = (stylesAsked.length ? stylesAsked : STYLES.map((s) => s.id)).filter((s) => s !== 'seasonal' || occasions.length);
  const winning = learned?.pillar?.key ? String(learned.pillar.key) : '';
  const order = [...styles].sort((a, b) => (STYLE[b].pillar.test(winning) ? 1 : 0) - (STYLE[a].pillar.test(winning) ? 1 : 0));
  const queues = order.map((s) => ({ style: s, topics: topicsFor(s, ctx).filter((t) => !p.cal.items.some((it) => monthOf(it.date) === month && lc(it.title) === lc(t.title) || similarity(it.title, t.title) > 0.7 || similarity(`${it.title} ${it.idea ?? ''}`, `${t.title} ${t.idea}`) > 0.6)) }));
  const options = [];
  const used = new Set();
  const pillars = p.settings.pillars ?? [];
  const pillarFor = (style) => { const hit = pillars.find((pl) => STYLE[style].pillar.test(`${pl.id} ${pl.name ?? ''}`)); return hit?.id; };
  for (let round = 0; options.length < count && round < 12; round++) {
    let progressed = false;
    for (const q of queues) {
      if (options.length >= count) break;
      const t = q.topics[round];
      if (!t) continue;
      progressed = true;
      const prefer = [...STYLE[q.style].formats, ...FORMATS];
      const left = (f) => (want[f] ?? 0) - options.filter((x) => x.format === f).length;
      const format = prefer.find((f) => left(f) > 0);
      if (!format) continue;
      const slot = t.date && t.date > today && !avoid.includes(t.date) ? { date: t.date, time: p.settings.postTimes[0] } : freeSlots[format]?.shift();
      if (!slot) continue;
      options.push({
        id: `opt-${options.length + 1}`, date: slot.date, time: slot.time, format, title: t.title, idea: t.idea, hook: t.hook, pillar: pillarFor(q.style) ?? undefined,
        occasion: t.occasion, style: q.style, styleLabel: STYLE[q.style].label,
        why: q.style === 'seasonal' ? `${t.title} falls on ${t.date}.` : learnedLine && STYLE[q.style].pillar.test(winning) ? `A theme that did well on your own results. ${learnedLine}` : `${STYLE[q.style].hint}.${(need[format] ?? 0) > 0 ? ` ${monthName(month)} is still missing ${format === 'post' ? 'posts' : `${format}s`}.` : ''}`,
      });
    }
    if (!progressed) break;
  }
  options.sort((a, b) => a.date.localeCompare(b.date));
  options.forEach((x, i) => { x.id = `opt-${i + 1}`; });

  const ask = [
    '', '## What the owner asked for on the Create page', '',
    `- Posts wanted: ${count}${o.decide || !o.count ? ' (the owner said "decide for me")' : ''}. Formats: ${formatsAsked.length ? formatsAsked.join(', ') : 'your choice, to fill the monthly mix'}.`,
    `- Styles: ${stylesAsked.length ? stylesAsked.map((s) => STYLE[s].label).join(', ') : 'a varied mix'}.`,
    ...(o.prompt?.trim() ? [`- In the owner's words: "${o.prompt.trim().slice(0, 1200)}"`] : []),
    ...(learned?.connected ? ['- What worked (their own results, never proof of cause): ' + (learnedLine ?? 'no clear winner yet.'), ...learned.top.map((t) => `  - top post: "${t.title}" (${t.format}, score ${t.score})`), '  Make more in that spirit, and say what you are testing.'] : ['- No results are connected yet, so base the ideas on the brand, its facts and the occasions.']),
    '- Starting points the Studio already worked out (improve them, replace the weak ones, keep the dates unless a better one exists):',
    ...options.map((x) => `  - ${x.date} ${x.format}: ${x.title} -- ${x.idea}`),
  ].join('\n');
  let request = '';
  try { request = proposePrompt(projectDir, { months: [month], today }) + ask; } catch { request = `Please propose ${count} post ideas for ${p.brand.name ?? p.id} for ${monthName(month)}.${ask}`; }

  const short = options.length < count ? `Only ${options.length} of the ${count} options could be made from what Nordle knows about this brand. Add its team and services to facts.json for more, or press Ask Claude to write the rest.` : null;
  return { project: p.id, short, ask, brand: p.brand.name ?? p.id, month, monthLabel: monthName(month), count, decided: !!(o.decide || !o.count), want, need, haveCounts: have.counts, options, learned, learnedLine, styles: STYLES.map(({ id, label, hint }) => ({ id, label, hint })), request };
}
