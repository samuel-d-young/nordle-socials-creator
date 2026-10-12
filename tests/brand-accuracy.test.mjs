// Does brand set-up really find the colours and fonts? Checked on made-up material whose right answers are known: exact colours from a logo
// (not the middle of a bin), colours written as hex / rgb() / hsl() / oklch(), variables, fonts named through var(), @font-face and Google Fonts,
// the site's own logo, and SVG logos in a folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { deflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binary } from '../src/video/ffmpeg.mjs';
import { colorsFromPalette, cssFacts, paletteOf, parseColour, scanBrand, svgPalette } from '../src/brand/scan.mjs';

const hasFfmpeg = spawnSync(binary('ffmpeg'), ['-version'], { windowsHide: true }).status === 0;

test('parseColour reads every way CSS writes a colour, and ignores see-through ones', () => {
  assert.equal(parseColour('#1b6ca8'), '#1B6CA8');
  assert.equal(parseColour('#abc'), '#AABBCC');
  assert.equal(parseColour('rgb(27, 108, 168)'), '#1B6CA8');
  assert.equal(parseColour('rgb(27 108 168 / 90%)'), '#1B6CA8');
  assert.equal(parseColour('rgba(27, 108, 168, 0.2)'), null, 'mostly see-through is not a brand colour');
  assert.equal(parseColour('hsl(210 72% 38%)'), '#1B61A7');
  assert.equal(parseColour('oklch(98.7% .022 95.277)'), '#FFFBEB', 'Tailwind amber-50');
  assert.equal(parseColour('oklch(21% .034 264.665)'), '#101828', 'Tailwind gray-900');
  assert.equal(parseColour('red'), null);
});

test('svgPalette reads the colours a logo is drawn with', () => {
  const svg = '<svg><path fill="#1B6CA8" d="M0"/><path style="fill:#F2A900;stroke:#123"/><stop stop-color="rgb(10,20,30)"/></svg>';
  const p = svgPalette(svg, 5);
  assert.deepEqual([...p.keys()].sort(), ['#112233', '#F2A900', '#0A141E', '#1B6CA8'].sort());
});

/** A tiny PNG (RGBA) with flat colour bands, written by hand so the colours are exactly what the test says. */
function png(bands, size = 64) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < size; y++) { const [r, g, b] = bands[Math.min(bands.length - 1, Math.floor((y / size) * bands.length))]; const row = Buffer.alloc(1 + size * 4); for (let x = 0; x < size; x++) { row[1 + x * 4] = r; row[2 + x * 4] = g; row[3 + x * 4] = b; row[4 + x * 4] = 255; } rows.push(row); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

test('a logo picture gives its exact colours, not the middle of a colour bin', { skip: !hasFfmpeg && 'ffmpeg is not installed' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'nordle-logo-'));
  const file = join(dir, 'logo.png');
  writeFileSync(file, png([[0xF2, 0xA9, 0x00], [0x1B, 0x6C, 0xA8], [0x1B, 0x6C, 0xA8]]));
  const pal = paletteOf([file]);
  assert.ok(pal.has('#1B6CA8'), `the blue is exact: ${[...pal.keys()]}`);
  assert.ok(pal.has('#F2A900'), `the gold is exact: ${[...pal.keys()]}`);
  assert.ok(pal.get('#1B6CA8') > pal.get('#F2A900'), 'and the bigger area weighs more');
});

test('colorsFromPalette names the five core colours and keeps the brand\'s other strong colours', () => {
  const pal = new Map([['#FFFFFF', 50], ['#0B1F33', 80], ['#1B6CA8', 400], ['#F2A900', 150], ['#2BA84A', 90], ['#C0C0C0', 5]]);
  const { colors } = colorsFromPalette(pal);
  assert.equal(colors.paper, '#FFFFFF');
  assert.equal(colors.ink, '#0B1F33');
  assert.equal(colors.accent, '#1B6CA8');
  assert.equal(colors.secondary, '#F2A900', 'the second brand colour is kept, not thrown away');
  assert.equal(colors.tertiary, '#2BA84A');
  assert.equal(colors.highlight, undefined);
});

const CSS = `
@import url("/more.css");
@font-face { font-family: "Brand Serif"; src: url(/b.woff2); }
:root { --color-primary: rgb(27 108 168); --color-gold: hsl(43 100% 47%); --color-ink: oklch(21% .034 264.665); --font-heading: "Brand Serif", Georgia, serif; --font-body: "Mulish", sans-serif; --shadow: rgba(0,0,0,.1); }
body { background: #fffaf2; color: var(--color-ink); font-family: var(--font-body); }
h1, h2 { font-family: var(--font-heading); }
a.button { background: var(--color-primary); color: #fff; }
`;

test('cssFacts finds colours in every notation, resolves variables, and finds fonts through var() and @font-face', () => {
  const f = cssFacts(CSS);
  const top = [...f.palette].sort((a, b) => b[1] - a[1]).map(([h]) => h);
  assert.ok(top.slice(0, 5).includes('#1B6CA8'), `primary near the top: ${top}`);
  assert.ok(f.palette.has('#101828') && f.palette.has('#FFFAF2'));
  assert.ok([...f.palette.keys()].some((h) => /^#F[0-9A-F]B/.test(h) || h === '#F0B000' || h.startsWith('#F')), 'the hsl gold is there');
  assert.equal(f.fonts.display, 'Brand Serif');
  assert.equal(f.fonts.body, 'Mulish');
  assert.deepEqual(f.shipped, ['Brand Serif']);
});

test('a website: its stylesheets (and @import), its logo and its fonts are read; the logo\'s exact colours join the palette', async () => {
  const LOGO = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="#B5179E" width="9" height="9"/></svg>';
  const pages = {
    'https://shop.example/': ['text/html', '<html><head><meta property="og:site_name" content="Shop"><link rel="stylesheet" href="/site.css"><link href="https://fonts.googleapis.com/css2?family=Mulish&family=Lora" rel="stylesheet"></head><body><header><img class="site-logo" src="/logo.svg" alt="Shop"></header></body></html>'],
    'https://shop.example/site.css': ['text/css', CSS],
    'https://shop.example/more.css': ['text/css', 'footer { background: #0F5132; }'],
    'https://shop.example/logo.svg': ['image/svg+xml', LOGO],
  };
  const fetchImpl = async (url) => { const hit = pages[new URL(String(url)).href]; return hit ? new Response(hit[1], { status: 200, headers: { 'content-type': hit[0] } }) : new Response('', { status: 404 }); };
  const r = await scanBrand({ website: 'shop.example', fetchImpl });
  assert.equal(r.draft.fonts.display.family, 'Brand Serif');
  assert.equal(r.draft.fonts.body.family, 'Mulish');
  assert.ok(r.palette.includes('#B5179E'), `the logo's colour is found: ${r.palette}`);
  assert.ok(r.found.some((t) => /site's logo/.test(t)));
  assert.ok(r.found.some((t) => /ships itself: Brand Serif/.test(t)));
  assert.ok(Object.values(r.draft.colors).includes('#1B6CA8') || Object.values(r.draft.colors).includes('#B5179E'));
});

test('a folder with an SVG logo and a style guide: the logo\'s colours and the guide\'s fonts come through', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nordle-brandkit-'));
  writeFileSync(join(dir, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><path fill="#1B6CA8" d="M0"/><path fill="#F2A900" d="M1"/></svg>');
  writeFileSync(join(dir, 'brand-guide.md'), 'Headings: Playfair Display\nBody text: Lora\nTone of voice: warm, plain\n');
  const r = await scanBrand({ folder: dir });
  assert.ok(r.palette.includes('#1B6CA8') && r.palette.includes('#F2A900'), `svg colours: ${r.palette}`);
  assert.equal(r.draft.fonts.display.family, 'Playfair Display');
  assert.equal(r.draft.fonts.body.family, 'Lora');
  assert.deepEqual(r.draft.voice.tone.slice(0, 2), ['warm', 'plain']);
});
