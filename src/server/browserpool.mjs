// One shared render browser for the server: opened when first needed, closed after a quiet minute, one job at a time.

import { openBrowser } from '../render/browser.mjs';

export class BrowserPool {
  constructor({ idleMs = 60000 } = {}) {
    this.idleMs = idleMs;
    this.browser = null;
    this.chain = Promise.resolve();
    this.timer = null;
  }

  use(fn) {
    const run = this.chain.then(async () => {
      clearTimeout(this.timer);
      this.browser ??= await openBrowser();
      try { return await fn(this.browser); } finally { this.#armIdle(); }
    });
    this.chain = run.catch(() => {});
    return run;
  }

  #armIdle() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.close(), this.idleMs);
    this.timer.unref?.();
  }

  async close() {
    clearTimeout(this.timer);
    const b = this.browser;
    this.browser = null;
    await b?.close().catch(() => {});
  }
}
