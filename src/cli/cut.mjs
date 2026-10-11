// node nordle.mjs cut <project> <doc> --source <id> [--track v1] <remove|restore|split|trim|move|delete|words> ...
//   cut words   <project> <doc> --source id [--all]        the transcript, numbered, with what is kept and what is cut
//   cut <project> <doc> --source id remove  12-20          cut words 12 to 20 out (one word: just 12). The video closes up.
//   cut <project> <doc> --source id restore 12-20          bring them back
//   cut <project> <doc> split  <clip> <seconds>            split a clip at a time on the timeline
//   cut <project> <doc> trim   <clip> [--in s] [--out s] [--at s] [--ripple]
//   cut <project> <doc> move   <clip> <seconds> [--ripple]
//   cut <project> <doc> delete <clip> [--no-ripple]
// Options: --no-ripple (leave a gap), --dry-run (print the operations, change nothing), --json, --check (run the cut check afterwards).
// The edit goes through the running editor when there is one for this project (the same validated patch as any edit); otherwise the
// document file is written directly the way the editor writes it (validated, atomically, with the history entry).

import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ROOT, readJson } from '../../tools/validate.mjs';
import { applyOps } from '../shared/ops.mjs';
import {
  CutError, defaultTrack, deleteClip, moveClip, removeWordsInfo, restoreWordsInfo, splitClip, totalDuration, trimClip,
} from '../shared/cutlist.mjs';
import { clock, cutOverview, formatOverview, loadSourceWords } from '../video/cutwords.mjs';

const VALUE_FLAGS = new Set(['source', 'track', 'in', 'out', 'at', 'max-pad']);
const SUBS = new Set(['remove', 'restore', 'split', 'trim', 'move', 'delete', 'words']);

const USAGE = `Usage:
  node nordle.mjs cut words   <project> <doc> --source <id> [--track v1] [--all]
  node nordle.mjs cut <project> <doc> --source <id> [--track v1] remove  <from>-<to>     (word numbers from "cut words")
  node nordle.mjs cut <project> <doc> --source <id> [--track v1] restore <from>-<to>
  node nordle.mjs cut <project> <doc> split  <clip> <seconds>
  node nordle.mjs cut <project> <doc> trim   <clip> [--in s] [--out s] [--at s] [--ripple]
  node nordle.mjs cut <project> <doc> move   <clip> <seconds> [--ripple]
  node nordle.mjs cut <project> <doc> delete <clip> [--no-ripple]
  options: --no-ripple  --dry-run  --json  --check`;

function parse(args) {
  const o = { _: [], flags: {} };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (VALUE_FLAGS.has(k)) o.flags[k] = args[++i]; else o.flags[k] = true;
  }
  return o;
}

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const projectDirOf = (arg) => [resolve(arg), join(ROOT, 'projects', arg)].find((d) => existsSync(join(d, 'brand.json'))) ?? null;
const quote = (words, i, j) => { const t = words.slice(i, j + 1).map((w) => w.text).join(' '); return t.length > 70 ? `${t.slice(0, 67)}...` : t; };

function parseRange(text) {
  const m = /^(\d+)(?:-(\d+))?$/.exec(String(text ?? ''));
  if (!m) return null;
  const i = Number(m[1]);
  return { i, j: m[2] === undefined ? i : Number(m[2]) };
}

/** Through the running editor, if there is one serving this very document. Returns null when it cannot be used. */
async function viaEditor(projectDir, docId, baseDoc, ops, note) {
  const { NordleClient } = await import('../mcp/client.mjs');
  const client = new NordleClient({ autostart: false });
  try { await client.connect(); } catch { return null; }
  const base = `/projects/${encodeURIComponent(basename(projectDir))}/docs/${encodeURIComponent(docId)}`;
  let got;
  try { got = await client.get(base); } catch { return null; }
  if (!deepEqual(got.doc, baseDoc)) return null; // a different copy of the project is open there
  const r = await client.post(`${base}/patch`, { ops, baseVersion: got.v, note });
  return r;
}

async function writeDirect(projectDir, file, ops, note) {
  const { DocSession } = await import('../server/store.mjs');
  const session = new DocSession({ dir: projectDir, brand: readJson(join(projectDir, 'brand.json')), platforms: readJson(join(ROOT, 'data', 'platforms.json')) }, file);
  const r = session.apply({ ops, actor: 'human', note });
  return r.ok ? { ok: true, v: r.v } : { ok: false, errors: r.errors };
}

export default {
  name: 'cut',
  usage: 'cut [words] <project> <doc> --source <id> <remove|restore|split|trim|move|delete> ...',
  summary: 'cut a video by its words: take words out, bring them back, split and trim clips',
  async run(args) {
    const { _: pos, flags } = parse(args);
    let sub;
    let rest;
    if (pos[0] === 'words') { sub = 'words'; rest = pos.slice(1); } else { rest = pos.slice(0, 2); sub = pos[2]; rest.push(...pos.slice(3)); }
    if (!SUBS.has(sub) || rest.length < 2) { console.error(USAGE); return 2; }
    const [projectArg, docArg, ...more] = rest;
    const projectDir = projectDirOf(projectArg);
    if (!projectDir) { console.error(`${projectArg} is not a Nordle project (no brand.json).`); return 2; }
    const docId = basename(docArg).replace(/\.json$/, '');
    const file = join(projectDir, 'docs', `${docId}.json`);
    if (!existsSync(file)) { console.error(`There is no document "${docId}" in ${projectDir}.`); return 2; }
    const doc = readJson(file);
    if (doc.kind !== 'video' || !doc.timeline) { console.error(`"${docId}" is not a video.`); return 2; }

    try {
      const ripple = flags['no-ripple'] ? false : flags.ripple ? true : undefined;
      const source = flags.source;
      let ops;
      let headline;
      const notes = [];
      let loaded;
      const needWords = () => (loaded ??= loadSourceWords(projectDir, doc, source));

      if (sub === 'words') {
        const { source: sid, words } = needWords();
        const ov = cutOverview(doc, { track: flags.track ?? defaultTrack(doc, sid), source: sid }, words);
        if (flags.json) console.log(JSON.stringify({ source: sid, track: ov.track, total: ov.total, words: ov.states, lines: ov.lines }, null, 2));
        else console.log(formatOverview(ov, { all: !!flags.all }));
        return 0;
      }

      if (sub === 'remove' || sub === 'restore') {
        const range = parseRange(more[0]);
        if (!range) { console.error(`Give the word numbers as <from>-<to>, for example 12-20 (see: node nordle.mjs cut words ${projectArg} ${docId}).`); return 2; }
        const { source: sid, words } = needWords();
        const track = flags.track ?? defaultTrack(doc, sid);
        const opts = { ripple: ripple ?? true, ...(flags['max-pad'] ? { maxPad: Number(flags['max-pad']) } : {}) };
        const r = (sub === 'remove' ? removeWordsInfo : restoreWordsInfo)(doc, { track, source: sid }, words, range.i, range.j, opts);
        ops = r.ops;
        notes.push(...r.notes);
        const secs = sub === 'remove' ? r.removed : r.restored;
        headline = ops.length
          ? `${sub === 'remove' ? 'CUT' : 'BACK'} words ${range.i}-${range.j} ("${quote(words, range.i, range.j)}"): ${secs.toFixed(2)} s ${sub === 'remove' ? 'taken out' : 'put back'} (source ${clock(r.from)} to ${clock(r.to)})`
          : `NOTHING words ${range.i}-${range.j} ("${quote(words, range.i, range.j)}") are already ${sub === 'remove' ? 'cut out' : 'in the video'}`;
      } else if (sub === 'split') {
        if (more.length < 2) { console.error(USAGE); return 2; }
        ops = splitClip(doc, more[0], Number(more[1]));
        headline = `SPLIT clip "${more[0]}" at ${Number(more[1])} s`;
      } else if (sub === 'trim') {
        if (!more[0]) { console.error(USAGE); return 2; }
        const to = {};
        for (const k of ['in', 'out', 'at']) if (flags[k] !== undefined) to[k] = Number(flags[k]);
        if (!Object.keys(to).length) { console.error('Give at least one of --in, --out, --at (seconds).'); return 2; }
        const clip = doc.timeline.tracks.flatMap((t) => t.clips).find((c) => c.id === more[0]);
        const sd = (doc.sources ?? []).find((s) => s.id === clip?.source)?.duration;
        ops = trimClip(doc, more[0], to, { ripple: ripple ?? false, ...(sd ? { sourceDuration: sd } : {}) });
        headline = `TRIM clip "${more[0]}" ${Object.entries(to).map(([k, v]) => `${k} ${v}`).join(', ')}`;
      } else if (sub === 'move') {
        if (more.length < 2) { console.error(USAGE); return 2; }
        ops = moveClip(doc, more[0], Number(more[1]), { ripple: ripple ?? false });
        headline = `MOVE clip "${more[0]}" to ${Number(more[1])} s`;
      } else {
        if (!more[0]) { console.error(USAGE); return 2; }
        ops = deleteClip(doc, more[0], { ripple: ripple ?? true });
        headline = `DELETE clip "${more[0]}"`;
      }

      const before = totalDuration(doc);
      const after = ops.length ? totalDuration(applyOps(doc, ops).doc) : before;
      const lengthLine = `The video is ${after.toFixed(2)} s long${after === before ? '' : ` (was ${before.toFixed(2)} s)`}.`;
      if (flags.json && flags['dry-run']) { console.log(JSON.stringify({ ops, total: after, before }, null, 2)); return 0; }
      console.log(headline);
      for (const n of notes) console.log(`     note ${n}`);
      if (!ops.length) return 0;
      if (flags['dry-run']) {
        console.log(`     dry run: ${ops.length} operation${ops.length === 1 ? '' : 's'}, nothing changed. ${lengthLine}`);
        for (const op of ops) console.log(`     ${JSON.stringify(op).slice(0, 220)}`);
        return 0;
      }

      const note = headline.replace(/^[A-Z]+ /, '').replace(/ \(source.*$/, '');
      const served = await viaEditor(projectDir, docId, doc, ops, note);
      if (served) {
        console.log(served.mode === 'proposed'
          ? `     SUGGESTED, NOT APPLIED: the owner has set this post to "suggest", so the change waits in the editor until they accept it (version ${served.v}).`
          : `     APPLIED through the running editor (version ${served.v})${served.status === 'pending' ? ', flagged there for the owner to accept or reject' : ''}.`);
        console.log(`     ${lengthLine}`);
      } else {
        const w = await writeDirect(projectDir, file, ops, note);
        if (!w.ok) {
          console.error('The change was not saved: the document would no longer be valid.');
          for (const e of w.errors) console.error(`     ${e.path ?? ''} ${e.message}`);
          return 1;
        }
        console.log(`     WROTE ${file} (version ${w.v}). ${lengthLine}`);
      }
      if (flags.check) {
        const { loadDocContext } = await import('../render/context.mjs');
        const { buildPlan, summarisePlan } = await import('../video/plan.mjs');
        const c = loadDocContext(file);
        const plan = await buildPlan({ doc: c.doc, brand: c.brand, projectDir: c.projectDir, platforms: c.platforms });
        const s = summarisePlan(plan);
        const bad = s.issues.filter((i) => i.level !== 'info');
        console.log(`     check: ${bad.length ? `${bad.length} thing${bad.length === 1 ? '' : 's'} to look at` : 'no problems'}`);
        for (const i of bad) console.log(`       ${i.level} ${i.code}: ${i.message}`);
        if (plan.blocking.length || bad.some((i) => i.level === 'error')) return 1;
      }
      return 0;
    } catch (e) {
      if (e instanceof CutError || e?.name === 'NordleError') { console.error(e.message); return 1; }
      throw e;
    }
  },
};
