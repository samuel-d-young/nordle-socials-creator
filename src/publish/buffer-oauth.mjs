// Sign in with Buffer: OAuth 2.0 authorization code + PKCE (a PUBLIC client: no client secret anywhere). What Buffer's developer docs
// say (read 30 Oct 2026), and what none of this has been tried against yet (see docs/PUBLISHING.md "Sign in with Buffer"):
//   * authorize  GET https://auth.buffer.com/auth  client_id, redirect_uri, response_type=code, scope (space separated), state,
//                code_challenge (base64url SHA-256 of the verifier), code_challenge_method=S256, prompt=consent
//   * token      POST https://auth.buffer.com/token  (form encoded)  authorization_code: client_id, code, redirect_uri, code_verifier
//                refresh: grant_type=refresh_token, refresh_token, client_id.  The answer has access_token (about an hour), expires_in,
//                scope, and refresh_token only when `offline_access` was asked for.
//   * REFRESH TOKENS ARE SINGLE USE: every refresh returns a new one and kills the old one; using an old one revokes the whole grant.
//     So there is exactly ONE place that refreshes (`refreshAccount`): a per-account lock inside this process, a lock file between
//     processes (the command line and the server share one settings file), and the new refresh token is written to disk (atomically)
//     before the new access token is handed to anyone.
// The redirect address must match what is registered in Buffer EXACTLY and must be https even for local use, so Buffer cannot send the
// browser straight to Nordle on 127.0.0.1. It goes to a tiny static page (site/connect/buffer.html, on GitHub Pages) that forwards the
// browser to http://127.0.0.1:<port>/app/oauth-callback.html, the port being in the `state` Nordle made. The page sees a one-time code that
// is useless without the verifier, and the verifier never leaves this process.
// Secrets here: access token, refresh token, code, verifier. None of them is returned by any route, logged, or put in a message.

import { createHash, randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { ACCOUNT_ID, DEFAULT_ACCOUNT, PublishError, changeSettings, loadSettings, publishDir, redact } from './store.mjs';

// ---- configuration: the app client, the redirect address, the scopes -------------------------------------------------------------------

/**
 * Nordle's own Buffer app client id (Buffer, Settings > API > App Clients; a PUBLIC client: PKCE, no client secret, so the id is not a secret and lives in the
 * repo). A fork registers its own app client and overrides this with NORDLE_BUFFER_CLIENT_ID or the publishing setting adapters.buffer.oauth.clientId.
 */
export const BUFFER_OAUTH_CLIENT_ID = 'doqCgiRK4o94fD7l-CQh-NRc4B0XIRCUe_rqQ9Q0zwL';
/** Registered in that app client EXACTLY like this (https, nothing added or removed). Forks override it with NORDLE_BUFFER_REDIRECT_URI or adapters.buffer.oauth.redirectUri. */
export const BUFFER_OAUTH_REDIRECT_URI = 'https://samuel-d-young.github.io/nordle-socials-creator/connect/buffer.html';
/**
 * What Nordle asks for at sign-in (Buffer's consent page lists these, so keep the list narrow). offline_access is what makes Buffer send a refresh token; Buffer's
 * app-client form has no checkbox for it, so if Buffer refuses it the message says so. To change the list without touching code: NORDLE_BUFFER_SCOPES (space
 * separated) or the publishing setting adapters.buffer.oauth.scopes (a list).
 */
export const BUFFER_OAUTH_SCOPES = ['account:read', 'posts:read', 'posts:write', 'offline_access'];
export const BUFFER_AUTH_URL = 'https://auth.buffer.com/auth';
export const BUFFER_TOKEN_URL = 'https://auth.buffer.com/token';

export const RENEW_BEFORE_MS = 2 * 60 * 1000;   // an access token this close to its end is renewed before it is used
export const PENDING_TTL_MS = 10 * 60 * 1000;   // a sign-in that was started and not finished is dropped after this
export const MAX_PENDING = 5;                   // sign-ins waiting at once (starting a sixth drops the oldest)

const CLIENT_ID_RE = /^[\x21-\x7e]{4,200}$/;
const pickText = (...values) => values.find((v) => typeof v === 'string' && v.trim())?.trim() ?? null;

const SCOPE_RE = /^[a-z][a-z_]*(:[a-z_*]+)?$/;

/**
 * { clientId (or null), redirectUri, scopes, problem? }. Order: the environment (NORDLE_BUFFER_CLIENT_ID, NORDLE_BUFFER_REDIRECT_URI, NORDLE_BUFFER_SCOPES),
 * then the publishing settings (adapters.buffer.oauth.clientId / .redirectUri / .scopes), then the constants above. `defaults` replaces the constants
 * (tests pass { clientId: null } to see Nordle as a copy with no app client id; the constant itself is never edited).
 */
export function oauthConfig(settings = loadSettings(), env = process.env, defaults = {}) {
  const own = settings?.adapters?.buffer?.oauth && typeof settings.adapters.buffer.oauth === 'object' ? settings.adapters.buffer.oauth : {};
  const dflt = { clientId: BUFFER_OAUTH_CLIENT_ID, redirectUri: BUFFER_OAUTH_REDIRECT_URI, scopes: BUFFER_OAUTH_SCOPES, ...hooks.defaults, ...defaults };
  const rawId = pickText(env.NORDLE_BUFFER_CLIENT_ID, own.clientId, dflt.clientId);
  const redirectUri = pickText(env.NORDLE_BUFFER_REDIRECT_URI, own.redirectUri, dflt.redirectUri);
  let problem = null;
  let u = null;
  try { u = new URL(redirectUri); } catch { /* reported below */ }
  if (!u || u.protocol !== 'https:' || u.username || u.password || u.hash) problem = 'The Buffer redirect address must be a full https:// address (no password, no #). Buffer only accepts https, even for local use.';
  const clientId = rawId && CLIENT_ID_RE.test(rawId) ? rawId : null;
  if (rawId && !clientId) problem = 'The Buffer app client id does not look right (one line, no spaces).';
  const asked = typeof env.NORDLE_BUFFER_SCOPES === 'string' && env.NORDLE_BUFFER_SCOPES.trim() ? env.NORDLE_BUFFER_SCOPES.trim().split(/\s+/) : Array.isArray(own.scopes) ? own.scopes : dflt.scopes;
  const scopes = [...new Set(asked)];
  const badScopes = !scopes.length || scopes.length > 12 || scopes.some((s) => typeof s !== 'string' || !SCOPE_RE.test(s));
  if (badScopes) problem = 'The Buffer scopes must be a short list of words like posts:write, separated by spaces.';
  return { clientId, redirectUri, scopes: badScopes ? [...BUFFER_OAUTH_SCOPES] : scopes, ...(problem ? { problem } : {}) };
}

// Tests inject a fake Buffer and a clock in two ways: per call (`{ fetchImpl, now }` on exchangeCode, refreshAccount, accessTokenFor), or for
// everything the adapter does through src/publish/index.mjs configure({ oauth: { fetch, now } }). `now` is a number or a function returning one.
// configure({ oauth: { defaults: { clientId: null } } }) makes the constants above read as unset (a copy of Nordle with no app client id).
let hooks = {};
export function configureOAuth(next = {}) { hooks = { ...hooks, ...next }; }
const at = (now) => (typeof now === 'function' ? now() : Number.isFinite(now) ? now : typeof hooks.now === 'function' ? hooks.now() : Number.isFinite(hooks.now) ? hooks.now : Date.now());

// ---- PKCE and state (pure) -------------------------------------------------------------------------------------------------------------

export const challengeOf = (verifier) => createHash('sha256').update(String(verifier), 'ascii').digest('base64url');
/** A fresh code verifier (32 random bytes, base64url, 43 characters) and its S256 challenge. */
export function createPkce(rand = randomBytes) {
  const verifier = rand(32).toString('base64url');
  return { verifier, challenge: challengeOf(verifier) };
}

export const STATE_RE = /^p(\d{4,5})-([0-9a-f]{32})$/;
/** `p<port>-<32 hex>`: the port tells the hosted relay page where on this computer to send the browser back to. */
export function newState(port, rand = randomBytes) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new PublishError(409, `Nordle is on port ${port}, and Buffer's sign-in can only come back to a port from 1024 to 65535. Start Nordle on another port.`);
  return `p${port}-${rand(16).toString('hex')}`;
}
/** { port, nonce } from a state Nordle made, or null for anything else. */
export function parseState(state) {
  const m = STATE_RE.exec(String(state ?? ''));
  if (!m) return null;
  const port = Number(m[1]);
  return port >= 1024 && port <= 65535 ? { port, nonce: m[2] } : null;
}

const enc = encodeURIComponent;
/** The address the person's browser is sent to on Buffer. */
export function buildAuthUrl({ clientId, redirectUri, scopes = BUFFER_OAUTH_SCOPES, state, challenge }) {
  const q = [['client_id', clientId], ['redirect_uri', redirectUri], ['response_type', 'code'], ['scope', scopes.join(' ')], ['state', state],
    ['code_challenge', challenge], ['code_challenge_method', 'S256'], ['prompt', 'consent']];
  return `${BUFFER_AUTH_URL}?${q.map(([k, v]) => `${k}=${enc(v)}`).join('&')}`;
}

// ---- sign-ins that have been started and not finished (memory only: a restart drops them, which is fine) ---------------------------------

const pending = new Map();   // state -> { verifier, accountId, label, clientId, redirectUri, createdAt }
const dropExpired = (t) => { for (const [k, v] of pending) if (t - v.createdAt > PENDING_TTL_MS) pending.delete(k); };
export function rememberPending(state, entry, t = at()) {
  dropExpired(t);
  while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);   // the oldest: an abandoned tab must not lock the person out
  pending.set(state, { ...entry, createdAt: t });
}
/** Take a pending sign-in out (single use). Returns the entry, { expired: true } or null (never started here, or already used). */
export function takePending(state, t = at()) {
  const e = pending.get(String(state ?? ''));
  if (!e) return null;
  pending.delete(String(state));
  return t - e.createdAt > PENDING_TTL_MS ? { expired: true } : e;
}
export const pendingCount = () => pending.size;
export const clearPending = () => pending.clear();   // tests

// ---- the token address -------------------------------------------------------------------------------------------------------------------

const SCOPE_REFUSED = 'Buffer refused one of the permissions Nordle asked for (invalid_scope), most likely "offline_access", which lets the sign-in renew itself. Nothing was connected. The list is BUFFER_OAUTH_SCOPES in src/publish/buffer-oauth.mjs; it can be changed there, with NORDLE_BUFFER_SCOPES, or with the publishing setting adapters.buffer.oauth.scopes.';
const SIGN_IN_AGAIN ='Your Buffer sign-in is no longer valid. Sign in with Buffer again in the publishing settings.';
const DEFINITIVE = new Set(['invalid_grant', 'invalid_token']);   // Buffer will never accept this grant again (a wrong client id is NOT in here: that is a setting, not the grant)
const cleanText = (text, secrets) => redact(text, ...secrets).replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);

/** What Buffer's error answer means, in words a person can act on. `secrets` are blanked out of anything Buffer echoed back. */
function tokenError(status, json, secrets) {
  const code = typeof json?.error === 'string' && /^[a-z_]{1,40}$/.test(json.error) ? json.error : null;
  const desc = typeof json?.error_description === 'string' ? cleanText(json.error_description, secrets) : '';
  let e;
  if (code === 'invalid_grant') e = new PublishError(401, SIGN_IN_AGAIN, { code: 'auth' });
  else if (code === 'invalid_client' || code === 'unauthorized_client') e = new PublishError(400, 'Buffer does not accept the Nordle app client id or its redirect address. Check that the client id is right and that the redirect address is registered exactly as Nordle sends it (docs/PUBLISHING.md, "Sign in with Buffer").', { code: 'oauth-client' });
  else if (code === 'access_denied') e = new PublishError(400, 'Buffer sign-in was refused, so nothing was connected.', { code: 'oauth-denied' });
  else if (code === 'invalid_scope') e = new PublishError(400, SCOPE_REFUSED, { code: 'oauth-scope' });
  else if (status >= 500) e = new PublishError(502, `Buffer's sign-in service had a problem (HTTP ${status}). Try again in a minute.`, { code: 'bad-response' });
  else e = new PublishError(400, `Buffer refused the sign-in${code ? ` (${code})` : ` (HTTP ${status})`}${desc ? `: ${desc}` : ''}.`, { code: 'oauth-refused' });
  e.oauthError = code;
  return e;
}

/** One POST to Buffer's token address. Returns the JSON answer or throws a PublishError that never contains the code, verifier or a token. */
async function tokenRequest(form, secrets, fetchImpl) {
  let res;
  try {
    res = await (fetchImpl ?? hooks.fetch ?? globalThis.fetch)(BUFFER_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new PublishError(502, 'Could not reach Buffer to finish the sign-in. Check the internet connection and try again.', { code: 'network' });
  }
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  if (res.ok && json && typeof json === 'object' && !json.error) return json;
  throw tokenError(res.status, json, secrets);
}

/** access_token, refresh_token, expires_in and scope out of an answer, checked. `t` is the time the answer arrived. */
function readTokens(json, t) {
  const access = json.access_token;
  if (typeof access !== 'string' || !/^[\x21-\x7e]{8,4096}$/.test(access)) throw new PublishError(502, 'Buffer answered the sign-in with something Nordle does not understand (no access token). Try again.', { code: 'bad-response' });
  if (json.token_type !== undefined && !/^bearer$/i.test(String(json.token_type))) throw new PublishError(502, 'Buffer answered with a kind of token Nordle does not use. Try again.', { code: 'bad-response' });
  const seconds = Number(json.expires_in);
  const refresh = typeof json.refresh_token === 'string' && /^[\x21-\x7e]{8,4096}$/.test(json.refresh_token) ? json.refresh_token : null;
  return {
    accessToken: access,
    refreshToken: refresh,
    expiresAt: new Date(t + (Number.isFinite(seconds) && seconds > 0 ? seconds : 3600) * 1000).toISOString(),
    scope: typeof json.scope === 'string' ? json.scope.slice(0, 300) : Array.isArray(json.scope) ? json.scope.join(' ').slice(0, 300) : null,
  };
}

// ---- starting and finishing a sign-in ----------------------------------------------------------------------------------------------------

const NO_CLIENT_ID = 'This copy of Nordle has no Buffer app client id yet, so "Sign in with Buffer" is not available here. Pasting a Buffer API key works instead (Buffer, Settings, API).';

/** Which account a new sign-in is saved into: the one asked for, else 'default' when there is none yet, else 'buffer', 'buffer-2', ... */
function chooseAccountId(settings, wanted) {
  if (wanted !== undefined && wanted !== null && wanted !== '') {
    const id = String(wanted);
    if (!ACCOUNT_ID.test(id)) throw new PublishError(400, `"${id}" is not an account id (lower-case letters, digits, - and _, at most 40).`);
    const existing = settings.accounts?.[id];
    if (existing && existing.adapter !== 'buffer') throw new PublishError(409, `"${id}" is an account of another adapter.`);
    return id;
  }
  const mine = Object.values(settings.accounts ?? {}).filter((a) => a?.adapter === 'buffer');
  if (!mine.length && !settings.accounts?.[DEFAULT_ACCOUNT]) return DEFAULT_ACCOUNT;
  for (let n = 1; n < 50; n++) { const id = n === 1 ? 'buffer' : `buffer-${n}`; if (!settings.accounts?.[id]) return id; }
  throw new PublishError(409, 'Too many Buffer accounts: remove one first.');
}

/**
 * Begin a sign-in (owner only). `port` is the port this server answers on. Returns { url, state, account }: the Buffer address to open, the state to
 * watch for, and the account the sign-in will be saved into. The verifier stays here.
 */
export function startSignIn({ port, account, label, role, now } = {}) {
  if (role !== 'human') throw new PublishError(403, 'Only the owner can sign in to Buffer, in the Studio.');
  const conf = oauthConfig();
  if (!conf.clientId) throw new PublishError(409, NO_CLIENT_ID, { code: 'no-client-id' });
  if (conf.problem) throw new PublishError(409, conf.problem, { code: 'bad-config' });
  const settings = loadSettings();
  const id = chooseAccountId(settings, account);
  if (label !== undefined && label !== null && (typeof label !== 'string' || !label.trim() || label.length > 60)) throw new PublishError(400, 'The account name must be short text (at most 60 characters).');
  const state = newState(port);
  const { verifier, challenge } = createPkce();
  rememberPending(state, { verifier, accountId: id, label: label?.trim() || settings.accounts?.[id]?.label || (id === DEFAULT_ACCOUNT ? 'Buffer' : id), clientId: conf.clientId, redirectUri: conf.redirectUri }, at(now));
  return { url: buildAuthUrl({ clientId: conf.clientId, redirectUri: conf.redirectUri, scopes: conf.scopes, state, challenge }), state, account: id };
}

/**
 * Trade the one-time code for tokens (owner only). The state must be one this process made, not expired, and is used up by this call whatever
 * happens next. Returns { accountId, label, accessToken, refreshToken, expiresAt, scope }: the caller saves it with saveSignIn.
 */
export async function exchangeCode({ code, state, error, role = 'human' } = {}, { fetchImpl, now } = {}) {
  if (role !== 'human') throw new PublishError(403, 'Only the owner can sign in to Buffer, in the Studio.');
  const t = at(now);
  const entry = takePending(state, t);
  if (!entry) throw new PublishError(409, 'Nordle does not recognise this sign-in: it was already used, or it was started somewhere else. Press "Sign in with Buffer" to start again.', { code: 'oauth-state' });
  if (entry.expired) throw new PublishError(410, 'That sign-in took more than 10 minutes, so it was dropped. Press "Sign in with Buffer" to start again.', { code: 'oauth-expired' });
  if (error !== undefined && error !== null && error !== '') {
    const word = typeof error === 'string' && /^[a-z_]{1,40}$/.test(error) ? error : null;
    throw new PublishError(400, word === 'access_denied' ? 'Buffer sign-in was refused, so nothing was connected.'
      : word === 'invalid_scope' ? SCOPE_REFUSED
        : `Buffer did not sign you in${word ? ` (${word})` : ''}. Nothing was connected.`, { code: word === 'invalid_scope' ? 'oauth-scope' : 'oauth-denied' });
  }
  if (typeof code !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(code)) throw new PublishError(400, 'Buffer sent back no sign-in code. Press "Sign in with Buffer" to start again.', { code: 'oauth-code' });
  const secrets = [code, entry.verifier];
  const json = await tokenRequest({ grant_type: 'authorization_code', client_id: entry.clientId, code, redirect_uri: entry.redirectUri, code_verifier: entry.verifier }, secrets, fetchImpl);
  return { accountId: entry.accountId, label: entry.label, ...readTokens(json, t) };
}

/** Save a finished sign-in as an account (atomic, mode 0600 like every settings write). The account's old key or sign-in is replaced. */
export function saveSignIn({ accountId, label, accessToken, refreshToken, expiresAt, scope }, role = 'human') {
  if (role !== 'human') throw new PublishError(403, 'Only the owner can sign in to Buffer, in the Studio.');
  changeSettings((s) => {
    const existing = s.accounts[accountId];
    if (existing && existing.adapter !== 'buffer') throw new PublishError(409, `"${accountId}" is an account of another adapter.`);
    const acc = (s.accounts[accountId] ??= { adapter: 'buffer', label: label || 'Buffer' });
    if (label) acc.label = label;
    Object.assign(acc, { token: accessToken, authType: 'oauth', expiresAt });
    if (refreshToken) acc.refreshToken = refreshToken; else delete acc.refreshToken;
    if (scope) acc.scope = scope; else delete acc.scope;
    delete acc.channelCache; delete acc.lastTestedAt; delete acc.lastTestOk;   // maybe another Buffer login: the next test lists the channels again
  });
  return { account: accountId, label, authType: 'oauth', expiresAt, renews: !!refreshToken };
}

/** Forget a Buffer sign-in on this computer (owner only). The account stays (its brands and channel names keep working once it is signed in again). */
export function disconnectSignIn(accountId, role) {
  if (role !== 'human') throw new PublishError(403, 'Only the owner can disconnect a Buffer sign-in, in the Studio.');
  changeSettings((s) => {
    const acc = s.accounts[String(accountId)];
    if (!acc || acc.adapter !== 'buffer') throw new PublishError(404, `There is no Buffer account "${accountId}".`);
    if (acc.authType !== 'oauth') throw new PublishError(409, 'That account uses an API key, not a Buffer sign-in. Use Remove to forget a key.');
    for (const k of ['token', 'refreshToken', 'expiresAt', 'scope', 'authType', 'lastTestedAt', 'lastTestOk']) delete acc[k];
  });
  return { ok: true, account: String(accountId) };
}

/** What the Studio needs to draw the button and the cards. Nothing secret. */
export function signInStatus(settings = loadSettings()) {
  const conf = oauthConfig(settings);
  return {
    configured: !!conf.clientId && !conf.problem,
    redirectUri: conf.redirectUri,
    scopes: conf.scopes,
    ...(conf.problem ? { problem: conf.problem } : {}),
    accounts: Object.entries(settings.accounts ?? {})
      .filter(([id, a]) => a?.adapter === 'buffer' && a.authType === 'oauth' && ACCOUNT_ID.test(id))
      .map(([id, a]) => ({ id, label: typeof a.label === 'string' && a.label ? a.label : id, authType: 'oauth', expiresAt: typeof a.expiresAt === 'string' ? a.expiresAt : null })),
  };
}

// ---- renewing: the ONE place that spends a refresh token -----------------------------------------------------------------------------------

const locks = new Map();   // accountId -> the end of the line of callers waiting to renew it
function inProcess(accountId, fn) {
  const run = (locks.get(accountId) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => {});
  locks.set(accountId, tail);
  tail.then(() => { if (locks.get(accountId) === tail) locks.delete(accountId); });
  return run;
}

/** Between processes (`nordle publish ...` and the server share one settings file): a lock file, given up after a minute in case a crash left it. */
async function betweenProcesses(accountId, fn) {
  const dir = publishDir();
  const file = join(dir, `oauth-refresh-${accountId}.lock`);
  const waitUntil = Date.now() + 20000;
  let held = false;
  while (!held) {
    try {
      const fd = openSync(file, 'wx');
      try { writeSync(fd, String(process.pid)); } finally { closeSync(fd); }
      held = true;
    } catch (e) {
      if (e.code === 'ENOENT') { try { mkdirSync(dir, { recursive: true }); } catch { break; } continue; }
      if (e.code !== 'EEXIST') break;   // no lock file possible here (read-only folder?): carry on with the in-process lock alone
      let age = 0;
      try { age = Date.now() - statSync(file).mtimeMs; } catch { continue; }
      if (age > 60000) { try { unlinkSync(file); } catch { /* someone else did */ } continue; }
      if (Date.now() > waitUntil) throw new PublishError(502, 'Another Nordle program is renewing the Buffer sign-in right now. Try again in a moment.', { code: 'busy' });
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  try { return await fn(); } finally { if (held) { try { unlinkSync(file); } catch { /* gone already */ } } }
}

const msLeft = (iso, t) => (typeof iso === 'string' && Number.isFinite(Date.parse(iso)) ? Date.parse(iso) - t : Infinity);
const closeToEnd = (iso, t) => msLeft(iso, t) <= RENEW_BEFORE_MS;
const viewOf = (acc, refreshed) => ({ token: acc.token, expiresAt: acc.expiresAt ?? null, refreshed });

/**
 * Give an OAuth account a good access token, renewing it if it is within two minutes of its end (or if `rejected`, the token Buffer just
 * refused, is still the one stored). Concurrent callers share one renewal: the second finds the new token already saved and uses it.
 * Returns { token, expiresAt, refreshed }. Throws a PublishError with code 'auth' when the person has to sign in again.
 */
export async function refreshAccount(accountId, { rejected = null, fetchImpl, now } = {}) {
  return inProcess(accountId, () => betweenProcesses(accountId, async () => {
    const t = at(now);
    const acc = loadSettings().accounts?.[accountId];   // read again inside the lock: someone may have renewed while this one waited
    if (!acc || acc.adapter !== 'buffer' || acc.authType !== 'oauth') throw new PublishError(400, 'That account does not use a Buffer sign-in.');
    if (!acc.token && !acc.refreshToken) throw new PublishError(401, SIGN_IN_AGAIN, { code: 'auth' });
    if (acc.token && acc.token !== rejected && !closeToEnd(acc.expiresAt, t)) return viewOf(acc, false);
    if (!acc.refreshToken) {
      if (acc.token && acc.token !== rejected && msLeft(acc.expiresAt, t) > 0) return viewOf(acc, false);   // no way to renew, but it still works for now
      throw new PublishError(401, 'Your Buffer sign-in has run out and cannot renew itself. Sign in with Buffer again in the publishing settings.', { code: 'auth' });
    }
    const conf = oauthConfig();
    if (!conf.clientId) throw new PublishError(409, NO_CLIENT_ID, { code: 'no-client-id' });
    const spent = acc.refreshToken;
    let json;
    try {
      json = await tokenRequest({ grant_type: 'refresh_token', refresh_token: spent, client_id: conf.clientId }, [spent, acc.token], fetchImpl);
    } catch (e) {
      if (e instanceof PublishError && DEFINITIVE.has(e.oauthError)) {
        // Buffer will never accept this grant again: forget it, so nothing keeps trying (a second try with a used token only digs deeper)
        changeSettings((s) => { const a = s.accounts[accountId]; if (a && a.refreshToken === spent) { delete a.refreshToken; delete a.token; a.lastTestOk = false; } });
        throw new PublishError(401, SIGN_IN_AGAIN, { code: 'auth' });
      }
      throw e;
    }
    const tk = readTokens(json, t);
    // write the new refresh token FIRST (the old one is dead), in one atomic save together with the access token; only then hand the access token out
    changeSettings((s) => {
      const a = s.accounts[accountId];
      if (!a) throw new PublishError(404, 'That Buffer account was removed while its sign-in was being renewed.');
      a.token = tk.accessToken;
      a.expiresAt = tk.expiresAt;
      if (tk.refreshToken) a.refreshToken = tk.refreshToken; else delete a.refreshToken;   // Buffer sent no new one: the old one is spent, never use it again
      if (tk.scope) a.scope = tk.scope;
    });
    return { token: tk.accessToken, expiresAt: tk.expiresAt, refreshed: true };
  }));
}

/** A good access token for an OAuth account: the stored one when it has more than two minutes left, else a renewed one. */
export async function accessTokenFor(accountId, { rejected = null, fetchImpl, now } = {}) {
  const acc = loadSettings().accounts?.[accountId];
  if (acc?.authType === 'oauth' && acc.token && acc.token !== rejected && !closeToEnd(acc.expiresAt, at(now))) return viewOf(acc, false);
  return refreshAccount(accountId, { rejected, fetchImpl, now });
}
