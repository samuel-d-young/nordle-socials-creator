// Insights > Options: how often and what Nordle reads from Buffer by itself.
// Data: GET/POST /api/buffer-pull (the owner saves; every value is one of a short list of choices). Nordle only READS Buffer here, it never writes to it.
import { api } from './api.js';
import { h } from './dom.js';
import { dateFmt } from './studio-store.js';
import { notify, plural } from './studio-ui.js';

const EVERY = { 1: 'Every hour (uses the most of Buffer\'s allowance)', 3: 'Every 3 hours', 6: 'Every 6 hours (recommended)', 12: 'Twice a day', 24: 'Once a day' };
const DAYS = { 30: 'the last 30 days', 90: 'the last 90 days', 180: 'the last 180 days' };
const MAXNEW = { 10: '10 new posts', 30: '30 new posts', 60: '60 new posts' };

function modal(title) {
  const body = h('div', { class: 'db bp' });
  const foot = h('div', { class: 'df' });
  const dlg = h('dialog', { class: 'bp-dialog', 'aria-label': title }, h('div', { class: 'dh' }, title), body, foot);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return { dlg, body, foot, close: () => dlg.close() };
}

const when = (iso) => (iso ? dateFmt.ago(iso) : 'not yet');
const inHours = (iso) => { const ms = Date.parse(iso) - Date.now(); if (!Number.isFinite(ms)) return ''; const m = Math.round(ms / 60000); return m <= 1 ? 'due now' : m < 90 ? `in about ${m} minutes` : `in about ${Math.round(m / 60)} hours`; };

/** Open the window for one brand's view of it (the options themselves are the same for every brand). */
export async function openPullOptions(pr) {
  const m = modal('Reading from Buffer');
  let state;
  try { state = await api.get(`/buffer-pull?project=${encodeURIComponent(pr.id)}`); } catch (e) { m.body.append(h('p', { class: 'muted' }, e.message)); m.foot.append(h('button', { class: 'btn', type: 'button', onclick: m.close }, 'Close')); return; }
  const o = { ...state.options };

  const field = {};
  const sel = (key, labels, current, act) => {
    const el = h('select', { class: 'field', 'data-field': act, 'aria-label': act }, state.choices[key].map((v) => h('option', { value: String(v), selected: v === current }, labels[v] ?? String(v))));
    field[act] = el;
    return el;
  };
  const check = (key, label, hint) => {
    const el = h('input', { type: 'checkbox', checked: !!o[key], 'data-field': `bp-${key}` });
    field[`bp-${key}`] = el;
    return h('label', { class: 'bp-check' }, el, h('span', {}, h('b', {}, label), hint ? h('small', { class: 'muted' }, hint) : null));
  };

  const when1 = h('div', { class: 'bp-line' }, h('label', { for: 'bp-every' }, 'How often'), sel('everyHours', EVERY, o.everyHours, 'bp-every'));
  const back = h('div', { class: 'bp-line' }, h('label', {}, 'Copy sent posts from'), sel('days', DAYS, o.days, 'bp-days'));
  const cap = h('div', { class: 'bp-line' }, h('label', {}, 'At most'), sel('maxNew', MAXNEW, o.maxNew, 'bp-maxnew'), h('span', { class: 'muted' }, ' each time'));

  const b = state.brand;
  const status = h('p', { class: 'sch-help bp-status', 'data-field': 'bp-status' },
    b ? (b.connected ? [`${pr.name ?? pr.id}: last read ${when(b.pulledAt)}`, b.nextAt && o.enabled ? `, next ${inHours(b.nextAt)}` : '', `. ${plural(b.copied, 'post')} made by hand in Buffer ${b.copied === 1 ? 'is' : 'are'} on its calendar.`, Number.isFinite(b.allowanceLeft) ? ` Buffer says ${b.allowanceLeft} of ${b.allowanceLimit} requests are left today.` : ''].join('') : `${pr.name ?? pr.id} has no Buffer account and channels yet (Publishing), so there is nothing to read.`) : '');

  m.body.append(
    h('p', { class: 'sch-help' }, 'Nordle can read Buffer by itself so Insights and the calendar stay true. It only reads: it never changes or deletes anything in Buffer here. Each read costs about one Buffer request for every 100 posts, and Buffer allows a fixed number a day, so a slower rhythm keeps more for scheduling.'),
    status,
    check('enabled', 'Read Buffer by itself', 'Off: nothing is read until you press “Update from Buffer”.'),
    when1,
    h('h4', { class: 'bp-h' }, 'What to read'),
    h('p', { class: 'sch-help' }, 'Which posts went out, and how they did, is always read while this is on (“When to post” needs it). On top of that:'),
    check('results', 'The numbers (reach, likes, saves…) for your posts', 'They go into Insights, on the post they belong to.'),
    check('handMade', 'Posts made by hand in Buffer', 'Copied onto the calendar as read-only “From Buffer” posts, so the month shows everything you post.'),
    h('div', { class: 'bp-sub' }, back, cap, check('covers', 'Save each post\'s picture in the project', 'A public https picture only, up to 6 MB. The post is copied without it if it cannot be fetched.')),
  );

  const dirty = () => ({
    enabled: field['bp-enabled'].checked, everyHours: Number(field['bp-every'].value), results: field['bp-results'].checked, handMade: field['bp-handMade'].checked,
    days: Number(field['bp-days'].value), maxNew: Number(field['bp-maxnew'].value), covers: field['bp-covers'].checked,
  });
  const sync = () => { const hand = field['bp-handMade'].checked; for (const k of ['bp-days', 'bp-maxnew', 'bp-covers']) field[k].disabled = !hand; field['bp-every'].disabled = !field['bp-enabled'].checked; };
  for (const el of Object.values(field)) el.addEventListener('change', sync);
  sync();

  const save = h('button', { class: 'btn primary', type: 'button', 'data-act': 'bp-save', onclick: async () => {
    save.disabled = true;
    try {
      await api.post(`/buffer-pull?project=${encodeURIComponent(pr.id)}`, dirty());
      notify(`Saved. ${field['bp-enabled'].checked ? `Nordle will read Buffer ${EVERY[Number(field['bp-every'].value)].replace(/ \(.*\)/, '').toLowerCase()}.` : 'Nordle will only read Buffer when you press “Update from Buffer”.'}`, { kind: 'ok' });
      m.close();
    } catch (e) { notify(e.message, { kind: 'error' }); save.disabled = false; }
  } }, 'Save');
  m.foot.append(h('button', { class: 'btn', type: 'button', 'data-act': 'bp-close', onclick: m.close }, 'Cancel'), save);
}
