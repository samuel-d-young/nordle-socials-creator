#!/usr/bin/env node
// A made-up workspace to look at the Studio with: three fictional brands, about 117 posts, check records, comments.
//   node tools/studio-demo.mjs [--port 5441] [--real]
// Nothing here is real: the brands, posts and pictures are generated. The workspace lives in the system temp folder and is
// deleted when you stop it (Ctrl+C).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNordleServer } from '../src/server/http.mjs';
import { buildWorkspace } from './studio-fixtures.mjs';

const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const port = Number(flag('--port') ?? 0);
if (port === 5400) { console.error('Port 5400 belongs to the main editor. Pick another.'); process.exit(2); }

const root = mkdtempSync(join(tmpdir(), 'nordle-studio-demo-'));
const real = args.includes('--real');
const posters = real ? await (await import('./studio-posters.mjs')).makePainter() : null;
const ws = await buildWorkspace(root, { size: real ? 'real' : 'small', paint: posters?.paint });
await posters?.close();
const app = createNordleServer({ roots: [ws.projectsDir] });
const actual = await app.listen(port);
console.log(`Studio demo: http://127.0.0.1:${actual}/   (${ws.projects.map((p) => `${p.name} ${p.items}`).join(', ')})`);
console.log('Stop with Ctrl+C. The demo files are removed when you do.');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => { await app.close(); rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 }); process.exit(0); });
}
