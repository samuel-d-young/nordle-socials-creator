// nordle_set_brief: write down what a post is for BEFORE designing it, so the design and the reviewer can be held to it.

export default function briefTools(client, { P, D, EDIT, load, patch }) {
  return [
    {
      name: 'nordle_set_brief',
      description: 'Write the brief for a post before you design it: the goal (what the viewer should do or feel), the audience, the one message, the tone, anything it must include or must avoid. It is saved in the document; the independent reviewer checks the finished post against it, so make it concrete and short.',
      inputSchema: {
        type: 'object',
        properties: {
          project: P, doc: D,
          goal: { type: 'string' }, audience: { type: 'string' }, message: { type: 'string' }, tone: { type: 'string' },
          must_include: { type: 'array', items: { type: 'string' } }, must_avoid: { type: 'array', items: { type: 'string' } },
          calendar_item: { type: 'string' }, post_date: { type: 'string', description: 'YYYY-MM-DD' }, notes: { type: 'string' },
        },
        required: ['project', 'doc'], additionalProperties: false,
      },
      annotations: EDIT,
      async handler(a) {
        const d = await load(client, a);
        const brief = {
          ...(d.doc.brief ?? {}),
          ...(a.goal !== undefined ? { goal: a.goal } : {}), ...(a.audience !== undefined ? { audience: a.audience } : {}),
          ...(a.message !== undefined ? { message: a.message } : {}), ...(a.tone !== undefined ? { tone: a.tone } : {}),
          ...(a.must_include ? { mustInclude: a.must_include } : {}), ...(a.must_avoid ? { mustAvoid: a.must_avoid } : {}),
          ...(a.calendar_item ? { calendarItem: a.calendar_item } : {}), ...(a.post_date ? { postDate: a.post_date } : {}),
          ...(a.notes !== undefined ? { notes: a.notes } : {}),
        };
        const ops = [{ op: d.doc.brief ? 'replace' : 'add', path: '/brief', value: brief }];
        return patch(client, a, d, ops, 'Set the brief');
      },
    },
  ];
}
