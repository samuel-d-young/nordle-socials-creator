// Stock libraries: a library described as data, a folder of the owner's own stock, the safe downloader, the licence ledger and the catalog
// entry that says "not looked at yet", and who may do what. A FAKE fetch stands in for every library: nothing real is ever contacted.
//   node --test tests/stock.test.mjs
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../tools/validate.mjs';
import { createNordleServer } from '../src/server/http.mjs';
import { Store } from '../src/server/store.mjs';
import { assertPublicHttps, extensionFor, plainHeadersOnly, safeFetch, StockError } from '../src/stock/net.mjs';
import { PRESETS } from '../src/stock/presets.mjs';
import { definitionProblems, restLibrary } from '../src/stock/rest.mjs';
import { configure, getStockItem, listLibraries, saveStockSettings, searchStock } from '../src/stock/index.mjs';
import { createPictureProxy, pictures, PICTURE_MAX_BYTES } from '../src/stock/pictures.mjs';
import { loadStock, stockPath } from '../src/stock/store.mjs';

const HUMAN = 'human-token-for-stock-tests-0123456789';
const AGENT = 'agent-token-for-stock-tests-0123456789';
const KEY = 'pexels-test-key-not-real-98765';
const KEY2 = 'pixabay-test-key-not-real-43210';
let work, projectDir, store, app, port, calls, handler;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('synthetic photo bytes')]);
const MP4 = Buffer.from('synthetic video bytes');

/** The fake internet: handler(url, init) -> { status?, json?, body?, type?, headers? }. */
function fakeFetch() {
  return async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers ?? {} });
    const r = handler(new URL(String(url)), init) ?? { status: 404, json: {} };
    const headers = { ...(r.headers ?? {}) };
    if (r.json !== undefined) return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json', ...headers } });
    return new Response(r.body ?? null, { status: r.status ?? 200, headers: { 'content-type': r.type ?? 'application/octet-stream', ...headers } });
  };
}

const PEXELS_PHOTO = { id: 123, width: 4000, height: 3000, url: 'https://www.pexels.com/photo/123/', photographer: 'Ana Example', alt: 'A bowl of oranges on a table', src: { original: 'https://images.pexels.com/photos/123/orig.jpeg', large: 'https://images.pexels.com/photos/123/large.jpeg', medium: 'https://images.pexels.com/photos/123/medium.jpeg' } };
const PEXELS_VIDEO = { id: 77, width: 3840, height: 2160, url: 'https://www.pexels.com/video/sea-77/', image: 'https://images.pexels.com/videos/77/pic.jpeg', duration: 12, user: { name: 'Bo Example' },
  video_files: [{ quality: 'sd', file_type: 'video/mp4', width: 640, link: 'https://videos.pexels.com/77/sd.mp4' }, { quality: 'hd', file_type: 'video/mp4', width: 1920, link: 'https://videos.pexels.com/77/hd.mp4' }, { quality: 'uhd', file_type: 'video/mp4', width: 3840, link: 'https://videos.pexels.com/77/uhd.mp4' }, { quality: 'hd', file_type: 'video/webm', width: 2560, link: 'https://videos.pexels.com/77/hd.webm' }] };

function pexels(u, init) {
  if (u.hostname === 'api.pexels.com') {
    if (init.headers?.Authorization !== KEY) return { status: 401, json: { error: 'bad key' } };
    if (u.pathname === '/v1/search') return { json: { total_results: 1, photos: [PEXELS_PHOTO] } };
    if (u.pathname === '/v1/photos/123') return { json: PEXELS_PHOTO };
    if (u.pathname === '/videos/search') return { json: { total_results: 1, videos: [PEXELS_VIDEO] } };
    if (u.pathname === '/videos/videos/77') return { json: PEXELS_VIDEO };
  }
  if (u.hostname === 'images.pexels.com' && u.pathname.endsWith('orig.jpeg')) return { type: 'image/jpeg', body: JPEG };
  if (u.hostname === 'videos.pexels.com' && u.pathname.endsWith('/hd.mp4')) return { type: 'video/mp4', body: MP4 };
  return undefined;
}

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'nordle-stock-'));
  process.env.NORDLE_PUBLISH_DIR = join(work, 'state');
  projectDir = join(work, 'projects', 'gannet');
  cpSync(join(ROOT, 'samples', 'little-gannet'), projectDir, { recursive: true, filter: (s) => !/[\\/](out|sources|assets)([\\/]|$)/.test(s) });
  store = new Store({ roots: [join(work, 'projects')] });
  configure({ fetch: fakeFetch() });
  app = createNordleServer({ roots: [join(work, 'projects')], token: HUMAN, agentToken: AGENT, runtimeDir: join(work, 'runtime') });
  port = await app.listen(0);
});
after(async () => {
  await app.close();
  configure({ fetch: undefined });
  rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  delete process.env.NORDLE_PUBLISH_DIR;
});
beforeEach(() => {
  rmSync(stockPath(), { force: true });
  rmSync(join(projectDir, 'assets', 'stock'), { recursive: true, force: true });
  rmSync(join(projectDir, 'sources', 'catalog.json'), { force: true });
  pictures.clear();
  calls = [];
  handler = pexels;
});

const api = async (role, method, path, body) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/stock${path}`, { method, headers: { 'x-nordle-token': role === 'human' ? HUMAN : AGENT, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
};
const addPexels = () => saveStockSettings({ library: 'pexels', preset: 'pexels', key: KEY }, 'human');

// ---- definitions and the address guard ---------------------------------------------------------------------------------------------

test('every ready-made definition is a valid definition; a bad one is told plainly what is wrong', () => {
  for (const [id, def] of Object.entries(PRESETS)) assert.deepEqual(definitionProblems(def), [], id);
  assert.match(definitionProblems({ ...PRESETS.pexels, search: { photo: { ...PRESETS.pexels.search.photo, url: 'http://api.pexels.com/v1/search?query={query}' }, video: PRESETS.pexels.search.video } }).join(' '), /https/);
  assert.match(definitionProblems({ ...PRESETS.pexels, search: { photo: { ...PRESETS.pexels.search.photo, url: 'https://api.pexels.com/v1/search' }, video: PRESETS.pexels.search.video } }).join(' '), /containing \{query\}/);
  assert.match(definitionProblems({ ...PRESETS.pexels, kinds: ['photo', 'gif'] }).join(' '), /kinds/);
  assert.match(definitionProblems({ ...PRESETS.pexels, id: 'Bad Id' }).join(' '), /id:/);
  assert.match(definitionProblems({ ...PRESETS.pexels, download: { photo: { urlPath: 'a.b', listPath: 'c' } } }).join(' '), /exactly one of/);
  assert.match(definitionProblems({ ...PRESETS.pexels, search: { photo: { ...PRESETS.pexels.search.photo, url: 'https://localhost/x?q={query}' }, video: PRESETS.pexels.search.video } }).join(' '), /private network/);
});

test('the address guard: https and public only; redirects are checked; the file type must match the kind', () => {
  assert.equal(assertPublicHttps('https://api.pexels.com/v1/search').hostname, 'api.pexels.com');
  for (const bad of ['http://api.pexels.com/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://192.168.1.10/x', 'https://172.16.0.1/x', 'https://172.31.255.1/x', 'https://169.254.169.254/latest', 'https://[::1]/x', 'https://user:pw@api.pexels.com/x', 'https://nas/x', 'https://printer.local/x', 'ftp://x.com/y', 'not a url']) {
    assert.throws(() => assertPublicHttps(bad), StockError, bad);
  }
  assertPublicHttps('https://172.32.0.1/x');           // just outside 172.16/12
  assert.equal(extensionFor('photo', 'image/jpeg', 'https://x.com/a'), 'jpg');
  assert.equal(extensionFor('photo', 'text/html', 'https://x.com/a.jpg'), null, 'a web page called photo.jpg is not a photo');
  assert.equal(extensionFor('video', 'application/octet-stream', 'https://x.com/clip.mp4'), 'mp4');
  assert.equal(extensionFor('video', 'application/octet-stream', 'https://x.com/clip.exe'), null);
  assert.equal(extensionFor('sfx', 'audio/mpeg', 'https://x.com/a'), 'mp3');
  assert.equal(extensionFor('music', 'video/mp4', 'https://x.com/a'), null);
});

test('a redirect to another site does not take the key with it; a redirect inside the same site does', async () => {
  const seen = [];
  const hops = {
    'https://api.library.example/v1/file': { status: 302, location: 'https://cdn.library.example/f.jpg' },        // another host
    'https://cdn.library.example/f.jpg': { status: 302, location: 'https://api.library.example/v1/other' },        // and back again
    'https://api.library.example/v1/other': { status: 200 },
    'https://api.library.example/v1/same': { status: 302, location: '/v1/same-2' },                                 // same site
    'https://api.library.example/v1/same-2': { status: 302, location: 'https://api.library.example:8443/v1/port' },  // same host, other port: another origin
    'https://api.library.example:8443/v1/port': { status: 200 },
  };
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), headers: { ...(init.headers ?? {}) } });
    const h = hops[String(url)] ?? { status: 404 };
    return { status: h.status, ok: h.status === 200, headers: { get: (n) => (n.toLowerCase() === 'location' ? h.location ?? null : null) } };
  };
  const headers = { accept: 'application/json', 'user-agent': 'Nordle (stock search)', Authorization: 'Bearer test-key-not-real', 'X-Api-Key': 'test-key-not-real', cookie: 'a=b' };
  const hop = (u) => seen.find((s) => s.url === u).headers;

  await safeFetch('https://api.library.example/v1/file', { headers }, { fetchImpl });
  assert.deepEqual(Object.keys(hop('https://api.library.example/v1/file')).sort(), Object.keys(headers).sort(), 'the library that was asked gets everything');
  assert.deepEqual(hop('https://cdn.library.example/f.jpg'), { accept: 'application/json', 'user-agent': 'Nordle (stock search)' }, 'another host gets only the plain headers');
  assert.deepEqual(hop('https://api.library.example/v1/other'), { accept: 'application/json', 'user-agent': 'Nordle (stock search)' }, 'and they stay off when it comes back');

  seen.length = 0;
  await safeFetch('https://api.library.example/v1/same', { headers }, { fetchImpl });
  assert.ok('Authorization' in hop('https://api.library.example/v1/same-2'), 'same origin: kept');
  assert.deepEqual(Object.keys(hop('https://api.library.example:8443/v1/port')).sort(), ['accept', 'user-agent'], 'another port is another origin');

  // other shapes of headers, and no headers at all
  seen.length = 0;
  await safeFetch('https://api.library.example/v1/file', { headers: new Headers({ 'X-Api-Key': 'k', Accept: 'image/*' }) }, { fetchImpl });
  assert.deepEqual(hop('https://cdn.library.example/f.jpg'), { accept: 'image/*' });
  seen.length = 0;
  await safeFetch('https://api.library.example/v1/file', {}, { fetchImpl });
  assert.equal(seen.length, 3);
  assert.ok(seen.every((s) => Object.keys(s.headers).length === 0));
  assert.deepEqual(plainHeadersOnly({ Accept: 'a', 'x-api-key': 'k', 'User-Agent': 'u', 'Accept-Language': 'en' }), { Accept: 'a', 'User-Agent': 'u', 'Accept-Language': 'en' });
});

// ---- searching ------------------------------------------------------------------------------------------------------------------------

test('a library made from a definition: the key goes in the header, results are plain, the key is nowhere in what comes back', async () => {
  addPexels();
  const r = await searchStock({ library: 'pexels', query: 'oranges on a table', kind: 'photo' });
  assert.equal(calls[0].url, 'https://api.pexels.com/v1/search?query=oranges%20on%20a%20table&per_page=15&page=1');
  assert.equal(calls[0].headers.Authorization, KEY);
  assert.deepEqual([r.library, r.kind, r.total, r.items.length], ['pexels', 'photo', 1, 1]);
  assert.deepEqual(r.items[0], { id: '123', kind: 'photo', library: 'pexels', title: 'A bowl of oranges on a table', author: 'Ana Example', page: 'https://www.pexels.com/photo/123/', thumb: PEXELS_PHOTO.src.medium, preview: PEXELS_PHOTO.src.large, width: 4000, height: 3000, duration: null, tags: [], license: PRESETS.pexels.license, licenseUrl: 'https://www.pexels.com/license/' });
  assert.ok(!JSON.stringify(r).includes(KEY));
  const v = await searchStock({ library: 'pexels', query: 'sea', kind: 'video' });
  assert.deepEqual([v.items[0].id, v.items[0].duration, v.items[0].author], ['77', 12, 'Bo Example']);
});

test('search asks plain questions: no key yet, a refused key, a limit, a kind the library does not have, an empty search', async () => {
  await assert.rejects(searchStock({ library: 'pexels', query: 'sea' }), /has not been added yet/);
  saveStockSettings({ library: 'pexels', preset: 'pexels' }, 'human');
  await assert.rejects(searchStock({ library: 'pexels', query: 'sea' }), /needs an API key first/);
  saveStockSettings({ library: 'pexels', key: 'wrong-key-wrong-key' }, 'human');
  await assert.rejects(searchStock({ library: 'pexels', query: 'sea' }), (e) => e.status === 401 && /refused the key/.test(e.message) && !e.message.includes('wrong-key'));
  saveStockSettings({ library: 'pexels', key: KEY }, 'human');
  await assert.rejects(searchStock({ library: 'pexels', query: 'sea', kind: 'music' }), /offers photo, video, not "music"/);
  await assert.rejects(searchStock({ library: 'pexels', query: '   ' }), /Say what to look for/);
  await assert.rejects(searchStock({ library: 'nope', query: 'sea' }), (e) => e.status === 404);
  handler = () => ({ status: 429, json: {} });
  await assert.rejects(searchStock({ library: 'pexels', query: 'sea' }), (e) => e.status === 429 && e.code === 'rate-limit');
  handler = () => ({ json: { something: 'else' } });
  await assert.rejects(searchStock({ library: 'pexels', query: 'sea' }), /no list at "photos"/);
});

test('a key sent in the web address (Pixabay style) never appears in an error', async () => {
  saveStockSettings({ library: 'pixabay', preset: 'pixabay', key: KEY2 }, 'human');
  handler = (u) => (u.hostname === 'pixabay.com' ? { status: 500, json: {} } : undefined);
  await assert.rejects(searchStock({ library: 'pixabay', query: 'sea' }), (e) => /answered 500/.test(e.message) && !e.message.includes(KEY2));
  assert.ok(calls[0].url.includes(`key=${KEY2}`), 'it was sent as the library asks');
  handler = () => { throw new Error(`connect failed for https://pixabay.com/api/?key=${KEY2}`); };
  await assert.rejects(searchStock({ library: 'pixabay', query: 'sea' }), (e) => /Could not reach/.test(e.message) && !e.message.includes(KEY2));
});

// ---- bringing a file in ---------------------------------------------------------------------------------------------------------------

test('get: the photo is saved in the project, its licence is written down, and its catalog entry says nobody has looked at it', async () => {
  addPexels();
  const r = await getStockItem(store, { library: 'pexels', kind: 'photo', id: '123', project: 'gannet', by: 'claude' });
  assert.deepEqual([r.path, r.already], ['assets/stock/pexels-123.jpg', false]);
  assert.deepEqual(readFileSync(join(projectDir, r.path)), JPEG);
  assert.deepEqual(readdirSync(join(projectDir, 'assets', 'stock')).sort(), ['licences.json', 'pexels-123.jpg'], 'no half-finished file is left');
  const ledger = JSON.parse(readFileSync(join(projectDir, 'assets', 'stock', 'licences.json'), 'utf8'));
  const line = ledger.items['assets/stock/pexels-123.jpg'];
  assert.deepEqual([line.library, line.id, line.author, line.license, line.by], ['pexels', '123', 'Ana Example', PRESETS.pexels.license, 'claude']);
  assert.equal(line.page, 'https://www.pexels.com/photo/123/');
  const cat = JSON.parse(readFileSync(join(projectDir, 'assets', 'catalog.json'), 'utf8')).items['assets/stock/pexels-123.jpg'];
  assert.match(cat.shows, /Not looked at yet/);
  assert.match(cat.traps[0], /not looked at yet/);
  assert.match(cat.origin, /Pexels.*Ana Example.*licence/);
  assert.ok(!JSON.stringify([line, cat]).includes(KEY));
  // the same item again fetches nothing more (it would spend the library's allowance)
  calls.length = 0;
  const again = await getStockItem(store, { library: 'pexels', kind: 'photo', id: '123', project: 'gannet' });
  assert.deepEqual([again.already, again.path, calls.length], [true, 'assets/stock/pexels-123.jpg', 0]);
  // an existing catalog entry is never overwritten by a later import
  const cf = join(projectDir, 'assets', 'catalog.json');
  const c = JSON.parse(readFileSync(cf, 'utf8'));
  c.items['assets/stock/pexels-123.jpg'].shows = 'Oranges in a white bowl on a wooden table, daylight from the left.';
  writeFileSync(cf, JSON.stringify(c));
  rmSync(join(projectDir, 'assets', 'stock', 'pexels-123.jpg'));
  await getStockItem(store, { library: 'pexels', kind: 'photo', id: '123', project: 'gannet' });
  assert.match(JSON.parse(readFileSync(cf, 'utf8')).items['assets/stock/pexels-123.jpg'].shows, /Oranges in a white bowl/);
});

test('get: a video picks the widest mp4 up to 2160 wide (4K is too big a file for a reel); sources are catalogued under sources/', async () => {
  addPexels();
  const r = await getStockItem(store, { library: 'pexels', kind: 'video', id: '77', project: 'gannet' });
  assert.equal(r.path, 'assets/stock/pexels-77.mp4');
  assert.ok(calls.some((c) => c.url === 'https://videos.pexels.com/77/hd.mp4'), 'the widest mp4 up to 2160 wide: not the 4K one, the webm or the small one');
  assert.ok(JSON.parse(readFileSync(join(projectDir, 'sources', 'catalog.json'), 'utf8')).items['assets/stock/pexels-77.mp4']);
});

test('get refuses what is not the right file: a web page, a file too big, a redirect to this computer, a project that is not there', async () => {
  addPexels();
  const original = handler;
  handler = (u, i) => (u.hostname === 'images.pexels.com' ? { type: 'text/html', body: '<html>sign in</html>' } : original(u, i));
  await assert.rejects(getStockItem(store, { library: 'pexels', kind: 'photo', id: '123', project: 'gannet' }), /not a picture \(text\/html\)/);
  handler = (u, i) => (u.hostname === 'images.pexels.com' ? { type: 'image/jpeg', body: JPEG, headers: { 'content-length': String(61 * 1024 * 1024) } } : original(u, i));
  await assert.rejects(getStockItem(store, { library: 'pexels', kind: 'photo', id: '123', project: 'gannet' }), (e) => e.status === 413);
  handler = (u, i) => (u.hostname === 'images.pexels.com' ? { status: 302, headers: { location: 'https://192.168.0.1/admin.jpg' } } : original(u, i));
  await assert.rejects(getStockItem(store, { library: 'pexels', kind: 'photo', id: '123', project: 'gannet' }), /private or reserved/);
  handler = (u, i) => (u.hostname === 'images.pexels.com' ? { status: 302, headers: { location: 'https://cdn.pexels.com/real.jpg' } } : u.hostname === 'cdn.pexels.com' ? { type: 'image/jpeg', body: JPEG } : original(u, i));
  assert.equal((await getStockItem(store, { library: 'pexels', kind: 'photo', id: '123', project: 'gannet' })).path, 'assets/stock/pexels-123.jpg', 'a normal redirect is followed');
  await assert.rejects(getStockItem(store, { library: 'pexels', kind: 'photo', id: '123', project: 'nope' }), (e) => e.status === 404);
  assert.deepEqual(readdirSync(join(projectDir, 'assets', 'stock')).filter((n) => n.endsWith('.part')), [], 'nothing half-finished is left behind');
});

// ---- the owner's own folder -------------------------------------------------------------------------------------------------------------

test('a folder of your own stock (for sites with no API) is searched by file and folder name and copied into the project', async () => {
  const lib = join(work, 'my-stock');
  mkdirSync(join(lib, 'Beaches', 'Sunrise'), { recursive: true });
  writeFileSync(join(lib, 'Beaches', 'Sunrise', 'sunrise over the bay.mp4'), MP4);
  writeFileSync(join(lib, 'Beaches', 'noon-surf.mp4'), MP4);
  writeFileSync(join(lib, 'notes.txt'), 'not media');
  assert.throws(() => saveStockSettings({ library: 'my-stock', path: 'relative/path' }, 'human'), /full path/);
  saveStockSettings({ library: 'my-stock', path: lib, kinds: ['video'], name: 'My stock', license: 'Envato Elements licence (registered per project)' }, 'human');
  assert.ok(listLibraries().some((l) => l.id === 'my-stock' && l.configured && l.type === 'folder'));
  const r = await searchStock({ library: 'my-stock', query: 'sunrise bay', kind: 'video' });
  assert.deepEqual(r.items.map((i) => i.id), ['Beaches/Sunrise/sunrise over the bay.mp4']);
  assert.equal(r.items[0].license, 'Envato Elements licence (registered per project)');
  assert.equal((await searchStock({ library: 'my-stock', query: 'beaches', kind: 'video' })).total, 2);
  const got = await getStockItem(store, { library: 'my-stock', kind: 'video', id: 'Beaches/Sunrise/sunrise over the bay.mp4', project: 'gannet' });
  assert.equal(got.path, 'assets/stock/my-stock-Beaches-Sunrise-sunrise-over-the-bay-mp4.mp4');
  assert.deepEqual(readFileSync(join(projectDir, got.path)), MP4);
  assert.ok(existsSync(join(lib, 'Beaches', 'Sunrise', 'sunrise over the bay.mp4')), 'copied, never moved');
  for (const bad of ['../secret.mp4', 'Beaches/../../x.mp4', '/etc/passwd', 'C:/Windows/x.mp4', 'Beaches\\noon-surf.mp4']) {
    await assert.rejects(getStockItem(store, { library: 'my-stock', kind: 'video', id: bad, project: 'gannet' }), StockError, bad);
  }
  assert.equal(calls.length, 0, 'a folder never touches the internet');
});

// ---- which brands use a library --------------------------------------------------------------------------------------------------------------

test('a library set up for some brands refuses the others, shows its brands, and "every brand" is the empty list', async () => {
  const lib = join(work, 'brand-stock');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, 'sunrise bay.mp4'), MP4);
  saveStockSettings({ library: 'brand-stock', path: lib, kinds: ['video'], name: 'Brand stock', brands: ['gannet'] }, 'human');
  assert.deepEqual(listLibraries().find((l) => l.id === 'brand-stock').brands, ['gannet']);
  assert.equal((await searchStock({ library: 'brand-stock', query: 'sunrise', kind: 'video', project: 'gannet' })).total, 1);
  await assert.rejects(searchStock({ library: 'brand-stock', query: 'sunrise', kind: 'video', project: 'other' }), (e) => e.status === 403 && /other brands/.test(e.message));
  assert.equal((await searchStock({ library: 'brand-stock', query: 'sunrise', kind: 'video' })).total, 1, 'no project named: nothing to refuse');
  assert.equal((await api('agent', 'POST', '/settings', { library: 'brand-stock', brands: [] })).status, 403, 'only the owner changes which brands use a library');
  assert.equal((await api('human', 'POST', '/settings', { library: 'brand-stock', brands: 'gannet' })).status, 400, 'a list of brand ids, not a string');
  assert.equal((await api('human', 'POST', '/settings', { library: 'brand-stock', brands: ['../x'] })).status, 400);
  assert.equal((await api('human', 'POST', '/settings', { library: 'brand-stock', brands: [] })).status, 200);
  assert.deepEqual(listLibraries().find((l) => l.id === 'brand-stock').brands, []);
  assert.equal((await searchStock({ library: 'brand-stock', query: 'sunrise', kind: 'video', project: 'other' })).total, 1, 'empty means every brand');
});

// ---- who may do what ----------------------------------------------------------------------------------------------------------------------

test('only the owner adds libraries and keys; Claude may search and bring a file in; no reply ever holds a key', async () => {
  assert.equal((await api('agent', 'POST', '/settings', { library: 'pexels', preset: 'pexels', key: KEY })).status, 403);
  assert.equal(existsSync(stockPath()), false, 'nothing was saved');
  assert.equal((await api('agent', 'POST', '/test', { library: 'pexels' })).status, 403);
  assert.throws(() => saveStockSettings({ library: 'pexels', key: KEY }, 'agent'), (e) => e.status === 403);
  const saved = await api('human', 'POST', '/settings', { library: 'pexels', preset: 'pexels', key: KEY });
  assert.equal(saved.status, 200, saved.text);
  assert.ok(!saved.text.includes(KEY));
  assert.equal(JSON.parse(readFileSync(stockPath(), 'utf8')).libraries.pexels.key, KEY, 'kept in the private file');
  assert.ok(!(await api('agent', 'GET', '/libraries')).text.includes(KEY));
  assert.equal((await api('human', 'POST', '/test', { library: 'pexels' })).json.ok, true);
  const found = await api('agent', 'GET', '/search?library=pexels&q=oranges&kind=photo');
  assert.equal(found.status, 200, found.text);
  assert.equal(found.json.items[0].id, '123');
  assert.ok(!found.text.includes(KEY));
  const got = await api('agent', 'POST', '/get', { library: 'pexels', id: '123', kind: 'photo', project: 'gannet' });
  assert.equal(got.status, 200, got.text);
  assert.equal(JSON.parse(readFileSync(join(projectDir, 'assets', 'stock', 'licences.json'), 'utf8')).items[got.json.path].by, 'claude');
  const bad = await api('agent', 'GET', '/search?library=pexels&q=&kind=photo');
  assert.equal(bad.status, 400);
  assert.equal((await api('human', 'POST', '/settings', { library: 'x', definition: { name: 'X' } })).status, 400, 'a bad definition is refused with the reason');
  assert.equal((await api('human', 'POST', '/settings', { library: 'pexels', remove: true })).status, 200);
  assert.deepEqual(loadStock().libraries, {});
});

test('your own definition: a library nobody wrote code for, added from JSON, searched and downloaded from', async () => {
  const def = {
    name: 'Tiny Stock', kinds: ['sfx'], auth: { in: 'header', name: 'Authorization', prefix: 'Bearer ' }, license: 'Tiny Stock licence: personal and commercial use', licenseUrl: 'https://tiny.example.com/licence',
    search: { sfx: { url: 'https://api.tiny.example.com/search?term={query}&n={perPage}&p={page}', itemsPath: 'data.sounds', totalPath: 'data.count', map: { id: 'uid', title: 'label', author: 'by.name', duration: 'secs', tags: 'keywords' } } },
    item: { sfx: { url: 'https://api.tiny.example.com/sounds/{id}', itemPath: 'data.sound' } },
    download: { sfx: { request: { url: 'https://api.tiny.example.com/sounds/{id}/download', urlPath: 'data.url' } } },
  };
  handler = (u, i) => {
    if (u.hostname === 'api.tiny.example.com') {
      if (i.headers?.Authorization !== 'Bearer tiny-key-not-real-1') return { status: 403, json: {} };
      const sound = { uid: 'a9', label: 'Soft rain on a roof', by: { name: 'Cy' }, secs: 8.5, keywords: 'rain, roof, calm' };
      if (u.pathname === '/search') return { json: { data: { count: 1, sounds: [sound] } } };
      if (u.pathname === '/sounds/a9') return { json: { data: { sound } } };
      if (u.pathname === '/sounds/a9/download') return { json: { data: { url: 'https://files.tiny.example.com/a9.mp3' } } };
    }
    if (u.hostname === 'files.tiny.example.com') return { type: 'audio/mpeg', body: Buffer.from('mp3 bytes') };
    return undefined;
  };
  saveStockSettings({ library: 'tiny', definition: def, key: 'tiny-key-not-real-1' }, 'human');
  const r = await searchStock({ library: 'tiny', query: 'rain', kind: 'sfx' });
  assert.deepEqual([r.items[0].id, r.items[0].title, r.items[0].author, r.items[0].duration, r.items[0].tags], ['a9', 'Soft rain on a roof', 'Cy', 8.5, ['rain', 'roof', 'calm']]);
  const got = await getStockItem(store, { library: 'tiny', kind: 'sfx', id: 'a9', project: 'gannet' });
  assert.equal(got.path, 'assets/stock/tiny-a9.mp3');
  assert.equal(got.license, 'Tiny Stock licence: personal and commercial use');
  assert.ok(JSON.parse(readFileSync(join(projectDir, 'sources', 'catalog.json'), 'utf8')).items['assets/stock/tiny-a9.mp3']);
  assert.ok(!JSON.stringify(restLibrary({ ...def, id: 'tiny' }, 'k'.repeat(10), { fetchImpl: fakeFetch() }).kinds).includes('k'.repeat(10)));
});

test('command line: adding a library or a key is the owner\'s own step and is refused inside a Claude run; the key comes from standard input and is never printed', () => {
  const env = { ...process.env, NORDLE_PROJECTS: join(work, 'projects'), NORDLE_PUBLISH_DIR: join(work, 'state') };
  const cli = (args, extra = {}, input = '') => spawnSync(process.execPath, [join(ROOT, 'nordle.mjs'), 'stock', ...args], { env: { ...env, ...extra }, encoding: 'utf8', windowsHide: true, input });
  let r = cli(['add', 'pexels', '--preset', 'pexels'], { NORDLE_AGENT_RUN: '1' });
  assert.equal(r.status, 3);
  assert.equal(existsSync(stockPath()), false);
  r = cli(['key', 'pexels'], { NORDLE_AGENT_RUN: '1' }, KEY);
  assert.equal(r.status, 3);
  r = cli(['add', 'pexels', '--preset', 'pexels']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  r = cli(['key', 'pexels'], {}, `${KEY}\n`);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(!r.stdout.includes(KEY) && !r.stderr.includes(KEY));
  assert.equal(JSON.parse(readFileSync(stockPath(), 'utf8')).libraries.pexels.key, KEY);
  r = cli(['libraries']);
  assert.match(r.stdout, /pexels .*Pexels.*ready/);
  assert.ok(!r.stdout.includes(KEY));
  r = cli(['remove', 'pexels']);
  assert.equal(r.status, 0);
  assert.equal(cli(['search', 'pexels', 'sea'], {}).status, 1, 'a removed library cannot be searched');
});

// ---- what the Studio's Stock window needs ---------------------------------------------------------------------------------------------

const getRaw = async (role, path, { query = '' } = {}) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/stock${path}${query}`, { headers: role ? { 'x-nordle-token': role === 'human' ? HUMAN : AGENT } : {} });
  return { status: res.status, headers: res.headers, body: Buffer.from(await res.arrayBuffer()) };
};
const thumbPath = (u) => `/thumb?url=${encodeURIComponent(u)}`;
/** A Pexels search that answers with these medium-size picture addresses (one photo each), then whatever `more` answers. */
const pexelsWithPictures = (urls, more = () => undefined) => {
  handler = (u, i) => {
    if (u.hostname === 'api.pexels.com' && u.pathname === '/v1/search' && i.headers?.Authorization === KEY) return { json: { total_results: urls.length, photos: urls.map((medium, n) => ({ ...PEXELS_PHOTO, id: 500 + n, src: { ...PEXELS_PHOTO.src, medium } })) } };
    return more(u, i) ?? pexels(u, i);
  };
};

test('the library list says what the window needs (a key is saved, one is wanted, files can be brought in) and never the key', async () => {
  const lib = join(work, 'ui-stock');
  mkdirSync(lib, { recursive: true });
  saveStockSettings({ library: 'pexels', preset: 'pexels', key: KEY }, 'human');
  saveStockSettings({ library: 'pixabay', preset: 'pixabay' }, 'human');
  saveStockSettings({ library: 'envato-market', preset: 'envato-market', key: 'envato-test-token-not-real-1' }, 'human');
  saveStockSettings({ library: 'ui-stock', path: lib, name: 'My downloads' }, 'human');
  const r = await api('agent', 'GET', '/libraries');
  assert.equal(r.status, 200);
  assert.ok(!r.text.includes(KEY) && !r.text.includes('envato-test-token-not-real-1'));
  const by = Object.fromEntries(r.json.libraries.map((l) => [l.id, l]));
  assert.deepEqual([by.pexels.takesKey, by.pexels.hasKey, by.pexels.configured, by.pexels.canDownload, by.pexels.downloadKinds], [true, true, true, true, ['photo', 'video']]);
  assert.deepEqual([by.pixabay.takesKey, by.pixabay.hasKey, by.pixabay.configured, by.pixabay.needs], [true, false, false, ['an API key']], 'added, but no key yet');
  assert.deepEqual([by['envato-market'].configured, by['envato-market'].canDownload, by['envato-market'].downloadKinds], [true, false, []], 'Envato Market can be searched, never bought from');
  assert.deepEqual([by.freesound.added, by.freesound.preset, by.freesound.hasKey, by.freesound.canDownload], [false, true, false, true], 'a preset not added yet');
  assert.deepEqual([by['ui-stock'].type, by['ui-stock'].canDownload, by['ui-stock'].takesKey, by['ui-stock'].kinds], ['folder', true, false, ['photo', 'video', 'music', 'sfx']], 'a folder with no kinds chosen offers every kind');
  assert.equal(by['ui-stock'].path, lib);
  assert.equal(by.example, undefined, 'files starting with _ are templates and never listed');
});

test('a folder cannot take the name of a library that already exists as something else', () => {
  const lib = join(work, 'name-clash');
  mkdirSync(lib, { recursive: true });
  saveStockSettings({ library: 'pexels', preset: 'pexels', key: KEY }, 'human');
  assert.throws(() => saveStockSettings({ library: 'pexels', path: lib }, 'human'), (e) => e.status === 400 && /already the name/.test(e.message));
  assert.throws(() => saveStockSettings({ library: 'freesound', path: lib }, 'human'), (e) => e.status === 400, 'nor a preset that has not been added yet');
  assert.equal(loadStock().libraries.pexels.key, KEY, 'the library and its key are untouched');
  saveStockSettings({ library: 'my-folder', path: lib, kinds: ['video'] }, 'human');
  saveStockSettings({ library: 'my-folder', kinds: ['photo', 'video'] }, 'human');
  assert.deepEqual(loadStock().libraries['my-folder'].kinds, ['photo', 'video'], 'a folder can still be edited');
});

test('errors carry a code when the library said why: a refused key, a rate limit', async () => {
  saveStockSettings({ library: 'pexels', preset: 'pexels', key: 'a-wrong-key-123456' }, 'human');
  let r = await api('human', 'GET', '/search?library=pexels&q=sea&kind=photo');
  assert.deepEqual([r.status, r.json.errors[0].code], [401, 'key-refused']);
  assert.ok(!r.text.includes('a-wrong-key-123456'));
  saveStockSettings({ library: 'pexels', key: KEY }, 'human');
  handler = () => ({ status: 429, json: {} });
  r = await api('human', 'GET', '/search?library=pexels&q=sea&kind=photo');
  assert.deepEqual([r.status, r.json.errors[0].code], [429, 'rate-limit']);
  r = await api('human', 'GET', '/search?library=pexels&q=&kind=photo');
  assert.equal(r.json.errors[0].code, undefined, 'no code when there is nothing to add');
});

test('thumb: a picture is fetched through Nordle only if a recent search returned its address; either token; cached; no key sent', async () => {
  addPexels();
  const pic = PEXELS_PHOTO.src.medium;
  handler = (u, i) => (u.hostname === 'images.pexels.com' && /(medium|large)\.jpeg$/.test(u.pathname) ? { type: 'image/jpeg', body: JPEG } : pexels(u, i));
  let r = await getRaw('human', thumbPath(pic));
  assert.equal(r.status, 403, 'never returned by a search: refused');
  assert.equal(calls.length, 0, 'and nothing was fetched');
  assert.equal((await getRaw('human', thumbPath('https://example.com/secret.png'))).status, 403, 'a public address that no search returned is refused too: not an open proxy');
  assert.equal((await getRaw('human', '/thumb')).status, 400, 'no address given');
  assert.equal((await getRaw(null, thumbPath(pic))).status, 401, 'no token');
  const found = await api('human', 'GET', '/search?library=pexels&q=oranges&kind=photo');
  assert.equal(found.json.items[0].thumb, pic);
  calls.length = 0;
  r = await getRaw('human', thumbPath(pic));
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.equal(r.headers.get('cache-control'), 'private, max-age=600');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(r.body, JPEG);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, pic);
  assert.equal(calls[0].headers.Authorization, undefined, 'the library key is never sent to a picture server');
  r = await getRaw('agent', thumbPath(pic));
  assert.equal(r.status, 200, "Claude's token may read pictures too");
  r = await getRaw(null, thumbPath(pic), { query: `&t=${HUMAN}` });
  assert.equal(r.status, 200, 'an <img> carries the token in the address');
  assert.equal(calls.length, 1, 'the second and third came from memory');
  assert.equal((await getRaw('human', thumbPath(PEXELS_PHOTO.src.large))).status, 200, 'the preview address of the same result is allowed as well');
  assert.equal((await getRaw('human', thumbPath(PEXELS_PHOTO.src.original))).status, 403, 'the original (never in a result) is not');
});

test('thumb refuses what is not a small picture: a web page, SVG, over 3 MB (declared or not), a private address, a redirect to one', async () => {
  addPexels();
  const addr = (n) => `https://images.pexels.com/photos/${n}/medium.jpeg`;
  const MAX = PICTURE_MAX_BYTES;
  const answers = {
    [addr(1)]: { type: 'text/html', body: '<html>sign in</html>' },
    [addr(2)]: { type: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
    [addr(3)]: { type: 'image/jpeg', body: JPEG, headers: { 'content-length': String(MAX + 1) } },
    [addr(4)]: { type: 'image/jpeg', body: Buffer.alloc(MAX + 1, 1) },
    [addr(5)]: { type: 'image/jpeg', body: Buffer.alloc(MAX, 1) },
    [addr(6)]: { status: 302, headers: { location: 'https://10.0.0.5/inside.jpg' } },
    [addr(7)]: { status: 302, headers: { location: 'https://cdn.pexels.com/real.jpg' } },
    [addr(8)]: { status: 404 },
    'https://cdn.pexels.com/real.jpg': { type: 'image/jpeg', body: JPEG },
  };
  const all = [...Object.keys(answers).filter((u) => u.includes('/photos/')), 'https://192.168.0.9/pic.jpg', 'http://images.pexels.com/photos/9/medium.jpeg'];
  pexelsWithPictures(all, (u) => answers[u.href]);
  await api('human', 'GET', '/search?library=pexels&q=oranges&kind=photo&perPage=15');
  calls.length = 0;
  const status = async (u) => (await getRaw('human', thumbPath(u))).status;
  assert.equal(await status(addr(1)), 422, 'a web page is not a picture');
  assert.equal(await status(addr(2)), 422, 'SVG is not shown');
  assert.equal(await status(addr(3)), 413, 'declared over 3 MB');
  assert.equal(await status(addr(4)), 413, 'over 3 MB without saying so: stopped while it arrives');
  const exact = await getRaw('human', thumbPath(addr(5)));
  assert.deepEqual([exact.status, exact.body.length], [200, MAX], 'exactly 3 MB is fine');
  assert.equal(await status('https://192.168.0.9/pic.jpg'), 422, 'a private address in a result is refused');
  assert.ok(!calls.some((c) => c.url.includes('192.168.0.9')), 'and never fetched');
  assert.equal(await status(addr(6)), 422, 'a redirect into the private network is refused');
  assert.ok(!calls.some((c) => c.url.includes('10.0.0.5')));
  assert.equal(await status(addr(7)), 200, 'a normal redirect to a public host is followed');
  assert.equal(await status(addr(8)), 404);
  assert.equal(await status('http://images.pexels.com/photos/9/medium.jpeg'), 403, 'a plain http address never got in');
  const before = calls.length;
  assert.equal(await status(addr(1)), 422);
  assert.equal(calls.length, before + 1, 'a refusal is not remembered: the next look asks again');
  assert.equal(pictures.size().bytes <= 48 * 1024 * 1024, true);
});

test('the picture gate: 30 minutes to use an address a search returned, 10 minutes in memory, both bounded', async () => {
  let clock = 1_000_000;
  const px = createPictureProxy({ now: () => clock, maxAllowed: 3, maxCached: 2 });
  let fetched = 0;
  const fakePic = async () => { fetched++; return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } }); };
  px.remember([{ thumb: 'https://a.example.com/1.jpg', preview: 'https://a.example.com/1big.jpg' }]);
  assert.equal(px.allows('https://a.example.com/1.jpg'), true);
  assert.equal(px.allows('https://a.example.com/other.jpg'), false);
  clock += 30 * 60000 - 1;
  assert.equal(px.allows('https://a.example.com/1.jpg'), true, 'still allowed a moment before 30 minutes');
  await px.get('https://a.example.com/1.jpg', { fetchImpl: fakePic });
  clock += 1;
  assert.equal(px.allows('https://a.example.com/1.jpg'), false, 'after 30 minutes it is not');
  await assert.rejects(px.get('https://a.example.com/1.jpg', { fetchImpl: fakePic }), (e) => e.status === 403);
  // seen again: the time starts again
  px.remember([{ thumb: 'https://a.example.com/1.jpg' }]);
  assert.equal(fetched, 1);
  await px.get('https://a.example.com/1.jpg', { fetchImpl: fakePic });
  assert.equal(fetched, 1, 'from memory (10 minutes)');
  clock += 10 * 60000;
  await px.get('https://a.example.com/1.jpg', { fetchImpl: fakePic });
  assert.equal(fetched, 2, 'after 10 minutes it is fetched again');
  // bounds: three addresses at most remembered, two pictures at most kept
  px.remember([{ thumb: 'https://a.example.com/2.jpg' }, { thumb: 'https://a.example.com/3.jpg' }, { thumb: 'https://a.example.com/4.jpg' }, { thumb: 'https://a.example.com/5.jpg' }]);
  assert.equal(px.size().allowed, 3);
  assert.equal(px.allows('https://a.example.com/2.jpg'), false, 'the oldest was let go');
  for (const n of [3, 4, 5]) await px.get(`https://a.example.com/${n}.jpg`, { fetchImpl: fakePic });
  assert.equal(px.size().cached, 2);
  // http, not a string, too long: never remembered
  px.remember([{ thumb: 'http://a.example.com/x.jpg' }, { thumb: 42 }, { thumb: `https://a.example.com/${'x'.repeat(2100)}` }, null, {}]);
  assert.equal(px.size().allowed, 3);
});

test('envato shortcut: the folder of your downloads becomes a library, a key is the owner\'s own step, a search without a key says what is missing', () => {
  const lib = join(work, 'envato-downloads');
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, 'sunrise-beach-aerial.mp4'), MP4);
  const env = { ...process.env, NORDLE_PROJECTS: join(work, 'projects'), NORDLE_PUBLISH_DIR: join(work, 'state') };
  const cli = (args, extra = {}, input = '') => spawnSync(process.execPath, [join(ROOT, 'nordle.mjs'), 'envato', ...args], { env: { ...env, ...extra }, encoding: 'utf8', windowsHide: true, input });
  let r = cli(['key'], { NORDLE_AGENT_RUN: '1' }, KEY);
  assert.equal(r.status, 3, 'a key is the owner\'s step');
  r = cli(['folder', lib, '--kinds', 'video'], { NORDLE_AGENT_RUN: '1' });
  assert.equal(r.status, 3, 'adding a library is the owner\'s step');
  r = cli(['folder', lib, '--kinds', 'video']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const entry = loadStock().libraries['envato-elements'];
  assert.deepEqual([entry.type, entry.path, entry.kinds], ['folder', lib, ['video']]);
  assert.match(entry.license, /register each download to a project/);
  const found = spawnSync(process.execPath, [join(ROOT, 'nordle.mjs'), 'stock', 'search', 'envato-elements', 'sunrise', '--kind', 'video'], { env, encoding: 'utf8', windowsHide: true });
  assert.match(found.stdout, /sunrise-beach-aerial\.mp4/);
  r = cli(['search', 'sunrise']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Envato Market (needs an API key first|has not been added yet)/);
  assert.equal(cli(['folder']).status, 2);
});
