// Claude's performance tools: read how the posts did (scored against the account's own history, honest about small numbers), get the
// REVIEW prompt, save a review (and the calendar changes it makes), and enter numbers the owner gave. They call the server's
// performance routes with Claude's token. Importing a CSV and applying a pillar mix are the owner's, so they are not here.

const METRICS = {
  type: 'object',
  description: 'Numbers exactly as the platform showed them. Leave out what you were not given.',
  properties: {
    reach: { type: 'number' }, impressions: { type: 'number' }, plays: { type: 'number' }, views: { type: 'number' }, likes: { type: 'number' }, comments: { type: 'number' },
    shares: { type: 'number' }, saves: { type: 'number' }, follows: { type: 'number' }, profileVisits: { type: 'number' }, linkClicks: { type: 'number' },
    watchTimeSec: { type: 'number', description: 'Total watch time in seconds.' }, avgWatchSec: { type: 'number', description: 'Average watch time in seconds.' },
    completionRate: { type: 'number', description: '0 to 1 (45 percent is 0.45).' }, dmStarts: { type: 'number' }, swipes: { type: 'number' },
  },
  additionalProperties: false,
};

const DIRECTION = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['do-more', 'stop', 'test'] },
    text: { type: 'string', description: 'The thing to do more of, stop, or test, in plain words.' },
    evidence: { type: 'string', description: 'The numbers behind it, with n.' },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'], description: 'low for fewer than 5 posts, high only for a clear gap on 10+ posts each side.' },
  },
  required: ['kind', 'text'],
  additionalProperties: false,
};

export default (client, { P, READ, EDIT, enc }) => {
  const base = (a) => `/projects/${enc(a.project)}/performance`;
  const qs = (params) => {
    const s = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    return s ? `?${s}` : '';
  };
  return [
    {
      name: 'nordle_performance_report',
      description: 'How a brand\'s posts performed in a week (period "2026-W45") or a month (period "2026-11"; default: the last complete month). Every post has a score from 0 to 100 relative to THIS account\'s own history (50 = a typical post of its format), results are grouped by pillar, format, hook type, weekday, time of day, face on the cover, reel length, caption length, music, series and occasion, each group with its n ("directional only" under 5 posts), plus the best and weakest posts with their numbers, what the last review recommended, and the data gaps. Read it before writing a review. Never say a group caused a result.',
      inputSchema: {
        type: 'object',
        properties: {
          project: P,
          period: { type: 'string', description: 'YYYY-MM or YYYY-Www. Default: the last complete month.' },
          kind: { type: 'string', enum: ['week', 'month'], description: 'When no period is given: the last complete week or month.' },
          window: { type: 'string', enum: ['7d', '28d', 'lifetime'], description: 'Which capture window to judge by. Default 7d.' },
        },
        required: ['project'], additionalProperties: false,
      },
      annotations: READ,
      async handler(a) {
        const r = await client.get(`${base(a)}/report${qs({ period: a.period, kind: a.kind, window: a.window })}`);
        const slim = { ...r, posts: r.posts.map(({ scoreBasis, faceMedia, hookRule, ...rest }) => ({ ...rest, scoreParts: scoreBasis?.parts?.map((x) => `${x.label} ${x.pct === null ? '-' : Math.round(x.pct * 100)}`) })) };
        delete slim.markdown;
        return { text: r.markdown, json: slim };
      },
    },
    {
      name: 'nordle_performance_prompt',
      description: 'The full REVIEW brief for a period, composed from the project\'s own files: the numbers, the rules of evidence (small groups are directional only, never causal), what the last review recommended, the upcoming calendar items (which are open to change and which are locked), and exactly what to save. Read it and follow it, then call nordle_performance_save_review once.',
      inputSchema: { type: 'object', properties: { project: P, period: { type: 'string', description: 'YYYY-MM or YYYY-Www. Default: the period that is due, or the last complete month.' }, window: { type: 'string', enum: ['7d', '28d', 'lifetime'] } }, required: ['project'], additionalProperties: false },
      annotations: READ,
      async handler(a) {
        const r = await client.get(`${base(a)}/prompt${qs({ period: a.period, window: a.window })}`);
        return { text: r.prompt };
      },
    },
    {
      name: 'nordle_performance_save_review',
      description: 'Save a performance review: reviews/<period>.md for the owner to read, plus the three to five directions, the pillar mix you recommend, and the calendar changes this review makes. The `plan` is applied through the calendar\'s own rules: new ideas arrive as ideas for the owner to approve (or approved when approval is delegated); upcoming ideas and approved-but-unbuilt items may have their hook, idea, title, media plan, audience, occasion, pillar or notes amended (an item the owner approved personally goes back to "idea" for their yes; items that arrived under delegated approval stay approved); built, signed-off, scheduled and posted items are never touched. You cannot change settings: the mix is saved for the owner to apply. The text must say what worked, what did not, directions with evidence and confidence, the mix, and the data gaps, and must not claim that anything caused a result.',
      inputSchema: {
        type: 'object',
        properties: {
          project: P,
          period: { type: 'string', description: 'The period reviewed: YYYY-MM or YYYY-Www.' },
          markdown: { type: 'string', description: 'The review text (markdown). Sections: What worked, What did not, Directions, Mix for next month, Last time, Data gaps.' },
          directions: { type: 'array', minItems: 0, maxItems: 8, items: DIRECTION },
          mix: { type: 'object', description: 'Recommended mix for next month. pillars: { <pillar id>: share } adding to 1.', properties: { pillars: { type: 'object', additionalProperties: { type: 'number' } }, formats: { type: 'object', additionalProperties: { type: 'integer' } }, note: { type: 'string' } }, additionalProperties: false },
          plan: {
            type: 'object',
            description: 'Calendar changes.',
            properties: {
              ideas: { type: 'array', maxItems: 20, items: { type: 'object', description: 'Same fields as nordle_calendar_propose.' } },
              amend: { type: 'array', maxItems: 30, items: { type: 'object', properties: { item: { type: 'string' }, set: { type: 'object', additionalProperties: { type: ['string', 'null'] } }, because: { type: 'string' } }, required: ['item', 'set'], additionalProperties: false } },
            },
            additionalProperties: false,
          },
        },
        required: ['project', 'period', 'markdown'], additionalProperties: false,
      },
      annotations: EDIT,
      async handler(a) {
        const r = await client.post(`${base(a)}/reviews`, { period: a.period, markdown: a.markdown, directions: a.directions, mix: a.mix, plan: a.plan });
        const lines = [`Saved the ${a.period} review (reviews/${a.period}.md).`];
        if (r.plan) {
          const { ideas, amended, skipped } = r.plan;
          lines.push(`Ideas: ${ideas.added.length} added${ideas.refused.length ? `, ${ideas.refused.length} refused (${ideas.refused.map((x) => `${x.title}: ${x.reasons.join('; ')}`).join(' | ')})` : ''}.`);
          lines.push(`Amended: ${amended.filter((x) => x.ok).length}${amended.filter((x) => !x.ok).length ? `, ${amended.filter((x) => !x.ok).length} failed (${amended.filter((x) => !x.ok).map((x) => `${x.item}: ${x.error}`).join(' | ')})` : ''}${amended.some((x) => x.sentBackToIdea) ? `. Back to "idea" for the owner's yes: ${amended.filter((x) => x.sentBackToIdea).map((x) => x.item).join(', ')}` : ''}.`);
          if (skipped.length) lines.push(`Left alone: ${skipped.map((x) => `${x.item} (${x.reason})`).join(' | ')}`);
        }
        if (r.review.meta.mix) lines.push('The pillar mix is saved with the review; the owner applies it in the Studio (Insights).');
        for (const w of r.warnings ?? []) lines.push(`Note: ${w}`);
        return { text: lines.join('\n'), json: r };
      },
    },
    {
      name: 'nordle_performance_add',
      description: 'Record the numbers a platform showed for one post. ONLY enter numbers the owner gave you or that are written in a file you were shown: never estimate, round up or infer a number. One post, one platform, one window (7d, 28d or lifetime); a newer entry for the same post, platform and window replaces the older. The entry is marked as entered by Claude. The post must be a calendar item. To load a whole export, the owner imports the CSV in the Studio (Insights) or with `node nordle.mjs performance import`.',
      inputSchema: {
        type: 'object',
        properties: {
          project: P,
          post: { type: 'string', description: 'The calendar item id.' },
          platform: { type: 'string', description: 'instagram, facebook, tiktok, linkedin ...' },
          window: { type: 'string', enum: ['7d', '28d', 'lifetime'], description: 'How long after publishing the numbers cover. Default 7d.' },
          metrics: METRICS,
          publishedAt: { type: 'string', description: 'When it went out (YYYY-MM-DD or ISO time), if the owner said.' },
          capturedAt: { type: 'string', description: 'The day the numbers were read off the platform, YYYY-MM-DD. Default today.' },
          note: { type: 'string' },
        },
        required: ['project', 'post', 'platform', 'metrics'], additionalProperties: false,
      },
      annotations: EDIT,
      async handler(a) {
        const { project, ...entry } = a;
        const r = await client.post(`${base({ project })}/metrics`, entry);
        return { text: `${r.replaced ? 'Replaced' : 'Saved'} the ${r.entry.window} numbers for ${r.entry.post} on ${r.entry.platform}: ${Object.entries(r.entry.metrics).map(([k, v]) => `${k} ${v}`).join(', ')}.`, json: r };
      },
    },
  ];
};
