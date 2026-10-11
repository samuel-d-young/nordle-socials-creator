// Runs the ffmpeg / ffprobe that is already installed on this computer. Nothing is bundled.
// Every process is started with windowsHide so no console window ever flashes up, and with stdin closed.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const WIN_FALLBACKS = ['C:\\ProgramData\\chocolatey\\bin', 'C:\\Program Files\\ffmpeg\\bin', 'C:\\ffmpeg\\bin'];
const cache = {};

function works(cmd) {
  try {
    const r = spawnSync(cmd, ['-version'], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
    return r.status === 0 && /version/i.test(r.stdout ?? '');
  } catch { return false; }
}

/** The command that runs ffmpeg or ffprobe: NORDLE_FFMPEG / NORDLE_FFPROBE, then the PATH, then the usual Windows places. */
export function binary(name) {
  if (cache[name]) return cache[name];
  const fromEnv = process.env[`NORDLE_${name.toUpperCase()}`];
  const candidates = [fromEnv, name];
  if (process.platform === 'win32') for (const d of WIN_FALLBACKS) candidates.push(join(d, `${name}.exe`));
  for (const c of candidates.filter(Boolean)) {
    if ((c === name || existsSync(c)) && works(c)) return (cache[name] = c);
  }
  throw new Error(`${name} was not found. Install ffmpeg (it is not bundled with Nordle) and make sure "${name}" is on the PATH, or set NORDLE_${name.toUpperCase()} to its full path.`);
}

let versionInfo;
/** { major, text } of the installed ffmpeg. */
export function ffmpegVersion() {
  if (versionInfo) return versionInfo;
  const r = spawnSync(binary('ffmpeg'), ['-version'], { windowsHide: true, encoding: 'utf8' });
  const m = /version\s+(?:n)?(\d+)\.(\d+)/.exec(r.stdout ?? '');
  return (versionInfo = { major: m ? Number(m[1]) : 6, minor: m ? Number(m[2]) : 0, text: (r.stdout ?? '').split('\n')[0] });
}

export class FfmpegError extends Error {
  constructor(message, { code, stderr, args } = {}) { super(message); this.name = 'FfmpegError'; this.code = code; this.stderr = stderr; this.args = args; }
}

/**
 * Run a program to the end.
 * @param {string[]} args
 * @param {{ bin?:string, onProgress?:(p:{frame?:number, seconds?:number})=>void, signal?:AbortSignal, capture?:'stdout'|'none', label?:string }} [opts]
 * @returns {Promise<{stdout:Buffer|string, stderr:string}>}
 */
export function run(args, opts = {}) {
  const bin = opts.bin ?? binary('ffmpeg');
  const isFfmpeg = /ffmpeg/i.test(bin) && !/ffprobe/i.test(bin);
  const full = isFfmpeg
    ? ['-hide_banner', '-nostdin', '-v', opts.verbose ? 'info' : 'error', '-y', ...(opts.onProgress ? ['-progress', 'pipe:2', '-nostats'] : []), ...args]
    : args;
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new FfmpegError('Cancelled.', { code: 'ABORT' }));
    const child = spawn(bin, full, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let err = '';
    let aborted = false;
    const onAbort = () => { aborted = true; child.kill(); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c) => out.push(c));
    let carry = '';
    child.stderr.on('data', (c) => {
      const text = c.toString('utf8');
      if (!opts.onProgress) { err += text; if (err.length > 40000) err = err.slice(-30000); return; }
      carry += text;
      const lines = carry.split(/\r?\n/);
      carry = lines.pop();
      const info = {};
      for (const line of lines) {
        const m = /^(frame|out_time_us|out_time_ms|progress)=(.*)$/.exec(line);
        if (m) {
          if (m[1] === 'frame') info.frame = Number(m[2]);
          else if (m[1] === 'out_time_us' || m[1] === 'out_time_ms') { const v = Number(m[2]); if (Number.isFinite(v) && v >= 0) info.seconds = v / 1e6; } else info.done = m[2] === 'end';
        } else if (line.trim() && !/^(fps|stream_|bitrate|total_size|out_time|dup_frames|drop_frames|speed)=/.test(line)) {
          err += `${line}\n`;
          if (err.length > 20000) err = err.slice(-12000);
        }
      }
      if (info.frame !== undefined || info.seconds !== undefined) opts.onProgress(info);
    });
    child.on('error', (e) => reject(new FfmpegError(`Could not start ${bin}: ${e.message}`, { code: 'SPAWN' })));
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (aborted) return reject(new FfmpegError('Cancelled.', { code: 'ABORT' }));
      const stdout = Buffer.concat(out);
      if (code === 0) return resolve({ stdout: opts.capture === 'text' ? stdout.toString('utf8') : stdout, stderr: err });
      const tail = err.trim().split('\n').slice(-8).join('\n');
      reject(new FfmpegError(`${opts.label ?? (isFfmpeg ? 'ffmpeg' : 'ffprobe')} failed (exit ${code}).${tail ? `\n${tail}` : ''}`, { code, stderr: err, args: full }));
    });
  });
}

/**
 * Run ffmpeg and hand what it writes to stdout to `onData`, piece by piece. Nothing is collected, so a long decode
 * (the sound of an hour of footage as raw samples) never sits in memory. Resolves when ffmpeg ends cleanly.
 * @param {string[]} args
 * @param {(chunk:Buffer)=>void} onData
 * @param {{ bin?:string, signal?:AbortSignal, label?:string }} [opts]
 */
export function runStream(args, onData, opts = {}) {
  const bin = opts.bin ?? binary('ffmpeg');
  const full = ['-hide_banner', '-nostdin', '-v', 'error', '-y', ...args];
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new FfmpegError('Cancelled.', { code: 'ABORT' }));
    const child = spawn(bin, full, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let aborted = false;
    let failure = null;
    const onAbort = () => { aborted = true; child.kill(); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (c) => {
      if (failure) return;
      try { onData(c); } catch (e) { failure = e; child.kill(); }
    });
    child.stderr.on('data', (c) => { err += c.toString('utf8'); if (err.length > 20000) err = err.slice(-12000); });
    child.on('error', (e) => reject(new FfmpegError(`Could not start ${bin}: ${e.message}`, { code: 'SPAWN' })));
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      if (failure) return reject(failure);
      if (aborted) return reject(new FfmpegError('Cancelled.', { code: 'ABORT' }));
      if (code === 0) return resolve();
      const tail = err.trim().split('\n').slice(-8).join('\n');
      reject(new FfmpegError(`${opts.label ?? 'ffmpeg'} failed (exit ${code}).${tail ? `\n${tail}` : ''}`, { code, stderr: err, args: full }));
    });
  });
}

/** Put a filter graph into a file and return the arguments that make ffmpeg read it (the command line has a length limit). */
export function filterScriptArgs(dir, name, graph) {
  const file = join(dir, name);
  writeFileSync(file, graph);
  return ffmpegVersion().major >= 7 ? ['-/filter_complex', file] : ['-filter_complex_script', file];
}

/** Run async jobs with at most `limit` at once, keeping the order of results. */
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** A number for a filter graph: plain decimal, never exponent notation. */
export const n6 = (v) => String(Number(Number(v).toFixed(6)));
