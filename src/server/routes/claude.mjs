// Is Claude Code ready? (root scope, GET /api/claude) -> { found, path, signedIn, how?, account?, message? }
// Nordle starts Claude Code for some jobs (reading a screenshot, writing ideas, building a post). This lets the Studio say "not signed in" before it tries,
// and which copy of Claude Code it would use. It runs `claude auth status`, which only reads the saved login.

import { claudeStatus } from '../../calendar/claude-bin.mjs';

export default {
  scope: 'root',
  key: 'claude',
  async handle(ctx) {
    const { method, res, sendJson, need, claudeStatusFn } = ctx;
    need(method === 'GET', 405, 'GET only.');
    return sendJson(res, 200, { ok: true, ...(claudeStatusFn ? claudeStatusFn() : claudeStatus()) });
  },
};
