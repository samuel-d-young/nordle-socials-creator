// Has Nordle been updated on GitHub? (root scope, /api/update)
//   GET  /api/update[?force=1]           -> { enabled, current:{version,sha,dirty}, latest:{sha,message,date}, updateAvailable, behindBy, changes:[{sha,message}], dismissed, command, url, error? }
//   POST /api/update/dismiss (owner) { sha }       hide the notice for that update
//   POST /api/update/settings (owner) { enabled }  turn the check off or on
// It asks GitHub's public API at most every six hours and only reads: nothing is installed by this (src/update/check.mjs).

import { checkForUpdate, dismissUpdate, setUpdateChecks } from '../../update/check.mjs';

export default {
  scope: 'root',
  key: 'update',
  async handle(ctx) {
    const { seg, method, req, res, url, sendJson, readJsonBody, need, needHuman, updateFetch, updateStateDir } = ctx;
    const sub = seg[1];
    if (!sub) {
      need(method === 'GET', 405, 'GET only.');
      return sendJson(res, 200, { ok: true, ...(await checkForUpdate({ fetchImpl: updateFetch ?? undefined, stateDir: updateStateDir ?? undefined, force: url.searchParams.get('force') === '1' })) });
    }
    if (sub === 'dismiss') {
      need(method === 'POST', 405, 'POST only.');
      needHuman();
      const b = await readJsonBody(req);
      need(typeof b.sha === 'string' && b.sha, 400, 'Send { "sha": "..." }.');
      dismissUpdate(b.sha, { stateDir: updateStateDir ?? undefined });
      return sendJson(res, 200, { ok: true });
    }
    if (sub === 'settings') {
      need(method === 'POST', 405, 'POST only.');
      needHuman();
      const b = await readJsonBody(req);
      setUpdateChecks(b.enabled !== false, { stateDir: updateStateDir ?? undefined });
      return sendJson(res, 200, { ok: true, enabled: b.enabled !== false });
    }
    return false;
  },
};
