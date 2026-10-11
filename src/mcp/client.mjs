// Claude's connection to the running Nordle editor server. It finds the server through a small runtime file the server writes
// (with Claude's own token, never the owner's), and starts the server if it is not running.

import { readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { basename, join } from 'node:path';
import { ROOT } from '../../tools/validate.mjs';

export const defaultRuntimeDir = () => process.env.NORDLE_RUNTIME_DIR ?? join(ROOT, '.nordle');

export class NordleError extends Error {
  constructor(message, status, errors = []) { super(message); this.name = 'NordleError'; this.status = status; this.errors = errors; }
}

export class NordleClient {
  constructor({ dir = defaultRuntimeDir(), autostart = process.env.NORDLE_NO_AUTOSTART !== '1', serverScript = join(ROOT, 'server.mjs') } = {}) {
    this.dir = dir;
    this.autostart = autostart;
    this.serverScript = serverScript;
    this.info = null;
  }

  #readRuntime() {
    try { return JSON.parse(readFileSync(join(this.dir, 'runtime.json'), 'utf8')); } catch { return null; }
  }

  async #alive(info) {
    if (!info?.port || !info?.agentToken) return false;
    try {
      const res = await fetch(`http://127.0.0.1:${info.port}/api/meta`, { headers: { 'x-nordle-token': info.agentToken }, signal: AbortSignal.timeout(2000) });
      return res.ok && (await res.json()).role === 'agent';
    } catch { return false; }
  }

  /** Make sure there is a server to talk to. */
  async connect() {
    if (this.info && await this.#alive(this.info)) return this.info;
    const found = this.#readRuntime();
    if (await this.#alive(found)) { this.info = found; return found; }
    if (!this.autostart) throw new NordleError('Nordle is not running. Start it with "npm start" in the Nordle folder, then try again.', 0);
    const child = spawn(process.execPath, [this.serverScript], {
      cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, NORDLE_RUNTIME_DIR: this.dir },
    });
    child.unref();
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const info = this.#readRuntime();
      if (info && info.pid === child.pid && await this.#alive(info)) { this.info = info; return info; }
    }
    throw new NordleError('Nordle did not start within 20 seconds. Try running "npm start" in the Nordle folder and read what it says.', 0);
  }

  get baseUrl() { return this.info ? `http://127.0.0.1:${this.info.port}` : null; }

  async #send(method, path, body, headers) {
    const info = await this.connect();
    const isBinary = Buffer.isBuffer(body);
    const res = await fetch(`http://127.0.0.1:${info.port}/api${path}`, {
      method,
      headers: { 'x-nordle-token': info.agentToken, ...(body !== undefined && !isBinary ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : isBinary ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) {
      const errors = json?.errors ?? [];
      throw new NordleError(errors.map((e) => (e.path && e.path !== '/' ? `${e.path}: ${e.message}` : e.message)).join('\n') || res.statusText, res.status, errors);
    }
    return json;
  }

  async request(method, path, body, headers) {
    try { return await this.#send(method, path, body, headers); } catch (e) {
      // the server may have been restarted: look for it again once
      if (e instanceof NordleError || !(e.cause || /fetch failed/.test(e.message))) throw e;
      this.info = null;
      return this.#send(method, path, body, headers);
    }
  }

  get(path) { return this.request('GET', path); }
  post(path, body = {}) { return this.request('POST', path, body); }

  /** Upload an image from this computer into a project's assets. */
  async uploadImage(project, filePath) {
    const st = await stat(filePath).catch(() => null);
    if (!st?.isFile()) throw new NordleError(`There is no file at ${filePath}.`, 0);
    if (st.size > 20 * 1024 * 1024) throw new NordleError('That image is over 20 MB.', 0);
    const buf = await readFile(filePath);
    return this.request('POST', `/projects/${encodeURIComponent(project)}/assets`, buf, { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(basename(filePath)) });
  }
}

