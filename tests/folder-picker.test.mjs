// "Choose…" beside a folder path: the system's folder window is opened by the server. Nothing here opens a real window: the program that
// would show it is replaced by a fake, on each operating system's branch.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PickerError, pickFolder, tidyPath } from '../src/server/folder-picker.mjs';
import { AGENT, closeBrowser } from './helpers.mjs';
import { studio, studioPage, TODAY } from './studio-helpers.mjs';

after(closeBrowser);

const fake = (r) => { const seen = []; const run = async (cmd, args) => { seen.push([cmd, args]); return { code: 0, stdout: '', stderr: '', missing: false, ...(typeof r === 'function' ? r(cmd, args) : r) }; }; run.seen = seen; return run; };

test('tidyPath: one line, no trailing slash, but a drive or the root stays whole', () => {
  assert.equal(tidyPath('/Users/me/Brand/\n'), '/Users/me/Brand');
  assert.equal(tidyPath('D:\\Brand\\Logos\\\r\n'), 'D:\\Brand\\Logos');
  assert.equal(tidyPath('C:\\'), 'C:\\');
  assert.equal(tidyPath('/'), '/');
  assert.equal(tidyPath(''), '');
});

test('Windows: PowerShell shows the dialog, the chosen path comes back, closing the window is a cancel, no PowerShell is a plain error', async () => {
  const ok = fake({ stdout: 'D:\\Brand\\Logos' });
  assert.deepEqual(await pickFolder({ platform: 'win32', run: ok, title: "It's a title" }), { path: 'D:\\Brand\\Logos' });
  const [cmd, args] = ok.seen[0];
  assert.equal(cmd, 'powershell.exe');
  assert.ok(args.includes('-STA'));
  assert.match(args.at(-1), /FolderBrowserDialog/);
  assert.match(args.at(-1), /'It''s a title'/, 'a quote in the title is escaped');
  assert.deepEqual(await pickFolder({ platform: 'win32', run: fake({ stdout: '' }) }), { cancelled: true });
  await assert.rejects(pickFolder({ platform: 'win32', run: fake({ missing: true }) }), PickerError);
  await assert.rejects(pickFolder({ platform: 'win32', run: fake({ code: 1, stderr: 'boom' }) }), /could not be opened/);
});

test('macOS: osascript, the trailing slash is dropped, Cancel (error -128) is a cancel', async () => {
  const ok = fake({ stdout: '/Users/me/Brand Photos/\n' });
  assert.deepEqual(await pickFolder({ platform: 'darwin', run: ok }), { path: '/Users/me/Brand Photos' });
  assert.equal(ok.seen[0][0], 'osascript');
  assert.ok(ok.seen[0][1].some((a) => /choose folder/.test(a)));
  assert.deepEqual(await pickFolder({ platform: 'darwin', run: fake({ code: 1, stderr: 'execution error: User canceled. (-128)' }) }), { cancelled: true });
  await assert.rejects(pickFolder({ platform: 'darwin', run: fake({ missing: true }) }), PickerError);
});

test('Linux: zenity first, then kdialog, and a clear error when neither is installed', async () => {
  assert.deepEqual(await pickFolder({ platform: 'linux', run: fake((cmd) => (cmd === 'zenity' ? { stdout: '/home/me/brand\n' } : {})) }), { path: '/home/me/brand' });
  const k = fake((cmd) => (cmd === 'zenity' ? { missing: true } : { stdout: '/home/me/k\n' }));
  assert.deepEqual(await pickFolder({ platform: 'linux', run: k }), { path: '/home/me/k' });
  assert.deepEqual(k.seen.map((s) => s[0]), ['zenity', 'kdialog']);
  assert.deepEqual(await pickFolder({ platform: 'linux', run: fake({ code: 1 }) }), { cancelled: true });
  await assert.rejects(pickFolder({ platform: 'linux', run: fake({ missing: true }) }), /zenity or kdialog/);
});

test('the route: only the owner may open it; a folder, a cancel and "no window here" are each answered plainly', async () => {
  const answers = [{ path: '/tmp/brand' }, { cancelled: true }, new PickerError('No window here.')];
  const titles = [];
  await studio(async ({ call }) => {
    assert.equal((await call('/brand/pick-folder', 'POST', {}, AGENT)).status, 403, 'Claude cannot open a window on the owner\'s screen');
    assert.equal((await call('/brand/pick-folder', 'GET')).status, 405);
    const a = await call('/brand/pick-folder', 'POST', { title: 'Pick the logos' });
    assert.deepEqual([a.status, a.body.ok, a.body.path], [200, true, '/tmp/brand']);
    assert.equal(titles[0], 'Pick the logos');
    const b = await call('/brand/pick-folder', 'POST', {});
    assert.deepEqual([b.status, b.body.cancelled], [200, true]);
    const c = await call('/brand/pick-folder', 'POST', {});
    assert.deepEqual([c.status, c.body.ok, c.body.unavailable, c.body.message], [200, false, true, 'No window here.']);
  }, { pickFolder: async (o) => { titles.push(o.title); const r = answers.shift(); if (r instanceof Error) throw r; return r; } });
});

test('Add a brand: Choose… adds a folder to the list, Add takes a pasted path, more than one is kept, Remove drops one, cancelling and failures are said in words', async () => {
  const one = mkdtempSync(join(tmpdir(), 'nordle-pick-'));
  const two = mkdtempSync(join(tmpdir(), 'nordle-pick-'));
  const three = mkdtempSync(join(tmpdir(), 'nordle-pick-'));
  const answers = [{ path: one }, { cancelled: true }, new PickerError('There is no folder window on this computer.')];
  await studioPage(async ({ page, open }) => {
    await open(`#/s/month?today=${TODAY}`);
    await page.locator('[data-act="add-brand"]').click();
    await page.fill('[data-field="wz-name"]', 'Picker Test');
    await page.locator('[data-act="wz-next"]').click();
    assert.equal(await page.locator('[data-act="wz-scan"]').isDisabled(), true);
    const listed = () => page.$$eval('[data-field="wz-folders"] .pick-path', (e) => e.map((x) => x.textContent));
    await page.locator('[data-act="wz-pick-folder"]').click();
    await page.waitForSelector('[data-field="wz-folders"]');
    assert.deepEqual(await listed(), [one]);
    assert.equal(await page.locator('[data-act="wz-scan"]').isDisabled(), false, 'a chosen folder is something to look at');
    // a second one by pasting it and pressing Add; a repeat is ignored
    await page.fill('[data-field="wz-folder"]', two);
    await page.locator('[data-act="wz-add-folder"]').click();
    await page.fill('[data-field="wz-folder"]', two);
    await page.keyboard.press('Enter');
    assert.deepEqual(await listed(), [one, two]);
    // cancelling and a failure leave the list alone and say why
    await page.locator('[data-act="wz-pick-folder"]').click();
    await page.waitForFunction(() => /No folder chosen/.test(document.querySelector('.pick-note').textContent));
    await page.locator('[data-act="wz-pick-folder"]').click();
    await page.waitForFunction(() => /no folder window/.test(document.querySelector('.pick-note').textContent));
    assert.deepEqual(await listed(), [one, two]);
    // a path typed but not added yet still counts when Look runs; Remove drops one
    await page.locator('[data-act="wz-remove-folder"]').first().click();
    assert.deepEqual(await listed(), [two]);
    await page.fill('[data-field="wz-folder"]', three);
    const sent = [];
    page.on('request', (r) => { if (r.url().endsWith('/api/brand/scan')) sent.push(r.postDataJSON()); });
    await page.locator('[data-act="wz-scan"]').click();
    await page.waitForSelector('[data-state="scanned"]');
    assert.deepEqual(sent[0].folders, [two]);
    assert.equal(sent[0].folder, three, 'the pasted path rides along');
  }, { pickFolder: async () => { const r = answers.shift(); if (r instanceof Error) throw r; return r; } });
});
