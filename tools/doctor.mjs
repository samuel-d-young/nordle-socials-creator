#!/usr/bin/env node
// nordle doctor: checks that this computer can run Nordle, and says how to fix what is missing.
//   node tools/doctor.mjs [--ci] [--json]
// --ci  ffmpeg and Chromium are reported but do not fail the run (CI images vary)

import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2));
const ci = flags.has('--ci');
const platform = process.platform;

function firstLine(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (r.error || r.status !== 0) return null;
  return `${r.stdout || r.stderr || ''}`.split(/\r?\n/)[0].trim() || null;
}

const hints = {
  node: { win32: 'winget install OpenJS.NodeJS.LTS', darwin: 'brew install node', linux: 'install Node.js 20 or newer from https://nodejs.org or your package manager' },
  git: { win32: 'winget install Git.Git', darwin: 'brew install git', linux: 'sudo apt install git (or your package manager)' },
  ffmpeg: { win32: 'winget install Gyan.FFmpeg  (then open a new terminal)', darwin: 'brew install ffmpeg', linux: 'sudo apt install ffmpeg (or your package manager)' },
};

function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  return { name: 'Node.js', required: true, ok: major >= 20, detail: `${process.versions.node} (needs 20 or newer)`, fix: hints.node[platform] };
}

function checkGit() {
  const v = firstLine('git', ['--version']);
  return { name: 'git', required: true, ok: !!v, detail: v ?? 'not found', fix: hints.git[platform] };
}

function checkFfmpeg(bin) {
  const v = firstLine(bin, ['-version']);
  const short = v ? v.replace(/^(ffmpeg|ffprobe) version\s+/, '').split(' ')[0] : 'not found';
  return { name: bin, required: !ci, ok: !!v, detail: short, fix: hints.ffmpeg[platform] };
}

async function checkBrowser() {
  try {
    const { openBrowser } = await import('../src/render/browser.mjs');
    const browser = await openBrowser();
    const version = browser.version();
    await browser.close();
    return { name: 'Browser for rendering', required: true, ok: true, detail: `Chromium ${version}`, fix: '' };
  } catch (e) {
    return { name: 'Browser for rendering', required: true, ok: false, detail: String(e.message).split(/\r?\n/)[0], fix: 'npx playwright-core install chromium' };
  }
}

function checkWritable() {
  let ok = true;
  try { accessSync(ROOT, constants.W_OK); } catch { ok = false; }
  return { name: 'Project folder writable', required: true, ok, detail: ROOT, fix: 'move Nordle to a folder you can write to' };
}

const checks = [checkNode(), checkGit(), checkFfmpeg('ffmpeg'), checkFfmpeg('ffprobe'), await checkBrowser(), checkWritable()];
const failed = checks.filter((c) => c.required && !c.ok);

if (flags.has('--json')) {
  console.log(JSON.stringify({ platform, arch: os.arch(), node: process.versions.node, checks, ready: failed.length === 0 }, null, 2));
} else {
  console.log(`Nordle doctor (${platform} ${os.arch()}, Node ${process.versions.node})`);
  console.log('Nordle was created by Samuel Young and is free to use under CC BY 4.0 (credit him if you share or build on it: ATTRIBUTION.md).\n');
  for (const c of checks) {
    const tag = c.ok ? 'OK  ' : c.required ? 'FAIL' : 'info';
    console.log(`  ${tag}  ${c.name}: ${c.detail}`);
    if (!c.ok && c.fix) console.log(`        fix: ${c.fix}`);
  }
  console.log(failed.length ? `\nNot ready: fix ${failed.map((c) => c.name).join(', ')}.` : '\nReady.');
  if (!ci && process.env.NORDLE_NO_UPDATE_CHECK !== '1') {
    try {
      const { checkForUpdate } = await import('../src/update/check.mjs');
      const u = await checkForUpdate();
      if (u.enabled && u.updateAvailable) console.log(`\nUpdate: Nordle has been updated on GitHub (${u.behindBy || 'new'} change${u.behindBy === 1 ? '' : 's'}). To update: ${u.command}`);
      else if (u.enabled && !u.error) console.log('\nUpdate: you have the latest Nordle.');
    } catch { /* no network: nothing to say */ }
  }
}
process.exitCode = failed.length ? 1 : 0;
