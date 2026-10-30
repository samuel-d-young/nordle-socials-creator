// How often and what Nordle reads from Buffer by itself (root scope, /api/buffer-pull).
//   GET  /api/buffer-pull[?project=<id>]   -> { ok, options, defaults, choices, brand?: { id, connected, pulledAt, nextAt, copied, allowanceLeft, allowanceLimit } }
//   POST /api/buffer-pull (owner) { enabled?, everyHours?, results?, handMade?, days?, maxNew?, covers? }  -> the same, after saving
// The choices are a short list each (src/publish/pull-options.mjs), so a request can never ask Buffer for something silly. Nothing here talks to Buffer:
// reading it is src/publish/auto-pull.mjs and "Update from Buffer" (routes/publish.mjs).

import { loadProject } from '../../calendar/service.mjs';
import { connected } from '../../publish/auto-pull.mjs';
import { PULL_CHOICES, PULL_DEFAULTS, cleanPullOptions, pullOptions, savePullOptions } from '../../publish/pull-options.mjs';
import { readSentPosts } from '../../publish/remote.mjs';
import { loadSettings, readAllowance, resolveSettings } from '../../publish/store.mjs';

function view(store, projectId) {
  const settings = loadSettings();
  const options = pullOptions(settings);
  const out = { ok: true, options, defaults: PULL_DEFAULTS, choices: PULL_CHOICES };
  const pr = projectId ? store.project(String(projectId)) : null;
  if (pr) {
    const s = resolveSettings(settings, 'buffer', pr.id);
    const pulledAt = readSentPosts(pr.dir).pulledAt ?? null;
    let copied = 0;
    try { copied = loadProject(pr.dir).cal.items.filter((i) => i.origin === 'buffer').length; } catch { /* a calendar that cannot be read says nothing here */ }
    const day = s.account ? readAllowance(s.account.id)?.windows?.['1day'] : null;
    out.brand = {
      id: pr.id, connected: connected(settings, pr.id), pulledAt, copied,
      nextAt: pulledAt && options.enabled ? new Date(Date.parse(pulledAt) + options.everyHours * 3600000).toISOString() : null,
      allowanceLeft: Number.isFinite(day?.left) ? day.left : null, allowanceLimit: Number.isFinite(day?.limit) ? day.limit : null,
    };
  }
  return out;
}

export default {
  scope: 'root',
  key: 'buffer-pull',
  async handle(ctx) {
    const { method, req, res, url, store, sendJson, readJsonBody, need, needHuman } = ctx;
    if (method === 'GET') return sendJson(res, 200, view(store, url.searchParams.get('project')));
    need(method === 'POST', 405, 'GET or POST only.');
    needHuman();
    const b = await readJsonBody(req);
    const { value, errors } = cleanPullOptions(b);
    if (errors.length) return sendJson(res, 422, { ok: false, errors });
    savePullOptions(value);
    return sendJson(res, 200, view(store, url.searchParams.get('project')));
  },
};
