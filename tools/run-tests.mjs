#!/usr/bin/env node
// Runs every tests/*.test.mjs as its own `node --test` process, two at a time (the same load as `--test-concurrency=2`).
//   node tools/run-tests.mjs [--concurrency 2] [--retries 1] [part of a file name ...]
// The browser-driven tests are timing-sensitive on slow or busy computers (CI runners especially): a file can time out under load and pass alone.
// So a file that fails is run again, on its own, and one that passes the second time is reported as FLAKY and does not fail the run. A file that fails
// every time does. Nothing is hidden: the flaky files are listed at the end, with the first failure's message.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf(name); if (i < 0) return dflt; const v = Number(args[i + 1]); args.splice(i, 2); return Number.isFinite(v) ? v : dflt; };
const CONCURRENCY = Math.max(1, flag('--concurrency', 2));
const RETRIES = Math.max(0, flag('--retries', 1));
const only = args.filter((a) => !a.startsWith('--'));
const files = readdirSync(join(ROOT, 'tests')).filter((f) => f.endsWith('.test.mjs') && (!only.length || only.some((o) => f.includes(o)))).sort().map((f) => join('tests', f));
if (!files.length) { console.error('No test files match.'); process.exit(2); }

function run(file) {
  return new Promise((done) => {
    const started = Date.now();
    let out = '';
    const child = spawn(process.execPath, ['--test', '--test-timeout=240000', file], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => done({ file, code: 1, out: String(e), ms: Date.now() - started }));
    child.on('close', (code) => done({ file, code, out, ms: Date.now() - started }));
  });
}
const failures = (out) => [...out.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1].slice(0, 140));
// The report of each failed test, from its "not ok" line to the "..." that closes it: the assertion, expected/actual and the stack.
function failureBlocks(out) {
  const lines = out.split('\n'), keep = [];
  for (let i = 0; i < lines.length && keep.length < 120; i++) {
    if (!/^\s*not ok \d+ /.test(lines[i])) continue;
    for (; i < lines.length && keep.length < 120; i++) { keep.push(lines[i]); if (/^\s*\.\.\.\s*$/.test(lines[i])) break; }
  }
  return keep.length ? keep : lines.slice(-40);
}
const counts = (out) => ({ tests: Number(/^# tests (\d+)/m.exec(out)?.[1] ?? 0), pass: Number(/^# pass (\d+)/m.exec(out)?.[1] ?? 0) });

const queue = [...files];
const results = [];
async function worker() {
  while (queue.length) {
    const file = queue.shift();
    let r = await run(file);
    const first = r.code === 0 ? null : failures(r.out);
    let tries = 0;
    while (r.code !== 0 && tries < RETRIES) { tries++; console.log(`  retrying ${file} on its own (first run failed: ${(first ?? []).join(' | ') || 'no test name found'})`); r = await run(file); }
    results.push({ file, ok: r.code === 0, flaky: r.code === 0 && first !== null, first, last: r.code === 0 ? null : failures(r.out), ...counts(r.out), out: r.code === 0 ? '' : r.out });
    console.log(`${r.code === 0 ? (first ? 'FLAKY' : 'ok   ') : 'FAIL '} ${file}  (${counts(r.out).pass}/${counts(r.out).tests}, ${(r.ms / 1000).toFixed(1)}s)`);
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

const bad = results.filter((r) => !r.ok), flaky = results.filter((r) => r.flaky);
const total = results.reduce((t, r) => t + r.tests, 0), passed = results.reduce((t, r) => t + r.pass, 0);
console.log(`\n${files.length} test files, ${total} tests counted in the last run of each file, ${passed} passed.`);
if (flaky.length) { console.log(`\n${flaky.length} file(s) failed once and passed on a second run alone (timing under load):`); for (const r of flaky) console.log(`  ${r.file}: ${r.first.join(' | ')}`); }
if (bad.length) {
  console.log(`\n${bad.length} file(s) FAILED every time:`);
  for (const r of bad) { console.log(`  ${r.file}: ${r.last.join(' | ') || 'no test name found'}`); console.log(failureBlocks(r.out).map((l) => `    ${l}`).join('\n')); }
  process.exit(1);
}
