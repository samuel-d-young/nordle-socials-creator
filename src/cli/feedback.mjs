// node nordle.mjs feedback <project> <doc>                                   the owner's open comments on a post (id, page, time, words)
// node nordle.mjs feedback <project> <doc> --reply <comment id> "text" [--resolve]   answer one (and mark it dealt with), through the running editor
// The command-line twin of nordle_get_feedback / nordle_reply / nordle_resolve, for a designer that has the shell but not the MCP tools.
// It talks to the editor with Claude's own token (the runtime file), so it can reply and resolve but never approve anything.

import { basename, resolve } from 'node:path';
import { NordleClient, NordleError } from '../mcp/client.mjs';

const enc = encodeURIComponent;
const clock = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

export default {
  name: 'feedback',
  usage: 'feedback <project> <doc> [--reply <comment id> "text" [--resolve]]',
  summary: 'read the owner\'s open comments on a post, answer them and mark them dealt with',
  async run(args) {
    const flags = {};
    const pos = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--resolve' || a === '--json') flags[a.slice(2)] = true;
      else if (a === '--reply') { flags.reply = args[++i]; if (args[i + 1] && !args[i + 1].startsWith('--')) flags.text = args[++i]; }
      else pos.push(a);
    }
    const [projectArg, doc] = pos;
    if (!projectArg || !doc) { console.error('Usage: node nordle.mjs feedback <project> <doc> [--reply <comment id> "text" [--resolve]]'); return 2; }
    const project = basename(resolve(projectArg));
    const base = `/projects/${enc(project)}/docs/${enc(doc)}`;
    const client = new NordleClient();
    try {
      if (flags.reply) {
        if (flags.text) await client.post(`${base}/review/reply`, { comment: flags.reply, text: flags.text });
        if (flags.resolve) await client.post(`${base}/review/resolve`, { comment: flags.reply });
        console.log(`${flags.text ? 'Replied' : ''}${flags.text && flags.resolve ? ' and ' : ''}${flags.resolve ? 'resolved' : ''} ${flags.reply}.`);
        return 0;
      }
      const d = await client.get(base);
      const open = (d.review?.comments ?? []).filter((c) => c.status === 'open');
      if (flags.json) { console.log(JSON.stringify(open, null, 2)); return 0; }
      if (!open.length) { console.log('No open comments.'); return 0; }
      for (const c of open) {
        const where = [c.page, c.time !== undefined && c.time !== null ? clock(c.time) : null, c.layer ? `layer ${c.layer}` : null, c.x !== undefined ? `at ${Math.round(c.x * 100)}%,${Math.round(c.y * 100)}%` : null].filter(Boolean).join(' · ');
        console.log(`${c.id}  [${where}]  ${c.author ?? 'owner'}: ${c.text}`);
        for (const r of c.replies ?? []) console.log(`    reply (${r.author ?? '?'}): ${r.text}`);
      }
      return 0;
    } catch (e) {
      if (e instanceof NordleError) { console.error(e.message); return 1; }
      throw e;
    }
  },
};
