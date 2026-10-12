// "How is this reel made?": the choices for a reel, shared by the Create page and the idea editor. Style (Auto, from footage, motion graphics only, motion graphics with
// a voice-over), what it uses (footage, photos, stock, a voice-over, music, sound effects, captions, logo, a closing card) and about how long. The words and the checks live
// in src/shared/reel-options.mjs, which the server and Claude's prompts use too.

import { h } from './dom.js';
import { REEL_LENGTHS, REEL_STYLES, REEL_USES, cleanReel, defaultUses } from '/src/shared/reel-options.mjs';

const chip = (label, on, onclick, extra = {}) => h('button', { class: `cr-chip${on ? ' on' : ''}`, type: 'button', 'aria-pressed': on ? 'true' : 'false', onclick, ...extra }, label);

/**
 * @param {{ value?: object|null, onChange: (reel: object|null) => void }} o
 * `value` is item.reel ({ style, uses, seconds }) or null; `onChange` is called with the cleaned choice (null when it is back to Auto with nothing set).
 * Returns an element that redraws itself on every choice.
 */
export function reelOptions({ value = null, onChange }) {
  const box = h('div', { class: 'reel-opts', 'data-field': 'reel-options' });
  let cur = value ? { ...value } : {};
  const emit = () => { const r = cleanReel(cur); onChange?.(r.value && (r.value.style && r.value.style !== 'auto' || r.value.uses || r.value.seconds) ? r.value : null); };
  const draw = () => {
    const style = cur.style ?? 'auto';
    const uses = cur.uses ?? defaultUses(style);
    const blocked = new Set(style === 'motion' ? ['footage', 'photos', 'stock', 'voiceover', 'captions'] : style === 'voiceover' ? ['footage', 'photos', 'stock'] : []);
    box.replaceChildren(
      h('div', { class: 'cr-row' }, h('span', { class: 'lbl-i' }, 'Made from'),
        h('div', { class: 'cr-chips', role: 'group', 'aria-label': 'How the reel is made' },
          REEL_STYLES.map((s) => chip(s.label, s.id === style, () => { cur = { ...cur, style: s.id }; delete cur.uses; emit(); draw(); }, { 'data-reel-style': s.id, title: s.hint })))),
      h('p', { class: 'muted cr-hint', 'data-state': 'reel-style-hint' }, REEL_STYLES.find((s) => s.id === style)?.hint ?? ''),
      style === 'voiceover' ? h('p', { class: 'muted cr-hint', 'data-state': 'reel-voice-hint' }, 'Needs a recording of your voice with word timings in the project. Nordle never makes a voice up: if there is none, Claude tells you what is missing.') : null,
      h('div', { class: 'cr-row' }, h('span', { class: 'lbl-i' }, 'Uses'),
        h('div', { class: 'cr-chips', role: 'group', 'aria-label': 'What the reel uses' },
          REEL_USES.filter((u) => !blocked.has(u.id)).map((u) => chip(u.label, uses.includes(u.id), () => { const now = new Set(uses); if (now.has(u.id)) now.delete(u.id); else now.add(u.id); cur = { ...cur, uses: [...now] }; emit(); draw(); }, { 'data-reel-use': u.id, title: u.hint })))),
      h('div', { class: 'cr-row' }, h('span', { class: 'lbl-i' }, 'Length'),
        h('div', { class: 'cr-chips', role: 'group', 'aria-label': 'About how long' },
          chip('Any', !cur.seconds, () => { delete cur.seconds; emit(); draw(); }, { 'data-reel-seconds': 'any' }),
          REEL_LENGTHS.map((n) => chip(`${n} s`, cur.seconds === n, () => { cur = { ...cur, seconds: n }; emit(); draw(); }, { 'data-reel-seconds': n })))));
  };
  draw();
  return box;
}
