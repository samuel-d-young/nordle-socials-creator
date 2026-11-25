// What happens to posts OUTSIDE the Studio's own requests, for the left bar's Claude box: a `nordle` command (a render, a reel build, a Buffer run),
// a script that changes the calendar through the calendar service, a Claude Code session working from a terminal. Each of those processes appends
// short lines to one shared file (the runtime folder's activity-feed.jsonl); the server reads the end of that file when the Studio asks what is going on.
//
//   start  { id, pid, at, ev:'start', project, doc?, item?, title?, kind, verb, past, what, source }   a piece of work has begun (it is "working")
//   end    { id, pid, at, ev:'end', ok }                                                              ... and ended
//   once   { id, pid, at, ev:'once', ... }                                                            something that happened in one go (a calendar change)
//
// A start whose process has gone away without an end line is shown as not finished. The file holds no tokens, captions or file contents: only which post,
// what kind of change, and when. Nothing here may throw into the caller: the feed is a convenience and a failure to write it must never stop real work.
// Tests: it is off inside `node --test` (NODE_TEST_CONTEXT) unless NORDLE_ACTIVITY_FEED names a file, and NORDLE_ACTIVITY=off turns it off anywhere.

import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TAIL_BYTES = 256 * 1024;      // the server reads only the end of the file
const TRIM_AT = 1024 * 1024;        // and keeps it from growing for ever
const KEEP_LINES = 600;

/** The server runs every API request inside this, with { role }, so the calendar service can tell the owner's own clicks (not shown) from automatic work. */
export const requestScope = new AsyncLocalStorage();

let serverProcess = false;
/** Called once by the server: work done inside it without a request (automatic scheduling, Buffer reads) is "Nordle", not a terminal. */
export function markServerProcess() { serverProcess = true; }

export const feedFile = () => process.env.NORDLE_ACTIVITY_FEED ?? join(process.env.NORDLE_RUNTIME_DIR ?? join(ROOT, '.nordle'), 'activity-feed.jsonl');
export const feedEnabled = () => process.env.NORDLE_ACTIVITY !== 'off' && (!process.env.NODE_TEST_CONTEXT || !!process.env.NORDLE_ACTIVITY_FEED);

/** Who is doing it: a Claude Code session (its shells carry CLAUDECODE=1), Nordle itself, or someone at a terminal. */
export const sourceNow = () => (serverProcess ? 'nordle' : process.env.CLAUDECODE || process.env.NORDLE_AGENT_RUN ? 'claude' : 'terminal');

const ID = /^[a-z0-9][a-z0-9_-]*$/;
const clean = (info = {}) => {
  const o = {};
  for (const k of ['project', 'doc', 'item']) if (typeof info[k] === 'string' && ID.test(info[k])) o[k] = info[k];
  for (const k of ['title', 'kind', 'verb', 'past', 'what']) if (typeof info[k] === 'string' && info[k]) o[k] = info[k].slice(0, 160);
  o.source = ['claude', 'nordle', 'terminal'].includes(info.source) ? info.source : sourceNow();
  return o;
};

function write(line, file = feedFile()) {
  if (!feedEnabled()) return false;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(line)}\n`);
    return true;
  } catch { return false; }
}

const open = new Map();     // id -> file, for pieces of work this process has started and not ended
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', (code) => { for (const [id, file] of open) write({ id, pid: process.pid, at: new Date().toISOString(), ev: 'end', ok: !code && !process.exitCode }, file); open.clear(); });
}

/**
 * A piece of work begins. Returns { id, end(ok) }; if the process ends first, the end is written for it (ok when it exits cleanly).
 * @param {{project?:string, doc?:string, item?:string, title?:string, kind?:string, verb:string, past:string, what:string, source?:string}} info
 */
export function startWork(info, { file = feedFile() } = {}) {
  const id = `f${randomBytes(5).toString('hex')}`;
  const ok = write({ id, pid: process.pid, at: new Date().toISOString(), ev: 'start', ...clean(info) }, file);
  if (ok) { open.set(id, file); hookExit(); }
  let ended = !ok;
  return {
    id,
    end(done = true) {
      if (ended) return;
      ended = true;
      open.delete(id);
      write({ id, pid: process.pid, at: new Date().toISOString(), ev: 'end', ok: !!done }, file);
    },
  };
}

/** Something that happened in one go. */
export function noteDone(info, { file = feedFile(), ok = true } = {}) {
  return write({ id: `f${randomBytes(5).toString('hex')}`, pid: process.pid, at: new Date().toISOString(), ev: 'once', ok, ...clean(info) }, file);
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function tail(file) {
  const size = statSync(file).size;
  const len = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
  const text = buf.toString('utf8');
  return (size > len ? text.slice(text.indexOf('\n') + 1) : text).split('\n').filter(Boolean);
}

/**
 * What the feed says: work still going (its process alive, no end line) and work finished lately, newest first. Shapes match src/server/activity.mjs's view.
 * @returns {{working:object[], recent:object[]}}
 */
export function readFeed({ file = feedFile(), keep = 12, isAlive = alive, staleMs = 6 * 3600000, now = Date.now() } = {}) {
  if (!existsSync(file)) return { working: [], recent: [] };
  let lines;
  try { lines = tail(file); } catch { return { working: [], recent: [] }; }
  const starts = new Map();
  const done = [];
  for (const raw of lines) {
    let l; try { l = JSON.parse(raw); } catch { continue; }
    if (!l || typeof l.id !== 'string') continue;
    if (l.ev === 'start') starts.set(l.id, l);
    else if (l.ev === 'end') { const s = starts.get(l.id); if (s) { starts.delete(l.id); done.push({ ...s, finishedAt: l.at, ok: l.ok !== false }); } }
    else if (l.ev === 'once') done.push({ ...l, startedAt: l.at, finishedAt: l.at, ok: l.ok !== false });
  }
  const view = (l) => ({
    id: l.id, project: l.project ?? '', doc: l.doc ?? null, item: l.item ?? null, title: l.title ?? '', kind: l.kind ?? 'outside', verb: l.verb ?? 'Working on', past: l.past ?? 'Worked on',
    what: l.what ?? 'a post', startedAt: l.startedAt ?? l.at, steps: 1, source: l.source ?? 'terminal',
    ...(l.finishedAt ? { finishedAt: l.finishedAt, ok: l.ok } : {}),
  });
  const working = [];
  for (const s of starts.values()) {
    if (isAlive(s.pid) && now - Date.parse(s.at) < staleMs) working.push(view(s));
    else done.push({ ...s, finishedAt: s.at, ok: false });          // its process went away without saying it had finished
  }
  done.reverse();      // the file is oldest first and the sort below is stable, so of two in the same millisecond the later line stays newest
  done.sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)));
  return { working: working.reverse(), recent: done.slice(0, keep).map(view) };
}

/** Keep the file small: when it passes about 1 MB, keep its last few hundred lines. Only the server calls this. */
export function trimFeed({ file = feedFile() } = {}) {
  try {
    if (!existsSync(file) || statSync(file).size < TRIM_AT) return false;
    const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-KEEP_LINES);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${lines.join('\n')}\n`);
    renameSync(tmp, file);
    return true;
  } catch { return false; }
}

// ---- calendar changes -----------------------------------------------------------------------------------------------------------------------------

const QUIET_FIELDS = new Set(['updated', 'build', 'publish', 'pendingChanges', 'queuedRevise', 'lastRun', 'insights', 'metrics']);
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function when(date, time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date ?? '');
  if (!m) return date ?? '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return `${WEEKDAY[d.getUTCDay()]} ${+m[3]} ${MONTH[+m[2] - 1]}${time ? `, ${time}` : ''}`;
}
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** One calendar item before and after, in plain words, or null when nothing worth a line changed (build progress, timestamps). */
export function describeItemChange(b, a) {
  if (!b && a) return { verb: 'Adding', past: 'Added', what: `a post on ${when(a.date, a.time)}` };
  if (b && !a) return { verb: 'Taking off', past: 'Took off', what: 'a post from the plan' };
  const keys = new Set([...Object.keys(b), ...Object.keys(a)].filter((k) => !QUIET_FIELDS.has(k)));
  const changed = [...keys].filter((k) => !same(b[k], a[k]));
  if (!changed.length) return null;
  if (a.status !== b.status) {
    if (a.status === 'scheduled') return { verb: 'Scheduling', past: 'Scheduled', what: `the post for ${when(a.date, a.time)}` };
    if (b.status === 'scheduled' && a.status !== 'posted') return { verb: 'Unscheduling', past: 'Unscheduled', what: 'the post' };
    const words = { 'signed-off': 'Signed off', posted: 'Marked as posted', built: 'Finished building', changes: 'Sent back for changes', approved: 'Approved the idea of', rejected: 'Turned down', idea: 'Put back as an idea' };
    if (words[a.status]) return { verb: 'Changing', past: words[a.status], what: 'the post' };
  }
  if (!same(b.date, a.date) || !same(b.time, a.time)) return { verb: 'Moving', past: 'Moved', what: `the post to ${when(a.date, a.time)}` };
  const eb = b.external ?? {}, ea = a.external ?? {};
  if (!same(eb.caption, ea.caption) || !same(eb.hashtags, ea.hashtags)) return { verb: 'Changing', past: 'Changed the caption of', what: 'the post' };
  if (!same(eb.video, ea.video) || !same(eb.cover, ea.cover) || !same(eb.note, ea.note) || !same(b.doc, a.doc)) return { verb: 'Changing', past: 'Put a new version of', what: 'the post' };
  if (changed.includes('title')) return { verb: 'Renaming', past: 'Renamed', what: 'the post' };
  return { verb: 'Changing', past: 'Changed', what: changed.length === 1 && changed[0] !== 'external' ? `the ${changed[0]} of the post` : 'the post' };
}

/**
 * After the calendar service saved: one line per changed post (or one line for a big batch), unless the change came from a request the server already
 * shows (Claude's own) or the owner's own click. `before` and `after` are whole calendars.
 */
export function noteCalendarChange(projectDir, before, after, { file } = {}) {
  try {
    if (!feedEnabled()) return 0;
    const role = requestScope.getStore()?.role;
    if (role === 'human' || role === 'agent') return 0;
    const project = basename(projectDir);
    if (typeof before === 'string') before = JSON.parse(before);
    const was = new Map((before?.items ?? []).map((i) => [i.id, i]));
    const now = new Map((after?.items ?? []).map((i) => [i.id, i]));
    const lines = [];
    for (const id of new Set([...was.keys(), ...now.keys()])) {
      const d = describeItemChange(was.get(id), now.get(id));
      if (d) lines.push({ project, item: id, title: (now.get(id) ?? was.get(id))?.title ?? '', kind: 'plan', ...d });
    }
    if (lines.length > 4) {
      const kinds = new Set(lines.map((l) => l.past));
      const past = kinds.size === 1 ? [...kinds][0] : 'Updated';
      noteDone({ project, kind: 'plan', verb: 'Updating', past, what: `${lines.length} posts on the plan`, title: '' }, { file });
      return 1;
    }
    for (const l of lines) noteDone(l, { file });
    return lines.length;
  } catch { return 0; }
}
