// Options for a campaign: a named push (a launch, a sale, an awareness week) with a goal, a window of dates, one message and one thing it asks people to do.
// The posts are made first and scheduled later: they land on the calendar as ideas (or approved), tied to the campaign, and nothing is sent anywhere until
// the owner schedules them. Like suggest.mjs these are honest skeletons built from what the owner wrote and the brand's own facts; Claude writes the real hooks.

import { CalendarError, loadProject } from './service.mjs';
import { FORMATS, similarity } from './plan.mjs';
import { addDays, diffDays, weekday } from './dates.mjs';
import { proposePrompt } from './prompts.mjs';
import { learnFrom } from './suggest.mjs';
import { monthOf } from './dates.mjs';

const clean = (s) => String(s ?? '').trim();

/** What a campaign can say, in the order it unfolds: tell people, say why, give the details, show the people, answer a question, remind, last call. */
function topics(c, ctx) {
  const name = c.name;
  const msg = clean(c.message), goal = clean(c.goal), cta = clean(c.cta);
  const staff = (ctx.facts?.staff ?? []).filter((s) => s?.name);
  const ask = cta ? ` One call to action: ${cta}.` : ' One clear call to action, from facts.json only.';
  const list = [
    { phase: 'start', title: `${name}: it starts now`, idea: `Announce ${name}.${msg ? ` The one message: ${msg}` : ''}${ask}`, hook: `${name} starts today.`, formats: ['reel', 'post'] },
    { phase: 'early', title: `Why ${name}`, idea: `Say why ${name} matters${goal ? `: ${goal}` : ''}. Plain words, one reason, nothing that cannot be backed up.`, hook: `Why we are doing ${name}.`, formats: ['carousel', 'reel'] },
    { phase: 'early', title: `${name}: what to know`, idea: `The practical details of ${name} (when, where, how to take part), using only what is in facts.json or the owner's notes.${ask}`, hook: `What to know about ${name}.`, formats: ['carousel', 'post'] },
    { phase: 'mid', title: staff.length ? `${staff[0].name} on ${name}` : `The people behind ${name}`, idea: `A person from ${ctx.brandName} talks about ${name} in their own words. Only what they have agreed to share.`, hook: staff.length ? `${staff[0].name} on ${name}.` : `Meet the people behind ${name}.`, formats: ['reel', 'post'] },
    { phase: 'mid', title: `${name}: your questions`, idea: `Answer the question people ask most about ${name}, in under 30 seconds, in the brand's voice.`, hook: `Asked about ${name}? Here is the answer.`, formats: ['reel', 'carousel'] },
    { phase: 'mid', title: `${name}: behind the scenes`, idea: `Show how ${name} comes together at ${ctx.brandName}: the preparation, the place, the people. No customers identifiable.`, hook: `How ${name} comes together.`, formats: ['reel', 'post'] },
    { phase: 'mid', title: `${name}: a closer look`, idea: `One detail of ${name} in depth, one slide or one sentence each.${msg ? ` Keep returning to: ${msg}` : ''}`, hook: `A closer look at ${name}.`, formats: ['carousel', 'reel'] },
    { phase: 'late', title: `${name}: a reminder`, idea: `A friendly reminder that ${name} is on, and how to take part.${ask}`, hook: `A reminder about ${name}.`, formats: ['post', 'reel'] },
    { phase: 'end', title: c.end ? `${name}: the final days` : `${name}: last call`, idea: `${c.end ? `${name} ends on ${c.end}.` : `Time is running short.`} Say so once, plainly, without pressure.${ask}`, hook: c.end ? `${name} ends soon.` : `Last call for ${name}.`, formats: ['post', 'reel'] },
  ];
  return list;
}

/**
 * @param {string} projectDir
 * @param {{ campaign: string, count?: number, decide?: boolean, formats?: string[], prompt?: string, today?: string, learn?: boolean }} o
 */
export function suggestForCampaign(projectDir, o = {}) {
  const p = loadProject(projectDir);
  const today = o.today ?? p.today;
  const camp = (p.cal.campaigns ?? []).find((c) => c.id === o.campaign);
  if (!camp) throw new CalendarError(404, 'No such campaign.');
  const start = camp.start && camp.start > today ? camp.start : addDays(today, 1);
  const end = camp.end && camp.end >= start ? camp.end : addDays(start, 27);
  const span = Math.max(1, diffDays(start, end) + 1);
  const formatsAsked = (o.formats ?? []).filter((f) => FORMATS.includes(f));
  const defaultCount = Math.min(10, Math.max(3, Math.ceil(span / 3)));
  const count = Math.max(1, Math.min(30, Math.round(o.decide || !o.count ? defaultCount : Number(o.count))));
  const learned = o.learn === false ? null : learnFrom(projectDir, { today });

  // free weekdays inside the window; the first post goes at the start and the last at the end, the rest spread between
  const free = [];
  const taken = new Set((p.cal.items ?? []).map((i) => i.date));
  for (let d = start; d <= end; d = addDays(d, 1)) { const wd = weekday(d); if (wd !== 0 && wd !== 6) free.push(d); }
  const pool = free.filter((d) => !taken.has(d)).length >= count ? free.filter((d) => !taken.has(d)) : free;
  const picks = [];
  for (let i = 0; i < Math.min(count, pool.length || count); i++) picks.push(pool.length ? pool[Math.round((i * (pool.length - 1)) / Math.max(1, count - 1))] : addDays(start, i));
  const dates = [...new Set(picks)];
  while (dates.length < count) dates.push(addDays(dates.at(-1) ?? start, 1));

  const ctx = { facts: p.facts, brandName: p.brand.name ?? p.id };
  const all = topics(camp, ctx);
  // the first and last are fixed, the middle ones fill in between
  const first = all[0], last = all.at(-1);
  const middle = all.slice(1, -1).filter((t) => !p.cal.items.some((it) => it.campaign === camp.id && similarity(it.title, t.title) > 0.7));
  const chosen = count === 1 ? [first] : [first, ...middle.slice(0, Math.max(0, count - 2)), ...(count >= 2 ? [last] : [])].slice(0, count);
  const cycle = formatsAsked.length ? formatsAsked : null;
  const options = chosen.map((t, i) => {
    const format = cycle ? cycle[i % cycle.length] : t.formats[0];
    return {
      id: `opt-${i + 1}`, date: dates[Math.min(i, dates.length - 1)], format, title: t.title, idea: t.idea, hook: t.hook, campaign: camp.id,
      style: 'campaign', styleLabel: 'Campaign', why: `Part of ${camp.name}${camp.goal ? ` (${camp.goal.slice(0, 80)})` : ''}. ${t.phase === 'start' ? 'It opens the campaign.' : t.phase === 'end' ? 'It closes the campaign.' : 'It keeps the message in front of people.'}`,
    };
  });
  options.sort((a, b) => a.date.localeCompare(b.date));
  options.forEach((x, i) => { x.id = `opt-${i + 1}`; });

  const ask = [
    '', `## The campaign: ${camp.name} (id "${camp.id}")`, '',
    ...(camp.goal ? [`- Goal: ${camp.goal}`] : []), `- Runs: ${start} to ${end}`, ...(camp.message ? [`- The one message: ${camp.message}`] : []), ...(camp.cta ? [`- What it asks people to do: ${camp.cta}`] : []), ...(camp.notes ? [`- Notes: ${camp.notes}`] : []),
    `- Every idea you propose for it must carry campaign: "${camp.id}" and a date inside the window. Posts are made first and scheduled later: leave them as ideas for the owner.`,
    `- Posts wanted: ${count}. Formats: ${formatsAsked.length ? formatsAsked.join(', ') : 'your choice, a mix'}.`,
    ...(o.prompt?.trim() ? [`- In the owner's words: "${o.prompt.trim().slice(0, 1200)}"`] : []),
    '- Starting points the Studio already worked out (improve them, replace the weak ones):', ...options.map((x) => `  - ${x.date} ${x.format}: ${x.title} -- ${x.idea}`),
  ].join('\n');
  let request = '';
  try { request = proposePrompt(projectDir, { months: [monthOf(start)], today }) + ask; } catch { request = `Please propose ${count} post ideas for the campaign "${camp.name}" for ${p.brand.name ?? p.id}.${ask}`; }
  return { project: p.id, brand: p.brand.name ?? p.id, campaign: camp, month: monthOf(start), monthLabel: camp.name, count, decided: !!(o.decide || !o.count), want: {}, options, learned, learnedLine: null, ask, request, short: options.length < count ? `Only ${options.length} of the ${count} options could be made for this campaign. Press Ask Claude now for the rest.` : null, styles: [] };
}
