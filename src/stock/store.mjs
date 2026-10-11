// Where stock libraries are remembered: <repo>/.nordle/stock.json (gitignored, written with mode 0600 where the OS has modes, never returned by
// any API: only `configured: true`). It holds, per library id:
//   { type?: 'rest' | 'folder'  (default rest), preset?: 'pexels' | ..., definition?: <a library definition, see rest.mjs>, key?: <the API key>,
//     path?: <a folder, for type folder>, kinds?: [...], name?: <shown name>, addedAt }
// NORDLE_PUBLISH_DIR overrides the folder (tests), the same as for the publishing settings.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { publishDir } from '../publish/store.mjs';

export const stockPath = () => join(publishDir(), 'stock.json');

const EMPTY = () => ({ schema: 'nordle.stock/0.1', libraries: {} });

export function loadStock() {
  try {
    const s = JSON.parse(readFileSync(stockPath(), 'utf8'));
    return { ...EMPTY(), ...s, libraries: s && typeof s.libraries === 'object' && s.libraries ? s.libraries : {} };
  } catch { return EMPTY(); }
}

function write(file, text) {
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* not every file system has modes */ }
}

/** Load, let fn change, save: two changes in a row never lose each other. */
export function changeStock(fn) {
  const s = loadStock();
  const r = fn(s);
  write(stockPath(), `${JSON.stringify(s, null, 2)}\n`);
  return r;
}
