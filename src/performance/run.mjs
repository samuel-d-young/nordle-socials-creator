// The optional headless review: when a project's calendar settings say review.autoReview is true and a review is due, ask Claude Code
// (`claude -p`) to write it. Same safety rules as the build runner (src/calendar/run.mjs):
//  - off unless settings.review.autoReview is on (or the caller says yes); never runs when there are no numbers to review
//  - one run at a time per project (the same .calendar-run.lock), a timeout, the whole process tree stopped by PID on Windows
//  - read tools plus the Nordle tools only (no Bash, no file writes by Claude itself); NORDLE_AGENT_RUN=1 so owner-only command-line
//    steps refuse; the review's calendar changes go through the calendar service, so a built post can never be touched
//  - spawn and exec are injected so tests never start a real Claude
// `calendar run` calls reviewStep() after building: it always MENTIONS a due review, and runs one only with autoReview on.

import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ROOT } from '../../tools/validate.mjs';
import { acquireRunLock } from '../calendar/lock.mjs';
import { DEFAULT_MAX_TURNS, DEFAULT_TIMEOUT_MS, claudeArgs, claudeBin, defaultExec, mcpConfig, runClaude } from '../calendar/run.mjs';
import { loadProject } from '../calendar/service.mjs';
import { spawn as nodeSpawn } from 'node:child_process';
import { reviewPrompt } from './prompts.mjs';
import { reviewDue } from './review.mjs';

const REVIEW_TOOLS = ['mcp__nordle', 'Read', 'Glob', 'Grep'];
const tail = (s, n) => (String(s ?? '').length > n ? `...${String(s).slice(-n)}` : String(s ?? ''));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

function parseOut(stdout) {
  const t = String(stdout ?? '').trim();
  for (const c of [t, t.split('\n').filter(Boolean).at(-1)]) { try { const j = JSON.parse(c); if (j && typeof j === 'object') return j; } catch { /* try the last line */ } }
  return null;
}

/**
 * Write the due review with Claude, if allowed. Returns { project, today, enabled, due, ran:[{outcome, period, error?, durationMs, log}], dryRun?, reason?, skipped?, locked? }.
 * outcome: 'reviewed' | 'failed' | 'timeout'.
 */
export async function runReview({
  projectDir, today, yes = false, dryRun = false, timeoutMs = DEFAULT_TIMEOUT_MS, maxTurns = DEFAULT_MAX_TURNS,
  exec = defaultExec, spawn = nodeSpawn, log = () => {}, nordleRoot = ROOT, model, window = '7d',
} = {}) {
  const dir = resolve(projectDir);
  const p = loadProject(dir);
  const day = today ?? p.today;
  const due = reviewDue(dir, day);
  const result = { project: p.id, today: day, enabled: true, due, ran: [] };
  if (!due.configured || !due.due) return result;
  if (!yes && !due.autoReview) return { ...result, enabled: false, reason: `autoReview is off for "${p.id}". The review is due: run it by hand (node nordle.mjs performance review-prompt ${p.id}) or turn it on (node nordle.mjs calendar settings ${p.id} --auto-review on).` };
  if (!due.numbers.withNumbers) return { ...result, skipped: `No numbers for ${due.label} yet, so there is nothing to review. Add them first (node nordle.mjs performance import ${p.id} <file.csv>).` };

  const prompt = reviewPrompt(dir, due.period, { today: day, window });
  const args = (mcpFile) => claudeArgs({ mcpFile, maxTurns, tools: REVIEW_TOOLS, model });
  if (dryRun) return { ...result, dryRun: [{ period: due.period, command: [claudeBin(), ...args('<temp mcp config>')], promptChars: prompt.length, prompt }] };

  const lock = acquireRunLock(dir, { mode: 'review', item: null }, { staleMs: timeoutMs * 1.5 + 120000 });
  if (!lock.ok) return { ...result, locked: lock.holder };
  const tmp = mkdtempSync(join(tmpdir(), 'nordle-review-'));
  try {
    const mcpFile = join(tmp, 'mcp.json');
    writeFileSync(mcpFile, JSON.stringify(mcpConfig(nordleRoot)));
    const startedMs = Date.now();
    log(`Asking Claude to write the ${due.period} review for ${p.id}...`);
    const argv = args(mcpFile);
    const run = await runClaude({ spawn, exec, bin: claudeBin(), args: argv, cwd: dir, env: { ...process.env, NORDLE_AGENT_RUN: '1' }, prompt, timeoutMs });
    run.parsed = parseOut(run.stdout);
    const file = join(dir, 'reviews', `${due.period}.md`);
    const wrote = existsSync(file) && statSync(file).mtimeMs >= startedMs - 1000;
    const outcome = wrote ? 'reviewed' : run.timedOut ? 'timeout' : 'failed';
    const error = wrote ? null : run.error ?? (run.timedOut ? `Timed out after ${Math.round(run.durationMs / 60000)} minutes.` : `Claude finished (exit ${run.code}) without saving a review. ${tail(run.parsed?.result ?? run.stderr, 300)}`);
    let logFile = null;
    try {
      const logDir = join(dir, 'history', 'calendar-runs');
      mkdirSync(logDir, { recursive: true });
      logFile = join(logDir, `${stamp()}-review.json`);
      writeFileSync(logFile, `${JSON.stringify({ mode: 'review', period: due.period, startedAt: new Date(startedMs).toISOString(), durationMs: run.durationMs, exitCode: run.code, timedOut: run.timedOut, spawnError: run.error, outcome, error, claude: run.parsed ? { is_error: run.parsed.is_error ?? null, num_turns: run.parsed.num_turns ?? null, total_cost_usd: run.parsed.total_cost_usd ?? null, result: tail(run.parsed.result, 2000) } : null, stderrTail: tail(run.stderr, 1500), command: [claudeBin(), ...argv], promptChars: prompt.length }, null, 2)}\n`);
    } catch { logFile = null; }
    result.ran.push({ outcome, period: due.period, ...(error ? { error } : {}), durationMs: run.durationMs, log: logFile });
  } finally {
    lock.release();
    rmSync(tmp, { recursive: true, force: true });
  }
  return result;
}

/**
 * What `calendar run` adds after building and proposing: a line when a review is due, and (autoReview only) the review itself.
 * Never throws. Returns { lines, failed }.
 */
export async function reviewStep(projectDir, opts = {}) {
  try {
    const due = reviewDue(projectDir, opts.today);
    if (!due.configured || !due.due) return { lines: [], failed: false };
    const r = await runReview({ projectDir, ...opts });
    const id = due.project;
    if (!r.enabled) return { lines: [`${id}: ${due.message} (${r.reason})`], failed: false };
    if (r.skipped) return { lines: [`${id}: ${r.skipped}`], failed: false };
    if (r.locked) return { lines: [`${id}: a review is due but another run is in progress.`], failed: false };
    if (r.dryRun) return { lines: r.dryRun.map((d) => `${id}: would write the ${d.period} review with: ${d.command.join(' ')} (prompt ${d.promptChars} characters; see: performance review-prompt ${id})`), failed: false };
    return { lines: r.ran.map((x) => `${id}: review ${x.period} ${x.outcome}${x.error ? `: ${x.error}` : ''}`), failed: r.ran.some((x) => x.outcome !== 'reviewed') };
  } catch (e) {
    return { lines: [`review check failed: ${e.message}`], failed: false };
  }
}
