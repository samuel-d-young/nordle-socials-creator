// "Has Nordle been updated on GitHub?" Nordle is installed by cloning the repository, so an update is new commits on its main branch. This asks GitHub's public API,
// at most once every six hours, for the latest commit on main and, when this copy is a git checkout, for what changed since the one you have. The only thing sent is
// the request itself (no names, no files, no identifiers). It can be switched off (NORDLE_NO_UPDATE_CHECK=1, or Studio > the update notice > Turn off). Nothing is
// ever installed by this: it tells you, and gives you the two commands to run.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = 'samuel-d-young/nordle-socials-creator';
export const REPO_URL = `https://github.com/${REPO}`;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SIX_HOURS = 6 * 3600 * 1000;

const readJson = (file, fallback) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
function writeJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}
export const stateFile = (dir = join(ROOT, '.nordle')) => join(dir, 'update.json');

/** The copy of Nordle on this computer: its version, and the commit it is on when it is a git checkout. */
export function localInfo(root = ROOT, run = spawnSync) {
  const version = readJson(join(root, 'package.json'), {}).version ?? null;
  let sha = null, dirty = false;
  if (existsSync(join(root, '.git'))) {
    const r = run('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 8000 });
    if (r.status === 0) sha = String(r.stdout).trim() || null;
    const s = run('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 8000 });
    dirty = s.status === 0 && String(s.stdout).trim().length > 0;
  }
  return { version, sha, dirty, root };
}

async function getJson(url, fetchImpl, timeoutMs = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ac.signal, headers: { accept: 'application/vnd.github+json', 'user-agent': 'Nordle update check' } });
    if (!res.ok) throw new Error(res.status === 403 || res.status === 429 ? 'GitHub asked for a pause (too many requests). It will try again later.' : `GitHub answered ${res.status}.`);
    return await res.json();
  } finally { clearTimeout(t); }
}
const firstLine = (s) => String(s ?? '').split('\n')[0].trim().slice(0, 140);

/**
 * @param {{ root?: string, stateDir?: string, fetchImpl?: Function, now?: number, force?: boolean, local?: object }} [o]
 */
export async function checkForUpdate({ root = ROOT, stateDir, fetchImpl = globalThis.fetch, now = Date.now(), force = false, local } = {}) {
  const file = stateFile(stateDir ?? join(root, '.nordle'));
  const state = readJson(file, {});
  const cur = local ?? localInfo(root);
  const base = { repo: REPO, url: REPO_URL, current: { version: cur.version, sha: cur.sha, dirty: cur.dirty }, command: `cd "${root}" && git pull && node setup.mjs` };
  if (process.env.NORDLE_NO_UPDATE_CHECK === '1' || state.disabled) return { ...base, enabled: false, updateAvailable: false, changes: [] };
  const fresh = state.checkedAt && now - state.checkedAt < SIX_HOURS && state.forSha === (cur.sha ?? null);
  if (fresh && !force && state.result) return { ...base, ...state.result, enabled: true, dismissed: state.dismissed === state.result.latest?.sha, cached: true };
  let result;
  try {
    const head = await getJson(`https://api.github.com/repos/${REPO}/commits/main`, fetchImpl);
    const latest = { sha: head.sha, message: firstLine(head.commit?.message), date: head.commit?.committer?.date ?? head.commit?.author?.date ?? null };
    result = { latest, updateAvailable: false, behindBy: 0, changes: [] };
    if (cur.sha && head.sha === cur.sha) { /* up to date */ } else if (cur.sha) {
      const cmp = await getJson(`https://api.github.com/repos/${REPO}/compare/${cur.sha}...${head.sha}`, fetchImpl);
      // "ahead" from the local commit to main means main has commits you do not have: that is an update. "behind" or "diverged" means this copy has its own work.
      if (cmp.status === 'ahead') {
        result.updateAvailable = true; result.behindBy = cmp.ahead_by ?? cmp.commits?.length ?? 0;
        result.changes = (cmp.commits ?? []).slice(-15).reverse().map((c) => ({ sha: c.sha.slice(0, 7), message: firstLine(c.commit?.message) }));
      } else if (cmp.status === 'identical') { /* nothing to do */ } else result.note = 'This copy has changes of its own, so Nordle cannot say whether it is behind.';
    } else {
      // not a git checkout (a downloaded zip): compare the version in package.json on GitHub with this one
      const pkg = await getJson(`https://raw.githubusercontent.com/${REPO}/main/package.json`, async (u, o) => fetchImpl(u, { ...o, headers: { 'user-agent': 'Nordle update check' } })).catch(() => null);
      if (pkg?.version && cur.version && pkg.version !== cur.version) { result.updateAvailable = true; result.changes = [{ sha: head.sha.slice(0, 7), message: `Version ${pkg.version} is out (you have ${cur.version}). ${result.latest.message}` }]; }
    }
  } catch (e) {
    return { ...base, enabled: true, updateAvailable: false, changes: [], error: e.name === 'AbortError' ? 'GitHub did not answer in time.' : e.message, ...(state.result ? { latest: state.result.latest } : {}) };
  }
  writeJson(file, { ...state, checkedAt: now, forSha: cur.sha ?? null, result });
  return { ...base, ...result, enabled: true, dismissed: state.dismissed === result.latest.sha };
}

/** Hide the notice for this update (a newer one shows again). */
export function dismissUpdate(sha, { root = ROOT, stateDir } = {}) {
  const file = stateFile(stateDir ?? join(root, '.nordle'));
  writeJson(file, { ...readJson(file, {}), dismissed: String(sha).slice(0, 40) });
}
/** Turn the check off or on. */
export function setUpdateChecks(enabled, { root = ROOT, stateDir } = {}) {
  const file = stateFile(stateDir ?? join(root, '.nordle'));
  const s = readJson(file, {});
  if (enabled) delete s.disabled; else s.disabled = true;
  writeJson(file, s);
}
