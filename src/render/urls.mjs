// Node-side settings for the renderer: where the render browser finds project files and fonts, and the bundled font list.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../tools/validate.mjs';

export const HOST = 'http://nordle.local';
export const NODE_URLS = { project: `${HOST}/project`, fonts: `${HOST}/fonts` };

let manifest;
export function loadFontManifest() {
  return (manifest ??= JSON.parse(readFileSync(join(ROOT, 'fonts', 'manifest.json'), 'utf8')).fonts);
}
