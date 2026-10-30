// "Sign in with Buffer" in the browser: the page on this computer that Buffer's redirect ends on (app/oauth-callback.html), the hosted relay page that
// sends the browser there (site/connect/buffer.html), and the Publishing window's button and cards. Buffer is FAKED (tests/buffer-oauth-fake.mjs): the browser's
// request to auth.buffer.com is answered inside the browser by the test, the token address and the API are in-process, and any other address outside this
// computer is blocked and fails the test, so nothing real is ever contacted.
//   node --test tests/buffer-oauth-ui.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { ROOT } from '../tools/validate.mjs';
import { closeBrowser, getBrowser } from './helpers.mjs';
import { studioPage } from './studio-helpers.mjs';
import { clearChannelMemo, configure } from '../src/publish/index.mjs';
import { clearPending } from '../src/publish/buffer-oauth.mjs';
import { fakeBuffer } from './buffer-oauth-fake.mjs';

const state = mkdtempSync(join(tmpdir(), 'nordle-oauth-ui-'));
process.env.NORDLE_PUBLISH_DIR = join(state, 'publish');
for (const k of ['NORDLE_BUFFER_CLIENT_ID', 'NORDLE_BUFFER_REDIRECT_URI', 'NORDLE_BUFFER_SCOPES']) delete process.env[k];
const fb = fakeBuffer();
configure({ buffer: { fetch: fb.fetch }, oauth: { fetch: fb.fetch, defaults: {} } });
after(async () => { await closeBrowser(); rmSync(state, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 }); delete process.env.NORDLE_PUBLISH_DIR; configure({ buffer: {}, oauth: { fetch: undefined, defaults: {} } }); });

const EXPECTED_ID = 'doqCgiRK4o94fD7l-CQh-NRc4B0XIRCUe_rqQ9Q0zwL';
const EXPECTED_REDIRECT = 'https://samuel-d-young.github.io/nordle-socials-creator/connect/buffer.html';
const HEX = 'a1'.repeat(16);
const isLocal = (u) => ['127.0.0.1', 'localhost'].includes(new URL(u).hostname);
const leaks = (text) => [...fb.issued, ...fb.verifiers].filter((s) => String(text).includes(s));

/** Everything leaving this computer is refused (and reported), so a test that reaches for the real Buffer fails. */
async function guard(context, errors) {
  await context.route((u) => !isLocal(u.href), async (route) => {
    // (the ad blocker on Samuel's PC talks to itself at local.adguard.org from inside every page, loopback ones too: that never leaves the computer)
    if (new URL(route.request().url()).hostname === 'local.adguard.org') { await route.continue(); return; }
    errors.push(`a request left this computer: ${route.request().url()}`);
    await route.abort();
  });
}
/** The fake "Allow" page: Buffer's authorize address is answered inside the browser with a redirect straight to the loopback callback (the hosted relay is tested apart). */
async function fakeAuthorize(context, port, errors, { deny = false } = {}) {
  await context.route('https://auth.buffer.com/**', async (route) => {
    let got;
    try { got = fb.authorize(route.request().url(), { clientId: EXPECTED_ID, redirectUri: EXPECTED_REDIRECT, scope: 'account:read posts:read posts:write offline_access' }); } catch (e) { errors.push(`the fake Buffer refused the authorize address: ${e.message}`); await route.abort(); return; }
    const back = `http://127.0.0.1:${port}/app/oauth-callback.html?${deny ? 'error=access_denied' : `code=${encodeURIComponent(got.code)}`}&state=${encodeURIComponent(got.state)}`;
    await route.fulfill({ status: 302, headers: { location: back } });
  });
}
const openPublishing = async (page) => { await page.click('.rail-foot .rf:has-text("Publishing")'); await page.waitForSelector('dialog.wide .bsi'); };
/** A clean slate: no accounts saved, nothing waiting, the fake Buffer empty. */
const fresh = () => { rmSync(join(state, 'publish', 'publish.json'), { force: true }); fb.reset(); clearPending(); clearChannelMemo(); };
const TODAY = '2026-10-05';

// ---- the page Buffer's redirect ends on ----------------------------------------------------------------------------------------------------

test('callback page: hands {code, state, error} to the Studio tab, takes the code out of the address, shows what happened, and cannot reach the API', async () => {
  await studioPage(async ({ page, open, port, errors }) => {
    await guard(page.context(), errors);
    await open(`#/s/month?today=${TODAY}`);
    await page.evaluate(() => { window.__got = []; window.__ch = new BroadcastChannel('nordle-buffer-oauth'); window.__ch.onmessage = (e) => window.__got.push(e.data); });
    const st = `p${port}-${HEX}`;
    const cb = await page.context().newPage();
    await cb.goto(`http://127.0.0.1:${port}/app/oauth-callback.html?code=THE.CODE-123&state=${st}`);
    await page.waitForFunction(() => window.__got.length >= 1);
    assert.deepEqual(await page.evaluate(() => window.__got[0]), { code: 'THE.CODE-123', state: st, error: null });
    assert.equal(cb.url(), `http://127.0.0.1:${port}/app/oauth-callback.html`, 'the code is no longer in the address bar');
    const kept = await cb.evaluate(() => JSON.parse(localStorage.getItem('nordle-buffer-oauth')));
    assert.deepEqual([kept.code, kept.state, kept.error], ['THE.CODE-123', st, null], 'the fallback for browsers that block the channel');
    // the Studio answers: first "received", then "done"
    await page.evaluate((s) => window.__ch.postMessage({ reply: 'received', state: s }), st);
    await cb.waitForFunction(() => /has the sign-in/.test(document.getElementById('msg')?.textContent ?? ''));
    await page.evaluate((s) => window.__ch.postMessage({ reply: 'done', state: s }), st);
    await cb.waitForSelector('main[data-state="ok"]');
    assert.equal(await cb.locator('#msg').innerText(), 'Connected to Nordle: you can close this tab.');
    assert.equal(await cb.evaluate(() => localStorage.getItem('nordle-buffer-oauth')), null, 'nothing is left in storage once it is done');
    // a reply for some other sign-in is ignored; a failure is shown in plain words
    const cb2 = await page.context().newPage();
    await cb2.goto(`http://127.0.0.1:${port}/app/oauth-callback.html?code=C2&state=${st.replace('a1', 'b2')}`);
    await page.waitForFunction(() => window.__got.length >= 2);
    const other = st.replace('a1', 'b2');
    await page.evaluate((s) => window.__ch.postMessage({ reply: 'done', state: s.replace('b2', 'c3') }), other);
    await page.evaluate((s) => window.__ch.postMessage({ reply: 'failed', state: s, message: 'Buffer sign-in was refused, so nothing was connected.' }), other);
    await cb2.waitForSelector('main[data-state="bad"]');
    assert.equal(await cb2.locator('#msg').innerText(), 'Buffer sign-in was refused, so nothing was connected.');
    // an error answer from Buffer is passed on as it is
    const cb3 = await page.context().newPage();
    await cb3.goto(`http://127.0.0.1:${port}/app/oauth-callback.html?error=access_denied&state=${st}`);
    await page.waitForFunction(() => window.__got.length >= 3);
    assert.deepEqual(await page.evaluate(() => window.__got[2]), { code: null, state: st, error: 'access_denied' });
    assert.match(await cb3.locator('#msg').innerText(), /did not sign you in/);
    // a visit with nothing in it explains itself and sends nothing
    const before = await page.evaluate(() => window.__got.length);
    const cb4 = await page.context().newPage();
    await cb4.goto(`http://127.0.0.1:${port}/app/oauth-callback.html`);
    assert.match(await cb4.locator('#msg').innerText(), /Nothing came with it/);
    await cb4.waitForTimeout(150);
    assert.equal(await page.evaluate(() => window.__got.length), before);
    // the page may be fetched without a token, but it is only a page: the API still wants the owner's token, and the CSP lets scripts come from this origin only
    const served = await fetch(`http://127.0.0.1:${port}/app/oauth-callback.html`);   // from here, not from the browser: an ad blocker may add to what a browser sees
    const csp = served.headers.get('content-security-policy');
    const scripts = csp.match(/script-src ([^;]*)/)[1].split(/\s+/).filter((t) => t !== 'local.adguard.org');   // (the ad blocker on Samuel's PC adds itself to every response, even to this one)
    assert.deepEqual(scripts, ["'self'"], 'scripts from this origin only: no inline script, no eval, no other host');
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(await served.text()), 'no inline script');
    assert.equal(await cb.evaluate(async () => (await fetch('/api/publish/oauth/buffer/status')).status), 401);
    assert.equal(await cb.evaluate(async () => (await fetch('/api/publish/oauth/buffer/finish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status), 401);
  });
});

test('callback page: when no Studio tab answers it says so, in plain words, instead of pretending it worked', async () => {
  await studioPage(async ({ page, port, errors }) => {
    await guard(page.context(), errors);
    await page.goto(`http://127.0.0.1:${port}/app/oauth-callback.html?code=X1&state=p${port}-${HEX}`);
    await page.waitForFunction(() => /did not answer/.test(document.getElementById('msg')?.textContent ?? ''), null, { timeout: 9000 });
    assert.equal(await page.locator('main').getAttribute('data-state'), 'bad');
  });
});

// ---- the hosted relay page --------------------------------------------------------------------------------------------------------------------

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const listen = (handler) => new Promise((resolve) => { const server = http.createServer(handler); server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })); });

test('relay page: forwards ?code&state (or ?error&state) to 127.0.0.1 on the port in the state and nowhere else; a malformed state is explained and goes nowhere', async () => {
  const siteDir = join(ROOT, 'site');
  const seen = [];
  const capture = await listen((req, res) => { if (req.url !== '/favicon.ico') seen.push({ url: req.url, host: req.headers.host }); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Nordle</title>captured'); });
  const site = await listen((req, res) => {
    const rel = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^[\\/]+/, '');
    try { const body = readFileSync(join(siteDir, rel)); res.writeHead(200, { 'content-type': TYPES[extname(rel)] ?? 'application/octet-stream' }); res.end(body); } catch { res.writeHead(404); res.end(); }
  });
  const context = await (await getBrowser()).newContext();
  const errors = [];
  try {
    await guard(context, errors);
    const page = await context.newPage();
    const relay = (query) => `http://127.0.0.1:${site.port}/connect/buffer.html?${query}`;
    const st = `p${capture.port}-${HEX}`;
    // a code
    await page.goto(relay(`code=abc.DEF-123_x~y&state=${st}`));
    await page.waitForURL(/oauth-callback/);
    assert.deepEqual(seen.map((s) => s.url), [`/app/oauth-callback.html?code=abc.DEF-123_x~y&state=${st}`]);
    assert.equal(seen[0].host, `127.0.0.1:${capture.port}`);
    // extra things in the address are not passed on, and cannot change where it goes
    seen.length = 0;
    await page.goto(relay(`code=c1&state=${st}&redirect=https://evil.example.test&host=evil.example.test&next=//evil.example.test&port=80`));
    await page.waitForURL(/oauth-callback/);
    assert.deepEqual(seen.map((s) => s.url), [`/app/oauth-callback.html?code=c1&state=${st}`]);
    // an error
    seen.length = 0;
    await page.goto(relay(`error=access_denied&error_description=nope&state=${st}`));
    await page.waitForURL(/oauth-callback/);
    assert.deepEqual(seen.map((s) => s.url), [`/app/oauth-callback.html?error=access_denied&state=${st}`]);
    // characters that mean something in HTML or an address are encoded, not interpreted
    seen.length = 0;
    await page.goto(relay(`code=${encodeURIComponent('<b>&x=1#')}&state=${st}`));
    await page.waitForURL(/oauth-callback/);
    assert.deepEqual(seen.map((s) => s.url), [`/app/oauth-callback.html?code=${encodeURIComponent('<b>&x=1#')}&state=${st}`]);
    // states that Nordle did not make
    seen.length = 0;
    for (const bad of [`p80-${HEX}`, `p${capture.port}-${HEX.toUpperCase()}`, `p${capture.port}-${HEX.slice(1)}`, 'garbage', `p${capture.port}-${HEX}.evil.example.test`, '']) {
      await page.goto(relay(`code=c9&state=${encodeURIComponent(bad)}`));
      assert.match(await page.locator('#msg').innerText(), /not a Buffer sign-in that Nordle started/, `state "${bad}"`);
      assert.equal(await page.locator('#msg').getAttribute('data-state'), 'bad');
    }
    await page.goto(relay(`state=${st}`));
    assert.match(await page.locator('#msg').innerText(), /Nothing came back/);
    await page.goto(relay(`code=${'x'.repeat(5000)}&state=${st}`));
    assert.match(await page.locator('#msg').innerText(), /does not accept/);
    await page.waitForTimeout(200);
    assert.deepEqual(seen, [], 'nothing was forwarded for any of those');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
    capture.server.close(); site.server.close();
  }
  // the source says the same thing
  const js = readFileSync(join(siteDir, 'connect', 'buffer.js'), 'utf8');
  const hosts = [...js.matchAll(/https?:\/\/([^/'"\s:]+)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(hosts)], ['127.0.0.1'], 'the only address in the script is 127.0.0.1');
  for (const bad of ['fetch(', 'XMLHttpRequest', 'sendBeacon', 'localStorage', 'sessionStorage', 'document.cookie', 'indexedDB', 'innerHTML', 'eval(', 'document.write']) assert.ok(!js.includes(bad), `buffer.js must not use ${bad}`);
  const htmlText = readFileSync(join(siteDir, 'connect', 'buffer.html'), 'utf8');
  assert.match(htmlText, /<meta http-equiv="Content-Security-Policy" content="[^"]*script-src 'self'[^"]*"/);
  assert.match(htmlText, /default-src 'none'/);
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(htmlText), 'no inline script');
  assert.ok(!/(src|href)="https?:/i.test(htmlText), 'nothing from outside');
  assert.ok(!/gtag|googletagmanager|google-analytics|plausible|matomo|segment\.com|fbq\(/i.test(htmlText + js), 'no tracking');
  // the landing page loads nothing from anywhere else either (its links go to GitHub and the licence, as links)
  const index = readFileSync(join(siteDir, 'index.html'), 'utf8');
  assert.ok(!/<script/i.test(index));
  assert.ok(!/<(link|img|script|iframe)[^>]+(src|href)="https?:/i.test(index));
  assert.match(index, /Nordle was created by Samuel Young, <a [^>]*>CC BY 4\.0<\/a>/);
});

// ---- the Publishing window --------------------------------------------------------------------------------------------------------------------

test('Publishing window: with no app client id the button says so in plain words and nothing opens; the API-key way is still there', async () => {
  fresh();
  configure({ oauth: { defaults: { clientId: null } } });
  try {
    await studioPage(async ({ page, open, errors }) => {
      await guard(page.context(), errors);
      const opened = [];
      page.context().on('page', (p) => opened.push(p.url()));
      await open(`#/s/month?today=${TODAY}`);
      await openPublishing(page);
      await page.waitForSelector('.bsi[data-configured="false"]');
      const box = page.locator('.bsi');
      assert.match(await box.innerText(), /no Buffer app client id yet/);
      assert.match(await box.innerText(), /API key works instead/);
      await page.click('[data-act="buffer-signin"]');
      await page.waitForSelector('.bsi[data-phase="unconfigured"]');
      assert.match(await page.locator('.bsi-say').innerText(), /no Buffer app client id yet/);
      await page.waitForTimeout(250);
      assert.deepEqual(opened, [], 'no tab was opened');
      assert.equal(await page.locator('dialog [data-act="add-account"]').count(), 1, 'pasting a key is still there, below');
      assert.match(await page.locator('.bacc-add h4').innerText(), /Or paste an API key/);
    });
  } finally { configure({ oauth: { defaults: {} } }); }
});

test('Publishing window: a Studio opened as "localhost" is told to use 127.0.0.1 (that is where Buffer\'s sign-in comes back to), and nothing opens', async () => {
  fresh();
  await studioPage(async ({ page, port, errors }) => {
    await guard(page.context(), errors);
    const opened = [];
    page.context().on('page', (p) => opened.push(p.url()));
    await page.goto(`http://localhost:${port}/#/s/month?today=${TODAY}`);
    await page.waitForSelector('.studio', { state: 'visible' });
    await openPublishing(page);
    await page.click('[data-act="buffer-signin"]');
    await page.waitForSelector('.bsi[data-phase="error"]');
    assert.match(await page.locator('.bsi-say').innerText(), new RegExp(`Open Nordle at http://127\\.0\\.0\\.1:${port}/ \\(not "localhost"\\)`));
    await page.waitForTimeout(200);
    assert.deepEqual(opened, []);
  });
});

test('Publishing window: Sign in with Buffer opens Buffer, comes back through the callback page, and the account card appears; Disconnect and "Sign in again" work', async () => {
  fresh();
  await studioPage(async ({ page, open, port, errors }) => {
    const context = page.context();
    await guard(context, errors);
    await fakeAuthorize(context, port, errors);
    await open(`#/s/month?today=${TODAY}`);
    await openPublishing(page);
    // the sign-in sits above the pasted key
    assert.equal(await page.evaluate(() => !!(document.querySelector('.bsi').compareDocumentPosition(document.querySelector('.bacc-add')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    assert.equal(await page.locator('[data-act="buffer-signin"]').isEnabled(), true);
    assert.equal(await page.locator('.bsi[data-configured="true"]').count(), 1);
    assert.equal(await page.locator('.bsi-say.bad').count(), 0, 'nothing is wrong, so nothing is said');
    // press it
    const popupP = context.waitForEvent('page');
    await page.click('[data-act="buffer-signin"]');
    const popup = await popupP;
    await popup.waitForSelector('main[data-state="ok"]', { timeout: 20000 });
    assert.equal(await popup.locator('#msg').innerText(), 'Connected to Nordle: you can close this tab.');
    // the window now has the account, says how it signed in, and offers to disconnect it
    await page.waitForSelector('.acc-banner.ok:has-text("Buffer is connected")');
    const row = page.locator('.bacc[data-account="default"]');
    assert.equal(await row.getAttribute('data-auth'), 'oauth');
    const text = await row.innerText();
    assert.match(text, /Connected/);
    assert.match(text, /Signed in with Buffer\. This hour's access runs out at \d{1,2}:\d{2}\s?(am|pm)?; Nordle renews it by itself\./i);
    assert.match(text, /2 channels/);
    assert.equal(await row.locator('[data-act="disconnect-account"]').count(), 1);
    assert.equal(await row.locator('[data-act="buffer-signin-again"]').count(), 0, 'it is signed in, so there is nothing to sign in again');
    assert.match(await page.locator('.bsi-say').innerText(), /Signed in with Buffer\./);
    // what happened on the wire
    assert.equal(fb.tokenRequests.length, 1);
    assert.equal(fb.tokenRequests[0].body.redirect_uri, EXPECTED_REDIRECT);
    assert.equal(fb.tokenRequests[0].body.client_id, EXPECTED_ID);
    assert.ok(!('client_secret' in fb.tokenRequests[0].body));
    // no secret reached the page, the callback page or the browser's storage
    assert.deepEqual(leaks(await page.content()), []);
    assert.deepEqual(leaks(await popup.content().catch(() => '')), []);
    assert.equal(await page.evaluate(() => localStorage.getItem('nordle-buffer-oauth')), null);
    // disconnect: the tokens go, the account stays and offers to sign in again
    await row.locator('[data-act="disconnect-account"]').click();
    await page.waitForSelector('dialog:has-text("Disconnect “Buffer”?")');
    assert.match(await page.locator('dialog:has-text("Disconnect “Buffer”?")').last().innerText(), /Buffer’s own settings/);
    await page.click('dialog button.danger');
    await page.waitForSelector('.acc-banner:has-text("Buffer is disconnected")');
    const gone = page.locator('.bacc[data-account="default"]');
    assert.match(await gone.innerText(), /Not connected/);
    assert.equal(await gone.locator('[data-act="disconnect-account"]').count(), 0);
    assert.equal(await gone.locator('[data-act="buffer-signin-again"]').count(), 1);
    // sign in again, from the account's own button
    const popup2P = context.waitForEvent('page');
    await gone.locator('[data-act="buffer-signin-again"]').click();
    const popup2 = await popup2P;
    await popup2.waitForSelector('main[data-state="ok"]', { timeout: 20000 });
    await page.waitForSelector('.bacc[data-account="default"] [data-act="disconnect-account"]');
    assert.equal(fb.tokenRequests.length, 2);
    assert.deepEqual(leaks(await page.content()), []);
  });
});

test('Publishing window: when the person says no in Buffer, the window says so and no account is made', async () => {
  fresh();
  await studioPage(async ({ page, open, port, errors }) => {
    const context = page.context();
    await guard(context, errors);
    await fakeAuthorize(context, port, errors, { deny: true });
    await open(`#/s/month?today=${TODAY}`);
    await openPublishing(page);
    const popupP = context.waitForEvent('page');
    await page.click('[data-act="buffer-signin"]');
    const popup = await popupP;
    await popup.waitForFunction(() => /refused/.test(document.getElementById('msg')?.textContent ?? ''), null, { timeout: 20000 });
    assert.equal(await popup.locator('main').getAttribute('data-state'), 'bad');
    await page.waitForSelector('.bsi[data-phase="refused"]');
    assert.match(await page.locator('.bsi-say').innerText(), /refused, so nothing was connected/);
    assert.equal(await page.locator('.bacc[data-account]').count(), 0);
    assert.equal(fb.tokenRequests.length, 0, 'no code, nothing to trade');
    assert.equal(await page.locator('[data-act="buffer-signin"]').isEnabled(), true, 'it can be tried again');
    // the browser logs the server's 400 for the refusal as a console error: expected here, and only here
    errors.splice(0, errors.length, ...errors.filter((e) => !/status of 400/.test(e)));
  });
});
