// Keep the pictures in a project's out/ folder in step with its documents. The Studio shows those pictures, so a change made in the editor
// (drag, resize, new words) would otherwise not show on the review page until someone exports by hand. A few seconds after the last
// change to a document it is drawn again, once, in the background; a failure is only logged (the next change tries again).

import { renderDocument } from '../render/render.mjs';

/**
 * @param {{use: Function}} pool the shared browser pool
 * @param {{delayMs?: number, onDone?: Function, log?: Function}} [opts]
 * @returns {{schedule(file: string): void, cancel(file: string): void, flush(): Promise<void>}}
 */
export function createAutoRender(pool, { delayMs = 5000, onDone, log = (m) => console.error(m) } = {}) {
  const timers = new Map();
  const running = new Set();
  const run = async (file) => {
    timers.delete(file);
    if (running.has(file)) { schedule(file); return; }          // still drawing the last change: draw again after it
    running.add(file);
    try {
      await pool.use((browser) => renderDocument(file, { browser, sheet: true }));
      onDone?.(file);
    } catch (e) { log(`autorender: ${file}: ${e.message}`); } finally { running.delete(file); }
  };
  function schedule(file) {
    clearTimeout(timers.get(file));
    const t = setTimeout(() => run(file), delayMs);
    t.unref?.();
    timers.set(file, t);
  }
  return {
    schedule,
    cancel(file) { clearTimeout(timers.get(file)); timers.delete(file); },
    async flush() { for (const file of [...timers.keys()]) { clearTimeout(timers.get(file)); await run(file); } },
  };
}
