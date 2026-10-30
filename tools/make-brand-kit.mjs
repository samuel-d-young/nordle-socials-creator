// node tools/make-brand-kit.mjs   ->  brand/   (the Nordle brand kit: logos, tokens, social images, the visual guide)
// Everything is generated from the tokens at the top of this file, which mirror app/styles.css and app/studio-skin.css, so the kit cannot
// drift from the app by hand-editing. Needs Playwright's Chromium (npx playwright-core install chromium) for the PNGs and the text measuring.
import {chromium} from 'playwright-core';
import {mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'brand');
for (const d of ['logo', 'social', 'tokens', 'favicon']) { try { rmSync(join(out, d), {recursive: true, force: true}); } catch { /* a folder open elsewhere: overwrite in place */ } }
for (const d of ['logo/svg', 'logo/png', 'social', 'tokens', 'favicon']) mkdirSync(join(out, d), {recursive: true});

// ---------------------------------------------------------------- tokens
const LIGHT = {paper: '#F2F0EA', rail: '#E9E6DE', surface: '#FBFAF7', ink: '#17191B', 'ink-2': '#44484C', 'ink-3': '#5C6065', rule: '#D8D4C9', 'rule-strong': '#B9B4A6',
	hot: '#FF6B1A', 'on-hot': '#17191B', proof: '#B52A17', stamp: '#17674A', pencil: '#865000', mark: '#F4E7A8', pin: '#D63B64', sel: '#2B59FF', table: '#E2DFD6'};
const DARK = {paper: '#131517', rail: '#0E1012', surface: '#1B1E21', ink: '#ECE9E0', 'ink-2': '#B7B4AA', 'ink-3': '#97948C', rule: '#2B2F33', 'rule-strong': '#43484D',
	hot: '#FF8A45', 'on-hot': '#17191B', proof: '#FF7A63', stamp: '#62C79B', pencil: '#E8AA48', mark: '#5A4B14', pin: '#FF6C93', sel: '#7C9BFF', table: '#0B0C0E'};
const ROLE = {paper: 'page', rail: 'side rail, recessed areas', surface: 'panels, inputs, raised things', ink: 'text, outlines, hard shadows, the primary button', 'ink-2': 'secondary text', 'ink-3': 'meta text',
	rule: 'hairlines', 'rule-strong': 'stronger hairlines, field borders', hot: 'the one accent: fills, borders and shadows with ink on them. Never small text on paper', 'on-hot': 'text on the orange',
	proof: 'something is wrong, needs you, today', stamp: 'signed off, passed', pencil: 'changes requested, warnings', mark: 'highlighter on a caption hook', pin: 'comment pins', sel: 'selection handles in the editor', table: 'the light table behind pictures'};

const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
const cr = (a, b) => contrast(a, b).toFixed(1);

// ---------------------------------------------------------------- fonts (embedded, so every file in the kit is self-contained)
const b64 = (p) => readFileSync(join(root, 'fonts', p)).toString('base64');
const FONT_CSS = `
@font-face{font-family:'Outfit Variable';font-weight:100 900;font-style:normal;src:url(data:font/woff2;base64,${b64('outfit/files/outfit-latin-wght-normal.woff2')}) format('woff2-variations')}
@font-face{font-family:'Doto Variable';font-weight:100 900;font-style:normal;src:url(data:font/woff2;base64,${b64('doto/files/doto-latin-wght-normal.woff2')}) format('woff2-variations')}`;

// ---------------------------------------------------------------- the mark (the app's icon.svg, and its variants)
const N_PATH = 'M17 41V16h7.5l12 15V16H44v25h-7.5l-12-15v15z';
const mark = ({tile = LIGHT.hot, edge = LIGHT.ink, glyph = LIGHT.ink, label = 'Nordle', size = 64} = {}) =>
	`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}" role="img" aria-label="${label}"><rect x="9" y="9" width="50" height="50" rx="12" fill="${edge}"/><rect x="4" y="4" width="50" height="50" rx="12" fill="${tile}" stroke="${edge}" stroke-width="4"/><path d="${N_PATH}" fill="${glyph}"/></svg>\n`;
// one colour: a solid tile with the N cut out, and the offset shadow as an outline-less second tile
const markMono = (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="Nordle"><path fill="${c}" fill-rule="evenodd" d="M16 4h26a12 12 0 0 1 12 12v26a12 12 0 0 1-12 12H16A12 12 0 0 1 4 42V16A12 12 0 0 1 16 4zM${N_PATH.slice(1)}"/><path fill="${c}" opacity=".45" d="M54 12.5a12 12 0 0 1 5 9.5v28a9 9 0 0 1-9 9H22a12 12 0 0 1-9.5-5H42a12 12 0 0 0 12-12z"/></svg>\n`;

// ---------------------------------------------------------------- measure the wordmark with the real font
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<style>${FONT_CSS}</style><canvas id="c"></canvas>`);
const measure = async (text, px, weight = 800, spacing = -0.035) => page.evaluate(async ([t, p, w, s, css]) => {
	await document.fonts.load(`${w} ${p}px 'Outfit Variable'`);
	const ctx = document.getElementById('c').getContext('2d');
	ctx.font = `${w} ${p}px 'Outfit Variable'`;
	return ctx.measureText(t).width + t.length * p * s;
}, [text, px, weight, spacing, FONT_CSS]);

const WM = 46; // wordmark font size inside a 64 unit lockup
const wNordle = await measure('Nordle', WM);
const wDot = await measure('.', WM);
const wordmarkSvg = ({ink = LIGHT.ink, hot = LIGHT.hot, pad = 4} = {}) => {
	const w = Math.ceil(wNordle + wDot + pad * 2);
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 64" width="${w}" height="64" role="img" aria-label="Nordle"><style>${FONT_CSS}.t{font:800 ${WM}px 'Outfit Variable',Outfit,'Inter',system-ui,sans-serif;letter-spacing:-0.035em}</style><text class="t" x="${pad}" y="47" fill="${ink}">Nordle<tspan fill="${hot}">.</tspan></text></svg>\n`;
};
const lockupH = ({ink = LIGHT.ink, hot = LIGHT.hot, markOpts = {}} = {}) => {
	const gap = 14, w = Math.ceil(64 + gap + wNordle + wDot + 6);
	const m = mark({size: 64, ...markOpts}).replace(/<svg[^>]*>/, '').replace('</svg>\n', '');
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} 64" width="${w}" height="64" role="img" aria-label="Nordle"><style>${FONT_CSS}.t{font:800 ${WM}px 'Outfit Variable',Outfit,'Inter',system-ui,sans-serif;letter-spacing:-0.035em}</style>${m}<text class="t" x="${64 + gap}" y="47" fill="${ink}">Nordle<tspan fill="${hot}">.</tspan></text></svg>\n`;
};
const lockupS = ({ink = LIGHT.ink, hot = LIGHT.hot, markOpts = {}} = {}) => {
	const w = Math.ceil(wNordle + wDot + 8), h = 64 + 18 + 56;
	const m = mark({size: 64, ...markOpts}).replace(/<svg[^>]*>/, '').replace('</svg>\n', '');
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="Nordle"><style>${FONT_CSS}.t{font:800 ${WM}px 'Outfit Variable',Outfit,'Inter',system-ui,sans-serif;letter-spacing:-0.035em}</style><g transform="translate(${Math.round((w - 64) / 2)} 0)">${m}</g><text class="t" x="4" y="${64 + 18 + 42}" fill="${ink}">Nordle<tspan fill="${hot}">.</tspan></text></svg>\n`;
};

const DARKMARK = {tile: DARK.hot, edge: DARK.ink, glyph: DARK.paper};
const files = {
	'logo/svg/nordle-mark.svg': mark(),
	'logo/svg/nordle-mark-on-dark.svg': mark(DARKMARK),
	'logo/svg/nordle-mark-black.svg': markMono('#17191B'),
	'logo/svg/nordle-mark-white.svg': markMono('#FFFFFF'),
	'logo/svg/nordle-wordmark.svg': wordmarkSvg(),
	'logo/svg/nordle-wordmark-on-dark.svg': wordmarkSvg({ink: DARK.ink, hot: DARK.hot}),
	'logo/svg/nordle-wordmark-black.svg': wordmarkSvg({ink: '#17191B', hot: '#17191B'}),
	'logo/svg/nordle-wordmark-white.svg': wordmarkSvg({ink: '#FFFFFF', hot: '#FFFFFF'}),
	'logo/svg/nordle-lockup.svg': lockupH(),
	'logo/svg/nordle-lockup-on-dark.svg': lockupH({ink: DARK.ink, hot: DARK.hot, markOpts: DARKMARK}),
	'logo/svg/nordle-lockup-stacked.svg': lockupS(),
	'logo/svg/nordle-lockup-stacked-on-dark.svg': lockupS({ink: DARK.ink, hot: DARK.hot, markOpts: DARKMARK}),
};
for (const [f, s] of Object.entries(files)) writeFileSync(join(out, f), s);

// ---------------------------------------------------------------- tokens
const cssVars = (o) => Object.entries(o).map(([k, v]) => `  --${k}: ${v};`).join('\n');
writeFileSync(join(out, 'tokens/nordle-tokens.css'), `/* Nordle design tokens. The same names the app uses (app/styles.css, app/studio-skin.css).
   Light is "Paper", dark is "Darkroom". Follow the system, and let a [data-theme] on <html> force one. Generated by tools/make-brand-kit.mjs. */
:root {
${cssVars(LIGHT)}
  --edge: var(--ink);                       /* outlines and hard shadows */
  --hard-sm: 2px 2px 0 var(--edge);          /* the hard offset shadows: small, default, large */
  --hard: 3px 3px 0 var(--edge);
  --hard-lg: 6px 6px 0 var(--edge);
  --dots: radial-gradient(color-mix(in srgb, var(--ink) 9%, transparent) 1px, transparent 1.4px);   /* the dotted paper: 22px grid */
  --font-ui: 'Outfit Variable', Outfit, 'Inter Variable', Inter, system-ui, 'Segoe UI', Roboto, sans-serif;
  --font-display: var(--font-ui);
  --font-dot: 'Doto Variable', Doto, ui-monospace, 'Cascadia Mono', Consolas, monospace;           /* numbers */
  --radius: 3px;                             /* controls; pictures and frames are 0 */
  --ease: cubic-bezier(.2, .7, .2, 1);
  --t-fast: 120ms; --t-mid: 180ms; --t-slow: 240ms;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
${cssVars(DARK).replace(/^/gm, '  ')}
    --edge: var(--hot);
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
${cssVars(DARK).replace(/^/gm, '  ')}
  --edge: var(--hot);
  color-scheme: dark;
}
`);
writeFileSync(join(out, 'tokens/nordle-tokens.json'), JSON.stringify({
	$description: 'Nordle design tokens (light = Paper, dark = Darkroom). Mirrors app/styles.css and app/studio-skin.css.',
	color: Object.fromEntries(Object.keys(LIGHT).map((k) => [k, {light: LIGHT[k], dark: DARK[k], role: ROLE[k]}])),
	font: {ui: 'Outfit Variable', numerals: 'Doto Variable', fallback: "Inter Variable, system-ui, 'Segoe UI', Roboto, sans-serif"},
	type: {label: '11/14, 0.14em tracked, 600, upper case', meta: '12/16', body: '13/20', lead: '15/22', h3: '18/24', h2: '24/28', h1: '36/38', masthead: '56/56'},
	space: [2, 4, 8, 12, 16, 24, 32, 48, 72],
	radius: {controls: 3, dialogs: 4, pictures: 0, dots: 999},
	shadow: {small: '2px 2px 0 edge', default: '3px 3px 0 edge', large: '6px 6px 0 edge'},
	motion: {fast: 120, mid: 180, slow: 240, easing: 'cubic-bezier(.2,.7,.2,1)'},
}, null, 2) + '\n');

// ---------------------------------------------------------------- shared css for the HTML pieces
const BASE_CSS = `${FONT_CSS}
:root{${cssVars(LIGHT)} --edge:${LIGHT.ink}; --font-ui:'Outfit Variable',Outfit,system-ui,sans-serif; --font-dot:'Doto Variable',ui-monospace,monospace}
*{box-sizing:border-box}html,body{margin:0}
body{font-family:var(--font-ui);color:var(--ink);background:var(--paper);-webkit-font-smoothing:antialiased}
.dots{background-image:radial-gradient(color-mix(in srgb,var(--ink) 9%,transparent) 1px,transparent 1.4px);background-size:22px 22px}
.wm{font-weight:800;letter-spacing:-.035em;line-height:1}.wm i{font-style:normal;color:var(--hot)}
`;

// ---------------------------------------------------------------- social images
const stamp = (txt, rot = -8, size = 64) => `<div style="display:inline-block;border:5px solid ${LIGHT.stamp};color:${LIGHT.stamp};font-weight:800;letter-spacing:.06em;font-size:${size}px;padding:6px 20px;transform:rotate(${rot}deg);background:color-mix(in srgb,${LIGHT.stamp} 9%,${LIGHT.paper});border-radius:6px;white-space:nowrap">${txt}</div>`;
const print = (w, h, shadow, inner) => `<div style="width:${w}px;height:${h}px;background:${LIGHT.surface};outline:4px solid ${LIGHT.ink};box-shadow:${shadow}px ${shadow}px 0 ${LIGHT.hot};position:relative;overflow:hidden">${inner}</div>`;
const printInner = (w, h, k) => `<div style="position:absolute;left:0;top:0;width:100%;height:${Math.round(h * 0.58)}px;background:${[LIGHT.hot, LIGHT.ink, LIGHT.pencil][k % 3]}"></div>
<div style="position:absolute;left:${w * 0.08}px;top:${h * 0.64}px;width:${w * 0.62}px;height:${h * 0.05}px;background:${LIGHT.ink}"></div>
<div style="position:absolute;left:${w * 0.08}px;top:${h * 0.74}px;width:${w * 0.8}px;height:${h * 0.03}px;background:${LIGHT.rule}"></div>
<div style="position:absolute;left:${w * 0.08}px;top:${h * 0.8}px;width:${w * 0.5}px;height:${h * 0.03}px;background:${LIGHT.rule}"></div>`;
const hero = (W, H, {dark = false, tag = true, big = 0} = {}) => {
	const T = dark ? DARK : LIGHT;
	const wm = big || Math.round(H * 0.25);
	const pw = Math.round(H * 0.36), ph = Math.round(pw * 1.25);
	return `<!doctype html><meta charset="utf-8"><style>${BASE_CSS}
:root{${cssVars(T)} --edge:${dark ? T.hot : T.ink}}
body{width:${W}px;height:${H}px;overflow:hidden;position:relative;background-color:${T.paper}}
.wm{color:${T.ink}}.wm i{color:${T.hot}}
</style><body class="dots" style="background-size:22px 22px">
<div style="position:absolute;left:${Math.round(W * 0.06)}px;top:50%;transform:translateY(-52%)">
 <div class="wm" style="font-size:${wm}px">Nordle<i>.</i></div>
 ${tag ? `<div style="font-size:${Math.round(wm * 0.26)}px;font-weight:600;margin-top:${Math.round(wm * 0.14)}px;color:${T.ink}">Claude designs. You decide.</div>
 <div style="font-size:${Math.round(wm * 0.16)}px;font-weight:400;margin-top:${Math.round(wm * 0.06)}px;color:${T['ink-2']};max-width:${Math.round(W * 0.46)}px;line-height:1.35">A local social-media studio: reels, carousels and posts, designed, checked and waiting for your yes.</div>` : ''}
</div>
<div style="position:absolute;right:${Math.round(W * 0.05)}px;top:50%;transform:translateY(-50%);width:${Math.round(pw * 1.6)}px;height:${Math.round(ph * 1.15)}px">
 <div style="position:absolute;left:0;top:${Math.round(ph * 0.12)}px;transform:rotate(-6deg)">${print(pw, ph, 10, printInner(pw, ph, 1))}</div>
 <div style="position:absolute;left:${Math.round(pw * 0.42)}px;top:0;transform:rotate(3deg)">${print(pw, ph, 10, printInner(pw, ph, 0))}</div>
 <div style="position:absolute;left:${Math.round(pw * 0.55)}px;top:${Math.round(ph * 0.55)}px;transform-origin:left top">${stamp('SIGNED OFF', -9, Math.round(H * 0.06))}</div>
</div></body>`;
};
const avatar = (S) => `<!doctype html><meta charset="utf-8"><style>${BASE_CSS}body{width:${S}px;height:${S}px;display:grid;place-items:center;background-size:${Math.round(S * 0.055)}px ${Math.round(S * 0.055)}px}</style><body class="dots">${mark({size: Math.round(S * 0.62)})}</body>`;

const SOCIAL = [
	['og-image.png', hero(1200, 630), 1200, 630], ['og-image-dark.png', hero(1200, 630, {dark: true}), 1200, 630],
	['github-social-preview.png', hero(1280, 640), 1280, 640], ['banner-1500x500.png', hero(1500, 500), 1500, 500],
	['readme-header.png', hero(1280, 320, {tag: false, big: 150}), 1280, 320],
	['avatar-800.png', avatar(800), 800, 800],
];

// ---------------------------------------------------------------- the visual guide
const swatch = (k, bg, fg) => `<div class="sw"><div class="chip" style="background:${bg};color:${fg}"><b>${k}</b></div><div class="mono">${bg}</div></div>`;
const pairRows = [
	['ink on paper', LIGHT.ink, LIGHT.paper, DARK.ink, DARK.paper], ['ink-2 on paper', LIGHT['ink-2'], LIGHT.paper, DARK['ink-2'], DARK.paper], ['ink-3 on paper', LIGHT['ink-3'], LIGHT.paper, DARK['ink-3'], DARK.paper],
	['proof on paper', LIGHT.proof, LIGHT.paper, DARK.proof, DARK.paper], ['stamp on paper', LIGHT.stamp, LIGHT.paper, DARK.stamp, DARK.paper], ['pencil on paper', LIGHT.pencil, LIGHT.paper, DARK.pencil, DARK.paper],
	['ink on orange', LIGHT['on-hot'], LIGHT.hot, DARK['on-hot'], DARK.hot], ['orange on paper (borders and fills only)', LIGHT.hot, LIGHT.paper, DARK.hot, DARK.paper],
];
const guide = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Nordle brand guide</title><style>${BASE_CSS}
body{font-size:16px;line-height:1.55}
.page{max-width:1080px;margin:0 auto;padding:0 28px 120px}
header.top{padding:64px 0 36px;border-bottom:3px solid var(--ink)}
header.top .wm{font-size:clamp(64px,13vw,150px)}
header.top p{font-size:22px;font-weight:600;margin:14px 0 0;max-width:640px}
nav{position:sticky;top:0;background:var(--paper);border-bottom:2px solid var(--ink);z-index:5;display:flex;gap:2px;flex-wrap:wrap;padding:8px 28px}
nav a{font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:600;color:var(--ink);text-decoration:none;padding:6px 10px;border:2px solid transparent}
nav a:hover{border-color:var(--ink);box-shadow:2px 2px 0 var(--hot)}
section{padding:56px 0 8px}
.lbl{font-size:12px;letter-spacing:.14em;text-transform:uppercase;font-weight:600;color:var(--ink-3)}
h2{font-size:44px;line-height:1.05;letter-spacing:-.035em;font-weight:800;margin:6px 0 14px}
h3{font-size:20px;letter-spacing:-.01em;margin:30px 0 8px}
p{margin:8px 0;max-width:720px}.lead{font-size:19px;max-width:760px}
.grid{display:grid;gap:18px}.g2{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}.g3{grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}.g4{grid-template-columns:repeat(auto-fit,minmax(150px,1fr))}
.card{background:var(--surface);border:2px solid var(--ink);box-shadow:3px 3px 0 var(--ink);padding:18px}
.card.dark{background:${DARK.paper};color:${DARK.ink};border-color:${DARK.ink};box-shadow:3px 3px 0 ${DARK.hot}}
.card .cap{font-size:13px;color:var(--ink-3);margin-top:10px}.card.dark .cap{color:${DARK['ink-3']}}
.logo{display:flex;align-items:center;justify-content:center;min-height:130px}
.sw .chip{height:84px;border:2px solid var(--ink);display:flex;align-items:flex-end;padding:8px 10px;font-size:14px}.mono{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--ink-3);margin-top:4px}
table{border-collapse:collapse;width:100%;font-size:14px;background:var(--surface);border:2px solid var(--ink)}th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--rule)}th{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}
.dn{font-family:var(--font-dot);font-weight:900}
.btn{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border:2px solid var(--ink);background:var(--surface);box-shadow:2px 2px 0 var(--ink);font:560 15px var(--font-ui);color:var(--ink)}
.btn.p{background:var(--ink);color:var(--paper);box-shadow:3px 3px 0 var(--hot)}.btn.q{border-color:transparent;box-shadow:none;background:transparent}
.tag{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.06em;padding:3px 9px;border:2px solid currentColor;border-radius:4px}
.do,.dont{border:2px solid var(--ink);padding:14px 16px;background:var(--surface)}.do b{color:var(--stamp)}.dont b{color:var(--proof)}
.dont .x{text-decoration:line-through;text-decoration-color:var(--proof)}
code{font-family:ui-monospace,Consolas,monospace;font-size:13px;background:color-mix(in srgb,var(--ink) 7%,transparent);padding:1px 5px}
kbd{font-family:ui-monospace,Consolas,monospace;font-size:12px;border:2px solid var(--ink);padding:0 6px;background:var(--surface);box-shadow:1px 1px 0 var(--ink)}
.clear{position:relative;display:inline-block;padding:32px;outline:2px dashed var(--rule-strong)}
.misuse .card{position:relative}.misuse .no{position:absolute;right:10px;top:8px;color:var(--proof);font-weight:800}
</style></head><body>
<nav><a href="#essence">Essence</a><a href="#logo">Logo</a><a href="#colour">Colour</a><a href="#type">Type</a><a href="#shape">Shape</a><a href="#components">Components</a><a href="#motion">Motion</a><a href="#voice">Voice</a><a href="#social">Social</a><a href="#credit">Credit</a><a href="#files">Files</a></nav>
<div class="page dots" style="background:transparent">
<header class="top"><div class="lbl">Brand guide, version 1.0</div><div class="wm">Nordle<i>.</i></div><p>Claude designs. You decide.</p><p style="font-weight:400;font-size:17px;color:var(--ink-2)">A local social-media studio where Claude is the designer and you are the art director. Created by Samuel Young, CC BY 4.0.</p></header>

<section id="essence"><div class="lbl">01</div><h2>Essence</h2>
<p class="lead">Nordle is a <b>proof desk</b>. Print people judged work on a light table: contact sheets, red pencil, a stamp when a proof passed. The Studio borrows that and nothing else. The pictures are the interface; the chrome is paper and ink; the orange is rationed.</p>
<div class="grid g3" style="margin-top:18px">
<div class="card"><b>Plain and quick</b><p>One loop, made fast: look, decide, next. Never a flourish that slows a decision.</p></div>
<div class="card"><b>Honest</b><p>Quiet when fine, loud when not. A missing check does not look like a passed one. Empty, loading and error states say what happened and what to do.</p></div>
<div class="card"><b>Yours</b><p>Local, versioned, reversible. Nothing leaves without the owner. The tone is a good colleague, not a salesman.</p></div></div>
<h3>Personality in four words</h3><p><b>Editorial. Tactile. Calm. Direct.</b> Not: playful, glossy, gradient-y, techy, or alarmed.</p></section>

<section id="logo"><div class="lbl">02</div><h2>Logo</h2>
<p class="lead">The mark is an <b>N</b> on an orange tile with an ink outline and a hard offset shadow: a stamp on a proof. The wordmark is <b>Nordle</b> in Outfit ExtraBold with the one orange full stop.</p>
<div class="grid g2" style="margin-top:18px">
<div class="card logo">${files['logo/svg/nordle-lockup.svg']}</div>
<div class="card dark logo">${files['logo/svg/nordle-lockup-on-dark.svg']}</div>
<div class="card logo">${files['logo/svg/nordle-lockup-stacked.svg']}</div>
<div class="card dark logo">${files['logo/svg/nordle-lockup-stacked-on-dark.svg']}</div></div>
<div class="grid g4" style="margin-top:18px">
<div class="card logo">${mark({size: 84})}</div><div class="card dark logo">${mark({...DARKMARK, size: 84})}</div>
<div class="card logo">${markMono('#17191B').replace('width="64" height="64"', 'width="84" height="84"')}</div><div class="card dark logo">${markMono('#FFFFFF').replace('width="64" height="64"', 'width="84" height="84"')}</div></div>
<h3>Rules</h3>
<table><tr><th>Rule</th><th>Detail</th></tr>
<tr><td>The name</td><td>Always <b>Nordle</b>: capital N, then lower case. Never NORDLE, nordle (except in code, paths and commands) or Nordle™. "Nordle Studio" for the front door of the app.</td></tr>
<tr><td>The full stop</td><td>Only in the wordmark, always orange (or the same colour as the word in one-colour use). Never in running text.</td></tr>
<tr><td>Clear space</td><td>Keep a quarter of the mark's height clear on every side. The mark's shadow counts as part of the mark.</td></tr>
<tr><td>Minimum size</td><td>Mark 16 px (it still reads as an N). Lockup 96 px wide. Below that use the mark alone.</td></tr>
<tr><td>Which one</td><td>Lockup in headers and documents. Mark alone for avatars, favicons, app icons. Stacked lockup when it must be square-ish. Dark versions on dark; one-colour versions only when colour printing is not possible.</td></tr>
<tr><td>Dark mode</td><td>The tile becomes the lighter orange <code>${DARK.hot}</code>, the outline and shadow become paper white, the N takes the dark page colour.</td></tr></table>
<h3>Clear space and misuse</h3>
<div class="grid g4 misuse"><div class="card"><div class="clear">${mark({size: 72})}</div><div class="cap">Quarter-height clear space</div></div>
<div class="card"><div class="no">NO</div><div class="logo" style="min-height:96px;transform:rotate(-12deg)">${mark({size: 72})}</div><div class="cap">Do not rotate or tilt the mark</div></div>
<div class="card"><div class="no">NO</div><div class="logo" style="min-height:96px">${mark({tile: '#2B59FF', size: 72})}</div><div class="cap">Do not recolour the tile</div></div>
<div class="card"><div class="no">NO</div><div class="logo" style="min-height:96px">${mark({size: 72}).replace('<svg ', '<svg style="filter:drop-shadow(0 8px 10px rgba(0,0,0,.5)) blur(0.6px)" ')}</div><div class="cap">No soft shadows, glows or blur: the shadow is hard</div></div></div></section>

<section id="colour"><div class="lbl">03</div><h2>Colour</h2>
<p class="lead">Paper and ink do the work. Colour is rationed to <b>three jobs</b>: who a post belongs to (a thin lane colour), progress (stamp green, pencil ochre) and what is wrong (one proof red). The orange is the brand: it never carries meaning on its own. If everything is coloured, nothing is urgent.</p>
<h3>Paper (light)</h3><div class="grid g4">${['paper', 'rail', 'surface', 'ink', 'ink-2', 'ink-3', 'rule', 'rule-strong'].map((k) => swatch(k, LIGHT[k], ['ink', 'ink-2', 'ink-3'].includes(k) ? LIGHT.paper : LIGHT.ink)).join('')}</div>
<h3>Signal colours</h3><div class="grid g4">${['hot', 'proof', 'stamp', 'pencil', 'mark', 'pin', 'sel', 'table'].map((k) => swatch(k, LIGHT[k], ['mark', 'hot', 'table'].includes(k) ? LIGHT.ink : '#fff')).join('')}</div>
<h3>Darkroom (dark)</h3><div class="grid g4">${['paper', 'surface', 'ink', 'hot', 'proof', 'stamp', 'pencil', 'mark'].map((k) => swatch(k, DARK[k], ['ink', 'hot', 'proof', 'stamp', 'pencil'].includes(k) ? DARK.paper : DARK.ink)).join('')}</div>
<h3>What each is for</h3>
<table><tr><th>Token</th><th>Light</th><th>Dark</th><th>Role</th></tr>${Object.keys(LIGHT).map((k) => `<tr><td><code>--${k}</code></td><td class="mono" style="margin:0">${LIGHT[k]}</td><td class="mono" style="margin:0">${DARK[k]}</td><td>${ROLE[k]}</td></tr>`).join('')}</table>
<h3>Measured contrast (WCAG)</h3>
<table><tr><th>Pair</th><th>Light</th><th>Dark</th></tr>${pairRows.map(([n, a, b, c, d]) => `<tr><td>${n}</td><td>${cr(a, b)}:1</td><td>${cr(c, d)}:1</td></tr>`).join('')}</table>
<p>Text is at least 4.5:1 everywhere it carries meaning. The orange is for fills, borders and shadows with ink on them; as small text on paper it is too pale. <b>Status is never colour alone</b>: every state also has its own shape and a word.</p>
<h3>Lane colours</h3><p>Each brand a person manages in Nordle brings its own accent. It is used only as a 3 px tick, a 7 percent lane tint and a dot, never as a text colour.</p></section>

<section id="type"><div class="lbl">04</div><h2>Type</h2>
<p class="lead">Two bundled families, both SIL OFL, in <code>fonts/</code>. <b>Outfit</b> for every word. <b>Doto</b>, a dot-matrix face, for numbers: counts, scores, years. Inter is the fallback.</p>
<div class="grid g2"><div class="card"><div class="lbl">Outfit 800, headings</div><div style="font-size:64px;font-weight:800;letter-spacing:-.035em;line-height:1">Ready to review.</div></div>
<div class="card"><div class="lbl">Doto 900, numbers</div><div class="dn" style="font-size:64px;line-height:1;color:var(--ink)">128 <span style="color:var(--hot)">2026</span></div></div></div>
<table style="margin-top:18px"><tr><th>Use</th><th>Size / line</th><th>Weight</th><th>Notes</th></tr>
<tr><td>Masthead</td><td>56 / 56</td><td>800</td><td>-0.035em tracking</td></tr><tr><td>h1</td><td>36 / 38</td><td>800</td><td></td></tr><tr><td>h2</td><td>24 / 28</td><td>800</td><td></td></tr><tr><td>h3</td><td>18 / 24</td><td>700</td><td></td></tr>
<tr><td>Lead</td><td>15 / 22</td><td>400</td><td></td></tr><tr><td>Body</td><td>13 / 20</td><td>400, 560 for controls</td><td>Tabular figures for dates and counts</td></tr><tr><td>Meta</td><td>12 / 16</td><td>400</td><td></td></tr>
<tr><td>Label</td><td>11 / 14</td><td>600</td><td>Upper case, 0.14em tracked. Nothing else is upper case, except the stamp.</td></tr></table>
<p>No light weights. No gradient text. <code>ui-monospace</code> only inside key caps like <kbd>A</kbd> <kbd>C</kbd> <kbd>→</kbd>.</p></section>

<section id="shape"><div class="lbl">05</div><h2>Shape and surface</h2>
<p class="lead">Paper with a faint dot grid. Things have an <b>ink outline and a hard shadow</b>, like prints lying on the table. The shadow is offset, not blurred, and it turns orange on hover.</p>
<div class="grid g3"><div class="card"><b>Outlines</b><p>2 px ink. 3 px for the rule above big figures. Pictures: a 2 px outline and no rounding (they are prints).</p></div>
<div class="card"><b>Shadows</b><p><code>2px 2px 0</code>, <code>3px 3px 0</code>, <code>6px 6px 0</code> in the edge colour (ink in light, orange in dark). One soft elevation only for menus on small screens.</p></div>
<div class="card"><b>Radius</b><p>0 on pictures and frames, 3 px on controls, 4 px on dialogs, 999 only on status dots. No uniform rounded card.</p></div></div>
<h3>Space</h3><p>4 px base: 2, 4, 8, 12, 16, 24, 32, 48, 72. Tight inside a group (4 to 8), generous between groups (24 to 48). Uniform padding everywhere is the tell of a template.</p>
<h3>Imagery</h3><p>The user's pictures are the interface: never cropped for decoration, never behind a gradient. Frame with the ink outline and the hard shadow. Illustration is flat and graphic, one orange, ink lines. No stock gloss, no 3D, no people clip art.</p>
<h3>Icons</h3><p>Outline icons, 16 px, 1.8 px stroke, round caps and joins, <code>currentColor</code>.</p></section>

<section id="components"><div class="lbl">06</div><h2>Components</h2>
<div class="grid g2"><div class="card"><div class="lbl">Buttons</div><p><span class="btn p">Approve</span> <span class="btn">Ask for changes</span> <span class="btn q">Skip</span></p><p class="cap" style="font-size:13px;color:var(--ink-3)">One primary per surface. Hover lifts by 1 px and grows the shadow; press drops into the page.</p></div>
<div class="card"><div class="lbl">Status</div><p><span class="tag" style="color:var(--stamp)">✓ SIGNED OFF</span> <span class="tag" style="color:var(--pencil)">✎ CHANGES</span> <span class="tag" style="color:var(--proof)">! CHECK FAILED</span> <span class="tag" style="color:var(--ink-3);border-style:dashed">? NOT CHECKED</span></p><p class="cap" style="font-size:13px;color:var(--ink-3)">A missing check is dashed, never a green tick.</p></div>
<div class="card"><div class="lbl">Figures</div><div style="display:flex;gap:28px;align-items:flex-end"><div><div class="dn" style="font-size:44px;line-height:1">12</div><div class="lbl">Needs review</div></div><div><div class="dn" style="font-size:44px;line-height:1">3</div><div class="lbl">Built today</div></div></div></div>
<div class="card"><div class="lbl">The stamp</div>${stamp('SIGNED OFF', -7, 28)}<p class="cap" style="font-size:13px;color:var(--ink-3)">The one expressive moment: it lands on the picture when a post is signed off.</p></div></div></section>

<section id="motion"><div class="lbl">07</div><h2>Motion</h2>
<p class="lead">120 ms for hover and press, 180 ms for state changes, 240 ms for panels and for the queue moving on. <code>cubic-bezier(.2,.7,.2,1)</code> always: things ease out and nothing eases in. Only <code>transform</code> and <code>opacity</code> animate.</p>
<p>The stamp lands in about 400 ms with a slight rotation. With <code>prefers-reduced-motion</code> every transition becomes a plain cross-fade or none, and the stamp a fade.</p></section>

<section id="voice"><div class="lbl">08</div><h2>Voice</h2>
<p class="lead">A calm, capable colleague. Say what happened, say what to do. Short sentences, whole sentences, the person is "you", Claude is "Claude".</p>
<div class="grid g2"><div class="do"><b>Do</b><p>"Updated. Have another look."</p><p>"3 posts need your yes. The first is ready."</p><p>"Claude is not signed in on this computer. Run <code>claude auth login</code> once."</p><p>"Nothing is posted until you press Schedule."</p></div>
<div class="dont"><b>Don't</b><p class="x">"Oops! Something went wrong 😬"</p><p class="x">"Supercharge your socials with AI-powered magic"</p><p class="x">"Task failed successfully"</p><p class="x">"Seamlessly leverage our best-in-class workflow"</p></div></div>
<h3>Habits</h3><ul><li>Lead with the next action. Then the reason, if it is needed.</li><li>Say <b>Nordle</b>, not "the platform" or "the tool". Say <b>post</b>, not "asset" or "content piece".</li><li>Errors state the cause and the fix. No blame, no jokes, no exclamation marks.</li><li>No hype words (revolutionary, seamless, magic, supercharge, game-changing). No "AI-powered": say what Claude does.</li><li>Australian and British spelling (colour, organise). Dates as "6 Nov 2026".</li><li>Never imply a post was published when it was only scheduled, or that a check passed when it did not run.</li></ul>
<h3>One-line descriptions</h3>
<table><tr><th>Length</th><th>Text</th></tr><tr><td>Tagline</td><td>Claude designs. You decide.</td></tr><tr><td>Short</td><td>A local social-media studio where Claude is the designer and you are the art director.</td></tr>
<tr><td>Long</td><td>Nordle plans the month, designs the posts (carousels, single graphics, reels cut from your real footage), writes the captions and checks its own work. You step through what is ready and approve, ask for changes or move things around. Every edit is versioned and reversible, and nothing is posted without you.</td></tr></table></section>

<section id="social"><div class="lbl">09</div><h2>Social and print</h2>
<p class="lead">A pile of prints, a green stamp, the wordmark. The ready-made images are in <code>social/</code>.</p>
<div class="grid g2"><div class="card"><img src="social/og-image.png" style="width:100%;display:block;border:2px solid var(--ink)" alt="Open Graph image"><div class="cap">og-image.png, 1200 x 630</div></div>
<div class="card dark"><img src="social/og-image-dark.png" style="width:100%;display:block;border:2px solid ${DARK.ink}" alt="Open Graph image, dark"><div class="cap">og-image-dark.png</div></div></div></section>

<section id="credit"><div class="lbl">10</div><h2>Credit</h2>
<p class="lead">Nordle was created by <b>Samuel Young</b> and is free under CC BY 4.0. The licence asks for credit.</p>
<div class="card"><p style="margin:0">Nordle, created by Samuel Young (https://github.com/samuel-d-young/nordle-socials-creator), CC BY 4.0. If you changed it: <b>Changes were made.</b></p></div>
<p>A fork or a service built on Nordle must carry that credit where its users can see it (README and an About page or footer), keep <code>LICENSE</code>, and must not suggest Samuel Young endorses it. Posts, pictures and videos made with Nordle need no credit. A fork should use <b>its own name and its own mark</b>: this logo identifies the original.</p>
<p>The paper, ink and orange look follows the style of RoboNuggets' RENDER Studio (CC BY 4.0, credited in <code>LICENSES.md</code>); the code, the mark and the wordmark are Nordle's own. Outfit, Doto and Inter are SIL OFL 1.1.</p></section>

<section id="files"><div class="lbl">11</div><h2>What is in the kit</h2>
<table><tr><th>Folder</th><th>Contents</th></tr>
<tr><td><code>logo/svg</code></td><td>Mark (colour, on dark, black, white), wordmark (4), horizontal lockup (2), stacked lockup (2). Wordmark files embed Outfit, so they render correctly in a browser; for Figma or Illustrator, install Outfit and use the PNGs or convert the text to outlines.</td></tr>
<tr><td><code>logo/png</code></td><td>The mark at 16 to 1024 px, the lockups at 2x, transparent.</td></tr>
<tr><td><code>favicon</code></td><td>favicon.ico, 16/32/48, apple-touch-icon 180, 192 and 512 for a web manifest.</td></tr>
<tr><td><code>social</code></td><td>OG image (light and dark), GitHub social preview, 1500x500 banner, README header, 800 px avatar.</td></tr>
<tr><td><code>tokens</code></td><td><code>nordle-tokens.css</code> (drop-in, light and dark) and <code>nordle-tokens.json</code>.</td></tr>
<tr><td><code>brand-guide.html</code></td><td>This page. <code>BRAND-GUIDE.md</code> is the same rules as text.</td></tr></table>
<p>Regenerate everything with <code>node tools/make-brand-kit.mjs</code>.</p></section>
</div></body></html>`;
writeFileSync(join(out, 'brand-guide.html'), guide);

// ---------------------------------------------------------------- render PNGs
const shot = async (html, w, h, path, {scale = 1, transparent = false} = {}) => {
	const p = await browser.newPage({viewport: {width: w, height: h}, deviceScaleFactor: scale});
	await p.setContent(html, {waitUntil: 'load'});
	await p.evaluate(() => document.fonts.ready);
	await p.screenshot({path, omitBackground: transparent, clip: {x: 0, y: 0, width: w, height: h}});
	await p.close();
};
for (const [f, html, w, h] of SOCIAL) await shot(html, w, h, join(out, 'social', f));
// the guide needs the social images next to it, so shoot them first (done above), then a full-page preview of the guide
const gp = await browser.newPage({viewport: {width: 1200, height: 900}});
await gp.goto('file:///' + join(out, 'brand-guide.html').replace(/\\/g, '/'));
await gp.evaluate(() => document.fonts.ready);
await gp.screenshot({path: join(out, 'brand-guide-preview.png'), fullPage: true});
await gp.close();

const markHtml = (svg, S) => `<!doctype html><body style="margin:0;background:transparent">${svg.replace(/width="\d+" height="\d+"/, `width="${S}" height="${S}"`)}</body>`;
for (const S of [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024]) await shot(markHtml(files['logo/svg/nordle-mark.svg'], S), S, S, join(out, 'logo/png', `nordle-mark-${S}.png`), {transparent: true});
for (const S of [512]) await shot(markHtml(files['logo/svg/nordle-mark-on-dark.svg'], S), S, S, join(out, 'logo/png', `nordle-mark-on-dark-${S}.png`), {transparent: true});
for (const [name, key] of [['nordle-lockup', 'lockup'], ['nordle-lockup-on-dark', 'lockup-on-dark'], ['nordle-lockup-stacked', 'lockup-stacked'], ['nordle-lockup-stacked-on-dark', 'lockup-stacked-on-dark'], ['nordle-wordmark', 'wordmark'], ['nordle-wordmark-on-dark', 'wordmark-on-dark']]) {
	const svg = files[`logo/svg/nordle-${key}.svg`];
	const [w, h] = svg.match(/viewBox="0 0 (\d+) (\d+)"/).slice(1).map(Number);
	await shot(`<!doctype html><body style="margin:0;background:transparent">${svg}</body>`, w, h, join(out, 'logo/png', `${name}@2x.png`), {scale: 2, transparent: true});
}
await shot(markHtml(files['logo/svg/nordle-mark.svg'], 180), 180, 180, join(out, 'favicon/apple-touch-icon.png'));
await shot(markHtml(files['logo/svg/nordle-mark.svg'], 192), 192, 192, join(out, 'favicon/icon-192.png'), {transparent: true});
await shot(markHtml(files['logo/svg/nordle-mark.svg'], 512), 512, 512, join(out, 'favicon/icon-512.png'), {transparent: true});
for (const S of [16, 32, 48]) await shot(markHtml(files['logo/svg/nordle-mark.svg'], S), S, S, join(out, 'favicon', `favicon-${S}.png`), {transparent: true});
writeFileSync(join(out, 'favicon/favicon.svg'), files['logo/svg/nordle-mark.svg']);
await browser.close();
console.log('brand kit written to', out);
