// The order of the brands in the Studio: the rail, the lanes of the month, the rows of the all-brands Insights. It is the owner's own choice on this
// computer, so it is kept with the other local settings (`studio.json` beside `publish.json`; NORDLE_PUBLISH_DIR moves both in tests), never in a project.
// A brand that is not in the saved order (a new one) goes after the ones that are, in its usual place among themselves.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishDir } from '../publish/store.mjs';

export const studioSettingsPath = () => join(publishDir(), 'studio.json');
const ID = /^[a-z0-9][a-z0-9_-]*$/;

function readSettings() {
  try { const j = JSON.parse(readFileSync(studioSettingsPath(), 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; }
}

/** The saved order, as brand ids (empty when none was chosen). */
export function readBrandOrder() {
  const o = readSettings().brandOrder;
  return Array.isArray(o) ? [...new Set(o.filter((x) => typeof x === 'string' && ID.test(x)))] : [];
}

/** `items` in the saved order. Stable: brands the order does not name keep their own order, after the named ones. */
export function applyBrandOrder(items, order = readBrandOrder(), key = (x) => x.id) {
  if (!order.length) return items;
  const rank = new Map(order.map((id, i) => [id, i]));
  return items.map((x, i) => ({ x, i }))
    .sort((a, b) => (rank.has(key(a.x)) ? rank.get(key(a.x)) : Infinity) - (rank.has(key(b.x)) ? rank.get(key(b.x)) : Infinity) || a.i - b.i)
    .map((r) => r.x);
}

/** Keep a new order. Only brands that exist are kept (`known`), each once; anything else in the request is dropped. Returns what was saved. */
export function saveBrandOrder(ids, known) {
  const have = new Set(known);
  const order = [...new Set((Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && have.has(x)))];
  const file = studioSettingsPath();
  mkdirSync(join(file, '..'), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ ...readSettings(), brandOrder: order }, null, 2)}\n`);
  renameSync(tmp, file);
  return order;
}
