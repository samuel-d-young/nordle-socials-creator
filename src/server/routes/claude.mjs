// Is Claude Code ready, and can Nordle sign it in? (root scope, /api/claude)
//   GET  /api/claude                -> { found, path, how?, signedIn, message?, login:{ state:'idle'|'waiting'|'done'|'failed'|'cancelled', url?, error? } }
//   POST /api/claude/login (owner)  -> starts `claude auth login` on this computer (the browser opens; the owner approves there). -> { login }
//   POST /api/claude/login/cancel (owner)
// Nordle starts Claude Code for some jobs (reading a screenshot, writing ideas, building a post). This lets the Studio say "not signed in" before it tries, offer
// a Sign in button instead of a terminal command, and notice when it is done. `claude auth status` only reads the saved login.

import { claudeStatus } from '../../calendar/claude-bin.mjs';
import { cancelLogin, loginState, startLogin } from '../../calendar/claude-login.mjs';

export default {
  scope: 'root',
  key: 'claude',
  async handle(ctx) {
    const { seg, method, res, sendJson, need, needHuman, claudeStatusFn, claudeLoginFns } = ctx;
    const status = () => (claudeStatusFn ? claudeStatusFn() : claudeStatus());
    const fns = claudeLoginFns ?? { start: () => startLogin(), cancel: () => cancelLogin(), state: () => loginState() };
    if (!seg[1]) { need(method === 'GET', 405, 'GET only.'); return sendJson(res, 200, { ok: true, ...status(), login: fns.state() }); }
    if (seg[1] === 'login') {
      need(method === 'POST', 405, 'POST only.');
      needHuman();   // approving a sign-in on the owner's computer is the owner's
      if (seg[2] === 'cancel') return sendJson(res, 200, { ok: true, login: fns.cancel() });
      return sendJson(res, 200, { ok: true, login: fns.start() });
    }
    return false;
  },
};
