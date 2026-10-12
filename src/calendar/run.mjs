// The headless runner: when an approved idea's date comes within the lead time, ask Claude Code (`claude -p`) to build it,
// check it, and link it to the calendar item. Also, when asked, to propose ideas that keep the next months filled.
//
// Safety, in the order a reader would worry about it:
//  - Nothing runs unless the project's settings.autoBuild (or autoPropose) is on, or the caller says yes.
//  - One build at a time per project (a lock file). A crashed run's lock and its half-built item are cleaned up next time.
//  - Every Claude run has a timeout; on Windows the whole process tree is stopped, by PID, never by name.
//  - The child gets NORDLE_AGENT_RUN=1 and only the tools it needs; the command-line steps only the owner may take
//    (approve, reject, sign off, settings) refuse when that variable is set. See docs/CALENDAR.md for what that does and does not guarantee.
//  - `spawn` and `exec` are injected so tests never start a real Claude.

import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT } from '../../tools/validate.mjs';
import { acquireRunLock } from './lock.mjs';
import { buildPrompt, proposePrompt } from './prompts.mjs';
import { CalendarError, linkDoc, listProjects, loadProject, mutateCalendar, runnableItems } from './service.mjs';
import { monthReport } from './plan.mjs';
import { addMonths, monthOf } from './dates.mjs';
import { claudeProgram, missingClaudeMessage } from './claude-bin.mjs';

export const DEFAULT_TIMEOUT_MS = 25 * 60 * 1000;
export const DEFAULT_MAX_TURNS = 60;
export const PROPOSE_MAX_TURNS = 25;
// What a run may cost. A claude -p run stops by itself at the budget, so a stuck run cannot quietly use a lot of the owner's allowance.
export const BUILD_BUDGET_USD = 2.5;
export const PROPOSE_BUDGET_USD = 1;
// Sonnet at medium effort builds a post well for far less than the biggest model at full effort; the owner can change both per brand (settings.claudeModel, claudeEffort)
export const DEFAULT_MODEL = 'sonnet';
export const DEFAULT_EFFORT = 'medium';
export const DEFAULT_LIMIT = 5;

const BUILD_TOOLS = ['mcp__nordle', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'Agent', 'Task', 'Bash(node:*)'];
const PROPOSE_TOOLS = ['mcp__nordle', 'Read', 'Glob', 'Grep'];

/** `claude -p` runs with its own sign-in, not the desktop app's: when that is missing or expired every run fails the same way, at once. */
export const SIGNED_OUT = /failed to authenticate|oauth session expired|not logged in|please run \/login|invalid api key|authentication_error/i;
export const SIGNED_OUT_MESSAGE = 'Claude Code is not signed in on this computer, so it could not start. In a terminal run: claude auth login (then try again).';

const clip = (s, n) => (String(s ?? '').length > n ? `${String(s).slice(0, n - 3)}...` : String(s ?? ''));
const tail = (s, n) => (String(s ?? '').length > n ? `...${String(s).slice(-n)}` : String(s ?? ''));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** Run a program and wait. Never rejects: { code, stdout, stderr }. No window on Windows. */
export function defaultExec(cmd, args = [], opts = {}) {
  return new Promise((done) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: opts.timeoutMs ?? 180000, cwd: opts.cwd, env: opts.env ?? process.env }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') + (error && typeof error.code !== 'number' ? ` ${error.message}` : '') });
    });
  });
}

// ---- the Claude Code command line --------------------------------------------------------------------------------------

export const claudeBin = () => claudeProgram();

/** The MCP config that gives the headless run the Nordle tools (written to a temp file for --mcp-config). */
export function mcpConfig(nordleRoot = ROOT) {
  const env = {};
  for (const k of ['NORDLE_RUNTIME_DIR', 'NORDLE_PROJECTS']) if (process.env[k]) env[k] = process.env[k];
  return { mcpServers: { nordle: { command: process.execPath, args: [join(nordleRoot, 'mcp.mjs')], ...(Object.keys(env).length ? { env } : {}) } } };
}

/** Arguments for `claude -p`. The prompt itself goes in on stdin. */
export function claudeArgs({ mcpFile, maxTurns = DEFAULT_MAX_TURNS, tools, model, effort, maxBudgetUsd } = {}) {
  const extra = (process.env.NORDLE_CLAUDE_ARGS ?? '').split(/\s+/).filter(Boolean);
  const allowed = process.env.NORDLE_CLAUDE_TOOLS ? process.env.NORDLE_CLAUDE_TOOLS.split(',').map((s) => s.trim()).filter(Boolean) : tools;
  return [
    '-p', '--output-format', 'json', '--max-turns', String(maxTurns),
    '--mcp-config', mcpFile, '--strict-mcp-config', '--permission-mode', 'acceptEdits',
    '--model', model || process.env.NORDLE_CLAUDE_MODEL || DEFAULT_MODEL,
    '--effort', effort || process.env.NORDLE_CLAUDE_EFFORT || DEFAULT_EFFORT,
    ...(maxBudgetUsd ? ['--max-budget-usd', String(maxBudgetUsd)] : []),
    '--no-session-persistence', ...extra,
    '--allowedTools', ...allowed,
  ];
}

function parseClaudeOutput(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  for (const candidate of [text, text.split('\n').filter(Boolean).at(-1)]) {
    try { const j = JSON.parse(candidate); if (j && typeof j === 'object') return j; } catch { /* try the last line */ }
  }
  return null;
}

/** Stop a child and everything it started. On Windows by PID with taskkill; never by program name. */
function killTree(child, exec) {
  const hard = () => { try { child.kill?.('SIGKILL'); } catch { /* already gone */ } };
  if (process.platform === 'win32' && Number.isInteger(child.pid) && child.pid > 4) {
    // the tree first (while its root still exists to be walked), then the root itself
    Promise.resolve(exec('taskkill', ['/pid', String(child.pid), '/t', '/f'])).then(hard, hard);
  } else hard();
}

/** Start Claude with a prompt on stdin and wait for it (or the timeout). Never rejects. */
export function runClaude({ spawn, exec, bin, args, cwd, env, prompt, timeoutMs, signal }) {
  return new Promise((done) => {
    const started = Date.now();
    let stdout = '', stderr = '', timedOut = false, aborted = false, settled = false, child, timer, backstop;
    const finish = (r) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(backstop);
      done({ code: null, signal: null, error: null, ...r, stdout, stderr, timedOut, aborted, durationMs: Date.now() - started });
    };
    // an AbortSignal stops the run the way a timeout does (the owner took the request back)
    const onAbort = () => { aborted = true; if (child) { killTree(child, exec); backstop = setTimeout(() => finish({ signal: 'SIGKILL' }), 10000); } else finish({ signal: 'SIGKILL' }); };
    if (signal?.aborted) { aborted = true; finish({ signal: 'SIGKILL' }); return; }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try { child = spawn(bin, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...(/\.(cmd|bat)$/i.test(String(bin)) ? { shell: true } : {}) }); } catch (e) { finish({ error: e.message }); return; }    const keep = (cur, chunk) => (cur + String(chunk)).slice(-2_000_000);
    child.stdout?.on('data', (d) => { stdout = keep(stdout, d); });
    child.stderr?.on('data', (d) => { stderr = keep(stderr, d); });
    child.on('error', (e) => finish({ error: e.code === 'ENOENT' ? missingClaudeMessage(bin) : e.message }));
    child.on('close', (code, signal) => finish({ code, signal }));
    child.stdin?.on?.('error', () => {});
    try { child.stdin?.end(prompt); } catch { /* the process may already have exited */ }
    timer = setTimeout(() => {
      timedOut = true;
      killTree(child, exec);
      backstop = setTimeout(() => finish({ signal: 'SIGKILL' }), 10000);   // if it never reports closing, stop waiting anyway
    }, timeoutMs);
  });
}

// ---- bookkeeping on the calendar ---------------------------------------------------------------------------------------

function claim(projectDir, id, mode, startedAt) {
  return mutateCalendar(projectDir, (cal) => {
    const it = cal.items.find((i) => i.id === id);
    if (!it) return null;
    const ok = mode === 'revise' ? it.status === 'changes' && it.doc : it.status === 'approved' && !it.doc;
    if (!ok) return null;
    it.status = 'building';
    it.run = { attempts: (it.run?.attempts ?? 0) + 1, startedAt, lastAt: startedAt, state: 'building' };
    it.updated = startedAt;
    return structuredClone(it);
  });
}

function giveBack(projectDir, id, mode, error, maxAttempts, { unlink = false, attempts: made } = {}) {
  return mutateCalendar(projectDir, (cal) => {
    const it = cal.items.find((i) => i.id === id);
    if (!it || !['building', 'built'].includes(it.status)) return null;       // the owner moved it meanwhile: leave it alone
    if (unlink) delete it.doc;
    it.status = mode === 'revise' && it.doc ? 'changes' : 'approved';
    const attempts = made ?? it.run?.attempts ?? 1;
    it.run = { attempts, startedAt: it.run?.startedAt, lastAt: new Date().toISOString(), lastError: clip(error, 500), state: attempts >= maxAttempts ? 'gave-up' : 'failed' };
    it.updated = new Date().toISOString();
    return structuredClone(it);
  });
}

/** A previous run died mid-build: put its item back, so it is built again rather than stuck on "building" for ever. */
export async function recoverStale(projectDir, now, staleMs) {
  return mutateCalendar(projectDir, (cal) => {
    const back = [];
    for (const it of cal.items) {
      if (it.status !== 'building') continue;
      const since = Date.parse(it.run?.startedAt ?? it.updated ?? '') || 0;
      if (now - since < staleMs) continue;
      it.status = it.doc ? ((it.feedback ?? []).some((f) => !f.resolved) ? 'changes' : 'built') : 'approved';
      it.run = { ...(it.run ?? {}), state: 'failed', lastError: 'A previous run stopped before it finished.', lastAt: new Date(now).toISOString() };
      back.push(it.id);
    }
    return back;
  });
}

function writeLog(projectDir, id, record) {
  try {
    const dir = join(projectDir, 'history', 'calendar-runs');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${stamp()}-${id}.json`);
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    return file;
  } catch { return null; }
}

const summarise = (out) => (out ? { is_error: out.is_error ?? null, subtype: out.subtype ?? null, num_turns: out.num_turns ?? null, total_cost_usd: out.total_cost_usd ?? null, session_id: out.session_id ?? null, result: clip(out.result, 2000) } : null);

/** Decide what a finished run achieved, and make the calendar say so. */
async function settle({ projectDir, item, mode, run, startedAtMs, exec, nordleRoot, maxAttempts, attempts, validate }) {
  const after = loadProject(projectDir).cal.items.find((i) => i.id === item.id);
  if (!after) return { outcome: 'failed', error: 'The item no longer exists.' };
  if (!['building', 'built'].includes(after.status)) return { outcome: 'skipped', error: `The owner changed the item to ${after.status} while it was being built; left as it is.` };

  let doc = after.status === 'built' ? after.doc : null;
  const note = [];
  if (!doc && !run.timedOut && !run.error) {
    const expected = after.doc ?? item.id;
    const file = join(projectDir, 'docs', `${expected}.json`);
    const fresh = existsSync(file) && (mode !== 'revise' || statSync(file).mtimeMs >= startedAtMs - 1000);
    if (fresh) { await linkDoc(projectDir, item.id, expected); doc = expected; note.push('The post existed but was not linked; the runner linked it.'); }
  }
  if (!doc) {
    const signedOut = !run.error && !run.timedOut && SIGNED_OUT.test(`${run.parsed?.result ?? ''} ${run.stdout ?? ''} ${run.stderr ?? ''}`);
    const why = signedOut ? SIGNED_OUT_MESSAGE : run.error ?? (run.timedOut ? `Timed out after ${Math.round(run.durationMs / 60000)} minutes.` : `Claude finished (exit ${run.code}) without building the post. ${clip(run.parsed?.result ?? tail(run.stderr, 400), 400)}`);
    await giveBack(projectDir, item.id, mode, why, maxAttempts, { attempts });
    return { outcome: signedOut ? 'signed-out' : run.timedOut ? 'timeout' : 'failed', error: why };
  }
  if (validate) {
    const file = join(projectDir, 'docs', `${doc}.json`);
    // tools/validate.mjs directly: `nordle.mjs validate` prints nothing once a CLI plug-in has loaded that module first
    const r = await exec(process.execPath, [join(nordleRoot, 'tools', 'validate.mjs'), file, '--assets'], { cwd: nordleRoot });
    if (r.code !== 0) {
      const why = `The finished post "${doc}" does not validate: ${clip((r.stdout + r.stderr).split('\n').filter((l) => /error|FAIL/.test(l)).slice(0, 3).join(' | '), 400)}`;
      await giveBack(projectDir, item.id, mode, why, maxAttempts, { unlink: mode !== 'revise', attempts });
      return { outcome: 'failed', error: why };
    }
  }
  return { outcome: 'built', doc, notes: note };
}

// ---- building ----------------------------------------------------------------------------------------------------------

/**
 * Build what is due. Options:
 *   projectDir, today (ISO date; default: today in the brand's timezone), yes (run even if autoBuild is off), dryRun (say what would
 *   run, change nothing), limit (most items this run), itemId (only this one), timeoutMs, maxTurns, validate (default true: run
 *   `nordle validate` on the result), exec/spawn (injected in tests), log (progress callback), nordleRoot, now.
 * Returns { project, today, enabled, reason?, locked?, due:[{id,mode,date}], ran:[{id,mode,outcome,doc?,error?,durationMs,log}], dryRun? }.
 */
export async function runDue({
  projectDir, today, yes = false, dryRun = false, limit = DEFAULT_LIMIT, itemId, timeoutMs = DEFAULT_TIMEOUT_MS, maxTurns = DEFAULT_MAX_TURNS,
  validate = true, exec = defaultExec, spawn = nodeSpawn, log = () => {}, nordleRoot = ROOT, now = Date.now(), model, signal,
} = {}) {
  const dir = resolve(projectDir);
  const look = () => {
    const proj = loadProject(dir);
    const q = runnableItems(proj.cal, today ?? proj.today).filter((x) => !itemId || x.item.id === itemId);
    return { p: proj, queue: q };
  };
  let { p, queue } = look();
  const day = today ?? p.today;
  const dueOf = (q) => q.map((x) => ({ id: x.item.id, mode: x.mode, date: x.item.date }));
  const result = { project: p.id, today: day, enabled: true, due: dueOf(queue), ran: [] };
  if (!yes && !p.settings.autoBuild) {
    return { ...result, enabled: false, reason: `autoBuild is off for "${p.id}". Turn it on (node nordle.mjs calendar settings ${p.id} --auto-build on) or run with --yes.` };
  }

  if (dryRun) {
    result.dryRun = queue.slice(0, limit).map(({ item, mode }) => {
      const prompt = buildPrompt(dir, item.id, { mode, today: day, nordleRoot });
      return { id: item.id, mode, command: [claudeBin(), ...claudeArgs({ mcpFile: '<temp mcp config>', maxTurns, tools: BUILD_TOOLS, model: model ?? p.settings.claudeModel, effort: p.settings.claudeEffort, maxBudgetUsd: p.settings.maxBudgetUsd ?? BUILD_BUDGET_USD })], promptChars: prompt.length, prompt };
    });
    return result;
  }

  const lock = acquireRunLock(dir, { mode: 'build' }, { staleMs: timeoutMs * 1.5 + 120000 });
  if (!lock.ok) return { ...result, locked: lock.holder };
  let tmp;
  try {
    // with the lock held nobody else is building, so anything still marked "building" was left by a run that died
    const recovered = await recoverStale(dir, now, timeoutMs * 1.5 + 120000);
    if (recovered.length) {
      log(`Put back items a previous run left half-built: ${recovered.join(', ')}`);
      ({ p, queue } = look());
      result.due = dueOf(queue);
    }
    if (!queue.length) return result;
    tmp = mkdtempSync(join(tmpdir(), 'nordle-run-'));
    const mcpFile = join(tmp, 'mcp.json');
    writeFileSync(mcpFile, JSON.stringify(mcpConfig(nordleRoot)));
    const maxAttempts = p.settings.maxBuildAttempts;

    for (const { item, mode } of queue.slice(0, limit)) {
      const startedAt = new Date().toISOString();
      const startedMs = Date.now();
      const claimed = await claim(dir, item.id, mode, startedAt);
      if (!claimed) { result.ran.push({ id: item.id, mode, outcome: 'skipped', error: 'It changed before the runner could start on it.' }); continue; }
      lock.update({ item: item.id, mode });
      log(`${mode === 'revise' ? 'Revising' : 'Building'} ${item.id} (${item.format}, ${item.date})...`);

      let prompt, args, run, verdict;
      try {
        prompt = buildPrompt(dir, item.id, { mode, today: day, nordleRoot });
        args = claudeArgs({ mcpFile, maxTurns, tools: BUILD_TOOLS, model: model ?? p.settings.claudeModel, effort: p.settings.claudeEffort, maxBudgetUsd: p.settings.maxBudgetUsd ?? BUILD_BUDGET_USD });
        const env = { ...process.env, NORDLE_AGENT_RUN: '1' };
        run = await runClaude({ spawn, exec, bin: claudeBin(), args, cwd: dir, env, prompt, timeoutMs, signal });
        run.parsed = parseClaudeOutput(run.stdout);
        if (run.aborted) {
          // the owner took the request back (Undo already put the item back as it was): leave the calendar alone
          result.ran.push({ id: item.id, mode, outcome: 'cancelled', durationMs: run.durationMs });
          log('  cancelled');
          break;
        }
        verdict = await settle({ projectDir: dir, item, mode, run, startedAtMs: startedMs, exec, nordleRoot, maxAttempts, attempts: claimed.run.attempts, validate });
      } catch (e) {
        // whatever went wrong, the item must not be left on "building"
        const why = `The runner hit a problem: ${e.message}`;
        await giveBack(dir, item.id, mode, why, maxAttempts, { attempts: claimed.run.attempts, unlink: mode !== 'revise' }).catch(() => {});
        result.ran.push({ id: item.id, mode, outcome: 'failed', error: why });
        log(`  failed: ${why}`);
        continue;
      }
      const logFile = writeLog(dir, item.id, {
        id: item.id, mode, startedAt, durationMs: run.durationMs, exitCode: run.code, signal: run.signal, timedOut: run.timedOut, spawnError: run.error,
        outcome: verdict.outcome, error: verdict.error ?? null, claude: summarise(run.parsed), stderrTail: tail(run.stderr, 1500), command: [claudeBin(), ...args], promptChars: prompt.length,
      });
      result.ran.push({ id: item.id, mode, outcome: verdict.outcome, ...(run.parsed?.num_turns ? { turns: run.parsed.num_turns } : {}), ...(typeof run.parsed?.total_cost_usd === 'number' ? { costUsd: run.parsed.total_cost_usd } : {}), ...(verdict.doc ? { doc: verdict.doc } : {}), ...(verdict.error ? { error: verdict.error } : {}), durationMs: run.durationMs, log: logFile });
      log(`  ${verdict.outcome}${verdict.doc ? ` -> ${verdict.doc}` : ''}${verdict.error ? `: ${verdict.error}` : ''}`);
      if ((verdict.outcome === 'failed' && run.error) || verdict.outcome === 'signed-out') break;          // Claude cannot even start (or is signed out): do not try the rest
    }
  } finally {
    lock.release();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
  return result;
}

// ---- proposing ---------------------------------------------------------------------------------------------------------

const stateFile = (dir) => join(dir, 'history', 'calendar-runs', 'propose-state.json');
const readState = (dir) => { try { return JSON.parse(readFileSync(stateFile(dir), 'utf8')); } catch { return {}; } };

/**
 * Ask Claude to propose ideas for the months (within horizonMonths) that are short of their quota. Same safety rules as runDue.
 * It runs at most once every `minHours` unless yes is true. Returns { project, enabled, months, ran:[...]}.
 */
export async function runPropose({
  projectDir, today, yes = false, dryRun = false, timeoutMs = DEFAULT_TIMEOUT_MS, maxTurns = PROPOSE_MAX_TURNS, minHours = 20,
  exec = defaultExec, spawn = nodeSpawn, log = () => {}, nordleRoot = ROOT, now = Date.now(), model, months: onlyMonths, extra = '',
} = {}) {
  const dir = resolve(projectDir);
  const p = loadProject(dir);
  const day = today ?? p.today;
  const months = [];
  if (Array.isArray(onlyMonths) && onlyMonths.length) months.push(...onlyMonths);   // the owner picked the month (the Create page)
  else for (let i = 0; i < p.settings.horizonMonths; i++) { const m = addMonths(monthOf(day), i); if (monthReport(p.cal, m).missingTotal > 0) months.push(m); }
  const result = { project: p.id, today: day, enabled: true, months, ran: [] };
  if (!yes && !p.settings.autoPropose) return { ...result, enabled: false, reason: `autoPropose is off for "${p.id}". Turn it on (node nordle.mjs calendar settings ${p.id} --auto-propose on) or run with --propose --yes.` };
  if (!months.length) return result;
  const last = readState(dir);
  if (!yes && last.lastAt && now - Date.parse(last.lastAt) < minHours * 3600 * 1000) return { ...result, skipped: `Proposed ${Math.round((now - Date.parse(last.lastAt)) / 3600000)} hours ago; waiting.` };

  const prompt = proposePrompt(dir, { months, today: day, nordleRoot }) + (extra ? `\n${String(extra).slice(0, 6000)}` : '');
  if (dryRun) return { ...result, dryRun: [{ command: [claudeBin(), ...claudeArgs({ mcpFile: '<temp mcp config>', maxTurns, tools: PROPOSE_TOOLS, model: model ?? p.settings.claudeModel, effort: p.settings.claudeEffort, maxBudgetUsd: p.settings.maxBudgetUsd ?? PROPOSE_BUDGET_USD })], promptChars: prompt.length, prompt }] };

  const lock = acquireRunLock(dir, { mode: 'propose', item: null }, { staleMs: timeoutMs * 1.5 + 120000 });
  if (!lock.ok) return { ...result, locked: lock.holder };
  const tmp = mkdtempSync(join(tmpdir(), 'nordle-run-'));
  try {
    const mcpFile = join(tmp, 'mcp.json');
    writeFileSync(mcpFile, JSON.stringify(mcpConfig(nordleRoot)));
    const before = new Set(loadProject(dir).cal.items.map((i) => i.id));
    log(`Asking Claude for ideas for ${months.join(', ')}...`);
    const args = claudeArgs({ mcpFile, maxTurns, tools: PROPOSE_TOOLS, model: model ?? p.settings.claudeModel, effort: p.settings.claudeEffort, maxBudgetUsd: p.settings.maxBudgetUsd ?? PROPOSE_BUDGET_USD });
    const run = await runClaude({ spawn, exec, bin: claudeBin(), args, cwd: dir, env: { ...process.env, NORDLE_AGENT_RUN: '1' }, prompt, timeoutMs });
    run.parsed = parseClaudeOutput(run.stdout);
    const added = loadProject(dir).cal.items.filter((i) => !before.has(i.id));
    const outcome = added.length ? 'proposed' : run.timedOut ? 'timeout' : 'failed';
    const error = added.length ? null : run.error ?? (run.timedOut ? 'Timed out.' : `Claude finished (exit ${run.code}) without adding any ideas. ${clip(run.parsed?.result ?? tail(run.stderr, 300), 300)}`);
    const logFile = writeLog(dir, 'propose', { startedAt: new Date(now).toISOString(), durationMs: run.durationMs, exitCode: run.code, timedOut: run.timedOut, outcome, added: added.map((i) => i.id), error, claude: summarise(run.parsed), stderrTail: tail(run.stderr, 1500), command: [claudeBin(), ...args], promptChars: prompt.length });
    mkdirSync(join(dir, 'history', 'calendar-runs'), { recursive: true });
    writeFileSync(stateFile(dir), JSON.stringify({ lastAt: new Date(now).toISOString(), months, added: added.length }));
    result.ran.push({ outcome, added: added.map((i) => i.id), ...(error ? { error } : {}), durationMs: run.durationMs, ...(run.parsed?.num_turns ? { turns: run.parsed.num_turns } : {}), ...(typeof run.parsed?.total_cost_usd === 'number' ? { costUsd: run.parsed.total_cost_usd } : {}), log: logFile });
  } finally {
    lock.release();
    rmSync(tmp, { recursive: true, force: true });
  }
  return result;
}

/** Every project under the projects folder(s): build what is due, then (if on) propose. One project at a time. */
export async function runAll(opts = {}) {
  const out = [];
  for (const proj of listProjects(opts.roots)) {
    try {
      const built = await runDue({ ...opts, projectDir: proj.dir });
      const proposed = await runPropose({ ...opts, projectDir: proj.dir });
      out.push({ project: proj.id, built, proposed });
    } catch (e) {
      if (!(e instanceof CalendarError)) throw e;
      out.push({ project: proj.id, error: e.message });
    }
  }
  return out;
}
