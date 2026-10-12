// Logos the way a brand kit keeps them: a full-colour one, a black one, a white one, an icon and a wordmark. Uploaded, checked for what they really are, made
// black or white in one click, and used on the right background.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOGO_KEYS, deriveLogo, logoForTone, logoProblem, recolourSvg, removeLogo, saveLogo } from '../src/brand/logos.mjs';
import { applyGuide, newBrand, toGuide } from '../src/brand/guide.mjs';
import { logoFor } from '../src/shared/patterns.mjs';
import { scanBrand } from '../src/brand/scan.mjs';
import { binary } from '../src/video/ffmpeg.mjs';
import { AGENT, TOKEN, closeBrowser } from './helpers.mjs';
import { studio } from './studio-helpers.mjs';

after(closeBrowser);
const have = spawnSync(binary('ffmpeg'), ['-version'], { windowsHide: true }).status === 0;
const skip = !have && 'ffmpeg is not installed';

/** A tiny PNG with a see-through background and a coloured square in the middle, written by hand. */
function png(rgb = [27, 108, 168], size = 32) {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = table[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([Buffer.from(t), d]))); return Buffer.concat([l, Buffer.from(t), d, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < size; y++) { const row = Buffer.alloc(1 + size * 4); for (let x = 0; x < size; x++) { const inside = x > 7 && x < 24 && y > 7 && y < 24; row.set(inside ? [...rgb, 255] : [0, 0, 0, 0], 1 + x * 4); } rows.push(row); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#1B6CA8"/><circle cx="5" cy="5" r="3" style="fill:#F2A900;stroke:rgb(10,20,30)"/><path d="M0 0h2v2z"/></svg>';
let n = 0;
function project() {
  const id = `lg-${++n}`;
  const dir = join(mkdtempSync(join(tmpdir(), 'nordle-logos-')), id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brand.json'), JSON.stringify(newBrand(id, { name: 'Logo Test' }), null, 2));
  return dir;
}
const brandOf = (dir) => JSON.parse(readFileSync(join(dir, 'brand.json'), 'utf8'));

test('a logo is checked for what is really inside it, not by its name', () => {
  assert.equal(logoProblem('logo.png', png()), null);
  assert.equal(logoProblem('logo.svg', Buffer.from(SVG)), null);
  assert.match(logoProblem('logo.png', Buffer.from('not a png')), /real PNG/);
  assert.match(logoProblem('logo.svg', Buffer.from('<html></html>')), /real SVG/);
  assert.match(logoProblem('logo.svg', Buffer.from('<svg><script>alert(1)</script></svg>')), /scripts/);
  assert.match(logoProblem('logo.svg', Buffer.from('<svg onload="x()"></svg>')), /scripts/);
  assert.match(logoProblem('logo.gif', png()), /PNG, SVG, JPG or WebP/);
  assert.match(logoProblem('logo.png', Buffer.alloc(0)), /empty/);
  assert.match(logoProblem('logo.png', Buffer.alloc(6 * 1024 * 1024, 1)), /over 5 MB/);
});

test('logos are saved by kind into assets/logos, replaced in place, shown in the guide and removed again', () => {
  const dir = project();
  assert.deepEqual(LOGO_KEYS, ['primary', 'black', 'white', 'icon', 'wordmark']);
  let g = saveLogo(dir, 'primary', 'My Logo.png', png());
  assert.equal(g.logoFiles.primary, 'assets/logos/primary.png');
  assert.ok(existsSync(join(dir, 'assets/logos/primary.png')));
  g = saveLogo(dir, 'primary', 'new.svg', Buffer.from(SVG));
  assert.equal(g.logoFiles.primary, 'assets/logos/primary.svg');
  assert.equal(existsSync(join(dir, 'assets/logos/primary.png')), false, 'the old file of that kind goes');
  g = saveLogo(dir, 'icon', 'mark.png', png([1, 2, 3]));
  assert.deepEqual(g.logos.sort(), ['icon', 'primary']);
  assert.throws(() => saveLogo(dir, 'banner', 'x.png', png()), /not a logo kind/);
  assert.throws(() => saveLogo(dir, 'white', 'x.png', Buffer.from('nope')), /real PNG/);
  g = removeLogo(dir, 'icon');
  assert.deepEqual(g.logos, ['primary']);
  assert.equal(existsSync(join(dir, 'assets/logos/icon.png')), false);
  assert.throws(() => removeLogo(dir, 'icon'), /no such logo/);
  assert.equal(brandOf(dir).logos.primary, 'assets/logos/primary.svg', 'and brand.json says which is which');
});

test('logo paths in a guide must be pictures inside the project assets', () => {
  const b = newBrand('x', { name: 'X' });
  assert.equal(applyGuide(b, { logos: { white: 'assets/logos/white.svg' } }).logos.white, 'assets/logos/white.svg');
  for (const bad of ['../secret.png', '/etc/passwd', 'assets/../x.png', 'assets/logo.exe', 'C:\\x.png']) assert.throws(() => applyGuide(b, { logos: { white: bad } }), /not a logo file/);
  assert.throws(() => applyGuide(b, { logos: { 'bad key!': 'assets/a.png' } }), /not a logo name/);
});

test('a black or white version is made from the colour logo: an SVG is recoloured, a PNG keeps its see-through parts', { skip }, () => {
  const dir = project();
  assert.throws(() => deriveLogo(dir, 'white'), /Add the full-colour logo first/);
  saveLogo(dir, 'primary', 'logo.svg', Buffer.from(SVG));
  let g = deriveLogo(dir, 'white');
  const white = readFileSync(join(dir, g.logoFiles.white), 'utf8');
  assert.ok(!/1B6CA8|F2A900/i.test(white), 'no brand colour is left');
  assert.match(white, /#FFFFFF/);
  assert.ok((white.match(/#FFFFFF/g) ?? []).length >= 3, 'every colour became white');
  g = deriveLogo(dir, 'black');
  assert.match(readFileSync(join(dir, g.logoFiles.black), 'utf8'), /#000000/);
  assert.throws(() => deriveLogo(dir, 'green'), /Only a black or a white/);
  // a PNG
  const d2 = project();
  saveLogo(d2, 'primary', 'logo.png', png([200, 30, 30]));
  const g2 = deriveLogo(d2, 'white');
  assert.equal(g2.logoFiles.white, 'assets/logos/white.png');
  const out = spawnSync(binary('ffmpeg'), ['-v', 'error', '-i', join(d2, 'assets/logos/white.png'), '-vf', 'format=rgba,scale=32:32:flags=neighbor', '-f', 'rawvideo', '-'], { windowsHide: true, maxBuffer: 1 << 20 });
  const px = out.stdout;
  const at = (x, y) => [...px.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)];
  assert.deepEqual(at(16, 16), [255, 255, 255, 255], 'the mark is white');
  assert.equal(at(2, 2)[3], 0, 'and the background is still see-through');
});

test('recolourSvg keeps none and gradients, and gives a shape with no fill the colour too', () => {
  const out = recolourSvg('<svg><defs><linearGradient id="g"/></defs><rect fill="none" stroke="red"/><rect fill="url(#g)"/><path d="M0 0"/></svg>', '#000000');
  assert.match(out, /fill="none"/);
  assert.match(out, /fill="url\(#g\)"/);
  assert.match(out, /stroke="#000000"/);
  assert.match(out, /<svg fill="#000000"/);
});

test('pictures use the logo that reads on their background: white on dark, colour on light; brands without variants are unchanged', () => {
  const both = { logos: { primary: 'a.svg', white: 'w.svg', black: 'b.svg' } };
  assert.equal(logoFor(both, 'dark'), 'w.svg');
  assert.equal(logoFor(both, 'accent'), 'w.svg');
  assert.equal(logoFor(both, 'light'), 'a.svg');
  assert.equal(logoFor({ logos: { black: 'b.svg' } }, 'light'), 'b.svg');
  assert.equal(logoFor({ logos: { white: 'w.svg' } }, 'light'), 'w.svg', 'the only one there is');
  assert.equal(logoFor({ logos: { primary: 'a.svg' } }, 'dark'), null, 'a brand with only the colour logo behaves as before');
  assert.equal(logoForTone({ primary: 'a.svg', white: 'w.svg' }, 'dark'), 'w.svg');
  assert.equal(logoForTone({}, 'dark'), null);
});

test('the routes: only the owner uploads, makes or removes a logo; a bad file is refused in plain words; the wizard\'s logos are kept with a new brand', { skip }, async () => {
  await studio(async ({ call, port, work }) => {
    const p = (await call('/projects')).body;
    const project = (p.projects ?? p)[0].id;
    const send = (variant, name, body, token = TOKEN) => fetch(`http://127.0.0.1:${port}/api/brand/logo/upload?project=${project}&variant=${variant}`, { method: 'POST', headers: { 'x-nordle-token': token, 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name) }, body }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
    assert.equal((await send('primary', 'logo.png', png(), AGENT)).status, 403);
    const bad = await send('primary', 'logo.png', Buffer.from('nope'));
    assert.equal(bad.status, 415);
    const ok = await send('primary', 'My Logo.png', png());
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ok.body.guide.logoFiles.primary, 'assets/logos/primary.png');
    assert.equal((await call('/brand/logo/derive', 'POST', { project, to: 'white' }, AGENT)).status, 403);
    const d = await call('/brand/logo/derive', 'POST', { project, to: 'white' });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.ok(d.body.guide.logoFiles.white);
    assert.equal((await call('/brand/logo/remove', 'POST', { project, variant: 'white' })).status, 200);
    assert.equal((await call('/brand/logo/remove', 'POST', { project, variant: 'white' })).status, 404);
    // a new brand made with logos from the wizard
    const session = 'cd12ab34cd12ab34';
    const stage = (name, body) => fetch(`http://127.0.0.1:${port}/api/brand/upload`, { method: 'POST', headers: { 'x-nordle-token': TOKEN, 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name), 'x-upload-session': session }, body });
    await stage('colour logo.png', png([27, 108, 168]));
    await stage('white logo.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4" fill="#FFFFFF"/></svg>'));
    const scan = await call('/brand/scan', 'POST', { name: 'Kit Brand', uploadSession: session, logoFiles: { primary: 'colour logo.png', white: 'white logo.svg' } });
    assert.equal(scan.status, 200, JSON.stringify(scan.body));
    assert.ok(scan.body.found.some((t) => /taken from your 2 logos/.test(t)));
    assert.ok(scan.body.palette.includes('#1B6CA8'), `the logo's blue is found: ${scan.body.palette}`);
    const made = await call('/brand/create', 'POST', { name: 'Kit Brand', uploadSession: session, logoFiles: { primary: 'colour logo.png', white: 'white logo.svg', banner: 'nope.png' } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const dir = join(work, 'projects', made.body.id);
    assert.deepEqual(Object.keys(brandOf(dir).logos).sort(), ['primary', 'white']);
    assert.ok(existsSync(join(dir, 'assets/logos/primary.png')) && existsSync(join(dir, 'assets/logos/white.svg')));
  });
});
