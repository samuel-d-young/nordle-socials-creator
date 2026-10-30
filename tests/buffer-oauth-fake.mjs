// A FAKE Buffer for the sign-in tests: the authorize step (what the person approves), the token address (auth.buffer.com/token) and the GraphQL
// API (api.buffer.com), all in-process. Nothing here ever touches the network: a request to any other address throws, so a test that reaches
// for the real Buffer fails loudly. It enforces what the real service is documented to: PKCE (the verifier must hash to the challenge), a code
// that works once, an exact redirect address, no client secret from a public client, and REFRESH TOKENS THAT ARE SINGLE USE (reusing a spent one
// revokes the whole grant, so a double refresh in Nordle shows up as a failure here).
import { createHash } from 'node:crypto';

const sha256 = (s) => createHash('sha256').update(String(s), 'ascii').digest('base64url');

export function fakeBuffer({ now = () => Date.now() } = {}) {
  const s = {
    tokenRequests: [],            // { method, url, contentType, body } for every call to the token address
    apiRequests: [],              // { bearer, status, onDisk } for every call to the API
    codes: new Map(),             // code -> { challenge, redirectUri, clientId, scope }
    access: new Map(),            // access token -> { grant, expiresAt, dead }
    refresh: new Map(),           // refresh token -> { grant, used }
    revoked: new Set(),           // grants
    issued: [],                   // every secret ever handed out (tests look for these where they must not be)
    verifiers: [],                // every code_verifier / code seen at the token address
    n: 0, expiresIn: 3600, omitRefresh: false, failToken: null, networkDown: false, tokenDelayMs: 0, deadOnArrival: false,
    onApi: null,                  // () => anything: read at the moment an API request arrives (tests look at the settings file here)
    creates: [], posts: [],
    orgName: 'Test Org',
    channels: [
      { id: 'ch_ig', name: 'Gannet IG', service: 'instagram', isDisconnected: false, isLocked: false },
      { id: 'ch_fb', name: 'Gannet FB', service: 'facebook', isDisconnected: false, isLocked: false },
    ],
  };
  const json = (status, obj, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

  /** What Buffer's consent page would do when the person presses "Allow": check the address, make a code, give back where to go. */
  s.authorize = (address, { clientId, redirectUri, scope } = {}) => {
    const u = new URL(address);
    if (u.origin + u.pathname !== 'https://auth.buffer.com/auth') throw new Error(`not Buffer's authorize address: ${u.origin}${u.pathname}`);
    const p = Object.fromEntries(u.searchParams);
    if (p.response_type !== 'code' || p.code_challenge_method !== 'S256' || p.prompt !== 'consent' || !p.code_challenge || !p.state) throw new Error(`authorize address is missing something: ${Object.keys(p)}`);
    if (clientId && p.client_id !== clientId) throw new Error('wrong client id');
    if (redirectUri && p.redirect_uri !== redirectUri) throw new Error('redirect address does not match the registered one exactly');
    if (scope && p.scope !== scope) throw new Error(`unexpected scope ${p.scope}`);
    const code = `CODE-${++s.n}-${Math.random().toString(36).slice(2, 10)}`;
    s.codes.set(code, { challenge: p.code_challenge, redirectUri: p.redirect_uri, clientId: p.client_id, scope: p.scope });
    s.issued.push(code);
    return { code, state: p.state, redirectUri: p.redirect_uri, params: p };
  };

  const issue = (grant, scope) => {
    const tag = `${++s.n}-${Math.random().toString(36).slice(2, 10)}`;
    const access = `ACCESSTOKEN-${tag}`, refresh = `REFRESHTOKEN-${tag}`;
    s.access.set(access, { grant, expiresAt: now() + s.expiresIn * 1000, dead: s.deadOnArrival });
    s.issued.push(access);
    const out = { access_token: access, token_type: 'Bearer', expires_in: s.expiresIn, scope: scope ?? 'account:read posts:read posts:write offline_access' };
    if (!s.omitRefresh) { s.refresh.set(refresh, { grant, used: false }); s.issued.push(refresh); out.refresh_token = refresh; }
    return out;
  };

  const token = async (url, init) => {
    if (s.networkDown) throw new TypeError('fetch failed');
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const body = Object.fromEntries(new URLSearchParams(String(init.body ?? '')));
    s.tokenRequests.push({ method: init.method, url: String(url), contentType: headers['content-type'], body });
    for (const k of ['code_verifier', 'code', 'refresh_token']) if (body[k]) s.verifiers.push(body[k]);
    if (s.tokenDelayMs) await new Promise((r) => setTimeout(r, s.tokenDelayMs));
    if (s.failToken) return json(s.failToken.status, s.failToken.body);
    const bad = (error, error_description) => json(400, { error, error_description });
    if ('client_secret' in body) return bad('invalid_request', 'a public client sends no client_secret');
    if (body.grant_type === 'authorization_code') {
      const c = s.codes.get(body.code);
      s.codes.delete(body.code);   // a code works once
      if (!c) return bad('invalid_grant', 'code is unknown or used');
      if (c.clientId !== body.client_id || c.redirectUri !== body.redirect_uri) return bad('invalid_grant', 'client id or redirect address differs');
      if (sha256(body.code_verifier) !== c.challenge) return bad('invalid_grant', 'PKCE verifier does not match');
      return json(200, issue(++s.n, c.scope));
    }
    if (body.grant_type === 'refresh_token') {
      if (!body.client_id) return bad('invalid_request', 'client_id is required');
      const r = s.refresh.get(body.refresh_token);
      if (!r) return bad('invalid_grant', 'refresh token is unknown');
      if (r.used || s.revoked.has(r.grant)) {   // single use: a second use kills everything the grant ever issued
        s.revoked.add(r.grant);
        return bad('invalid_grant', 'refresh token was already used');
      }
      r.used = true;
      return json(200, issue(r.grant));
    }
    return bad('unsupported_grant_type');
  };

  const api = async (url, init) => {
    const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const bearer = String(headers.authorization ?? '').replace(/^Bearer /, '');
    const t = s.access.get(bearer);
    const good = !!t && !t.dead && !s.revoked.has(t.grant) && now() < t.expiresAt;
    const rec = { bearer, status: good ? 200 : 401, onDisk: s.onApi ? s.onApi() : null };
    s.apiRequests.push(rec);
    if (!good) return json(401, { errors: [{ message: 'token expired or revoked', extensions: { code: 'UNAUTHORIZED' } }] });
    const q = JSON.parse(String(init.body || '{}'));
    if (/GetOrganizations/.test(q.query)) return json(200, { data: { account: { organizations: [{ id: 'org_1', name: s.orgName }] } } });
    if (/GetChannels/.test(q.query)) return json(200, { data: { channels: s.channels } });
    if (/createPost/.test(q.query)) {
      s.creates.push({ bearer, input: q.variables.input });
      return json(200, { data: { createPost: { __typename: 'PostActionSuccess', post: { id: `post_${s.creates.length}`, dueAt: q.variables.input.dueAt } } } });
    }
    return json(400, { errors: [{ message: 'unknown query' }] });
  };

  s.fetch = async (url, init = {}) => {
    const u = new URL(url);
    if (u.origin === 'https://auth.buffer.com' && u.pathname === '/token') return token(url, init);
    if (u.origin === 'https://api.buffer.com') return api(url, init);
    if (u.host === 'media.fake.test') return new Response(null, { status: 200, headers: { 'content-type': 'image/png' } });
    throw new Error(`the fake Buffer was asked for ${u.origin}${u.pathname}: nothing else may be reached from a test`);
  };

  s.refreshRequests = () => s.tokenRequests.filter((r) => r.body.grant_type === 'refresh_token');
  s.expireAccess = (tok) => { const t = s.access.get(tok); if (t) t.dead = true; };
  s.reset = () => { s.tokenRequests.length = 0; s.apiRequests.length = 0; s.codes.clear(); s.access.clear(); s.refresh.clear(); s.revoked.clear(); s.issued.length = 0; s.verifiers.length = 0; s.creates.length = 0; Object.assign(s, { expiresIn: 3600, omitRefresh: false, failToken: null, networkDown: false, tokenDelayMs: 0, deadOnArrival: false, onApi: null }); };
  return s;
}
