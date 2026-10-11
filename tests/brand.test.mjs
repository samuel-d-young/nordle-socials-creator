// A brand's simple style guide (read, change, validated), drafting a guide from a website / captions with a FAKE fetch (nothing real is contacted),
// and adding a brand. Who may do what: Claude's token may read a guide; changing one, scanning and creating are the owner's.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT, closeBrowser } from './helpers.mjs';
import { studio, built } from './studio-helpers.mjs';
import { scanBrand, scanCaptions, handleOf } from '../src/brand/scan.mjs';
import { applyGuide, toGuide, newBrand, GuideError } from '../src/brand/guide.mjs';

after(closeBrowser);

const SITE = `<html><head><meta property="og:site_name" content="Harbour Bakery"><meta property="og:description" content="Sourdough by the sea">
<style>:root{--brand:#1b6ca8;--ink:#12263a} body{font-family:'Lora',serif;color:#12263a} h1{font-family:"Playfair Display",serif}</style></head><body>Hello</body></html>`;
const fakeFetch = async (url) => {
  const u = String(url);
  if (u.startsWith('https://harbour.example')) return new Response(SITE, { status: 200, headers: { 'content-type': 'text/html' } });
  return new Response('', { status: 404 });
};

test('toGuide shows the five core colours first and keeps other colours after them', () => {
  const g = toGuide({ id: 'b', name: 'B', colors: { ink: '#111111', paper: '#FFFFFF', accent: '#FF0000', accentDark: '#AA0000', muted: '#777777', sky: '#00AAFF' }, fonts: { display: { family: 'A', source: 'google' }, body: { family: 'B', source: 'system' } } });
  assert.deepEqual(g.colors.core.map((c) => c.key), ['ink', 'paper', 'accent', 'accentDark', 'muted']);
  assert.deepEqual(g.colors.more.map((c) => c.key), ['sky']);
  assert.equal(g.fonts.body.source, 'system');
});

test('applyGuide checks colours, fonts and links and says what is wrong in plain words', () => {
  const base = newBrand('tester', { name: 'Tester' });
  assert.equal(applyGuide(base, { colors: { accent: '#abc' } }).colors.accent, '#AABBCC', 'short hex is widened and upper-cased');
  assert.throws(() => applyGuide(base, { colors: { accent: 'red' } }), (e) => e instanceof GuideError && /not a colour/.test(e.message));
  assert.throws(() => applyGuide(base, { name: '   ' }), /name/);
  assert.throws(() => applyGuide(base, { fonts: { display: { family: 'Bad;font' } } }), /not a font name/);
  assert.equal(applyGuide(base, { links: { website: 'tester.example' } }).links.website, 'https://tester.example');
  assert.ok(applyGuide(base, { colors: { sky: '#00AAFF' } }).colors.sky);
  const kept = applyGuide(applyGuide(base, { colors: { sky: '#00AAFF' } }), { colors: {}, removeColors: ['sky', 'accent'] });
  assert.equal(kept.colors.sky, undefined, 'an extra colour can be removed');
  assert.ok(kept.colors.accent, 'a core colour cannot be removed');
});

test('captions give the usual hashtags; handles are read from links', () => {
  const c = scanCaptions('Fresh loaves today! #Sourdough #HarbourBakery\nBack tomorrow #Sourdough');
  assert.deepEqual(c.hashtags.slice(0, 2), ['#Sourdough', '#HarbourBakery']);
  assert.equal(handleOf('https://www.instagram.com/harbour.bakery/'), 'harbour.bakery');
  assert.equal(handleOf('@harbour.bakery'), 'harbour.bakery');
});

test('a website read through a fake fetch gives a name, colours and fonts; a dead site is a plain problem, not a crash', async () => {
  const ok = await scanBrand({ website: 'harbour.example', fetchImpl: fakeFetch });
  assert.equal(ok.draft.name, 'Harbour Bakery');
  assert.match(JSON.stringify(ok.draft.fonts), /Playfair Display/);
  assert.ok(ok.found.length > 0);
  assert.equal(ok.draft.links.website, 'https://harbour.example');
  const dead = await scanBrand({ name: 'Nowhere', website: 'https://dead.example', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(dead.draft.name, 'Nowhere');
  assert.ok(dead.problems.some((p) => /could not be read/.test(p)), dead.problems.join(' | '));
});

test('routes: anyone with a token reads a guide, only the owner changes one, and a bad change is refused with the reason', () => studio(async ({ call, work }) => {
  const id = built.projects[0].id;
  const read = await call(`/brand/guide?project=${id}`, 'GET', undefined, AGENT);
  assert.equal(read.status, 200);
  assert.equal(read.body.guide.id, id);
  assert.equal((await call('/brand/guide?project=nope')).status, 404);
  assert.equal((await call('/brand/guide', 'POST', { project: id, patch: { name: 'Hacked' } }, AGENT)).status, 403);
  const bad = await call('/brand/guide', 'POST', { project: id, patch: { colors: { accent: 'blue' } } });
  assert.equal(bad.status, 400);
  assert.match(JSON.stringify(bad.body.errors), /not a colour/);
  const before = JSON.parse(readFileSync(join(work, 'projects', id, 'brand.json'), 'utf8'));
  const saved = await call('/brand/guide', 'POST', { project: id, patch: { name: 'Renamed Brand', colors: { accent: '#123456' }, voice: { tone: ['warm', 'plain'] } } });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const after2 = JSON.parse(readFileSync(join(work, 'projects', id, 'brand.json'), 'utf8'));
  assert.equal(after2.name, 'Renamed Brand');
  assert.equal(after2.colors.accent, '#123456');
  assert.deepEqual(after2.voice.tone, ['warm', 'plain']);
  assert.deepEqual(after2.fonts, before.fonts, 'what the guide does not show is left exactly as it was');
  assert.deepEqual(after2.logos, before.logos);
}));

test("routes: scan and create are the owner's; a created brand has a valid brand file, a timezone and folders, and a repeated name gets a new id", () => studio(async ({ call, work }) => {
  assert.equal((await call('/brand/scan', 'POST', { captions: '#a' }, AGENT)).status, 403);
  assert.equal((await call('/brand/create', 'POST', { name: 'Nope' }, AGENT)).status, 403);
  const scan = await call('/brand/scan', 'POST', { name: 'Seaside Cafe', captions: 'Fresh today! #SeasideCafe #Coffee' });
  assert.equal(scan.status, 200, JSON.stringify(scan.body));
  assert.ok(scan.body.hashtags.includes('#SeasideCafe'));
  assert.equal((await call('/brand/create', 'POST', { name: '' })).status, 400);
  assert.equal((await call('/brand/create', 'POST', { name: 'Seaside Cafe', timezone: 'Mars/Olympus' })).status, 400);
  const made = await call('/brand/create', 'POST', { name: 'Seaside Cafe', timezone: 'Australia/Perth', guide: { colors: { accent: '#0A7B83' }, links: { handle: '@seaside' } } });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const dir = join(work, 'projects', made.body.id);
  const brand = JSON.parse(readFileSync(join(dir, 'brand.json'), 'utf8'));
  assert.equal(brand.name, 'Seaside Cafe');
  assert.equal(brand.colors.accent, '#0A7B83');
  assert.equal(brand.links.handle, '@seaside');
  assert.equal(JSON.parse(readFileSync(join(dir, 'nordle.project.json'), 'utf8')).timezone, 'Australia/Perth');
  assert.ok(existsSync(join(dir, 'docs')) && existsSync(join(dir, 'assets')));
  const again = await call('/brand/create', 'POST', { name: 'Seaside Cafe' });
  assert.equal(again.status, 201);
  assert.notEqual(again.body.id, made.body.id);
  assert.equal((await call(`/brand/guide?project=${made.body.id}`)).body.guide.name, 'Seaside Cafe');
}));
