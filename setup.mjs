#!/usr/bin/env node
// One-step setup:  node setup.mjs [--register] [--no-browser] [--dry-run]
//   1. checks Node 20+ (and tells you if ffmpeg is missing: video needs it)
//   2. npm install (the four small dependencies in package.json)
//   3. downloads the Chromium that Nordle draws pages with (about 170 MB, once) unless --no-browser
//   4. --register: adds the Nordle MCP server to Claude Code and copies the skill into your skills folder
//   5. runs the doctor so you can see what is ready
// Nothing here touches anything outside this folder, except step 4 (your Claude Code settings and skills folder).

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const dry = args.has('--dry-run');
const win = process.platform === 'win32';

const say = (s) => console.log(s);
const run = (cmd, a, opts = {}) => {
  say(`  $ ${cmd} ${a.join(' ')}`);
  if (dry) return { status: 0 };
  const r = spawnSync(cmd, a, { cwd: ROOT, encoding: 'utf8', windowsHide: true, shell: win && ['npm', 'npx', 'claude'].includes(cmd), ...opts });
  if (r.error) return { status: 1, error: r.error.message };
  return r;
};

say('Nordle setup' + (dry ? ' (dry run: nothing is changed)' : ''));

const major = Number(process.versions.node.split('.')[0]);
if (major < 20) { say(`x Node.js 20 or newer is needed (this is ${process.versions.node}). Install it from nodejs.org and run this again.`); process.exit(1); }
say(`ok Node.js ${process.versions.node}`);

const ff = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true, shell: win });
say(ff.status === 0 ? 'ok ffmpeg found (video posts will work)' : '! ffmpeg not found. Posts made of pictures work without it; video posts need it. Install it (https://ffmpeg.org) and run `node nordle.mjs doctor`.');

if (!existsSync(join(ROOT, 'node_modules', 'ajv'))) {
  say('\n1. Installing the dependencies');
  const r = run('npm', ['install', '--no-audit', '--no-fund']);
  if (r.status !== 0) { say(`x npm install failed.\n${r.stderr ?? r.error ?? ''}`); process.exit(1); }
} else say('ok dependencies already installed');

if (!args.has('--no-browser')) {
  say('\n2. Getting the browser Nordle draws pages with (about 170 MB, only the first time)');
  const r = run('npx', ['playwright-core', 'install', 'chromium']);
  if (r.status !== 0) { say(`x Could not get the browser.\n${r.stderr ?? r.error ?? ''}\nTry again, or run: npx playwright-core install chromium`); process.exit(1); }
}

if (args.has('--register')) {
  say('\n3. Connecting Claude Code');
  const mcp = join(ROOT, 'mcp.mjs').replace(/\\/g, '/');
  const r = run('claude', ['mcp', 'add', '--scope', 'user', 'nordle', '--', 'node', mcp]);
  if (r.status !== 0) say(`! Could not run \`claude mcp add\` (${(r.stderr ?? r.error ?? '').toString().trim().split('\n')[0]}).\n  Run this yourself in a terminal: claude mcp add --scope user nordle -- node ${mcp}`);
  const skills = join(homedir(), '.claude', 'skills', 'nordle');
  if (!dry) { mkdirSync(dirname(skills), { recursive: true }); cpSync(join(ROOT, 'skills', 'nordle'), skills, { recursive: true }); }
  say(`ok skill copied to ${skills}`);
  say('  Restart Claude Code so the nordle_* tools appear.');
}

say('\nChecking this computer');
const d = run(process.execPath, [join(ROOT, 'nordle.mjs'), 'doctor'], {});
if (!dry && d.stdout) say(d.stdout.trim().split('\n').map((l) => `  ${l}`).join('\n'));

say(`\nDone. Start the editor with:  node server.mjs --open   (http://127.0.0.1:5400)\nFirst time? Open the sample project, or tell Claude: "Make a 5-slide carousel in the sample brand".`);
