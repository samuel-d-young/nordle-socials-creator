// Every front-end file must parse. One stray apostrophe in a string leaves the whole Studio blank (the page loads, the script dies on its
// first line), and no other test notices until a browser opens that file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { ROOT } from '../tools/validate.mjs';

test('every file in app/ parses as JavaScript', () => {
  const files = readdirSync(join(ROOT, 'app')).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 20);
  const bad = [];
  for (const f of files) {
    const r = spawnSync(process.execPath, ['--check', join(ROOT, 'app', f)], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) bad.push(`${f}: ${String(r.stderr).split('\n').find((l) => /Error/.test(l)) ?? 'does not parse'}`);
  }
  assert.deepEqual(bad, []);
});
