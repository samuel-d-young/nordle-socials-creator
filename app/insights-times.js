// "When to post": what the brand's own sent posts say about days and times, read from Buffer (src/performance/best-time.mjs).
// Every number is a post's result compared with that channel's usual result (1.0 = usual, 1.3 = 30% better), with the number of posts
// behind it and a range, so a lucky post cannot make a slot look good. It only knows the times that have been used: the page says so.
// Data: GET /api/publish/best-times?project=   POST /api/publish/sync-posts {project} (owner: asks Buffer, a few requests).

import { api } from './api.js';
import { h, icon } from './dom.js';
import { dateFmt } from './studio-store.js';
import { notify, plural, skeleton } from './studio-ui.js';

const LO = Math.log(0.5), HI = Math.log(2);
/** Where a score sits on a bar that runs from 0.5× to 2× with 1.0× in the middle (percent from the left). */
const pos = (x) => Math.max(0, Math.min(100, ((Math.log(Math.max(0.05, x)) - LO) / (HI - LO)) * 100));
const WORD = { better: 'clearly better', worse: 'clearly worse', unclear: 'about usual', thin: 'too few posts', none: 'no posts' };
const dm = (iso) => (iso ? dateFmt.dm(iso.slice(0, 10)) : '');

function bar(row, { most = false } = {}) {
  if (!row.n) return h('li', { class: 'bt-row none' }, h('span', { class: 'bt-l' }, row.label), h('span', { class: 'bt-track' }), h('span', { class: 'bt-v muted' }, 'no posts'));
  const centre = 50, at = pos(row.lift);
  const from = Math.min(centre, at), width = Math.abs(at - centre);
  return h('li', { class: `bt-row ${row.verdict}`, title: `${row.label}: ${row.lift}× a typical post (range ${row.lo} to ${row.hi}), from ${plural(row.n, 'post')}. ${WORD[row.verdict] ?? ''}.` },
    h('span', { class: 'bt-l' }, row.label, most ? h('i', { class: 'bt-most', title: 'The time you use most' }, ' most used') : null),
    h('span', { class: 'bt-track', role: 'img', 'aria-label': `${row.lift} times a typical post` },
      h('i', { class: 'bt-mid' }),
      h('i', { class: 'bt-fill', style: { left: `${from}%`, width: `${width}%` } }),
      h('i', { class: 'bt-range', style: { left: `${pos(row.lo)}%`, width: `${Math.max(1, pos(row.hi) - pos(row.lo))}%` } })),
    h('span', { class: 'bt-v' }, h('b', {}, `${row.lift}×`), h('span', { class: 'muted' }, ` · ${row.n}`)));
}

function chart(title, rows, hint) {
  const most = rows.reduce((m, r) => (r.n > (m?.n ?? 0) ? r : m), null);
  return h('div', { class: 'bt-chart' }, h('h4', { class: 'lbl' }, title), hint ? h('p', { class: 'muted bt-hint' }, hint) : null,
    h('ul', { class: 'bt-rows', 'aria-label': title }, rows.map((r) => bar(r, { most: !!most && most.n >= 10 && r === most }))));
}

const TOTAL_LABELS = [['views', 'Views'], ['reach', 'Reach'], ['likes', 'Likes'], ['comments', 'Comments'], ['shares', 'Shares'], ['saves', 'Saves'], ['follows', 'Follows'], ['linkClicks', 'Link clicks']];
const nf0 = new Intl.NumberFormat('en-AU', { maximumFractionDigits: 0 });

/**
 * "From Buffer": this brand's own totals for the last 28 days, read from the posts Buffer reports as sent. No calendar item is needed,
 * so there are numbers as soon as the pull has run, including for posts made before Nordle. Per-post numbers (the scored list below)
 * appear for posts Nordle scheduled itself; this card says how many posts had numbers at all.
 */
export function totalsPanel(pr) {
  const body = h('div', { class: 'bt-body' }, skeleton(2));
  const sec = h('section', { class: 'bt bt-totals', id: `bt-totals-${pr.id}`, 'aria-label': 'From Buffer' },
    h('div', { class: 'ins-ghead' }, h('h3', { class: 'lbl' }, 'From Buffer, last 28 days')), body);
  const again = () => { if (!sec.isConnected) { document.removeEventListener('nordle-insights-refresh', again); return; } fill(); };
  document.addEventListener('nordle-insights-refresh', again);
  const fill = () => api.get(`/publish/buffer-totals?project=${encodeURIComponent(pr.id)}&days=28`).then((t) => {
    if (!t.hasPull || !t.posts) {
      body.replaceChildren(h('p', { class: 'muted' }, t.hasPull ? 'No posts went out in the last 28 days.' : 'Nothing has been pulled from Buffer yet. Press “Update from Buffer” below.'));
      return;
    }
    const m = t.metrics ?? {};
    const tiles = TOTAL_LABELS.filter(([k]) => m[k] !== undefined).map(([k, label]) => h('div', { class: 'tot' }, h('b', {}, nf0.format(m[k])), h('span', { class: 'muted' }, label)));
    body.replaceChildren(
      h('div', { class: 'tot-row' }, h('div', { class: 'tot' }, h('b', {}, nf0.format(t.posts)), h('span', { class: 'muted' }, 'Posts sent')), tiles),
      h('p', { class: 'muted bt-hint' }, `${nf0.format(t.withNumbers)} of ${nf0.format(t.posts)} posts had results from Buffer yet${t.pulledAt ? `, updated ${dateFmt.ago(t.pulledAt)}` : ''}. Instagram and Facebook each count a post once, so a post on both counts twice. Buffer reports zero for results it does not have yet, so recent posts can be low.`));
  }).catch(() => body.replaceChildren(h('p', { class: 'muted' }, 'Could not read the Buffer totals.')));
  fill();
  return sec;
}

/** The "When to post" section for one brand. It loads by itself; "Update from Buffer" pulls fresh results. */
export function timesPanel(pr) {
  const body = h('div', { class: 'bt-body' }, skeleton(3));
  const status = h('span', { class: 'muted bt-status' });
  const sync = h('button', { class: 'btn', type: 'button', 'data-act': 'bt-sync', title: 'Ask Buffer for the posts that have gone out and how they did (a few requests)', onclick: () => pull(false) }, icon('calendarSend', 14), 'Update from Buffer');
  const sec = h('section', { class: 'bt', id: `bt-${pr.id}`, 'aria-label': 'When to post' },
    h('div', { class: 'ins-ghead' }, h('h3', { class: 'lbl' }, 'When to post'), h('span', { class: 'sp' }), status, sync),
    h('p', { class: 'ins-gnote muted' }, 'Worked out from this brand\'s own posts that went out through Buffer. Each post is compared with the same channel\'s usual result, so a big page and a small one count the same. Only times you have actually used can show up here.'),
    body);

  async function pull(force = false) {
    sync.disabled = true; status.textContent = 'Asking Buffer…';
    try {
      const r = await api.post('/publish/sync-posts', { project: pr.id, ...(force ? { force: true } : {}) });
      if (r.skipped) { notify(r.message, { kind: 'info', ms: 12000, action: { label: 'Pull anyway', fn: () => pull(true) } }); status.textContent = ''; sync.disabled = false; return; }
      const m = r.metrics;
      notify(`Pulled ${plural(r.fetched, 'post')} from Buffer in ${plural(r.requests, 'request')}.${r.incomplete ? ` Not everything: ${r.incomplete}.` : ''}${m?.ok ? ` ${m.matched} matched a post in Nordle and now have numbers in Insights; ${m.unmatched} were made outside Nordle and count in the totals only.` : ''}`, { kind: r.incomplete ? 'info' : 'ok', ms: 12000 });
      document.dispatchEvent(new Event('nordle-insights-refresh'));
    } catch (e) { notify(e.message, { kind: 'error' }); status.textContent = ''; sync.disabled = false; return; }
    sync.disabled = false;
    await show();
  }

  function render(r) {
    if (!r.analysis) {
      body.replaceChildren(h('div', { class: 'bt-empty' }, h('p', {}, 'Nordle has not looked at this brand\'s Buffer history yet.'), h('p', { class: 'muted' }, 'Press “Update from Buffer”. It reads the posts that have gone out and how they did, using a handful of requests.')));
      status.textContent = '';
      return;
    }
    const a = r.analysis;
    const day = r.allowance?.windows?.['1day'];
    status.textContent = [r.pulledAt ? `Updated ${dateFmt.ago(r.pulledAt)}` : '', Number.isFinite(day?.left) ? `${day.left} of ${day.limit} Buffer requests left today` : ''].filter(Boolean).join(' · ');
    const c = a.counts;
    const notes = [c.tooNew ? `${plural(c.tooNew, 'post')} from the last day and a half are left out until their results settle` : null, c.unmeasured ? `${plural(c.unmeasured, 'post')} had no measured result` : null].filter(Boolean);
    const next = r.suggestions ?? [];
    body.replaceChildren(...[
      h('p', { class: 'bt-count' }, h('b', {}, `${c.used} posts`), ` with settled results across ${plural(c.channels, 'channel')}, ${dm(c.from)} to ${dm(c.to)}.`, notes.length ? h('span', { class: 'muted' }, ` ${notes.join('; ')}.`) : null),
      next.length ? h('div', { class: 'bt-next' }, h('h4', { class: 'lbl' }, 'Good times coming up'),
        h('ul', { class: 'bt-slots' }, next.map((x) => h('li', { class: `bt-slot ${x.confidence}`, title: x.reason },
          h('b', {}, x.label), h('span', { class: 'muted' }, ` · ${new Date(x.iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })}`), h('span', { class: 'bt-conf' }, x.confidence === 'clear' ? 'clear evidence' : x.confidence === 'likely' ? 'looks better' : 'a guess'), h('span', { class: 'muted' }, ` ${x.lift}× a typical post, ${plural(x.n, 'post')}`)))),
        h('p', { class: 'muted bt-hint' }, 'These appear as choices when you press Schedule.')) : h('p', { class: 'muted' }, 'No time stands out yet. See the charts for what each day and hour has done.'),
      h('div', { class: 'bt-charts' },
        chart('By day of the week', a.weekday, 'Bars to the right of the line did better than usual; the thin line is the range a lucky or unlucky post could move it. The number after the dot is how many posts.'),
        chart('By hour of the day', a.hour.map((x) => ({ ...x, label: x.label })), 'The hour the post went out, on the brand\'s own clock.')),
      a.combos.length ? h('details', { class: 'ins-fold' }, h('summary', {}, h('span', { class: 'lbl' }, 'Best day-and-hour combinations')),
        h('ul', { class: 'bt-rows' }, a.combos.slice(0, 10).map((x) => bar({ ...x, label: x.label })))) : null,
      h('details', { class: 'ins-fold' }, h('summary', {}, h('span', { class: 'lbl' }, 'How to read this')), h('ul', { class: 'ins-ul muted' }, a.caveats.map((t) => h('li', {}, t)))),
    ].filter(Boolean));
  }

  async function show() {
    try { render(await api.get(`/publish/best-times?project=${encodeURIComponent(pr.id)}&count=4`)); } catch (e) { body.replaceChildren(h('p', { class: 'ins-err' }, e.message)); }
  }
  show();
  return sec;
}
