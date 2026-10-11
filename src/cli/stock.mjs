// node nordle.mjs stock <command> ...   search outside stock libraries (photos, video, music, sound effects) and bring files into a project,
// with their licence written down. See docs/STOCK.md. Adding a library or a key is the owner's step on their own machine: it is refused when
// NORDLE_AGENT_RUN=1 (set inside Claude's headless runs). Searching and bringing a file in are open to the designer.

import { readFileSync } from 'node:fs';
import { Store } from '../server/store.mjs';
import { projectRoots, resolveProject } from '../calendar/service.mjs';
import { StockError, getStockItem, listLibraries, saveStockSettings, searchStock, testStockLibrary } from '../stock/index.mjs';

const out = (s = '') => console.log(s);
const err = (s) => console.error(s);

const USAGE = `stock <command> ...

  libraries                                       what can be searched: added libraries, presets still to add, folders
  search <library> "words" [--kind photo|video|music|sfx] [--page N] [--per-page N] [--json]
  get <library> <item id> --project <project> [--kind photo|video|music|sfx]
                                                  bring one item into the project (assets/stock/), with its licence line and a catalog entry
                                                  that says it has not been looked at yet
  add <library> [--preset pexels|pixabay|freesound] [--definition file.json] [--name "Shown name"]     (owner only)
  add <library> --folder "D:/Stock/Videos" [--kinds video,photo] [--license "text"] [--name ..]    a folder of your own stock (owner only)
  key <library> [--clear]                         save the API key, read from standard input, never from an argument (owner only)
  remove <library>                                forget a library and its key (owner only; files already in projects stay)
  test <library>                                  one small search to see whether the key works (owner only)

Libraries with no API (Envato Elements and similar): download in your browser into a folder, then add that folder with --folder; its files
are searched by name and copied into a project like any other. Nordle never buys anything and never signs in to a site for you.
Exit codes: 0 fine, 1 failed or refused, 2 usage, 3 an owner-only step was refused.`;

function parse(args) {
  const flags = {}, pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
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

const clock = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');

export default {
  name: 'stock',
  usage: 'stock <libraries|search|get|add|key|remove|test> ...',
  summary: 'search stock libraries and bring files into a project, with their licences',
  async run(args) {
    const [cmd, ...rest] = args;
    const { flags, pos } = parse(rest);
    try {
      switch (cmd) {
        case 'libraries': {
          for (const l of listLibraries()) out(`${l.id.padEnd(12)} ${l.name}  [${l.kinds.join(', ')}]  ${l.added ? (l.configured ? 'ready' : `added, needs ${l.needs.join(' and ')}`) : 'not added yet'}${l.verified === false ? '  (definition not yet tried with a live key)' : ''}${l.path ? `  ${l.path}` : ''}`);
          return 0;
        }
        case 'search': {
          const [library, ...words] = pos;
          if (!library || !words.length) { err('Usage: stock search <library> "words" [--kind ..]'); return 2; }
          const r = await searchStock({ library, query: words.join(' '), kind: flags.kind === true ? undefined : flags.kind, page: flags.page, perPage: flags['per-page'] });
          if (flags.json) { out(JSON.stringify(r, null, 2)); return 0; }
          out(`${r.name}: ${r.kind} "${r.query}" page ${r.page}${r.total !== null ? ` of about ${r.total} results` : ''}   licence: ${r.license ?? 'see each item'}`);
          for (const it of r.items) out(`  ${it.id}  ${it.title}${it.author ? `  by ${it.author}` : ''}${it.duration ? `  ${clock(it.duration)}` : ''}${it.width ? `  ${it.width}x${it.height}` : ''}${it.page ? `\n      ${it.page}` : ''}${it.license && it.license !== r.license ? `\n      licence: ${it.license}` : ''}`);
          if (!r.items.length) out('  nothing found');
          return 0;
        }
        case 'get': {
          const [library, id] = pos;
          if (!library || !id || typeof flags.project !== 'string') { err('Usage: stock get <library> <item id> --project <project> [--kind ..]'); return 2; }
          const proj = resolveProject(flags.project);
          const store = new Store({ roots: projectRoots() });
          const r = await getStockItem(store, { library, id, kind: flags.kind === true ? undefined : flags.kind, project: proj.id, by: isAgentRun() ? 'claude' : 'owner' });
          out(`${r.already ? 'Already in the project' : 'Saved'}: ${r.path}`);
          out(`  licence: ${r.license ?? 'not stated: check the library\'s page'}`);
          if (!r.already) out('  it has a catalog entry that says it has NOT been looked at: view it and rewrite "shows" before using it.');
          return 0;
        }
        case 'add': {
          const refused = ownerOnly('add a stock library'); if (refused) return refused;
          const [library] = pos;
          if (!library) { err('Usage: stock add <library> [--preset ..| --definition file.json | --folder path]'); return 2; }
          const body = { library, name: typeof flags.name === 'string' ? flags.name : undefined };
          if (typeof flags.folder === 'string') { body.path = flags.folder; if (typeof flags.kinds === 'string') body.kinds = flags.kinds.split(',').map((s) => s.trim()); if (typeof flags.license === 'string') body.license = flags.license; }
          else if (typeof flags.definition === 'string') body.definition = JSON.parse(readFileSync(flags.definition, 'utf8'));
          else if (typeof flags.preset === 'string') body.preset = flags.preset;
          saveStockSettings(body, 'human');
          out(`Added ${library}.${body.path ? '' : ' Now save its key: echo KEY | node nordle.mjs stock key ' + library}`);
          return 0;
        }
        case 'key': {
          const refused = ownerOnly('save a stock library key'); if (refused) return refused;
          const [library] = pos;
          if (!library) { err('Usage: stock key <library> [--clear]   (the key comes from standard input)'); return 2; }
          if (flags.clear) { saveStockSettings({ library, key: null }, 'human'); out(`Forgot the key for ${library}.`); return 0; }
          const key = readFileSync(0, 'utf8').trim();
          if (!key) { err('No key on standard input. Example: echo YOUR_KEY | node nordle.mjs stock key pexels'); return 2; }
          saveStockSettings({ library, key }, 'human');
          out(`Saved the key for ${library}. It is kept in a private file and never shown.`);
          return 0;
        }
        case 'remove': {
          const refused = ownerOnly('remove a stock library'); if (refused) return refused;
          if (!pos[0]) { err('Usage: stock remove <library>'); return 2; }
          saveStockSettings({ library: pos[0], remove: true }, 'human');
          out(`Removed ${pos[0]}.`);
          return 0;
        }
        case 'test': {
          const refused = ownerOnly('test a stock library'); if (refused) return refused;
          if (!pos[0]) { err('Usage: stock test <library>'); return 2; }
          const r = await testStockLibrary(pos[0], 'human');
          out(r.message);
          return r.ok ? 0 : 1;
        }
        default: out(USAGE); return cmd ? 2 : 0;
      }
    } catch (e) {
      if (e instanceof StockError) { err(e.message); return e.status === 403 ? 3 : 1; }
      throw e;
    }
  },
};
