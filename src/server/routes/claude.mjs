// Is Claude Code ready, and can Nordle sign it in? (root scope, /api/claude)
//   GET  /api/claude                -> { found, path, how?, signedIn, message?, login:{ state:'idle'|'waiting'|'done'|'failed'|'cancelled', url?, error? } }
//   POST /api/claude/login (owner)  -> starts `claude auth login` on this computer (the browser opens; the owner approves there). -> { login }
//   POST /api/claude/login/cancel (owner)
// Nordle starts Claude Code for some jobs (reading a screenshot, writing ideas, building a post). This lets the Studio say "not signed in" before it tries, offer
// a Sign in button instead of a terminal command, and notice when it is done. `claude auth status` only reads the saved login.

import { claudeStatus } from '../../calendar/claude-bin.mjs';
import { cancelLogin, loginState, logoutClaude, startLogin } from '../../calendar/claude-login.mjs';
import { anyJobRunning } from '../../calendar/jobs.mjs';

export default {
  scope: 'root',
  key: 'claude',
  async handle(ctx) {
    const { seg, method, res, sendJson, need, needHuman, human, HttpError, claudeStatusFn, claudeLoginFns } = ctx;
    const status = () => (claudeStatusFn ? claudeStatusFn() : claudeStatus());
    const fns = claudeLoginFns ?? { start: () => startLogin(), cancel: () => cancelLogin(), state: () => loginState(), logout: () => logoutClaude() };
    if (!seg[1]) {
      need(method === 'GET', 405, 'GET only.');
      const { account, ...rest } = status();   // whose account it is is the owner's to see, not Claude's
      return sendJson(res, 200, { ok: true, ...rest, ...(human && account ? { account } : {}), login: fns.state() });
    }
    if (seg[1] === 'logout') {
      need(method === 'POST', 405, 'POST only.');
      needHuman();
      if ((fns.busy ?? anyJobRunning)()) throw new HttpError(409, 'Claude is working on something right now. Wait for it to finish, then sign out.');
      const r = fns.logout?.() ?? { ok: false, error: 'Signing out is not available here.' };
      return sendJson(res, r.ok ? 200 : 502, { ok: r.ok, ...(r.ok ? {} : { errors: [{ path: '/', message: r.error }] }), ...status(), login: fns.state() });
    }
    if (seg[1] === 'login') {
      need(method === 'POST', 405, 'POST only.');
      needHuman();   // approving a sign-in on the owner's computer is the owner's
      if (seg[2] === 'cancel') return sendJson(res, 200, { ok: true, login: fns.cancel() });
      return sendJson(res, 200, { ok: true, login: fns.start() });
    }
    return false;
  },
};
