// Claude's publishing tools: see what the owner has connected, and plan what would go out (what is ready, what is blocked and
// why). There is deliberately NO tool to schedule, send, save a key or test a connection: only the owner schedules, in the Studio.

export default (client, { READ, NordleError }) => {
  void NordleError;
  return [
    {
      name: 'nordle_publish_adapters',
      description: 'The places Nordle can hand finished posts to: "bundle" (an export folder, always available) and "buffer". For each: whether the owner has connected it (configured), what is still missing (needs), its accounts (logins) and the channels it knows, which account and channels each brand publishes to (a brand can post to an Instagram profile and several Facebook pages), and a note. You cannot connect or send anything: only the owner schedules, in the Studio.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: READ,
      async handler() {
        const r = await client.get('/publish/adapters');
        const lines = [];
        for (const a of r.adapters) {
          lines.push(`${a.id} (${a.name}): ${a.configured ? 'connected' : 'not connected'}${a.needs.length ? `; still needed: ${a.needs.join('; ')}` : ''}${a.channels.length ? `; channels: ${a.channels.map((c) => `${c.name} [${c.service}]`).join(', ')}` : ''}`);
          for (const acc of a.accounts) lines.push(`    account ${acc.id} "${acc.label}": ${acc.configured ? 'key saved' : 'no key'}`);
          for (const [project, b] of Object.entries(a.brands)) lines.push(`    ${project} -> ${b.account ?? 'no account'}: ${b.channels.map((c) => `${c.name ?? c.id}${c.enabled ? '' : ' (off)'}`).join(', ') || 'no channels'}`);
        }
        return { text: lines.join('\n'), json: r };
      },
    },
    {
      name: 'nordle_publish_plan',
      description: 'Plan publishing for an adapter without sending anything: for the given posts (uids like "<project>:<calendar item id>", from the Studio) or a whole month of a project, say for each post and each channel its brand posts to when it would go out (the calendar date and time in the brand\'s timezone, plus the channel\'s offset), the caption and pictures, and what BLOCKS it (not signed off, failing checks, missing pictures, a time in the past, no account or channel connected for the brand...). Use it to tell the owner what is ready and what to fix. The plan is only a preview: you cannot run it, and only the owner schedules, in the Studio, from a plan of their own. Only signed-off posts can ever be scheduled.',
      inputSchema: {
        type: 'object',
        properties: {
          adapter: { type: 'string', enum: ['bundle', 'buffer'] },
          uids: { type: 'array', items: { type: 'string' }, maxItems: 100, description: 'Posts as "<project>:<calendar item id>".' },
          project: { type: 'string', description: 'With month: the project id (omit for every project).' },
          month: { type: 'string', description: 'YYYY-MM: every calendar item of that month.' },
          channels: { type: 'object', additionalProperties: { type: 'array', items: { type: 'string' } }, description: 'Optional: per post uid, only these channel ids (a preview of leaving some channels out).' },
        },
        required: ['adapter'],
        additionalProperties: false,
      },
      annotations: READ,
      async handler(a) {
        const r = await client.post('/publish/plan', { adapter: a.adapter, uids: a.uids, project: a.project, month: a.month, channels: a.channels });
        const lines = [`Plan for ${r.adapter}: ${r.summary.ready} ready, ${r.summary.blocked} blocked. (A preview: only the owner can run it, in the Studio.)`];
        for (const it of r.items) {
          lines.push(`${it.ready ? 'READY  ' : 'BLOCKED'} ${it.uid}  ${it.whenLocal ?? 'no date'}  ${it.format ?? '?'}  ${it.title}${it.channel ? `  -> ${it.channel.name ?? it.channel.id}` : ''}`);
          for (const b of it.blockers) lines.push(`    blocked: ${b}`);
          for (const w of it.warnings) lines.push(`    warning: ${w}`);
        }
        return { text: lines.join('\n'), json: r };
      },
    },
  ];
};
