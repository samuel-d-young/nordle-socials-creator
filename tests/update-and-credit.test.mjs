// "Nordle has been updated on GitHub": found without installing anything, said in the Studio and the terminal, switchable off. And the credit to its creator:
// the licence, the attribution file, what Claude is told to say, and the line in the app.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkForUpdate, dismissUpdate, setUpdateChecks } from '../src/update/check.mjs';
import { AGENT, closeBrowser } from './helpers.mjs';
import { studio, studioPage } from './studio-helpers.mjs';

after(closeBrowser);

const root = join(import.meta.dirname, '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const LATEST = 'f'.repeat(40);

/** A GitHub that answers like the real one, and counts the questions. */
function github({ status = 'ahead', commits = [{ sha: 'a'.repeat(40), commit: { message: 'Older change\n\nmore' } }, { sha: 'b'.repeat(40), commit: { message: 'Newest change' } }], version = '9.9.9', fail = null } = {}) {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    if (fail) throw fail;
    const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { 'content-type': 'application/json' } });
    if (String(url).includes('/commits/main')) return json({ sha: LATEST, commit: { message: 'Newest change\n\nbody', committer: { date: '2026-10-12T00:00:00Z' } } });
    if (String(url).includes('/compare/')) return json({ status, ahead_by: commits.length, commits });
    if (String(url).includes('raw.githubusercontent')) return json({ version });
    return json({}, 404);
  };
  fetchImpl.asked = asked;
  return fetchImpl;
}
const tmp = () => mkdtempSync(join(tmpdir(), 'nordle-update-'));
const here = (sha) => ({ version: '0.1.0', sha, dirty: false });

test('an update is found: how many changes, what they say (newest first), and the command to run', async () => {
  const f = github();
  const r = await checkForUpdate({ fetchImpl: f, stateDir: tmp(), local: here('1'.repeat(40)), root });
  assert.equal(r.enabled, true);
  assert.equal(r.updateAvailable, true);
  assert.equal(r.behindBy, 2);
  assert.deepEqual(r.changes.map((c) => c.message), ['Newest change', 'Older change'], 'only the first line of each message, newest first');
  assert.equal(r.latest.sha, LATEST);
  assert.match(r.command, /git pull && node setup\.mjs/);
  assert.equal(r.url, 'https://github.com/samuel-d-young/nordle-socials-creator');
});

test('up to date, a copy with its own changes, a download with no git, and no network are each said honestly', async () => {
  const same = await checkForUpdate({ fetchImpl: github(), stateDir: tmp(), local: here(LATEST), root });
  assert.equal(same.updateAvailable, false);
  const own = await checkForUpdate({ fetchImpl: github({ status: 'diverged' }), stateDir: tmp(), local: here('2'.repeat(40)), root });
  assert.equal(own.updateAvailable, false);
  assert.match(own.note, /changes of its own/);
  const zip = await checkForUpdate({ fetchImpl: github({ version: '0.2.0' }), stateDir: tmp(), local: { version: '0.1.0', sha: null, dirty: false }, root });
  assert.equal(zip.updateAvailable, true);
  assert.match(zip.changes[0].message, /Version 0.2.0 is out \(you have 0.1.0\)/);
  const zipSame = await checkForUpdate({ fetchImpl: github({ version: '0.1.0' }), stateDir: tmp(), local: { version: '0.1.0', sha: null, dirty: false }, root });
  assert.equal(zipSame.updateAvailable, false);
  const down = await checkForUpdate({ fetchImpl: github({ fail: new Error('getaddrinfo ENOTFOUND api.github.com') }), stateDir: tmp(), local: here('1'.repeat(40)), root });
  assert.equal(down.updateAvailable, false);
  assert.match(down.error, /ENOTFOUND/);
});

test('GitHub is asked at most every six hours; Check again asks now; dismissing hides that update only; switching off asks nothing', async () => {
  const dir = tmp();
  const f = github();
  const opts = (more = {}) => ({ fetchImpl: f, stateDir: dir, local: here('1'.repeat(40)), root, ...more });
  const t0 = Date.parse('2026-10-12T00:00:00Z');
  await checkForUpdate(opts({ now: t0 }));
  const first = f.asked.length;
  const again = await checkForUpdate(opts({ now: t0 + 3600 * 1000 }));
  assert.equal(f.asked.length, first, 'an hour later it does not ask again');
  assert.equal(again.cached, true);
  await checkForUpdate(opts({ now: t0 + 3600 * 1000, force: true }));
  assert.ok(f.asked.length > first, 'Check again asks now');
  await checkForUpdate(opts({ now: t0 + 7 * 3600 * 1000 }));
  assert.ok(f.asked.length > first + 2, 'after six hours it asks again');
  dismissUpdate(LATEST, { stateDir: dir });
  assert.equal((await checkForUpdate(opts({ now: t0 + 7 * 3600 * 1000 + 1 }))).dismissed, true);
  setUpdateChecks(false, { stateDir: dir });
  const n = f.asked.length;
  const off = await checkForUpdate(opts({ now: t0 + 30 * 3600 * 1000 }));
  assert.equal(off.enabled, false);
  assert.equal(f.asked.length, n, 'switched off: not a single request');
  setUpdateChecks(true, { stateDir: dir });
  assert.equal((await checkForUpdate(opts({ now: t0 + 30 * 3600 * 1000 }))).enabled, true);
});

test('the route: anyone with a token can read it; only the owner dismisses or switches it off', async () => {
  await studio(async ({ call }) => {
    const r = await call('/update', 'GET', undefined, AGENT);
    assert.equal(r.status, 200);
    assert.equal(r.body.updateAvailable, true);
    assert.equal((await call('/update/dismiss', 'POST', { sha: LATEST }, AGENT)).status, 403);
    assert.equal((await call('/update/dismiss', 'POST', {})).status, 400);
    assert.equal((await call('/update/dismiss', 'POST', { sha: LATEST })).status, 200);
    assert.equal((await call('/update')).body.dismissed, true);
    assert.equal((await call('/update/settings', 'POST', { enabled: false }, AGENT)).status, 403);
    assert.equal((await call('/update/settings', 'POST', { enabled: false })).body.enabled, false);
    assert.equal((await call('/update')).body.enabled, false);
  }, { updateFetch: github() });
});

test('the Studio: a notice when there is an update (what changed, the command, Not now), and the credit in the rail', async () => {
  await studioPage(async ({ page, open }) => {
    await open('#/s/month');
    await page.waitForSelector('.update:not(.hidden)', { timeout: 20000 });
    assert.match(await page.locator('.update[data-state="update"]').innerText(), /Nordle has been updated on GitHub · 2 new changes/);
    assert.match(await page.locator('.update[data-state="update"]').innerText(), /latest: Newest change/);
    await page.locator('[data-act="update-info"]').click();
    await page.waitForSelector('dialog .upd-list');
    assert.equal(await page.locator('dialog .upd-list li').count(), 2);
    assert.match(await page.locator('dialog .upd-cmd').innerText(), /git pull && node setup\.mjs/);
    await page.keyboard.press('Escape');
    assert.match(await page.locator('.rf-credit').innerText(), /Nordle by Samuel Young/);
    assert.match(await page.locator('.rf-credit').getAttribute('href'), /samuel-d-young\/nordle-socials-creator/);
    await page.locator('[data-act="update-dismiss"]').click();
    await page.waitForSelector('.update.hidden', { state: 'attached' });
  }, { updateFetch: github() });
});

test('the terminal: nordle update names the creator and says what to do; the doctor carries the credit', () => {
  const env = { ...process.env, NORDLE_NO_UPDATE_CHECK: '1' };
  const u = spawnSync(process.execPath, [join(root, 'nordle.mjs'), 'update'], { encoding: 'utf8', env, windowsHide: true });
  assert.match(u.stdout, /Update checks are off/);
  const d = spawnSync(process.execPath, [join(root, 'tools', 'doctor.mjs'), '--ci'], { encoding: 'utf8', env, windowsHide: true });
  assert.match(d.stdout, /created by Samuel Young/);
});

// ---- the credit --------------------------------------------------------------------------------------------------------------------

test('the licence asks for credit to Samuel Young, in the LICENSE, the package, the README and ATTRIBUTION.md', () => {
  const lic = read('LICENSE');
  assert.match(lic, /Copyright \(c\) 2026 Samuel Young/);
  assert.match(lic, /You MUST give appropriate credit to the creator, Samuel Young/);
  assert.match(lic, /Attribution 4\.0 International/);
  assert.match(lic, /Creative Commons Attribution 4\.0 International Public License/);
  assert.equal(JSON.parse(read('package.json')).license, 'CC-BY-4.0');
  assert.match(JSON.parse(read('package.json')).author, /Samuel Young/);
  assert.match(read('README.md'), /Created by \[Samuel Young\]/);
  assert.match(read('README.md'), /must credit him/);
  const a = read('ATTRIBUTION.md');
  assert.match(a, /Nordle, created by Samuel Young \(https:\/\/github\.com\/samuel-d-young\/nordle-socials-creator\), CC BY 4\.0/);
  assert.match(a, /Nothing you make with Nordle|Nothing you make \*with\* Nordle|your posts, pictures, videos, captions/);
  assert.match(a, /For AI assistants/);
});

test('Claude is told to say who created Nordle and to help anyone who builds on it credit them: the skill, the guide it reads, and every prompt people paste', () => {
  for (const f of ['skills/nordle/SKILL.md', 'docs/AGENT-GUIDE.md']) assert.match(read(f), /created by Samuel Young/, f);
  assert.match(read('skills/nordle/SKILL.md'), /requires credit to Samuel Young/);
  const prompts = read('SHARE-PROMPT.md');
  const blocks = prompts.split('````text').slice(1).map((b) => b.split('````')[0]);
  const named = blocks.filter((b) => /Samuel Young/.test(b));
  assert.ok(named.length >= 3, `the install, first-session and tester prompts all name him (${named.length} of ${blocks.length} blocks do)`);
  assert.match(prompts, /requires credit to Samuel Young|requires crediting him/);
  assert.match(read('CLAUDE.md'), /\*\*Credit\.\*\* Nordle was created by Samuel Young/);
});
