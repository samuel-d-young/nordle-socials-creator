// Choosing the cover of a reel. A window with the best few frames Nordle found (sharp, steady, well lit, not the closing card), one to
// click; a button that lets Nordle take the best one; and the cover now. The player's own button ("Use this frame as the cover")
// is for any other moment. Each choice asks the server (owner only), which retakes the cover picture from the finished video and
// keeps the frame for publishing. With nothing chosen, the best frame is used automatically when the post is scheduled.

import { api } from './api.js';
import { h, dialog } from './dom.js';
import { bumpPictures, notify } from './studio-ui.js';

const clock = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

/**
 * Open the window. Resolves with { time, auto } when a cover was chosen, else null.
 * @param {{uid:string, title:string}} post
 */
export async function openCoverPicker(post) {
  let chosen = null;
  let finish = null;
  const status = h('p', { class: 'muted cv-pick-note' }, 'Looking through the video for the best frames…');
  const grid = h('div', { class: 'cv-pick-grid', role: 'group', 'aria-label': 'Suggested covers' });
  const now = h('p', { class: 'cv-pick-now muted' });
  const set = async (body, done) => {
    grid.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    try {
      const r = await api.post('/studio/cover', { uid: post.uid, ...body });
      chosen = { time: r.time, auto: !!r.auto, cover: r.cover };
      bumpPictures();
      notify(r.auto ? `Cover picked automatically: ${clock(r.time)}.` : `Cover set to ${clock(r.time)}.`, { kind: 'ok' });
      done?.();
    } catch (e) { notify(e.message, { kind: 'error' }); grid.querySelectorAll('button').forEach((b) => { b.disabled = false; }); }
  };
  const loaded = (async () => {
    try {
      const r = await api.get(`/studio/cover-candidates?uid=${encodeURIComponent(post.uid)}&count=6`);
      now.textContent = r.current ? `The cover now: ${clock(r.current.time)}${r.current.auto ? ' (picked automatically)' : ' (chosen)'}.` : 'No cover is chosen yet. If you leave it, the best frame is picked when the post is scheduled.';
      status.textContent = r.candidates.length ? 'Best first. Click one to use it as the cover.' : 'No good frames were found. Use the player to choose any moment.';
      grid.replaceChildren(...r.candidates.map((c, i) => h('button', { class: `cv-pick${i === 0 ? ' best' : ''}`, type: 'button', 'data-time': String(c.time), title: `Use ${clock(c.time)} as the cover`, onclick: () => set({ time: c.time }, () => finish?.('chosen')) },
        h('img', { src: c.image, alt: `Frame at ${clock(c.time)}`, draggable: 'false' }), h('span', { class: 'cv-pick-t' }, i === 0 ? `Best · ${clock(c.time)}` : clock(c.time)))));
    } catch (e) { status.textContent = e.message; }
  })();
  const r = await dialog({
    title: `Cover for “${post.title}”`,
    build: (body, fin) => { finish = fin; body.append(status, grid, now); },
    actions: [{ id: 'cancel', label: 'Close' }, { id: 'auto', label: 'Pick the best one for me', primary: true }],
  });
  await loaded.catch(() => {});
  if (r === 'auto') await set({ auto: true });
  return chosen;
}
