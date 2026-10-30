// Sign in with Buffer (OAuth + PKCE), the owner's part of it: /api/publish/oauth/buffer/... (the rest of /api/publish is routes/publish.mjs;
// this file shares its key and answers only the `oauth` branch, returning false for everything else). Every call is the OWNER's: the agent
// token gets 403, because a sign-in connects Nordle to a Buffer login and Claude must never be able to start or finish one.
//
//   GET  /api/publish/oauth/buffer/status      -> { configured, redirectUri, scopes, accounts:[{id,label,authType,expiresAt}], problem? }
//          configured: this copy of Nordle has a Buffer app client id (NORDLE_BUFFER_CLIENT_ID, settings adapters.buffer.oauth.clientId, or the constant)
//   POST /api/publish/oauth/buffer/start       { account?, label? } -> { url, state, account }     409 with plain words when there is no client id
//          url is the Buffer address to open in a new tab; state is what to wait for. The PKCE verifier stays on the server.
//   POST /api/publish/oauth/buffer/finish      { code, state, error? } -> { ok, message, account, label, authType:'oauth', expiresAt, renews, channels? }
//          trades the code for tokens, saves the account, then tests the connection the way the key flow does (lists the channels and keeps them).
//          The page that received Buffer's redirect (app/oauth-callback.html) cannot do this itself: it has no token. The Studio tab hands it over.
//   POST /api/publish/oauth/buffer/disconnect  { account } -> { ok, account }   forgets the stored tokens on this computer (revoking Nordle inside Buffer is the person's step)
// No reply, log line or error here ever contains an access token, a refresh token, a code or a verifier.

import { PublishError, clearChannelMemo, testAdapter } from '../../publish/index.mjs';
import { disconnectSignIn, exchangeCode, saveSignIn, signInStatus, startSignIn } from '../../publish/buffer-oauth.mjs';
import { loadSettings } from '../../publish/store.mjs';

export default {
  scope: 'root',
  key: 'publish',
  async handle(ctx) {
    const { seg, method, req, res, human, sendJson, readJsonBody, needHuman, need } = ctx;
    if (seg[1] !== 'oauth') return false;
    const role = human ? 'human' : 'agent';
    try {
      need(seg[2] === 'buffer', 404, 'There is no sign-in for that service. Only Buffer has one.');
      const sub = seg[3];
      if (sub === 'status') {
        need(method === 'GET', 405, 'GET only.');
        needHuman();
        return sendJson(res, 200, { ok: true, ...signInStatus(loadSettings()) });
      }
      if (sub === 'start') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        const b = await readJsonBody(req);
        const port = req.socket?.localPort;
        return sendJson(res, 200, { ok: true, ...startSignIn({ port, account: b.account, label: b.label, role }) });
      }
      if (sub === 'finish') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        const b = await readJsonBody(req);
        const got = await exchangeCode({ code: typeof b.code === 'string' ? b.code : undefined, state: typeof b.state === 'string' ? b.state : undefined, error: typeof b.error === 'string' ? b.error : undefined, role });
        const saved = saveSignIn(got, role);
        clearChannelMemo(saved.account);
        // the same check the key flow makes: can the account reach Buffer, and which channels does it see (kept for the brands)
        const test = await testAdapter('buffer', saved.account, role);
        const note = saved.renews ? undefined : 'Buffer gave Nordle no way to renew this sign-in (no refresh token), so it stops working in about an hour and you will need to sign in again. If this keeps happening, Buffer may not be accepting the "offline_access" permission.';
        return sendJson(res, 200, { ok: !!test.ok, message: test.message ?? '', ...saved, ...(note ? { note } : {}), ...(test.channels ? { channels: test.channels } : {}) });
      }
      if (sub === 'disconnect') {
        need(method === 'POST', 405, 'POST only.');
        needHuman();
        const b = await readJsonBody(req);
        need(typeof b.account === 'string' && b.account, 400, 'Say which account: {"account": "<account id>"}.');
        const r = disconnectSignIn(b.account, role);
        clearChannelMemo(b.account);
        return sendJson(res, 200, r);
      }
      return false;
    } catch (e) {
      if (e instanceof PublishError) return sendJson(res, e.status, { ok: false, errors: [{ path: '/', message: e.message }] });
      throw e;
    }
  },
};
