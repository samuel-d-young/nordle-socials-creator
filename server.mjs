#!/usr/bin/env node
// Start the Nordle editor:  node server.mjs [--port 5400] [--open]
// Projects live in ./projects (or the folders in NORDLE_PROJECTS, separated like PATH). On the first run the sample
// project is copied there so there is something to open.

import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { delimiter, join } from 'node:path';
import { ROOT } from './tools/validate.mjs';
import { createNordleServer } from './src/server/http.mjs';
import { createReviser } from './src/studio/revise.mjs';
import { createAutoScheduler } from './src/publish/auto.mjs';
import { createAutoSync } from './src/publish/auto-sync.mjs';

const args = process.argv.slice(2);
const flagValue = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const explicitPort = flagValue('--port') ?? process.env.NORDLE_PORT ?? process.env.PORT;
const wantedPort = Number(explicitPort ?? 5400);
if (!Number.isInteger(wantedPort) || wantedPort < 0 || wantedPort > 65535) { console.error('nordle: --port must be a number from 0 to 65535'); process.exit(2); }

const roots = process.env.NORDLE_PROJECTS ? process.env.NORDLE_PROJECTS.split(delimiter).filter(Boolean) : [join(ROOT, 'projects')];
const home = roots[0];
mkdirSync(home, { recursive: true });

const hasProject = (dir) => existsSync(dir) && readdirSync(dir).some((n) => existsSync(join(dir, n, 'brand.json')));
if (!roots.some(hasProject)) {
  const sample = join(ROOT, 'samples', 'little-gannet');
  if (existsSync(sample)) {
    cpSync(sample, join(home, 'little-gannet'), { recursive: true, filter: (src) => !/[\\/](out|sources|history|review)([\\/]|$)/.test(src) });
    console.log(`First run: copied the sample project to ${join(home, 'little-gannet')}`);
  }
}

// "Request changes" in the Studio starts the designer on the post at once (a headless Claude run; each project's autoRevise setting can turn it off)
const reviser = createReviser();
// ...and, once the owner has switched it on in the Studio, signed-off posts whose slot is a week away go to Buffer by themselves
const autoScheduler = createAutoScheduler();
const autoSync = createAutoSync();
const app = createNordleServer({ roots, createIn: home, autoRender: true, reviser, autoScheduler, runtimeDir: process.env.NORDLE_RUNTIME_DIR ?? join(ROOT, '.nordle') });
let port;
for (let attempt = 0; attempt < (explicitPort === undefined ? 10 : 1); attempt++) {
  try { port = await app.listen(wantedPort === 0 ? 0 : wantedPort + attempt); break; } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e;
    if (explicitPort !== undefined) { console.error(`nordle: port ${wantedPort} is already in use. Try: node server.mjs --port ${wantedPort + 1}`); process.exit(1); }
  }
}
if (port === undefined) { console.error('nordle: no free port found near 5400.'); process.exit(1); }

// a run that died with the last server left its post on "building": put it back and start that revision again
autoScheduler.start(app.store);
autoSync.start(app.store);
reviser.recover(app.store).then((again) => { if (again.length) console.log(`Revising again after the restart: ${again.join(', ')}`); }, () => {});

const url = `http://127.0.0.1:${port}/`;
console.log(`Nordle is running at ${url}`);
console.log(`Projects: ${roots.join(delimiter)}   (stop with Ctrl+C)`);

if (args.includes('--open')) {
  const [cmd, cmdArgs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd, cmdArgs, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// stopping the server also stops any designer run it started (its post goes back on the next start)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { for (const uid of reviser.pending()) reviser.cancel(uid); autoScheduler.stop(); autoSync.stop(); await app.close(); process.exit(0); });
