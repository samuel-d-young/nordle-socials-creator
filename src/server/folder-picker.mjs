// "Choose a folder": the operating system's own folder window, opened by the Nordle server on the owner's computer, so nobody has to type or paste a path.
// A web page cannot learn the full path of a folder (browsers only hand over names and files), and the server runs on this computer anyway, so
// the server asks the system to show the window and reads back the path:
//   Windows  PowerShell + the standard folder dialog, owned by a hidden top-most form so it opens in front
//   macOS    osascript "choose folder"
//   Linux    zenity, or kdialog if that is what is installed
// Resolves { path } or { cancelled: true }; throws PickerError (with a plain message) when there is no way to show a window.
// `run` is injectable so tests never open a real window.

import { spawn } from 'node:child_process';

export class PickerError extends Error {}

const TIMEOUT_MS = 10 * 60 * 1000;

/** @param {string} cmd @param {string[]} args @returns {Promise<{code:number|null, stdout:string, stderr:string, missing:boolean}>} */
export function runProgram(cmd, args) {
  return new Promise((resolve) => {
    let out = '', err = '', done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve({ stdout: out, stderr: err, missing: false, ...r }); } };
    let child;
    try { child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { return resolve({ code: null, stdout: '', stderr: String(e.message ?? e), missing: true }); }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } finish({ code: null, stderr: 'timed out' }); }, TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ code: null, stderr: String(e.message ?? e), missing: e.code === 'ENOENT' }));
    child.on('close', (code) => finish({ code }));
  });
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;
const asQuote = (s) => `"${String(s).replace(/[\\"]/g, ' ')}"`;

/** Tidy what a dialog printed: one line, no trailing slash (but keep "C:\" and "/"). */
export function tidyPath(raw) {
  let p = String(raw ?? '').replace(/[\r\n]+$/g, '').trim();
  if (p.length > 1 && !/^[A-Za-z]:[\\/]?$/.test(p)) p = p.replace(/[\\/]+$/, '');
  return p;
}

/**
 * @param {{ title?: string, platform?: string, run?: typeof runProgram }} [o]
 * @returns {Promise<{ path: string } | { cancelled: true }>}
 */
export async function pickFolder({ title = 'Choose a folder', platform = process.platform, run = runProgram } = {}) {
  const label = String(title).slice(0, 120);
  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '[System.Windows.Forms.Application]::EnableVisualStyles()',
      '$o = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0; StartPosition = "CenterScreen"; Width = 1; Height = 1 }',
      '$o.Show(); $o.Activate()',
      `$f = New-Object System.Windows.Forms.FolderBrowserDialog -Property @{ Description = ${psQuote(label)}; ShowNewFolderButton = $true }`,
      'if ($f.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($f.SelectedPath) }',
      '$o.Close()',
    ].join('; ');
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script]);
    if (r.missing) throw new PickerError('Windows PowerShell could not be started, so there is no folder window. Type or paste the folder path instead.');
    const path = tidyPath(r.stdout);
    if (path) return { path };
    if (r.code && r.code !== 0) throw new PickerError('The folder window could not be opened. Type or paste the folder path instead.');
    return { cancelled: true };
  }
  if (platform === 'darwin') {
    const r = await run('osascript', ['-e', 'tell application "System Events" to activate', '-e', `POSIX path of (choose folder with prompt ${asQuote(label)})`]);
    if (r.missing) throw new PickerError('macOS could not show the folder window. Type or paste the folder path instead.');
    const path = tidyPath(r.stdout);
    if (path) return { path };
    if (/-128|User canceled/i.test(r.stderr)) return { cancelled: true };
    if (r.code && r.code !== 0) throw new PickerError('The folder window could not be opened. Type or paste the folder path instead.');
    return { cancelled: true };
  }
  // Linux and anything else: whichever of the common dialogs is installed
  const tries = [['zenity', ['--file-selection', '--directory', `--title=${label}`]], ['kdialog', ['--getexistingdirectory', '.', '--title', label]]];
  for (const [cmd, args] of tries) {
    const r = await run(cmd, args);
    if (r.missing) continue;
    const path = tidyPath(r.stdout);
    if (path) return { path };
    return { cancelled: true };   // zenity and kdialog exit non-zero and print nothing when the window is closed
  }
  throw new PickerError('There is no folder window on this computer (install zenity or kdialog), so type or paste the folder path instead.');
}


/**
 * "Choose files": the same idea for several files at once (videos you already have). Resolves { paths: [...] } or { cancelled: true }.
 * @param {{ title?: string, kind?: 'video', platform?: string, run?: typeof runProgram }} [o]
 */
export async function pickFiles({ title = 'Choose files', kind = 'video', platform = process.platform, run = runProgram } = {}) {
  const label = String(title).slice(0, 120);
  const exts = kind === 'video' ? ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'm2ts', 'mxf', 'mpg', 'mpeg'] : [];
  const lines = (raw) => String(raw ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (platform === 'win32') {
    const filter = exts.length ? `Videos (${exts.map((e) => `*.${e}`).join(', ')})|${exts.map((e) => `*.${e}`).join(';')}|All files|*.*` : 'All files|*.*';
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '[System.Windows.Forms.Application]::EnableVisualStyles()',
      '$o = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false; Opacity = 0; StartPosition = "CenterScreen"; Width = 1; Height = 1 }',
      '$o.Show(); $o.Activate()',
      `$f = New-Object System.Windows.Forms.OpenFileDialog -Property @{ Title = ${psQuote(label)}; Multiselect = $true; Filter = ${psQuote(filter)}; CheckFileExists = $true }`,
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      'if ($f.ShowDialog($o) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write(($f.FileNames -join "`n")) }',
      '$o.Close()',
    ].join('; ');
    const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script]);
    if (r.missing) throw new PickerError('Windows PowerShell could not be started, so there is no file window. Type or paste the file paths instead.');
    const paths = lines(r.stdout);
    if (paths.length) return { paths };
    if (r.code && r.code !== 0) throw new PickerError('The file window could not be opened.');
    return { cancelled: true };
  }
  if (platform === 'darwin') {
    const types = kind === 'video' ? ' of type {"public.movie"}' : '';
    const script = [
      'tell application "System Events" to activate',
      `set fs to choose file with prompt ${asQuote(label)}${types} with multiple selections allowed`,
      'set out to ""',
      'repeat with f in fs',
      'set out to out & POSIX path of f & linefeed',
      'end repeat',
      'return out',
    ];
    const r = await run('osascript', script.flatMap((l) => ['-e', l]));
    if (r.missing) throw new PickerError('macOS could not show the file window. Type or paste the file paths instead.');
    const paths = lines(r.stdout);
    if (paths.length) return { paths };
    if (/-128|User canceled/i.test(r.stderr)) return { cancelled: true };
    if (r.code && r.code !== 0) throw new PickerError('The file window could not be opened.');
    return { cancelled: true };
  }
  const tries = [
    ['zenity', ['--file-selection', '--multiple', '--separator=\n', `--title=${label}`, ...(exts.length ? [`--file-filter=Videos | ${exts.map((e) => `*.${e}`).join(' ')}`] : [])]],
    ['kdialog', ['--getopenfilename', '.', exts.length ? `*.${exts.join(' *.')}|Videos` : '*', '--multiple', '--separate-output', '--title', label]],
  ];
  for (const [cmd, args] of tries) {
    const r = await run(cmd, args);
    if (r.missing) continue;
    const paths = lines(r.stdout);
    return paths.length ? { paths } : { cancelled: true };
  }
  throw new PickerError('There is no file window on this computer (install zenity or kdialog), so type or paste the file paths instead.');
}
