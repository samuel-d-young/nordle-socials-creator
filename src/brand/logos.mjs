// A brand's logos, the way a brand kit keeps them: the full-colour logo, a black one, a white one, an icon (the mark alone) and a wordmark (the name alone).
// The files live in the project's assets/logos/ and brand.json's `logos` says which is which. Pictures use the right one for their background:
// white on dark, colour or black on light (src/shared/patterns.mjs logoFor). A black or white version can be made from the colour logo in one click.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { binary } from '../video/ffmpeg.mjs';
import { GuideError, applyGuide, brandFile, readBrand, toGuide } from './guide.mjs';

export const LOGO_VARIANTS = [
  { key: 'primary', label: 'Full colour', hint: 'The logo as it normally appears' },
  { key: 'black', label: 'Black', hint: 'All black, for light backgrounds and print' },
  { key: 'white', label: 'White', hint: 'All white, for dark backgrounds and photos' },
  { key: 'icon', label: 'Icon or mark', hint: 'The symbol on its own, for small spaces' },
  { key: 'wordmark', label: 'Wordmark', hint: 'The name on its own' },
];
export const LOGO_KEYS = LOGO_VARIANTS.map((v) => v.key);
const EXTS = new Set(['.png', '.svg', '.jpg', '.jpeg', '.webp']);
export const LOGO_MAX_BYTES = 5 * 1024 * 1024;

const writeAtomic = (file, data) => { mkdirSync(dirname(file), { recursive: true }); const tmp = `${file}.${process.pid}.tmp`; writeFileSync(tmp, data); renameSync(tmp, file); };

/** Why a file cannot be a logo, in plain words, or null when it can. Looks at what is really inside, not only the name. */
export function logoProblem(name, buf) {
  const ext = extname(String(name ?? '')).toLowerCase();
  if (!EXTS.has(ext)) return 'A logo must be a PNG, SVG, JPG or WebP picture.';
  if (!buf?.length) return 'That file is empty.';
  if (buf.length > LOGO_MAX_BYTES) return 'That logo is over 5 MB. Export a smaller one.';
  const head = buf.subarray(0, 16);
  if (ext === '.png' && !(head[0] === 0x89 && head.toString('latin1', 1, 4) === 'PNG')) return 'That does not look like a real PNG.';
  if ((ext === '.jpg' || ext === '.jpeg') && !(head[0] === 0xff && head[1] === 0xd8)) return 'That does not look like a real JPG.';
  if (ext === '.webp' && !(head.toString('latin1', 0, 4) === 'RIFF' && head.toString('latin1', 8, 12) === 'WEBP')) return 'That does not look like a real WebP.';
  if (ext === '.svg') {
    const text = buf.toString('utf8');
    if (!/<svg[\s>]/i.test(text)) return 'That does not look like a real SVG.';
    if (/<script|\son\w+\s*=|javascript:|<foreignObject|<iframe/i.test(text)) return 'That SVG contains scripts or embedded pages, which a logo never needs. Export it again as a plain SVG.';
  }
  return null;
}

const logoDir = (projectDir) => join(projectDir, 'assets', 'logos');
const relOf = (variant, ext) => `assets/logos/${variant}${ext}`;

function setLogoPath(projectDir, variant, rel) {
  const next = applyGuide(readBrand(projectDir), { logos: { [variant]: rel } });
  writeAtomic(brandFile(projectDir), `${JSON.stringify(next, null, 2)}\n`);
  return toGuide(next);
}
function dropOldFile(projectDir, variant, keepRel) {
  const brand = readBrand(projectDir);
  const old = brand.logos?.[variant];
  if (old && old !== keepRel && old.startsWith('assets/logos/')) { try { rmSync(join(projectDir, old), { force: true }); } catch { /* a handle is open: leave it */ } }
}

/** Save an uploaded logo as one variant. Returns the guide. */
export function saveLogo(projectDir, variant, name, buf) {
  if (!LOGO_KEYS.includes(variant)) throw new GuideError(400, `"${variant}" is not a logo kind. Kinds: ${LOGO_KEYS.join(', ')}.`);
  const problem = logoProblem(name, buf);
  if (problem) throw new GuideError(415, problem);
  const rel = relOf(variant, extname(name).toLowerCase().replace('.jpeg', '.jpg'));
  dropOldFile(projectDir, variant, rel);
  writeAtomic(join(projectDir, rel), buf);
  return setLogoPath(projectDir, variant, rel);
}

export function removeLogo(projectDir, variant) {
  const brand = readBrand(projectDir);
  const rel = brand.logos?.[variant];
  if (!rel) throw new GuideError(404, 'There is no such logo.');
  if (rel.startsWith('assets/logos/')) { try { rmSync(join(projectDir, rel), { force: true }); } catch { /* leave it */ } }
  return setLogoPath(projectDir, variant, null);
}

// ---- making a black or white version -----------------------------------------------------------------------------------------------

const TARGET = { black: '#000000', white: '#FFFFFF' };
/** An SVG with every colour it draws with replaced by one colour, so it becomes a one-colour logo. */
export function recolourSvg(text, hex) {
  const keep = /^(none|transparent|currentcolor|inherit)$/i;
  const swap = (v) => (keep.test(v.trim()) || /^url\(/i.test(v.trim()) ? v : hex);
  let out = String(text)
    .replace(/\b(fill|stroke|stop-color|flood-color)\s*=\s*"([^"]*)"/gi, (m, k, v) => `${k}="${swap(v)}"`)
    .replace(/\b(fill|stroke|stop-color|flood-color)\s*=\s*'([^']*)'/gi, (m, k, v) => `${k}='${swap(v)}'`)
    .replace(/\b(fill|stroke|stop-color|flood-color)\s*:\s*([^;"}']+)/gi, (m, k, v) => `${k}:${swap(v)}`);
  // a shape with no fill at all is drawn black: give the whole picture the colour so white works too
  if (!/<svg[^>]*\sfill\s*=/i.test(out)) out = out.replace(/<svg\b/i, `<svg fill="${hex}"`);
  return out;
}

/** Make the black or white version from another logo (the full-colour one by default). Raster logos keep their see-through parts. Returns the guide. */
export function deriveLogo(projectDir, to, from = 'primary') {
  if (!TARGET[to]) throw new GuideError(400, 'Only a black or a white version can be made.');
  const brand = readBrand(projectDir);
  const srcRel = brand.logos?.[from];
  if (!srcRel) throw new GuideError(404, `Add the ${from === 'primary' ? 'full-colour' : from} logo first, then a ${to} one can be made from it.`);
  const src = join(projectDir, srcRel);
  if (!existsSync(src)) throw new GuideError(404, 'That logo file is missing.');
  const ext = extname(src).toLowerCase();
  if (ext === '.svg') {
    const rel = relOf(to, '.svg');
    dropOldFile(projectDir, to, rel);
    writeAtomic(join(projectDir, rel), recolourSvg(readFileSync(src, 'utf8'), TARGET[to]));
    return setLogoPath(projectDir, to, rel);
  }
  const rel = relOf(to, '.png');
  const tmp = join(tmpdir(), `nordle-logo-${process.pid}-${Date.now()}.png`);
  const v = to === 'black' ? '0' : '255';
  const r = spawnSync(binary('ffmpeg'), ['-v', 'error', '-y', '-i', src, '-vf', `format=rgba,lutrgb=r=${v}:g=${v}:b=${v}`, '-frames:v', '1', tmp], { windowsHide: true });
  if (r.status !== 0 || !existsSync(tmp)) throw new GuideError(500, 'ffmpeg could not make that version. Upload it yourself.');
  try { dropOldFile(projectDir, to, rel); writeAtomic(join(projectDir, rel), readFileSync(tmp)); } finally { rmSync(tmp, { force: true }); }
  return setLogoPath(projectDir, to, rel);
}

/** Which logo reads on a background: white on dark, colour (or black) on light. null when the brand has none of the kinds. */
export function logoForTone(logos, tone) {
  const L = logos ?? {};
  if (!(L.white || L.black || L.primary)) return null;
  return tone === 'dark' || tone === 'accent' ? (L.white ?? L.primary ?? L.black ?? null) : (L.primary ?? L.black ?? L.white ?? null);
}
export { logoDir };
