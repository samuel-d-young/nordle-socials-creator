// The Copy tab: caption, call to action, hashtags, alt text, and the "Check this post" results.

import { h, icon, preserveFocus, debounce } from './dom.js';
import { state, update, subscribe } from './state.js';
import { setDocValue, runCheck, select } from './doc.js';

const norm = (s) => String(s).toLowerCase().replace(/[‘’]/g, "'");

export function mountCopy(root) {
  let lastSig = '';

  function limits() {
    return state.sizes.filter((s) => s.preset?.maxCaption).map((s) => ({ id: s.id, platform: s.preset.platform, max: s.preset.maxCaption }));
  }

  function build() {
    const doc = state.doc;
    if (!doc) return;
    const copy = doc.copy ?? {};
    const fullLength = () => [copy.caption, copy.cta, (copy.hashtags ?? []).map((t) => (t.startsWith('#') ? t : `#${t}`)).join(' ')].filter(Boolean).join('\n\n').length;
    const lim = limits();
    const minMax = lim.length ? Math.min(...lim.map((l) => l.max)) : null;
    const banned = (state.brand?.voice?.bannedPhrases ?? []).map(norm).filter((p) => norm([copy.caption, copy.cta].filter(Boolean).join(' ')).includes(p));

    const caption = h('textarea', { class: 'field', rows: 6, 'data-field': 'caption', value: copy.caption ?? '', placeholder: 'Write the caption…' });
    const saveCaption = debounce(() => { if (caption.value !== (copy.caption ?? '')) setDocValue('/copy/caption', caption.value || undefined, 'Edit caption'); }, 450);
    caption.addEventListener('input', () => { saveCaption(); counter.textContent = `${caption.value.length + (copy.cta ? copy.cta.length + 2 : 0)} characters`; });
    caption.addEventListener('blur', () => saveCaption.flush());
    const counter = h('div', { class: `counter${minMax && fullLength() > minMax ? ' over' : ''}` }, minMax ? `${fullLength()} of ${minMax} (shortest limit: ${lim.find((l) => l.max === minMax).platform})` : `${fullLength()} characters`);

    const cta = h('input', { class: 'field', value: copy.cta ?? '', 'data-field': 'cta', placeholder: 'e.g. Tell us which one you will try first.', onchange: (e) => setDocValue('/copy/cta', e.target.value || undefined, 'Edit call to action') });

    const tags = copy.hashtags ?? [];
    const tagInput = h('input', { class: 'field', placeholder: 'Add a hashtag and press Enter', 'data-field': 'tag' });
    tagInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const t = tagInput.value.trim().replace(/\s+/g, '');
      if (!t) return;
      const tag = t.startsWith('#') ? t : `#${t}`;
      if (!/^#[\p{L}\p{N}_]+$/u.test(tag)) return;
      if (!tags.includes(tag)) setDocValue('/copy/hashtags', [...tags, tag], 'Add hashtag');
      tagInput.value = '';
    });

    const altBlock = h('div', { class: 'group' }, h('h3', {}, 'Alt text'),
      h('p', { class: 'muted', style: { fontSize: '11px' } }, 'A short description of each page for people who cannot see it.'),
      (doc.pages ?? []).map((p, i) => h('div', { class: 'row', style: { alignItems: 'flex-start' } }, h('label', { title: p.title ?? p.id }, `${i + 1}`),
        h('textarea', { class: 'field', rows: 2, 'data-field': `alt-${p.id}`, value: copy.alt?.[p.id] ?? '', placeholder: p.title ?? p.id,
          onchange: (e) => setDocValue(`/copy/alt/${p.id}`, e.target.value || undefined, 'Edit alt text') }))));

    root.replaceChildren(
      h('div', { class: 'group' }, h('h3', {}, 'Caption'), caption, counter,
        banned.length ? h('div', { class: 'badge warn', style: { marginTop: '6px' } }, `Contains a phrase this brand avoids: ${banned.join(', ')}`) : null,
        lim.length ? h('div', { class: 'muted', style: { fontSize: '11px' } }, lim.map((l) => `${l.platform} ${l.max}`).join(' · ')) : null),
      h('div', { class: 'group' }, h('h3', {}, 'Call to action'), cta),
      h('div', { class: 'group' }, h('h3', {}, 'Hashtags'),
        h('div', { class: 'chips', style: { marginBottom: '8px' } }, tags.map((t) => h('span', { class: 'chip' }, t, h('button', { title: 'Remove', onclick: () => setDocValue('/copy/hashtags', tags.filter((x) => x !== t).length ? tags.filter((x) => x !== t) : undefined, 'Remove hashtag') }, icon('x', 12))))), tagInput),
      altBlock,
      checkBlock());
  }

  function checkBlock() {
    const c = state.checks;
    const box = h('div', { class: 'group' }, h('h3', {}, 'Design review',
      h('button', { class: 'btn sm primary', disabled: !!c?.running, onclick: runCheck }, icon('sparkle', 14), c?.running ? 'Checking…' : 'Run check')),
    h('p', { class: 'muted', style: { fontSize: '11px' } }, 'Renders every page at every size and grades it: hierarchy, spacing, alignment, collisions, text that is cut off or too faint, platform safe zones, consistency across a carousel, brand colours and fonts, and the copy.'));
    if (c?.issues) {
      const errs = c.issues.filter((i) => i.level === 'error').length, warns = c.issues.filter((i) => i.level === 'warn').length, infos = c.issues.filter((i) => i.level === 'info').length;
      box.append(h('div', { class: 'row', style: { flexWrap: 'wrap' } },
        h('span', { class: `badge ${c.verdict === 'good' ? 'ok' : 'warn'}`, title: `Pass mark: ${c.passScore}` }, `Design score ${c.score}/100`),
        h('span', { class: `badge ${errs ? 'warn' : 'ok'}` }, errs ? `${errs} problem${errs > 1 ? 's' : ''}` : 'No problems'),
        h('span', { class: 'muted' }, [warns && `${warns} to look at`, infos && `${infos} suggestion${infos > 1 ? 's' : ''}`].filter(Boolean).join(' · '))));
      for (const i of c.issues) {
        const sizes = i.sizes ?? (i.size ? [i.size] : []);
        const layerId = i.layer && !String(i.layer).includes('/') && !String(i.layer).startsWith('copy') ? i.layer : null;
        box.append(h('div', { class: `issue ${i.level}`, onclick: () => { if (i.page) update({ pageId: i.page }); if (i.page && layerId) { select(i.page, layerId); update({ panel: 'props' }); } } },
          h('div', { class: 'lv' }), h('div', {}, h('div', {}, i.message), i.fix ? h('div', { style: { fontSize: '12px', margin: '2px 0' } }, 'Fix: ', i.fix) : null,
            h('div', { class: 'muted', style: { fontSize: '11px' } }, [i.rule, i.page && `page ${i.page}`, layerId && `layer ${layerId}`, sizes.length && sizes.join(', ')].filter(Boolean).join(' · ')))));
      }
    }
    return box;
  }

  subscribe(() => {
    if (state.route.name !== 'edit' || !state.doc || state.panel !== 'copy') return;
    const sig = JSON.stringify([state.doc.copy, state.doc.pages?.map((p) => p.id + (p.title ?? '')), state.sizes.map((s) => s.id), state.brand?.voice, state.checks]);
    if (sig === lastSig) return;
    lastSig = sig;
    preserveFocus(root, build);
  });
  return { rebuild: () => { lastSig = ''; build(); } };
}
