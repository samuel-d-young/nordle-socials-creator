// Claude's calendar tools: read the plan, propose ideas, tidy them, find what is due, get the prompt to build one, and link
// a finished post to its item. They call the server's calendar routes with Claude's token, so the owner-only steps
// (approve, reject, sign off, request changes, settings) are not here and cannot be done through these tools.

const IDEA = {
  type: 'object',
  properties: {
    date: { type: 'string', description: 'The day it goes out, YYYY-MM-DD, in the brand\'s timezone. Not in the past.' },
    time: { type: 'string', description: 'HH:MM, optional (the calendar\'s post times are used otherwise).' },
    format: { type: 'string', enum: ['reel', 'carousel', 'post', 'story'] },
    title: { type: 'string', description: 'A short working title, under 140 characters.' },
    pillar: { type: 'string', description: 'A pillar id from nordle_calendar_get (effective.pillars).' },
    idea: { type: 'string', description: 'One or two sentences: what it says, why this audience cares, what makes it true.' },
    hook: { type: 'string', description: 'The first line or first second: a reason to stop scrolling, under about 125 characters.' },
    audience: { type: 'string' },
    occasion: { type: 'string', description: 'A date or season it rides on, as named in the occasions list (for example "Melbourne Cup Day").' },
    campaign: { type: 'string', description: 'The id of the campaign this idea belongs to (calendar.campaigns in nordle_calendar_get). Leave it out for an ordinary post.' },
    mediaPlan: { type: 'string', description: 'Which catalogued photos or clips will carry it. Only plan media that exists.' },
    guidance: { type: 'string', description: 'Extra information from the owner to steer this post (what to stress, who to feature, what to avoid). Copy it from the words the owner used; do not invent it.' },
    reel: { type: 'object', description: 'Reels only. How it is made: { style: auto (Claude decides; the default) | footage | motion (motion graphics only, no footage) | voiceover (motion graphics timed to a voice-over the owner recorded), uses: [footage, photos, stock, voiceover, music, sfx, captions, logo, endcard], seconds }. Leave it out for an ordinary footage reel.', properties: { style: { type: 'string', enum: ['auto', 'footage', 'motion', 'voiceover'] }, uses: { type: 'array', items: { type: 'string', enum: ['footage', 'photos', 'stock', 'voiceover', 'music', 'sfx', 'captions', 'logo', 'endcard'] } }, seconds: { type: 'integer' }, shape: { type: 'string', enum: ['vertical', 'portrait', 'square', 'landscape'], description: 'The picture shape: vertical 9:16 (default), portrait 4:5, square 1:1 or landscape 16:9.' } }, additionalProperties: false },
    notes: { type: 'string' },
  },
  required: ['date', 'format', 'title'],
  additionalProperties: false,
};

const brief = (it) => `${it.id}  ${it.date}${it.time ? ` ${it.time}` : ''}  ${it.format}  [${it.status}]  ${it.title}`;
const issueLines = (xs, prefix) => (xs ?? []).map((x) => `  ${prefix} ${x.rule ?? x.path}: ${x.message}`);

export default (client, { P, READ, EDIT, enc, NordleError }) => {
  const base = (a) => `/projects/${enc(a.project)}/calendar`;
  const qs = (params) => {
    const s = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    return s ? `?${s}` : '';
  };
  return [
    {
      name: 'nordle_calendar_get',
      description: 'Read a project\'s content calendar: the settings (monthly quota, lead days, pillars, regions), every month against its quota (what is still missing), the items in range with their status, which items are due to be built, the checks on each open idea, and the Australian occasions in range (public holidays, awareness days, school holidays; entries marked verify must be confirmed before a post states the date). Start here before proposing or building anything. Items go idea -> approved (by the owner) -> building -> built -> signed-off (by the owner) -> posted.',
      inputSchema: {
        type: 'object',
        properties: {
          project: P, from: { type: 'string', description: 'First day, YYYY-MM-DD. Default: the start of this month.' },
          to: { type: 'string', description: 'Last day, YYYY-MM-DD. Default: the end of the planning horizon.' },
          status: { type: 'string', enum: ['idea', 'approved', 'building', 'built', 'changes', 'signed-off', 'scheduled', 'rejected', 'posted'], description: 'Only items with this status.' },
        },
        required: ['project'], additionalProperties: false,
      },
      annotations: READ,
      async handler(a) {
        const o = await client.get(`${base(a)}${qs({ from: a.from, to: a.to })}`);
        const items = o.calendar.items.filter((i) => i.date >= o.range.from && i.date <= o.range.to && (!a.status || i.status === a.status));
        const lint = Object.fromEntries(Object.entries(o.lint).filter(([id, l]) => (l.errors.length || l.warnings.length) && items.some((i) => i.id === id)).map(([id, l]) => [id, { errors: l.errors.map((e) => e.message), warnings: l.warnings.map((w) => w.message) }]));
        return {
          text: `${o.brandName}: today ${o.today} (${o.timezone}). ${o.months.map((m) => `${m.month} ${m.total}/${m.quotaTotal}${m.missingTotal ? ` (missing ${Object.entries(m.missing).filter(([, n]) => n).map(([f, n]) => `${n} ${f}`).join(', ')})` : ''}`).join('; ')}. ${o.due.length ? `Due now: ${o.due.map((d) => d.id).join(', ')}.` : 'Nothing is due to build.'}`,
          json: { project: o.project, today: o.today, range: o.range, effective: o.effective, months: o.months, items, lint, due: o.due, running: o.running, occasions: o.occasions },
        };
      },
    },
    {
      name: 'nordle_calendar_propose',
      description: 'Propose post ideas for the calendar. Each is checked first: a repeat of an angle or hook within 90 days, a banned phrase, a health-advertising no-go (before/after, testimonials, "painless", "guarantee"...), a date in the past, an unknown pillar, or a month already at its quota is refused with the reason; the rest are saved as status "idea" for the owner to approve, edit or reject in the Studio (or as "approved" when the owner has delegated approval in the settings). Warnings (unsourced figure, occasion date to verify, crowded day) are saved with the idea for you to weigh. Read nordle_calendar_get first, and use nordle_calendar_prompt (kind propose) for the full brief. You cannot approve your own ideas.',
      inputSchema: { type: 'object', properties: { project: P, ideas: { type: 'array', minItems: 1, maxItems: 40, items: IDEA } }, required: ['project', 'ideas'], additionalProperties: false },
      annotations: EDIT,
      async handler(a) {
        const r = await client.post(`${base(a)}/propose`, { ideas: a.ideas });
        const lines = [];
        const delegated = r.added.some((i) => i.status === 'approved');
        lines.push(`${r.added.length} idea${r.added.length === 1 ? '' : 's'} saved${r.added.length ? (delegated ? ' as APPROVED (the owner delegated approval); they will be built as their date nears.' : ' as "idea": they are waiting for the owner to approve them in the Studio. Nothing will be built until they do.') : '.'}`);
        for (const it of r.added) { lines.push(`+ ${brief(it)}`); lines.push(...issueLines(r.warnings[it.id], 'warn')); }
        if (r.rejected.length) lines.push(`${r.rejected.length} refused:`);
        for (const x of r.rejected) { lines.push(`- ${x.input?.date ?? '?'} ${x.input?.format ?? '?'} "${x.input?.title ?? '?'}"`); lines.push(...issueLines(x.errors, 'error')); }
        for (const m of r.months) lines.push(`${m.month}: ${m.total}/${m.quotaTotal} planned${m.missingTotal ? `, missing ${Object.entries(m.missing).filter(([, n]) => n).map(([f, n]) => `${n} ${f}`).join(', ')}` : ', full'}.`);
        return { text: lines.join('\n') };
      },
    },
    {
      name: 'nordle_calendar_update',
      description: 'Change fields on a calendar item: date, time, format, title, pillar, idea, hook, audience, occasion, mediaPlan, notes (null clears one). The same checks as nordle_calendar_propose apply. If you change what an idea the owner already approved says, it goes back to "idea" and the owner has to approve it again. You cannot approve, reject, sign off or request changes, and a built, signed-off or posted item only takes notes.',
      inputSchema: {
        type: 'object',
        properties: { project: P, item: { type: 'string', description: 'The item id from nordle_calendar_get.' }, set: { type: 'object', description: 'Field -> new value.', additionalProperties: { type: ['string', 'null'] } } },
        required: ['project', 'item', 'set'], additionalProperties: false,
      },
      annotations: EDIT,
      async handler(a) {
        const r = await client.post(`${base(a)}/items/${enc(a.item)}`, a.set);
        return { text: [`Updated: ${brief(r.item)}`, ...(r.item.status === 'idea' && a.set && Object.keys(a.set).some((k) => k !== 'notes') ? ['It is an idea: it still needs the owner\'s approval.'] : []), ...issueLines(r.lint?.warnings, 'warn')].join('\n') };
      },
    },
    {
      name: 'nordle_calendar_due',
      description: 'The items to build now: approved ideas whose date is within the lead time (build), and built posts the owner sent back with changes (revise). Empty means nothing to do. Use nordle_calendar_prompt for the full brief of one.',
      inputSchema: { type: 'object', properties: { project: P }, required: ['project'], additionalProperties: false },
      annotations: READ,
      async handler(a) {
        const r = await client.get(`${base(a)}/due`);
        return { text: r.due.length ? `Today ${r.today}, lead ${r.leadDays} days. To do:\n${r.due.map((d) => `- ${d.mode}: ${brief(d.item)}`).join('\n')}` : `Nothing is due (today ${r.today}, lead ${r.leadDays} days).`, json: r };
      },
    },
    {
      name: 'nordle_calendar_prompt',
      description: 'The full brief for a planning job, composed from the project\'s own files: with "item", the instructions to build (or revise) that calendar item into a finished, checked post, including the toolchain, the self-check, the independent review and the content rules; without it, the instructions to propose ideas for the coming months (give "month" as 2026-11 or a comma list). Read it and follow it.',
      inputSchema: {
        type: 'object',
        properties: { project: P, item: { type: 'string', description: 'Calendar item id: get the build brief for it.' }, month: { type: 'string', description: 'For the propose brief: months, e.g. "2026-11" or "2026-11,2026-12".' }, revise: { type: 'boolean', description: 'Build brief only: treat it as a revision of the existing post.' } },
        required: ['project'], additionalProperties: false,
      },
      annotations: READ,
      async handler(a) {
        const r = await client.get(`${base(a)}/prompt${qs({ kind: a.item ? 'build' : 'propose', item: a.item, month: a.month, revise: a.revise ? '1' : undefined })}`);
        return { text: r.prompt };
      },
    },
    {
      name: 'nordle_calendar_link',
      description: 'Tell the calendar that a post has been built for an item: sets the item\'s document and its status to "built", which puts it in front of the owner for sign-off. Only for items the owner approved (approved, building, or sent back with changes). Building from a spec with brief.calendarItem set does this for you. The owner signs off, not you.',
      inputSchema: { type: 'object', properties: { project: P, item: { type: 'string' }, doc: { type: 'string', description: 'The document id in the project (docs/<doc>.json).' } }, required: ['project', 'item', 'doc'], additionalProperties: false },
      annotations: EDIT,
      async handler(a) {
        const r = await client.post(`${base(a)}/items/${enc(a.item)}/link`, { doc: a.doc });
        return { text: `Linked: ${brief(r.item)} -> document "${r.item.doc}". It is now waiting for the owner's sign-off.` };
      },
    },
    {
      name: 'nordle_calendar_slots',
      description: 'The free, evenly spread dates and formats that would bring a month up to its quota (default 8 reels + 3 carousels + 2 posts = 13), given what is already planned. A starting point for proposing: move a slot a day or two to land on an occasion.',
      inputSchema: { type: 'object', properties: { project: P, month: { type: 'string', description: 'YYYY-MM' } }, required: ['project', 'month'], additionalProperties: false },
      annotations: READ,
      async handler(a) {
        const r = await client.get(`${base(a)}/slots${qs({ month: a.month })}`);
        if (!r) throw new NordleError('No answer from the calendar.', 0);
        return { text: r.slots.length ? `${r.month}: open slots\n${r.slots.map((s) => `- ${s.date} ${s.time} ${s.format}`).join('\n')}` : `${r.month} is full.`, json: r };
      },
    },
  ];
};
