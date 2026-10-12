// Signing in to Claude Code from the Studio, with no terminal: Nordle starts the sign-in, the browser does its part, and Nordle carries on when it is done. A pretend sign-in
// process stands in for `claude auth login`; nothing real is started or signed in.
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cancelLogin, loginState, logoutClaude, resetLogin, startLogin } from '../src/calendar/claude-login.mjs';
import { AGENT, closeBrowser } from './helpers.mjs';
import { studio, studioPage, TODAY } from './studio-helpers.mjs';

after(closeBrowser);
beforeEach(() => resetLogin());

const FOUND = { path: '/x/claude', how: 'the PATH', tried: [] };
/** A pretend `claude auth login`: it prints a link, and ends when you call finish(code). */
function fakeLogin() {
  const calls = [];
  const spawn = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.killed = false; child.kill = () => { child.killed = true; };
    calls.push({ cmd, args, child });
    setImmediate(() => child.stdout.emit('data', 'Opening browser to sign in...\nIf it does not open, visit: https://claude.ai/oauth/authorize?code=abc123.\n'));
    return child;
  };
  return { spawn, calls };
}
const signedOut = () => ({ found: true, path: FOUND.path, signedIn: false });
let signed = false;

test('the sign-in starts claude auth login, shows its link, and is done only when Claude Code says it is signed in', async () => {
  const f = fakeLogin();
  signed = false;
  const status = () => ({ found: true, path: FOUND.path, signedIn: signed });
  const s = startLogin({ spawn: f.spawn, found: FOUND, status });
  assert.equal(s.state, 'waiting');
  assert.deepEqual([f.calls[0].cmd, f.calls[0].args], ['/x/claude', ['auth', 'login', '--claudeai']]);
  await new Promise((r) => setImmediate(r));
  assert.equal(loginState().url, 'https://claude.ai/oauth/authorize?code=abc123', 'the link is kept, without the full stop after it');
  assert.equal(startLogin({ spawn: f.spawn, found: FOUND, status }).state, 'waiting', 'a second click does not start a second sign-in');
  assert.equal(f.calls.length, 1);
  signed = true;
  f.calls[0].child.emit('close', 0);
  assert.equal(loginState().state, 'done');
  // a clean exit that did not sign in is not success
  signed = false;
  resetLogin();
  const g = fakeLogin();
  startLogin({ spawn: g.spawn, found: FOUND, status });
  g.calls[0].child.emit('close', 0);
  assert.equal(loginState().state, 'failed');
  assert.match(loginState().error, /still says it is not signed in/);
});

test('already signed in: nothing is started; not installed: it says so; cancel stops it; ten minutes is the limit', async () => {
  const f = fakeLogin();
  const r = startLogin({ spawn: f.spawn, found: FOUND, status: () => ({ found: true, signedIn: true }) });
  assert.deepEqual([r.state, r.already, f.calls.length], ['done', true, 0]);
  const none = startLogin({ spawn: f.spawn, found: { path: null, how: '', tried: [] }, status: () => ({ found: false }) });
  assert.equal(none.state, 'failed');
  assert.match(none.error, /not installed/);
  const g = fakeLogin();
  startLogin({ spawn: g.spawn, found: FOUND, status: signedOut });
  assert.equal(cancelLogin().state, 'cancelled');
  assert.equal(g.calls[0].child.killed, true, 'the sign-in process is stopped');
  assert.equal(loginState().state, 'cancelled');
  const h = fakeLogin();
  startLogin({ spawn: h.spawn, found: FOUND, status: signedOut, timeoutMs: 20 });
  await new Promise((res) => setTimeout(res, 80));
  assert.equal(loginState().state, 'failed');
  assert.match(loginState().error, /ten minutes/);
});

test('the route: anyone with a token can read the state; only the owner starts or cancels a sign-in', async () => {
  const seen = [];
  const fns = { start: () => { seen.push('start'); return { state: 'waiting', url: 'https://claude.ai/x' }; }, cancel: () => { seen.push('cancel'); return { state: 'cancelled' }; }, state: () => ({ state: 'idle' }) };
  await studio(async ({ call }) => {
    const g = await call('/claude', 'GET', undefined, AGENT);
    assert.equal(g.status, 200);
    assert.deepEqual([g.body.found, g.body.signedIn, g.body.login.state], [true, false, 'idle']);
    assert.equal((await call('/claude/login', 'POST', {}, AGENT)).status, 403, 'Claude does not sign itself in');
    assert.equal((await call('/claude/login', 'POST', {})).body.login.state, 'waiting');
    assert.equal((await call('/claude/login/cancel', 'POST', {})).body.login.state, 'cancelled');
    assert.deepEqual(seen, ['start', 'cancel']);
  }, { claudeStatusFn: () => ({ found: true, path: '/x/claude', signedIn: false }), claudeLoginFns: fns });
});

test('Add a brand: signed out, Read my screenshot offers Sign in; after signing in the screenshot is read by itself, with no command typed', async () => {
  const shot = join(mkdtempSync(join(tmpdir(), 'nordle-signin-')), 'kit.png');
  writeFileSync(shot, Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360f8cfc0f01f0000050001ffa5e8fd00000000049454e44ae426082', 'hex'));
  let isSigned = false, started = 0, read = 0;
  await studioPage(async ({ page, open }) => {
    await open(`#/s/month?today=${TODAY}`);
    await page.waitForSelector('.claude-bar:not(.hidden)', { timeout: 20000 });
    assert.match(await page.locator('.claude-bar').innerText(), /Claude is not signed in on this computer/);
    await page.locator('[data-act="add-brand"]').click();
    await page.fill('[data-field="wz-name"]', 'Signin Brand');
    await page.locator('[data-act="wz-next"]').click();
    await page.setInputFiles('[data-field="shot-import"] [data-field="shot-file"]', shot);
    await page.waitForSelector('[data-field="shot-import"] .shot-th img');
    await page.locator('[data-act="shot-read"]').click();
    await page.waitForSelector('[data-field="shot-import"] [data-act="claude-signin"]');
    assert.equal(read, 0, 'nothing was read while signed out');
    await page.locator('[data-field="shot-import"] [data-act="claude-signin"]').click();
    await page.waitForSelector('[data-state="signin-waiting"]');
    assert.match(await page.locator('[data-field="shot-import"] .signin').innerText(), /A browser window opened/);
    assert.equal(started, 1);
    isSigned = true;          // the owner approved in the browser
    await page.waitForSelector('[data-state="shot-read"] .bg-sw', { timeout: 30000 });
    assert.equal(read, 1, 'the screenshot was read by itself once Claude was signed in');
  }, {
    claudeStatusFn: () => ({ found: true, path: '/x/claude', signedIn: isSigned }),
    claudeLoginFns: { start: () => { started += 1; return { state: 'waiting', url: 'https://claude.ai/x' }; }, cancel: () => ({ state: 'cancelled' }), state: () => ({ state: isSigned ? 'done' : 'waiting', url: 'https://claude.ai/x' }) },
    brandReader: async () => { read += 1; return { colors: [{ name: 'Ocean', hex: '#1B6CA8' }], fonts: { heading: 'Lora' } }; },
  });
});

// ---- signing out, and switching to another account --------------------------------------------------------------------------------------------------------

test('logoutClaude runs `claude auth logout`, stops a waiting sign-in, and is done only when Claude Code says it is signed out', () => {
  const calls = [];
  let signedIn = true;
  const run = (cmd, args) => { calls.push([cmd, args]); if (args.join(' ') === 'auth logout') signedIn = false; return { status: 0 }; };
  const status = () => ({ found: true, path: FOUND.path, signedIn });
  const g = fakeLogin();
  startLogin({ spawn: g.spawn, found: FOUND, status: () => ({ found: true, signedIn: false }) });
  const r = logoutClaude({ run, found: FOUND, status });
  assert.deepEqual(r, { ok: true, signedOut: true });
  assert.deepEqual(calls, [['/x/claude', ['auth', 'logout']]]);
  assert.equal(g.calls[0].child.killed, true, 'a sign-in that was waiting is stopped');
  assert.equal(loginState().state, 'idle');
  // the program says it worked but the login is still there
  const stuck = logoutClaude({ run: () => ({ status: 0 }), found: FOUND, status: () => ({ found: true, signedIn: true }) });
  assert.equal(stuck.ok, false);
  assert.match(stuck.error, /still says it is signed in/);
  assert.match(logoutClaude({ run: () => ({ error: new Error('boom') }), found: FOUND, status }).error, /could not sign out: boom/);
  assert.match(logoutClaude({ found: { path: null }, status }).error, /not installed/);
});

test('the sign-out route: owner only, refused while Claude is working, the account email is the owner\'s to see and never Claude\'s', async () => {
  let signedIn = true, busy = false;
  const fns = { start: () => ({ state: 'waiting' }), cancel: () => ({ state: 'cancelled' }), state: () => ({ state: 'idle' }), logout: () => { signedIn = false; return { ok: true }; }, busy: () => busy };
  await studio(async ({ call }) => {
    assert.equal((await call('/claude', 'GET')).body.account, 'owner@example.test', 'the owner sees whose account it is');
    assert.equal((await call('/claude', 'GET', undefined, AGENT)).body.account, undefined, 'Claude does not');
    assert.equal((await call('/claude/logout', 'POST', {}, AGENT)).status, 403, 'Claude cannot sign itself out');
    busy = true;
    const refused = await call('/claude/logout', 'POST', {});
    assert.equal(refused.status, 409);
    assert.match(refused.body.errors[0].message, /working on something/);
    assert.equal(signedIn, true, 'nothing was signed out');
    busy = false;
    const ok = await call('/claude/logout', 'POST', {});
    assert.deepEqual([ok.status, ok.body.signedIn], [200, false]);
    assert.equal(signedIn, false);
  }, { claudeStatusFn: () => ({ found: true, path: '/x/claude', signedIn, ...(signedIn ? { account: 'owner@example.test' } : {}) }), claudeLoginFns: fns });
});

test('Claude account window: shows who is signed in, Switch account signs out and offers the sign-in, and the banner follows', async () => {
  let signedIn = true, loggedOut = 0, started = 0;
  await studioPage(async ({ page, open }) => {
    await open(`#/s/month?today=${TODAY}`);
    await page.waitForSelector('[data-act="open-claude-account"]');
    assert.equal(await page.locator('.claude-bar:not(.hidden)').count(), 0, 'signed in: no banner');
    await page.locator('[data-act="open-claude-account"]').click();
    await page.waitForSelector('[data-state="claude-signed-in"]');
    assert.equal(await page.locator('[data-field="claude-email"]').innerText(), 'owner@example.test');
    await page.locator('[data-act="claude-switch"]').click();
    await page.waitForSelector('[data-state="claude-signed-out"]');
    assert.equal(loggedOut, 1);
    assert.match(await page.locator('[data-state="claude-signed-out"]').innerText(), /Now sign in with the other account/);
    await page.waitForSelector('dialog [data-act="claude-signin"]');
    await page.waitForSelector('.claude-bar:not(.hidden)', { timeout: 15000 });
    assert.match(await page.locator('.claude-bar').innerText(), /not signed in/);
    await page.locator('dialog [data-act="claude-signin"]').click();
    await page.waitForSelector('dialog [data-state="signin-waiting"]');
    assert.equal(started, 1);
    signedIn = true;   // the owner approved with the other account in the browser
    await page.waitForSelector('dialog [data-state="claude-signed-in"]', { timeout: 30000 });
    await page.waitForSelector('.claude-bar.hidden', { state: 'attached', timeout: 15000 });
  }, {
    claudeStatusFn: () => ({ found: true, path: '/x/claude', signedIn, ...(signedIn ? { account: 'owner@example.test' } : {}) }),
    claudeLoginFns: { start: () => { started += 1; return { state: 'waiting', url: 'https://claude.ai/x' }; }, cancel: () => ({ state: 'cancelled' }), state: () => ({ state: signedIn ? 'done' : 'waiting' }), logout: () => { signedIn = false; loggedOut += 1; return { ok: true }; }, busy: () => false },
  });
});
