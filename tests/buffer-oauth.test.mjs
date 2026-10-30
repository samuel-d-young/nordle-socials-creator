// "Sign in with Buffer" (OAuth 2.0 authorization code + PKCE), server side. Everything talks to a FAKE Buffer (tests/buffer-oauth-fake.mjs): the authorize
// step, the token address and the API are in-process, and any other address throws, so nothing real is ever contacted. The browser parts (the callback page,
// the relay page, the Publishing window) are in tests/buffer-oauth-ui.test.mjs.
//   node --test tests/buffer-oauth.test.mjs
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../tools/validate.mjs';
import { createNordleServer } from '../src/server/http.mjs';
import { loadCalendar, newCalendar, saveCalendar } from '../src/calendar/model.mjs';
import { clearChannelMemo, configure, getAdapter, saveSettingsFor } from '../src/publish/index.mjs';
import { accountsFor, auditPath, clearAllowanceMemo, loadSettings, plansDir, publishDir, resolveSettings, settingsPath } from '../src/publish/store.mjs';
import {
  BUFFER_AUTH_URL, BUFFER_OAUTH_CLIENT_ID, BUFFER_OAUTH_REDIRECT_URI, BUFFER_OAUTH_SCOPES, MAX_PENDING, accessTokenFor, buildAuthUrl, challengeOf, clearPending,
  createPkce, exchangeCode, newState, oauthConfig, parseState, pendingCount, refreshAccount, saveSignIn, startSignIn,
} from '../src/publish/buffer-oauth.mjs';
import { fakeBuffer } from './buffer-oauth-fake.mjs';

const HUMAN = 'human-token-for-oauth-tests-0123456789';
const AGENT = 'agent-token-for-oauth-tests-0123456789';
const EXPECTED_ID = 'doqCgiRK4o94fD7l-CQh-NRc4B0XIRCUe_rqQ9Q0zwL';
const EXPECTED_REDIRECT = 'https://samuel-d-young.github.io/nordle-socials-creator/connect/buffer.html';
const EXPECTED_SCOPE = 'account:read posts:read posts:write offline_access';
for (const k of ['NORDLE_BUFFER_CLIENT_ID', 'NORDLE_BUFFER_REDIRECT_URI', 'NORDLE_BUFFER_SCOPES']) delete process.env[k];

let work, app, port, projectDir, clock;
const fb = fakeBuffer({ now: () => clock });
const P = 'gannet';
const PORT = 45678;   // a port for tests that build a sign-in without a server

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'nordle-oauth-'));
  process.env.NORDLE_PUBLISH_DIR = join(work, 'state');
  projectDir = join(work, 'projects', P);
  cpSync(join(ROOT, 'samples', 'little-gannet'), projectDir, { recursive: true, filter: (s) => !/[\\/](out|sources|docs)([\\/]|$)/.test(s) });
  mkdirSync(join(projectDir, 'docs'), { recursive: true });
  saveCalendar(projectDir, { ...newCalendar('little-gannet'), timezone: 'Australia/Melbourne', items: [] });
  clock = Date.now();
  configure({ buffer: { fetch: fb.fetch }, oauth: { fetch: fb.fetch, now: () => clock, defaults: {} } });
  app = createNordleServer({ roots: [join(work, 'projects')], token: HUMAN, agentToken: AGENT, runtimeDir: join(work, 'runtime') });
  port = await app.listen(0);
});
after(async () => {
  await app.close();
  configure({ buffer: {}, oauth: { fetch: undefined, now: undefined, defaults: {} } });
  rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  delete process.env.NORDLE_PUBLISH_DIR;
});
beforeEach(() => {
  rmSync(settingsPath(), { force: true });
  rmSync(plansDir(), { recursive: true, force: true });
  rmSync(join(projectDir, 'publish'), { recursive: true, force: true });
  clearPending(); clearChannelMemo(); clearAllowanceMemo();
  fb.reset();
  clock = Date.now();
  configure({ oauth: { defaults: {} } });
});

// ---- helpers ----------------------------------------------------------------------------------------------------------------------------

async function call(role, method, path, body) {
  let res;
  for (let attempt = 0; ; attempt++) {   // loopback on Windows now and then drops a connection before the server sees it
    try {
      res = await fetch(`http://127.0.0.1:${port}/api/publish${path}`, { method, headers: { 'x-nordle-token': role === 'human' ? HUMAN : AGENT, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      break;
    } catch (e) { if (attempt >= 2 || !(e instanceof TypeError)) throw e; }
  }
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text };
}
const human = (m, p, b) => call('human', m, p, b);
const agent = (m, p, b) => call('agent', m, p, b);
const sha256 = (s) => createHash('sha256').update(s, 'ascii').digest('base64url');
const leaks = (text) => [...fb.issued, ...fb.verifiers].filter((secret) => String(text).includes(secret));
const noSecrets = (text, what) => assert.deepEqual(leaks(text), [], `${what} must not contain a token, code or verifier`);
const raw = (account = 'default') => loadSettings().accounts[account];
const via = { fetchImpl: fb.fetch, now: () => clock };

/** A finished sign-in saved as an account, without the HTTP layer. */
async function connectDirect({ account = 'default' } = {}) {
  const { url } = startSignIn({ port: PORT, account, role: 'human', now: clock });
  const got = fb.authorize(url);
  const t = await exchangeCode({ code: got.code, state: got.state, role: 'human' }, via);
  saveSignIn(t, 'human');
  return t;
}
/** The adapter's view of an account, the way testAdapter and the planner build it. */
const perOf = (id = 'default') => { const a = accountsFor(loadSettings(), 'buffer').find((x) => x.id === id); return { token: a.token, account: { id: a.id, label: a.label, authType: a.authType, expiresAt: a.expiresAt }, organizationId: null, options: {}, channelCache: [] }; };
const latest = (prefix) => [...fb.issued].reverse().find((x) => x.startsWith(prefix));

/** Sign in through the routes, as the Studio does. */
async function signInOverHttp(body = {}) {
  const st = await human('POST', '/oauth/buffer/start', body);
  assert.equal(st.status, 200, st.text);
  const got = fb.authorize(st.json.url, { clientId: EXPECTED_ID, redirectUri: EXPECTED_REDIRECT, scope: EXPECTED_SCOPE });
  assert.equal(got.state, st.json.state);
  const fin = await human('POST', '/oauth/buffer/finish', { code: got.code, state: got.state });
  return { st, got, fin };
}

// ---- PKCE, state, the address ------------------------------------------------------------------------------------------------------------

test('PKCE: the RFC 7636 appendix B vector, and a fresh verifier is 43 URL-safe characters whose challenge is its SHA-256', () => {
  assert.equal(challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  const a = createPkce(), b = createPkce();
  assert.match(a.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(a.challenge, sha256(a.verifier));
  assert.notEqual(a.verifier, b.verifier);
});

test('state: p<port>-<32 hex>; the port is only accepted from 1024 up; anything else is not ours', () => {
  const s = newState(5400);
  assert.match(s, /^p5400-[0-9a-f]{32}$/);
  assert.deepEqual(parseState(s), { port: 5400, nonce: s.slice(6) });
  assert.throws(() => newState(80), /port/);
  assert.throws(() => newState(70000), /port/);
  for (const bad of [null, '', 'p80-' + 'a'.repeat(32), 'p123456-' + 'a'.repeat(32), 'p5400-' + 'A'.repeat(32), 'p5400-' + 'a'.repeat(31), 'x5400-' + 'a'.repeat(32), `p5400-${'a'.repeat(32)}&host=evil.test`]) assert.equal(parseState(bad), null, String(bad));
});

test('the authorize address has exactly the documented parameters, the registered redirect address and the narrow scopes', () => {
  assert.equal(BUFFER_OAUTH_REDIRECT_URI, EXPECTED_REDIRECT);
  assert.deepEqual(BUFFER_OAUTH_SCOPES, EXPECTED_SCOPE.split(' '));
  const { url, state } = startSignIn({ port: PORT, role: 'human' });
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, BUFFER_AUTH_URL);
  assert.equal(BUFFER_AUTH_URL, 'https://auth.buffer.com/auth');
  const p = Object.fromEntries(u.searchParams);
  assert.deepEqual(Object.keys(p).sort(), ['client_id', 'code_challenge', 'code_challenge_method', 'prompt', 'redirect_uri', 'response_type', 'scope', 'state']);
  assert.equal(p.client_id, EXPECTED_ID);
  assert.equal(p.redirect_uri, EXPECTED_REDIRECT);
  assert.equal(p.response_type, 'code');
  assert.equal(p.scope, EXPECTED_SCOPE);
  assert.equal(p.state, state);
  assert.match(p.code_challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(p.code_challenge_method, 'S256');
  assert.equal(p.prompt, 'consent');
  assert.ok(!/client_secret|verifier/.test(url), 'a public client sends no secret and the verifier stays home');
  assert.ok(!url.includes('+'), 'spaces are %20');
  // the pure builder gives the same thing
  assert.equal(buildAuthUrl({ clientId: 'abc12345', redirectUri: EXPECTED_REDIRECT, state, challenge: p.code_challenge }).includes('client_id=abc12345'), true);
});

test('configuration: the constant is the default; the environment and the publishing settings override it; "unset" is reached through a parameter, not by editing the constant', () => {
  assert.equal(BUFFER_OAUTH_CLIENT_ID, EXPECTED_ID);
  assert.equal(oauthConfig({}, {}).clientId, EXPECTED_ID);
  assert.equal(oauthConfig({}, {}).redirectUri, EXPECTED_REDIRECT);
  assert.deepEqual(oauthConfig({}, {}).scopes, BUFFER_OAUTH_SCOPES);
  const own = { adapters: { buffer: { oauth: { clientId: 'from-settings-1234', redirectUri: 'https://fork.example.test/connect/buffer.html', scopes: ['posts:write', 'account:read'] } } } };
  assert.equal(oauthConfig(own, {}).clientId, 'from-settings-1234');
  assert.equal(oauthConfig(own, {}).redirectUri, 'https://fork.example.test/connect/buffer.html');
  assert.deepEqual(oauthConfig(own, {}).scopes, ['posts:write', 'account:read']);
  const envWins = oauthConfig(own, { NORDLE_BUFFER_CLIENT_ID: 'from-env-12345', NORDLE_BUFFER_SCOPES: 'posts:read offline_access' });
  assert.equal(envWins.clientId, 'from-env-12345');
  assert.deepEqual(envWins.scopes, ['posts:read', 'offline_access']);
  assert.equal(oauthConfig({}, {}, { clientId: null }).clientId, null, 'a copy of Nordle with no app client id');
  assert.match(oauthConfig({}, { NORDLE_BUFFER_REDIRECT_URI: 'http://127.0.0.1:5400/cb' }).problem, /https/);
  assert.match(oauthConfig({}, { NORDLE_BUFFER_SCOPES: 'posts:write; drop table' }).problem, /scopes/);
  assert.match(oauthConfig({}, { NORDLE_BUFFER_CLIENT_ID: 'has space inside' }).problem, /client id/);
});

// ---- exchanging the code ----------------------------------------------------------------------------------------------------------------

test('the token request is form-encoded with the verifier and NO client secret, and the tokens come back checked', async () => {
  const { url } = startSignIn({ port: PORT, role: 'human', now: clock });
  const got = fb.authorize(url);
  const t = await exchangeCode({ code: got.code, state: got.state, role: 'human' }, via);
  assert.equal(fb.tokenRequests.length, 1);
  const r = fb.tokenRequests[0];
  assert.equal(r.method, 'POST');
  assert.equal(r.url, 'https://auth.buffer.com/token');
  assert.match(r.contentType, /^application\/x-www-form-urlencoded/);
  assert.deepEqual(Object.keys(r.body).sort(), ['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri']);
  assert.equal(r.body.grant_type, 'authorization_code');
  assert.equal(r.body.client_id, EXPECTED_ID);
  assert.equal(r.body.redirect_uri, EXPECTED_REDIRECT);
  assert.equal(r.body.code, got.code);
  assert.equal(sha256(r.body.code_verifier), got.params.code_challenge, 'the verifier that was sent hashes to the challenge in the address');
  assert.ok(!('client_secret' in r.body));
  assert.equal(t.accountId, 'default');
  assert.match(t.accessToken, /^ACCESSTOKEN-/);
  assert.match(t.refreshToken, /^REFRESHTOKEN-/);
  assert.equal(t.expiresAt, new Date(clock + 3600 * 1000).toISOString());
  assert.equal(t.scope, EXPECTED_SCOPE);
});

test('state: a made-up, expired or reused state is refused (and never reaches Buffer); an error answer uses the state up; at most five wait at once', async () => {
  // made up
  startSignIn({ port: PORT, role: 'human', now: clock });
  await assert.rejects(exchangeCode({ code: 'a-code', state: `p${PORT}-${'a'.repeat(32)}`, role: 'human' }, via), (e) => e.status === 409 && /does not recognise/.test(e.message));
  await assert.rejects(exchangeCode({ code: 'a-code', state: 'nonsense', role: 'human' }, via), /does not recognise/);
  assert.equal(fb.tokenRequests.length, 0, 'nothing was sent to Buffer');
  // expired: more than 10 minutes
  clearPending();
  const old = startSignIn({ port: PORT, role: 'human', now: clock });
  const oldGot = fb.authorize(old.url);
  await assert.rejects(exchangeCode({ code: oldGot.code, state: oldGot.state, role: 'human' }, { fetchImpl: fb.fetch, now: () => clock + 10 * 60 * 1000 + 1000 }), (e) => e.status === 410 && /more than 10 minutes/.test(e.message));
  assert.equal(fb.tokenRequests.length, 0);
  // just inside the 10 minutes still works
  const ok = startSignIn({ port: PORT, role: 'human', now: clock });
  const okGot = fb.authorize(ok.url);
  await exchangeCode({ code: okGot.code, state: okGot.state, role: 'human' }, { fetchImpl: fb.fetch, now: () => clock + 9 * 60 * 1000 });
  // reused
  await assert.rejects(exchangeCode({ code: okGot.code, state: okGot.state, role: 'human' }, via), /does not recognise/);
  assert.equal(fb.tokenRequests.length, 1, 'only the first use reached Buffer');
  // an error answer (the person said no) consumes the state: a code that arrives afterwards with it is refused
  const denied = startSignIn({ port: PORT, role: 'human', now: clock });
  await assert.rejects(exchangeCode({ error: 'access_denied', state: denied.state, role: 'human' }, via), /refused/);
  await assert.rejects(exchangeCode({ code: 'late', state: denied.state, role: 'human' }, via), /does not recognise/);
  const scope = startSignIn({ port: PORT, role: 'human', now: clock });
  await assert.rejects(exchangeCode({ error: 'invalid_scope', state: scope.state, role: 'human' }, via), (e) => /offline_access/.test(e.message) && /BUFFER_OAUTH_SCOPES/.test(e.message));
  // a missing code with a good state
  const bare = startSignIn({ port: PORT, role: 'human', now: clock });
  await assert.rejects(exchangeCode({ state: bare.state, role: 'human' }, via), /no sign-in code/);
  // at most five at once: the sixth start drops the oldest
  clearPending();
  const states = Array.from({ length: MAX_PENDING + 1 }, () => startSignIn({ port: PORT, role: 'human', now: clock }).state);
  assert.equal(pendingCount(), MAX_PENDING);
  await assert.rejects(exchangeCode({ code: 'x', state: states[0], role: 'human' }, via), /does not recognise/);
  assert.equal(pendingCount(), MAX_PENDING, 'the newest five are still waiting');
  assert.equal(fb.tokenRequests.length, 1);
});

test('only the owner starts or finishes a sign-in in the library too', async () => {
  assert.throws(() => startSignIn({ port: PORT, role: 'agent' }), (e) => e.status === 403);
  await assert.rejects(exchangeCode({ code: 'x', state: 'y', role: 'agent' }, via), (e) => e.status === 403);
});

test('Buffer\'s refusals become plain words that never repeat the code, the verifier or a token', async () => {
  const start = () => { const s = startSignIn({ port: PORT, role: 'human', now: clock }); return { s, got: fb.authorize(s.url) }; };
  // invalid_grant, with a description that echoes the code and verifier back
  let { got } = start();
  fb.failToken = { status: 400, body: { error: 'invalid_grant', error_description: `bad code ${got.code}` } };
  await assert.rejects(exchangeCode({ code: got.code, state: got.state, role: 'human' }, via), (e) => { assert.match(e.message, /Sign in with Buffer again/); noSecrets(e.message, 'the message'); assert.ok(!e.message.includes(got.code)); return true; });
  // the client id or redirect address is wrong
  ({ got } = start());
  fb.failToken = { status: 400, body: { error: 'invalid_client' } };
  await assert.rejects(exchangeCode({ code: got.code, state: got.state, role: 'human' }, via), /client id or its redirect address/);
  // something else, with a description that echoes the verifier
  ({ got } = start());
  fb.failToken = { status: 400, body: { error: 'invalid_request', error_description: `code ${got.code} was rejected` } };
  await assert.rejects(exchangeCode({ code: got.code, state: got.state, role: 'human' }, via), (e) => { assert.match(e.message, /invalid_request/); assert.ok(!e.message.includes(got.code), 'Buffer\'s echo of the code is blanked'); noSecrets(e.message, 'the message'); return true; });
  // the token address is down
  ({ got } = start());
  fb.failToken = null; fb.networkDown = true;
  await assert.rejects(exchangeCode({ code: got.code, state: got.state, role: 'human' }, via), (e) => e.status === 502 && /Could not reach Buffer/.test(e.message));
  // a 500 with no JSON
  ({ got } = start());
  fb.networkDown = false; fb.failToken = { status: 503, body: { oops: true } };
  await assert.rejects(exchangeCode({ code: got.code, state: got.state, role: 'human' }, via), (e) => e.status === 502 && /HTTP 503/.test(e.message));
  // an answer with no access token
  ({ got } = start());
  fb.failToken = { status: 200, body: { token_type: 'Bearer' } };
  await assert.rejects(exchangeCode({ code: got.code, state: got.state, role: 'human' }, via), /something Nordle does not understand/);
});

// ---- renewing -------------------------------------------------------------------------------------------------------------------------------

test('a refresh token is single use: the new one is on disk before the new access token is used, and the old one is gone', async () => {
  const first = await connectDirect();
  clock += 3500 * 1000;   // 100 seconds left: inside the two-minute margin
  fb.onApi = () => raw().refreshToken;   // what the settings file holds at the moment an API request arrives
  const per = perOf();
  const adapter = getAdapter('buffer');
  const r = await adapter.check(per);
  assert.equal(r.ok, true, r.message);
  assert.equal(fb.refreshRequests().length, 1);
  assert.equal(fb.refreshRequests()[0].body.refresh_token, first.refreshToken);
  assert.deepEqual(Object.keys(fb.refreshRequests()[0].body).sort(), ['client_id', 'grant_type', 'refresh_token'], 'a public client sends no secret');
  assert.equal(fb.apiRequests.length, 1, 'the old token was never sent: it was renewed before the request');
  const newAccess = latest('ACCESSTOKEN-'), newRefresh = latest('REFRESHTOKEN-');
  assert.notEqual(newRefresh, first.refreshToken);
  assert.equal(fb.apiRequests[0].bearer, newAccess);
  assert.equal(fb.apiRequests[0].onDisk, newRefresh, 'the newest refresh token was already saved when the new access token was first used');
  assert.equal(raw().refreshToken, newRefresh);
  assert.equal(raw().token, newAccess);
  assert.equal(raw().expiresAt, new Date(clock + 3600 * 1000).toISOString());
  assert.equal(per.token, newAccess, 'the caller\'s settings carry the new access token');
  assert.equal(per.account.expiresAt, raw().expiresAt);
  // a second use of the renewed sign-in is quiet
  assert.equal((await adapter.check(per)).ok, true);
  assert.equal(fb.refreshRequests().length, 1);
});

test('the two-minute margin: a token with 121 seconds left is used as it is, one with 119 is renewed first', async () => {
  const t = await connectDirect();
  clock += 3600 * 1000 - 121 * 1000;
  assert.equal((await accessTokenFor('default', via)).token, t.accessToken);
  assert.equal(fb.refreshRequests().length, 0);
  clock += 2 * 1000;   // 119 seconds left
  const r = await accessTokenFor('default', via);
  assert.equal(r.refreshed, true);
  assert.notEqual(r.token, t.accessToken);
  assert.equal(fb.refreshRequests().length, 1);
});

test('concurrent callers share ONE renewal (a second use of the spent refresh token would revoke the whole grant)', async () => {
  await connectDirect();
  clock += 3600 * 1000 - 60 * 1000;
  fb.tokenDelayMs = 40;   // overlap them for real
  const out = await Promise.all([accessTokenFor('default', via), accessTokenFor('default', via), refreshAccount('default', via), accessTokenFor('default', via)]);
  assert.equal(fb.refreshRequests().length, 1, 'one request to the token address');
  assert.equal(new Set(out.map((x) => x.token)).size, 1, 'everyone got the same new access token');
  assert.equal(fb.revoked.size, 0, 'the grant is intact');
  // and through the adapter: five requests at once, one renewal
  clock += 3600 * 1000 - 60 * 1000;
  const adapter = getAdapter('buffer');
  const per = Array.from({ length: 5 }, () => perOf());
  const checks = await Promise.all(per.map((p) => adapter.check(p)));
  assert.ok(checks.every((c) => c.ok), JSON.stringify(checks));
  assert.equal(fb.refreshRequests().length, 2, 'one more renewal for the next hour, not five');
  assert.equal(fb.revoked.size, 0);
  assert.equal(readdirSync(publishDir()).filter((f) => f.endsWith('.lock')).length, 0, 'no lock file is left behind');
});

test('a refused renewal (invalid_grant) says to sign in again, forgets the dead grant, and does not loop', async () => {
  const t = await connectDirect();
  fb.refresh.get(t.refreshToken).used = true;   // Buffer will call it spent
  clock += 3600 * 1000 - 30 * 1000;
  await assert.rejects(accessTokenFor('default', via), (e) => {
    assert.equal(e.status, 401);
    assert.equal(e.code, 'auth');
    assert.match(e.message, /Sign in with Buffer again/);
    noSecrets(e.message, 'the message');
    return true;
  });
  assert.equal(fb.refreshRequests().length, 1);
  assert.equal(raw().refreshToken, undefined, 'the dead refresh token is forgotten');
  assert.equal(accountsFor(loadSettings(), 'buffer')[0].token, null, 'the account reads as not connected');
  // every later call fails at once, without asking Buffer again
  for (let i = 0; i < 3; i++) await assert.rejects(accessTokenFor('default', via), /Sign in with Buffer again/);
  const adapter = getAdapter('buffer');
  const r = await adapter.check({ token: 'stale-access-token-1', account: { id: 'default', authType: 'oauth', expiresAt: new Date(clock - 1000).toISOString() }, options: {} });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'auth');
  assert.match(r.message, /Sign in with Buffer again/);
  assert.equal(fb.refreshRequests().length, 1, 'no loop');
});

test('a renewal that fails for another reason (the network) keeps the sign-in so the next try can work', async () => {
  const t = await connectDirect();
  clock += 3600 * 1000 - 30 * 1000;
  fb.networkDown = true;
  await assert.rejects(accessTokenFor('default', via), (e) => e.status === 502 && /Could not reach Buffer/.test(e.message));
  assert.equal(raw().refreshToken, t.refreshToken, 'the refresh token was not spent, so it is kept');
  fb.networkDown = false;
  assert.equal((await accessTokenFor('default', via)).refreshed, true);
});

test('Buffer sends no new refresh token on a renewal: the spent one is never tried again, and the card says it cannot renew', async () => {
  await connectDirect();
  fb.omitRefresh = true;
  clock += 3600 * 1000 - 30 * 1000;
  assert.equal((await accessTokenFor('default', via)).refreshed, true);
  assert.equal(raw().refreshToken, undefined);
  assert.equal(accountsFor(loadSettings(), 'buffer')[0].renews, false);
  clock += 3601 * 1000;   // past the end of that hour
  await assert.rejects(accessTokenFor('default', via), /cannot renew itself/);
  assert.equal(fb.refreshRequests().length, 1);
});

test('the adapter: a 401 for a sign-in renews once and asks once more; a second 401 is an error, not a loop; an API key is never renewed', async () => {
  const t = await connectDirect();
  const adapter = getAdapter('buffer');
  fb.expireAccess(t.accessToken);   // revoked or expired at Buffer's side while the stored expiry still looks fine
  const per = perOf();
  const ok = await adapter.check(per);
  assert.equal(ok.ok, true, ok.message);
  assert.deepEqual(fb.apiRequests.map((x) => x.status), [401, 200]);
  assert.notEqual(fb.apiRequests[0].bearer, fb.apiRequests[1].bearer);
  assert.equal(fb.refreshRequests().length, 1);
  assert.equal(per.token, fb.apiRequests[1].bearer);
  // both tokens refused: one renewal, one retry, then a plain error
  fb.deadOnArrival = true;
  fb.expireAccess(per.token);
  fb.apiRequests.length = 0;
  const bad = await adapter.check(per);
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'auth');
  assert.match(bad.message, /Sign in with Buffer again/);
  assert.equal(fb.apiRequests.length, 2, 'asked, renewed, asked once more, and stopped');
  assert.equal(fb.refreshRequests().length, 2);
  // a pasted API key that is refused: no renewal, no retry
  fb.reset(); clock = Date.now();
  const key = { token: 'pasted-key-that-buffer-refuses', options: {}, account: { id: 'k', label: 'k', authType: 'key', expiresAt: null } };
  const refused = await adapter.check(key);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /did not accept the API key/);
  assert.equal(fb.apiRequests.length, 1);
  assert.equal(fb.tokenRequests.length, 0);
});

// ---- accounts: key versus sign-in -------------------------------------------------------------------------------------------------------

test('saving a pasted key clears every trace of a Buffer sign-in; so does clearing the key', async () => {
  await connectDirect();
  assert.equal(raw().authType, 'oauth');
  assert.ok(raw().refreshToken && raw().expiresAt && raw().scope);
  saveSettingsFor('buffer', { account: 'default', token: 'brand-new-pasted-key-0001' }, 'human');
  assert.deepEqual(Object.keys(raw()).sort(), ['adapter', 'label', 'token']);
  assert.equal(raw().token, 'brand-new-pasted-key-0001');
  assert.equal(accountsFor(loadSettings(), 'buffer')[0].authType, 'key');
  assert.equal(accountsFor(loadSettings(), 'buffer')[0].expiresAt, null);
  // the other way: a sign-in replaces a key
  await connectDirect();
  assert.equal(raw().authType, 'oauth');
  assert.notEqual(raw().token, 'brand-new-pasted-key-0001');
  saveSettingsFor('buffer', { account: 'default', token: null }, 'human');
  assert.deepEqual(Object.keys(raw()).sort(), ['adapter', 'label']);
});

test('the settings the adapter works with say it is a sign-in and when it ends, but never carry the refresh token', async () => {
  const t = await connectDirect();
  saveSettingsFor('buffer', { channels: { [P]: 'ch_ig' } }, 'human');
  const s = resolveSettings(loadSettings(), 'buffer', P);
  assert.equal(s.account.authType, 'oauth');
  assert.equal(s.account.expiresAt, t.expiresAt);
  assert.equal(s.token, t.accessToken);
  assert.ok(!JSON.stringify(s).includes(t.refreshToken));
  assert.ok(!JSON.stringify(accountsFor(loadSettings(), 'buffer')).includes(t.refreshToken));
});

// ---- the routes ------------------------------------------------------------------------------------------------------------------------------

test('routes: Claude\'s token gets 403 on status, start, finish and disconnect, and a refused call does not use up a sign-in', async () => {
  for (const [m, p, b] of [['GET', '/oauth/buffer/status'], ['POST', '/oauth/buffer/start', {}], ['POST', '/oauth/buffer/finish', { code: 'x', state: 'y' }], ['POST', '/oauth/buffer/disconnect', { account: 'default' }]]) {
    const r = await agent(m, p, b);
    assert.equal(r.status, 403, `${m} ${p}`);
  }
  const st = await human('POST', '/oauth/buffer/start', {});
  const got = fb.authorize(st.json.url);
  assert.equal((await agent('POST', '/oauth/buffer/finish', { code: got.code, state: got.state })).status, 403);
  assert.equal(fb.tokenRequests.length, 0);
  const fin = await human('POST', '/oauth/buffer/finish', { code: got.code, state: got.state });
  assert.equal(fin.status, 200, fin.text);   // the agent's attempt did not consume it
  // nothing without a token at all
  const none = await fetch(`http://127.0.0.1:${port}/api/publish/oauth/buffer/status`);
  assert.equal(none.status, 401);
});

test('routes: status says whether this copy can sign in (a missing client id is said in plain words), and start refuses with 409', async () => {
  const s = await human('GET', '/oauth/buffer/status');
  assert.equal(s.status, 200);
  assert.deepEqual(s.json, { ok: true, configured: true, redirectUri: EXPECTED_REDIRECT, scopes: BUFFER_OAUTH_SCOPES, accounts: [] });
  configure({ oauth: { defaults: { clientId: null } } });
  const un = await human('GET', '/oauth/buffer/status');
  assert.equal(un.json.configured, false);
  const start = await human('POST', '/oauth/buffer/start', {});
  assert.equal(start.status, 409);
  assert.match(start.json.errors[0].message, /no Buffer app client id yet/);
  assert.match(start.json.errors[0].message, /API key/);
  assert.equal(pendingCount(), 0, 'nothing was started');
  // the publishing setting brings it back
  mkdirSync(publishDir(), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify({ schema: 'nordle.publish/0.1', adapters: { buffer: { oauth: { clientId: 'fork-client-id-1234' } } }, accounts: {}, brands: {} }));
  const back = await human('POST', '/oauth/buffer/start', {});
  assert.equal(back.status, 200);
  assert.equal(new URL(back.json.url).searchParams.get('client_id'), 'fork-client-id-1234');
});

test('routes: start returns the address and the state (carrying this server\'s port), finish saves the account and tests it; no secret is in any reply', async () => {
  const { st, got, fin } = await signInOverHttp();
  assert.deepEqual(Object.keys(st.json).sort(), ['account', 'ok', 'state', 'url']);
  assert.equal(st.json.account, 'default');
  assert.equal(parseState(st.json.state).port, port, 'the state names the port the server really answers on');
  assert.equal(fin.status, 200, fin.text);
  assert.equal(fin.json.ok, true, fin.text);
  assert.equal(fin.json.account, 'default');
  assert.equal(fin.json.authType, 'oauth');
  assert.equal(fin.json.renews, true);
  assert.equal(fin.json.expiresAt, new Date(clock + 3600 * 1000).toISOString());
  assert.match(fin.json.message, /Connected to Buffer: Test Org/);
  assert.deepEqual(fin.json.channels.map((c) => c.id), ['ch_ig', 'ch_fb']);
  for (const k of ['token', 'accessToken', 'refreshToken', 'refresh_token', 'access_token', 'verifier', 'code']) assert.ok(!(k in fin.json), `${k} is not in the reply`);
  noSecrets(st.text, 'the start reply'); noSecrets(fin.text, 'the finish reply');
  // the account is saved as a sign-in, with the channels the test found
  assert.equal(raw().authType, 'oauth');
  assert.equal(raw().token, latest('ACCESSTOKEN-'));
  assert.equal(raw().channelCache.length, 2);
  assert.ok(raw().lastTestedAt);
  // the code was used once, with the verifier of this very sign-in
  assert.equal(fb.tokenRequests.length, 1);
  assert.equal(sha256(fb.tokenRequests[0].body.code_verifier), got.params.code_challenge);
  // status now lists it
  const status = await human('GET', '/oauth/buffer/status');
  assert.deepEqual(status.json.accounts, [{ id: 'default', label: 'Buffer', authType: 'oauth', expiresAt: fin.json.expiresAt }]);
  noSecrets(status.text, 'the status reply');
  // what the Studio reads
  const list = await human('GET', '/adapters');
  noSecrets(list.text, 'the adapters reply');
  const acc = list.json.adapters.find((a) => a.id === 'buffer').accounts[0];
  assert.deepEqual([acc.id, acc.configured, acc.authType, acc.renews, acc.expiresAt], ['default', true, 'oauth', true, fin.json.expiresAt]);
  // a second use of the same sign-in
  const again = await human('POST', '/oauth/buffer/finish', { code: got.code, state: got.state });
  assert.equal(again.status, 409);
  assert.match(again.json.errors[0].message, /does not recognise/);
});

test('routes: a named account, a second sign-in, "sign in again", and a person who says no', async () => {
  const one = await signInOverHttp({ account: 'agency', label: 'Agency login' });
  assert.equal(one.fin.json.account, 'agency');
  assert.equal(one.fin.json.label, 'Agency login');
  assert.equal(raw('agency').label, 'Agency login');
  const two = await signInOverHttp();   // no name: the next free id
  assert.equal(two.fin.json.account, 'buffer');
  const again = await signInOverHttp({ account: 'agency' });   // the same account again keeps its name
  assert.equal(raw('agency').label, 'Agency login');
  assert.equal(again.fin.json.account, 'agency');
  assert.equal((await human('POST', '/oauth/buffer/start', { account: 'Not An Id' })).status, 400);
  assert.equal((await human('POST', '/oauth/buffer/start', { label: 'x'.repeat(61) })).status, 400);
  // no
  const st = await human('POST', '/oauth/buffer/start', {});
  const no = await human('POST', '/oauth/buffer/finish', { error: 'access_denied', state: st.json.state });
  assert.equal(no.status, 400);
  assert.match(no.json.errors[0].message, /refused/);
  assert.equal(Object.keys(loadSettings().accounts).length, 2, 'no account was made');
});

test('routes: disconnect forgets the tokens on this computer and keeps the account; a key account is not disconnected this way', async () => {
  const { fin } = await signInOverHttp();
  const t = raw();
  const d = await human('POST', '/oauth/buffer/disconnect', { account: 'default' });
  assert.equal(d.status, 200);
  assert.deepEqual(d.json, { ok: true, account: 'default' });
  assert.deepEqual(Object.keys(raw()).sort(), ['adapter', 'channelCache', 'label']);
  assert.ok(!JSON.stringify(loadSettings()).includes(t.refreshToken) && !JSON.stringify(loadSettings()).includes(t.token), 'both tokens are gone from the file');
  const list = await human('GET', '/adapters');
  const acc = list.json.adapters.find((a) => a.id === 'buffer').accounts[0];
  assert.equal(acc.configured, false);
  assert.equal(acc.authType, undefined);
  assert.equal((await human('GET', '/oauth/buffer/status')).json.accounts.length, 0);
  assert.equal((await human('POST', '/oauth/buffer/disconnect', { account: 'default' })).status, 409, 'nothing left to disconnect');
  assert.equal((await human('POST', '/oauth/buffer/disconnect', { account: 'nope' })).status, 404);
  assert.equal((await human('POST', '/oauth/buffer/disconnect', {})).status, 400);
  // signing in again fills the same account
  const again = await signInOverHttp({ account: 'default' });
  assert.equal(again.fin.json.ok, true);
  assert.equal(raw().authType, 'oauth');
  assert.ok(fin.json.expiresAt);
  // a key account
  saveSettingsFor('buffer', { account: 'keyed', token: 'a-pasted-key-for-the-test-1' }, 'human');
  assert.equal((await human('POST', '/oauth/buffer/disconnect', { account: 'keyed' })).status, 409);
});

test('routes: if Buffer gives no refresh token (the offline_access permission was not honoured) the sign-in works and says it cannot renew itself', async () => {
  fb.omitRefresh = true;
  const { fin } = await signInOverHttp({ account: 'norefresh' });
  assert.equal(fin.json.ok, true, fin.text);
  assert.equal(fin.json.renews, false);
  assert.match(fin.json.note, /no way to renew/);
  assert.match(fin.json.note, /offline_access/);
  assert.equal(raw('norefresh').refreshToken, undefined);
  const acc = (await human('GET', '/adapters')).json.adapters.find((a) => a.id === 'buffer').accounts[0];
  assert.equal(acc.renews, false);
});

// ---- a real post, end to end, with a sign-in ---------------------------------------------------------------------------------------------

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('synthetic picture')]);
function addPost(id) {
  const pages = ['cover', 'tip', 'cta'];
  const doc = { schema: 'nordle.doc/0.1', id, title: `Post ${id}`, kind: 'carousel', brand: P, sizes: ['ig-feed-4x5'], copy: { caption: 'Fresh beans, roasted this morning.', hashtags: ['#coffee'], alt: Object.fromEntries(pages.map((p) => [p, `Picture of ${p}`])) }, pages: pages.map((p) => ({ id: p, title: p, layers: [] })) };
  writeFileSync(join(projectDir, 'docs', `${id}.json`), JSON.stringify(doc, null, 2));
  mkdirSync(join(projectDir, 'out', id), { recursive: true });
  pages.forEach((p, i) => writeFileSync(join(projectDir, 'out', id, `${id}_ig-feed-4x5_${String(i + 1).padStart(2, '0')}-${p}.png`), PNG));
  const cal = loadCalendar(projectDir, P);
  cal.items.push({ id, date: '2099-11-12', time: '18:30', format: 'carousel', title: `Post ${id}`, status: 'signed-off', doc: id, updated: new Date().toISOString() });
  saveCalendar(projectDir, cal);
  return `${P}:${id}`;
}

test('a post goes out through a Buffer sign-in, renewed on the way, and no token, refresh token, code or verifier lands in a reply, a plan or the audit log', async () => {
  await signInOverHttp();
  const s = await human('POST', '/settings', { adapter: 'buffer', channels: { [P]: 'ch_ig' }, options: { mediaBaseUrl: 'https://media.fake.test/m' } });
  assert.equal(s.status, 200, s.text);
  noSecrets(s.text, 'the settings reply');
  const uid = addPost('oauth-post');
  clock += 3600 * 1000 - 60 * 1000;   // the hour is nearly up: the run must renew
  const plan = await human('POST', '/plan', { adapter: 'buffer', uids: [uid] });
  assert.equal(plan.status, 200, plan.text);
  assert.equal(plan.json.summary.ready, 1, plan.text);
  noSecrets(plan.text, 'the plan reply');
  const run = await human('POST', '/run', { planId: plan.json.planId });
  assert.equal(run.status, 200, run.text);
  assert.equal(run.json.results[0].ok, true, run.text);
  noSecrets(run.text, 'the run reply');
  assert.equal(fb.creates.length, 1);
  assert.equal(fb.creates[0].bearer, latest('ACCESSTOKEN-'), 'the post was made with the renewed access token');
  assert.equal(fb.refreshRequests().length, 1);
  assert.equal(fb.revoked.size, 0);
  // files that must stay clean
  for (const f of readdirSync(plansDir())) noSecrets(readFileSync(join(plansDir(), f), 'utf8'), `the saved plan ${f}`);
  const audit = readFileSync(auditPath(projectDir), 'utf8');
  assert.match(audit, /"event":"schedule"/);
  assert.match(audit, /"account":"default"/);
  noSecrets(audit, 'the audit log');
  // ...while the settings file does hold them (the one place), privately
  const file = readFileSync(settingsPath(), 'utf8');
  assert.ok(file.includes(latest('ACCESSTOKEN-')) && file.includes(latest('REFRESHTOKEN-')));
  if (process.platform !== 'win32') assert.equal(statSync(settingsPath()).mode & 0o777, 0o600);
  assert.ok(existsSync(settingsPath()));
});
