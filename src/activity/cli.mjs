// What a `nordle` command does to a post, in plain words, for the left bar's Claude box (src/activity/feed.mjs). Read-only commands (doctor, validate,
// plans, previews, help) say nothing. The project and the post are read from the arguments: a path under projects/<brand>/ (a spec or document file
// names the post), or a <brand>:<calendar item id> uid as `publish` takes them.

import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const ID = /^[a-z0-9][a-z0-9_-]*$/;
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

/** Where a project folder is, for an argument like projects/<brand>/specs/x.json (relative to `cwd`) or an absolute path to projects/<brand>. */
function projectOf(arg) {
  const m = /(?:^|[\\/])projects[\\/]([a-z0-9][a-z0-9_-]*)(?:[\\/]|$)/i.exec(String(arg));
  return m ? m[1] : null;
}

/** The post a command is about, and its title when it can be read cheaply. */
export function targetOf(args, { root = process.cwd() } = {}) {
  let project = null, doc = null, item = null, title = '';
  for (const a of args) {
    if (typeof a !== 'string' || a.startsWith('--')) continue;
    const uid = /^([a-z0-9][a-z0-9_-]*):([a-z0-9][a-z0-9_-]*)$/.exec(a);
    if (uid && !item) { project ??= uid[1]; item = uid[2]; continue; }
    const p = projectOf(a);
    if (p) project ??= p;
    if (/\.json$/i.test(a) && (p || project)) { const id = basename(a).replace(/\.json$/i, ''); if (ID.test(id) && !doc) { doc = id; const j = readJson(existsSync(a) ? a : join(root, a)); if (j?.title) title = String(j.title); } }
  }
  if (project && (item || doc) && !title) {
    const cal = readJson(join(root, 'projects', project, 'calendar.json'));
    const it = cal?.items?.find((i) => i.id === (item ?? doc) || i.doc === doc);
    if (it?.title) title = it.title;
    if (it && !item) item = it.id;
  }
  return { project, doc, item, title };
}

/**
 * @param {string} cmd   the first word after `nordle.mjs`
 * @param {string[]} args the rest
 * @returns {null|{project?:string, doc?:string, item?:string, title?:string, kind:string, verb:string, past:string, what:string}}
 */
export function describeCli(cmd, args = [], opts = {}) {
  const has = (f) => args.includes(f);
  const sub = args[0];
  let d = null;
  switch (cmd) {
    case 'render': d = { kind: 'render', verb: 'Rendering', past: 'Rendered', what: 'the pictures of' }; break;
    case 'verify': d = { kind: 'check', verb: 'Checking', past: 'Checked', what: 'the design of' }; break;
    case 'build': d = { kind: 'design', verb: 'Building', past: 'Built', what: 'the design of' }; break;
    case 'reel':
      d = has('--render') ? { kind: 'render', verb: 'Rendering', past: 'Rendered', what: 'the video of' }
        : has('--sheet') ? { kind: 'stills', verb: 'Making a contact sheet of', past: 'Made a contact sheet of', what: 'the video of' }
          : { kind: 'video', verb: 'Building', past: 'Built', what: 'the video of' };
      break;
    case 'cut': d = { kind: 'cut', verb: 'Cutting', past: 'Cut', what: 'the video of' }; break;
    case 'video': if (['render', 'export'].includes(sub)) d = { kind: 'render', verb: 'Rendering', past: 'Rendered', what: 'the video of' }; break;
    case 'publish':
      if (sub === 'run' && has('--yes')) d = { kind: 'publish', verb: 'Sending to Buffer:', past: 'Sent to Buffer:', what: 'the post' };
      else if (sub === 'sync' && has('--yes')) d = { kind: 'publish', verb: 'Bringing Buffer in step with', past: 'Brought Buffer in step with', what: 'the plan' };
      break;
    case 'calendar': if (['run', 'build', 'propose'].includes(sub)) d = { kind: 'plan', verb: 'Working on', past: 'Worked on', what: 'the plan' }; break;
    case 'stock': if (sub === 'get') d = { kind: 'stock', verb: 'Getting', past: 'Got', what: 'a stock file' }; break;
    case 'record': case 'finish': d = { kind: 'check', verb: 'Recording the checks of', past: 'Recorded the checks of', what: 'the post' }; break;
    default: d = null;
  }
  if (!d) return null;
  const t = targetOf(args, opts);
  // `what` reads "the video of" + the post's title in the box; without a post it is just the brand's work
  if (!t.title && !t.item && !t.doc) d.what = d.what.replace(/ of$/, '').replace(/^the pictures$/, 'pictures');
  else d.what = d.what.replace(/ of$/, '');
  return { ...d, ...Object.fromEntries(Object.entries(t).filter(([, v]) => v)) };
}
