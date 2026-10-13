// Simple mode of the Create page: three steps, one decision each.
//   1. Say what you want: one sentence, what kind, how many.
//   2. Pick from the board: every idea is drawn as a strip of frames (the shots of a reel, the slides of a carousel) in the brand's colours, so you can see
//      it before anything is built. Keep it, ask for "Another like this", or pin a note on it for Claude.
//   3. Claude makes them: they go on the calendar approved and into the build queue (one at a time), and you watch them arrive.
// The ideas come from what Nordle knows about the brand (free and instant), or from Claude (it writes them; uses the owner's Claude usage).
// Advanced mode (studio-create.js) keeps every control. Server routes used: GET /calendar/suggest, POST /calendar/items, POST /calendar/run,
// GET /calendar/run-status, GET /calendar, POST /calendar/items/:id/approve.

import { api } from './api.js';
import { h, icon } from './dom.js';
import { S, addMonths, dateFmt, load, monthOf } from './studio-store.js';
import { FORMAT_LABEL, buildLine, claudeSignIn, elapsed, glyph, notify, plural } from './studio-ui.js';

export const sm = { text: '', kind: 'auto', count: 3, cards: [], reserve: [], picked: new Set(), notes: {}, open: null, busy: '', error: '', short: '', made: [], claude: null, timer: 0, brand: null };

const KINDS = [['auto', 'Let Nordle choose'], ['reel', 'Reels'], ['carousel', 'Carousels'], ['post', 'Single posts']];
const COUNTS = [[1, 'One'], [3, 'Three'], [8, 'A month']];
const nextMonth = () => addMonths(monthOf(S.today), 1);

/** Read the sentence the way a person means it: "three reels about the team" sets the kind, the number and the style. Choices made with the chips win. */
export function readAsk(text, { kind = 'auto', count = 3 } = {}) {
  const t = ` ${String(text ?? '').toLowerCase()} `;
  const formats = kind !== 'auto' ? [kind]
    : [['reel', /\b(reels?|videos?|clips?)\b/], ['carousel', /\b(carousels?|slides?|swipe)\b/], ['post', /\b(posts?|graphics?|images?|tiles?)\b/], ['story', /\bstor(y|ies)\b/]].filter(([, re]) => re.test(t)).map(([f]) => f);
  const words = { one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, ten: 10, twelve: 12 };
  const num = /\b(\d{1,2}|an?|one|two|three|four|five|six|seven|eight|ten|twelve)\s+(reels?|videos?|carousels?|posts?|ideas?|graphics?|stor(?:y|ies))\b/.exec(t);
  const said = num ? (Number(num[1]) || words[num[1]]) : null;
  const styles = [['team', /\b(team|staff|meet|people|who we are)\b/], ['educate', /\b(explain|how|what is|guide|tips?|learn)\b/], ['faq', /\b(questions?|faq|ask)\b/],
    ['behind', /\b(behind|process|day in|how we)\b/], ['seasonal', /\b(christmas|easter|season|holiday|occasion|cup|new year|mother'?s|father'?s)\b/], ['community', /\b(community|local|charity|sponsor)\b/],
    ['invite', /\b(book|offer|promot|invite|visit|call)\b/]].filter(([, re]) => re.test(t)).map(([s]) => s);
  return { formats, styles, count: Math.max(1, Math.min(20, said ?? count)) };
}

/** The brand's colours sorted into a dark, a light and an accent, for drawing the frames. */
function palette(colors = {}) {
  const hexes = Object.values(colors).filter((c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c));
  const lum = (x) => { const v = [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]; };
  const sat = (x) => { const v = [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16)); return Math.max(...v) - Math.min(...v); };
  const by = [...hexes].sort((a, b) => lum(a) - lum(b));
  const dark = colors.ink ?? by[0] ?? '#1d2125', light = colors.paper ?? by.at(-1) ?? '#f6f1ea';
  const accent = colors.accent ?? [...hexes].filter((x) => x !== dark && x !== light).sort((a, b) => sat(b) - sat(a))[0] ?? '#d97a2b';
  const on = (bg) => (lum(bg) > 0.35 ? dark : light);
  return { dark, light, accent, on };
}

const sentences = (s) => String(s ?? '').split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** What each frame of an idea shows: a reel's shots (with rough seconds), a carousel's slides, a single post. A sketch, not the finished post. */
export function framesFor(card, brandName) {
  const lines = sentences(card.idea).slice(0, 3);
  if (card.format === 'reel') return [{ t: card.hook || card.title, k: 'Hook', at: '0s' }, ...lines.slice(0, 2).map((x, i) => ({ t: x, k: 'Shot', at: `${2 + i * 3}s` })), { t: brandName, k: 'End card', at: `${2 + Math.min(2, lines.length) * 3}s`, end: true }];
  if (card.format === 'carousel') return [{ t: card.title, k: 'Cover', at: '1' }, { t: card.hook || lines[0] || '', k: 'Slide', at: '2' }, ...lines.slice(card.hook ? 0 : 1, 3).map((x, i) => ({ t: x, k: 'Slide', at: String(3 + i) })), { t: brandName, k: 'Last slide', at: 'end', end: true }];
  if (card.format === 'story') return [{ t: card.hook || card.title, k: 'Story', at: '1' }, { t: brandName, k: 'Link', at: '2', end: true }];
  return [{ t: card.title, k: 'Post', at: '', sub: card.hook }];
}

function strip(card, pr) {
  const p = palette(pr.colors);
  const grounds = [p.dark, p.accent, p.light];
  const tall = card.format === 'reel' || card.format === 'story';
  return h('ol', { class: `sb-strip${tall ? ' tall' : ''}`, 'aria-label': `${FORMAT_LABEL[card.format] ?? card.format}: what it shows` },
    framesFor(card, pr.name).map((f, i) => {
      const bg = f.end ? p.dark : grounds[i % grounds.length];
      return h('li', { class: `sb-frame${f.end ? ' end' : ''}`, style: { background: bg, color: p.on(bg) } },
        h('span', { class: 'sb-k', style: { color: bg === p.accent ? p.on(bg) : p.accent } }, f.k),
        h('span', { class: 'sb-t' }, clip(f.t, f.end ? 40 : 70)),
        f.sub ? h('span', { class: 'sb-s' }, clip(f.sub, 60)) : null,
        f.at ? h('span', { class: 'sb-at' }, f.at) : null);
    }));
}

const chip = (label, on, onclick, extra = {}) => h('button', { class: `cr-chip${on ? ' on' : ''}`, type: 'button', 'aria-pressed': on ? 'true' : 'false', onclick, ...extra }, label);

/** Ask Nordle for ideas: from the brand's facts, occasions and the monthly mix. A few spares are kept for "Another like this". */
async function showIdeas(pr, redraw) {
  const ask = readAsk(sm.text, { kind: sm.kind, count: sm.count });
  sm.busy = 'ideas'; sm.error = ''; sm.short = ''; redraw();
  const q = new URLSearchParams({ month: nextMonth(), learn: '1', count: String(Math.min(30, ask.count * 3)) });
  if (ask.formats.length) q.set('formats', ask.formats.join(','));
  if (ask.styles.length) q.set('styles', ask.styles.join(','));
  if (sm.text.trim()) q.set('prompt', sm.text.trim());
  try {
    const r = await api.get(`/projects/${encodeURIComponent(pr.id)}/calendar/suggest?${q}`);
    const all = r.options.map((o) => ({ ...o, key: `n-${o.id}-${Date.now() % 100000}`, source: 'nordle' }));
    // spread the ones shown across the kinds and styles, keep the rest as spares
    const shown = [];
    for (const o of all) { if (shown.length >= ask.count) break; if (!shown.some((x) => x.style === o.style && x.format === o.format) || all.length - shown.length <= ask.count - shown.length) shown.push(o); }
    for (const o of all) { if (shown.length >= ask.count) break; if (!shown.includes(o)) shown.push(o); }
    sm.cards = shown; sm.reserve = all.filter((o) => !shown.includes(o));
    sm.picked = new Set(shown.map((c) => c.key)); sm.notes = {}; sm.made = [];
    if (!shown.length) sm.short = 'Nordle could not make ideas for that from what it knows about this brand yet. Let Claude write them, or add the team and services to the brand\'s facts.';
    else if (shown.length < ask.count) sm.short = `Nordle found ${plural(shown.length, 'idea')} from what it knows about this brand. Let Claude write more if you want ${ask.count}.`;
  } catch (e) { sm.error = e.message; }
  sm.busy = ''; redraw();
}

/** Swap one idea for a spare of the same kind (or any spare), like asking for another take. */
function another(card, redraw) {
  const i = sm.reserve.findIndex((o) => o.format === card.format && o.style !== card.style) ?? -1;
  const j = i >= 0 ? i : sm.reserve.findIndex((o) => o.format === card.format);
  const k = j >= 0 ? j : sm.reserve.findIndex(() => true);
  if (k < 0) { notify('No more ideas like this from what Nordle knows. Let Claude write some instead.', { kind: 'info' }); return; }
  const [next] = sm.reserve.splice(k, 1);
  const at = sm.cards.indexOf(card);
  sm.cards[at] = next;
  if (sm.picked.delete(card.key)) sm.picked.add(next.key);
  delete sm.notes[card.key];
  redraw();
}

/** Claude writes the ideas instead (on this computer, under the owner's sign-in). They land on the calendar as ideas, and on this board. */
async function askClaude(pr, redraw) {
  const ask = readAsk(sm.text, { kind: sm.kind, count: sm.count });
  const words = [sm.text.trim() || 'Ideas for the next month.', `Make ${ask.count} ${ask.formats.length ? ask.formats.map((f) => (FORMAT_LABEL[f] ?? f).toLowerCase()).join(' or ') : 'posts of whatever kinds fit best'}.`].join(' ');
  sm.error = ''; sm.made = [];
  try {
    await api.post(`/projects/${encodeURIComponent(pr.id)}/calendar/run`, { action: 'propose', months: [nextMonth()], extra: `\n## What the owner asked for on the Create page\n\n- In the owner's words: "${words.slice(0, 1500)}"\n- Propose exactly ${ask.count} idea(s).` });
    sm.claude = { startedAt: new Date().toISOString(), state: 'working', count: ask.count };
  } catch (e) { sm.error = e.message; }
  redraw();
  watch(pr, redraw);
}

/** Follow Claude while it writes, then put what it wrote on the board. */
async function watch(pr, redraw) {
  clearTimeout(sm.timer);
  if (sm.claude?.state !== 'working') return;
  try {
    const r = await api.get(`/projects/${encodeURIComponent(pr.id)}/calendar/run-status`);
    if (r.running?.kind === 'propose' || (r.queue ?? []).some((q) => q.kind === 'propose')) { sm.claude.running = r.running; sm.timer = setTimeout(() => watch(pr, redraw), 3000); return redraw(); }
    const last = r.last;
    if (last?.kind === 'propose' && last.outcome !== 'proposed') { sm.claude = { ...sm.claude, state: 'failed', error: last.error ?? 'Claude did not add any ideas.' }; return redraw(); }
    const m = nextMonth();
    const cal = (await api.get(`/projects/${encodeURIComponent(pr.id)}/calendar?from=${m}-01&to=${addMonths(m, 1)}-01`)).calendar;
    const fresh = (cal.items ?? []).filter((i) => i.status === 'idea' && (i.updated ?? '') >= sm.claude.startedAt);
    sm.cards = fresh.map((i) => ({ key: `c-${i.id}`, source: 'calendar', itemId: i.id, date: i.date, time: i.time, format: i.format, title: i.title, idea: i.idea, hook: i.hook, styleLabel: 'Written by Claude', why: i.notes ?? '' }));
    sm.reserve = []; sm.picked = new Set(sm.cards.map((c) => c.key)); sm.notes = {};
    sm.claude = { ...sm.claude, state: 'done', added: fresh.length };
    await load({ force: true });
  } catch (e) { sm.claude = { ...sm.claude, state: 'failed', error: e.message }; }
  redraw();
}

/** Step 3: the picked ideas go on the calendar approved and Claude builds them, one at a time. `now: false` keeps them as ideas for later. */
async function make(pr, redraw, { now }) {
  const chosen = sm.cards.filter((c) => sm.picked.has(c.key));
  if (!chosen.length) return;
  sm.busy = now ? 'making' : 'saving'; sm.error = ''; redraw();
  const base = `/projects/${encodeURIComponent(pr.id)}/calendar`;
  const made = [];
  try {
    const fresh = chosen.filter((c) => c.source !== 'calendar');
    if (fresh.length) {
      const items = fresh.map((c) => ({ date: c.date, ...(c.time ? { time: c.time } : {}), format: c.format, title: c.title, idea: c.idea, hook: c.hook, ...(c.pillar ? { pillar: c.pillar } : {}), ...(c.occasion ? { occasion: c.occasion } : {}), ...(sm.notes[c.key]?.trim() ? { guidance: sm.notes[c.key].trim().slice(0, 2000) } : {}), status: now ? 'approved' : 'idea' }));
      const r = await api.post(`${base}/items`, { items });
      for (const it of r.items ?? []) made.push({ itemId: it.id, title: it.title, format: it.format });
      if (r.rejected?.length) sm.error = `${plural(r.rejected.length, 'idea')} could not be added: ${r.rejected[0].errors?.[0]?.message ?? 'a check failed'}.`;
    }
    for (const c of chosen.filter((x) => x.source === 'calendar')) {
      if (sm.notes[c.key]?.trim()) await api.patch(`${base}/items/${encodeURIComponent(c.itemId)}`, { guidance: sm.notes[c.key].trim().slice(0, 2000) });
      if (now) await api.post(`${base}/items/${encodeURIComponent(c.itemId)}/approve`, {});
      made.push({ itemId: c.itemId, title: c.title, format: c.format });
    }
    if (now) for (const m of made) await api.post(`${base}/run`, { action: 'build', item: m.itemId });
    sm.made = made.map((m) => ({ ...m, uid: `${pr.id}:${m.itemId}`, now }));
    sm.cards = sm.cards.filter((c) => !sm.picked.has(c.key));
    sm.picked = new Set();
    await load({ force: true });
    notify(now ? `Claude is making ${plural(made.length, 'post')}, one at a time.` : `${plural(made.length, 'idea')} saved in the Plan.`, { kind: 'ok' });
  } catch (e) { sm.error = e.message; }
  sm.busy = ''; redraw();
  follow(redraw);
}

/** While the posts are being made, look again every few seconds so their progress shows. */
function follow(redraw) {
  clearTimeout(sm.follow);
  const waiting = sm.made.some((m) => m.now && ['approved', 'building', undefined].includes(S.byUid.get(m.uid)?.status));
  if (!waiting) return;
  sm.follow = setTimeout(async () => { try { await load({ force: true }); } catch { /* try again next time */ } redraw(); follow(redraw); }, 5000);
}

function steps() {
  const at = sm.made.length ? 3 : sm.cards.length ? 2 : 1;
  const step = (n, label) => h('li', { class: `sp-step${n === at ? ' now' : n < at ? ' done' : ''}`, 'aria-current': n === at ? 'step' : undefined }, h('span', { class: 'sp-n' }, n < at ? icon('check', 13) : String(n)), label);
  return h('ol', { class: 'sp-steps', 'aria-label': 'Steps' }, step(1, 'Say what you want'), step(2, 'Pick from the board'), step(3, 'Claude makes them'));
}

function askCard(pr, redraw) {
  const t = h('textarea', { class: 'field sp-ask', rows: 2, 'data-field': 'simple-ask', 'aria-label': 'What do you want to post?', placeholder: 'e.g. Three reels introducing the team, warm and a little funny' });
  t.value = sm.text;
  t.addEventListener('input', () => { sm.text = t.value; });
  t.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); showIdeas(pr, redraw); } });
  const working = sm.claude?.state === 'working';
  return h('section', { class: 'cr-card sp-card', 'aria-label': 'What do you want to post?', 'data-section': 'simple-ask' },
    h('h3', { class: 'sp-q' }, 'What do you want to post?'),
    t,
    h('div', { class: 'cr-row' }, h('span', { class: 'lbl-i' }, 'Kind'),
      h('div', { class: 'cr-chips', role: 'group', 'aria-label': 'Kind of post' }, KINDS.map(([k, label]) => chip(label, sm.kind === k, () => { sm.kind = k; redraw(); }, { 'data-kind': k })))),
    h('div', { class: 'cr-row' }, h('span', { class: 'lbl-i' }, 'How many'),
      h('div', { class: 'cr-chips', role: 'group', 'aria-label': 'How many' }, COUNTS.map(([n, label]) => chip(label, sm.count === n, () => { sm.count = n; redraw(); }, { 'data-count': n })))),
    h('div', { class: 'cr-go sp-go' },
      h('button', { class: 'btn primary cr-big', type: 'button', 'data-act': 'simple-ideas', disabled: !!sm.busy || working, onclick: () => showIdeas(pr, redraw) }, sm.busy === 'ideas' ? 'Looking…' : sm.cards.length ? 'Show me different ideas' : 'Show me ideas'),
      h('button', { class: 'btn', type: 'button', 'data-act': 'simple-claude', disabled: !!sm.busy || working, onclick: () => askClaude(pr, redraw), title: 'Claude writes them from your words. Uses your Claude usage (about 20 to 30 cents).' }, icon('sparkle', 14), 'Let Claude write them'),
      h('span', { class: 'muted sp-help' }, 'Ideas are free and instant. Claude writes them from your exact words, in a few minutes.')),
    claudeLine(pr, redraw));
}

function claudeLine(pr, redraw) {
  const c = sm.claude;
  if (!c) return null;
  if (c.state === 'working') return h('div', { class: 'build-line live', role: 'status', 'data-state': 'simple-claude-working' }, h('i', { class: 'spin', 'aria-hidden': 'true' }), h('span', {}, h('b', {}, 'Claude is writing your ideas'), ` · ${elapsed(c.startedAt)}. They appear here when they are ready. You can leave this page.`));
  if (c.state === 'failed') {
    const out = /not signed in/i.test(c.error ?? '');
    return h('div', { class: 'build-line', role: 'alert', 'data-state': 'simple-claude-failed' }, icon('alert', 14), h('span', { class: 'bad' }, out ? 'Claude is not signed in on this computer. ' : c.error),
      out ? claudeSignIn({ onReady: () => { sm.claude = null; notify('Signed in. Press Let Claude write them again.', { kind: 'ok' }); redraw(); } }) : null);
  }
  if (c.state === 'done' && !c.added) return h('div', { class: 'build-line', role: 'status' }, icon('alert', 14), h('span', {}, 'Claude finished but added no new ideas. Try different words.'));
  return null;
}

function card(c, pr, redraw) {
  const on = sm.picked.has(c.key);
  const noting = sm.open === c.key;
  const note = sm.notes[c.key] ?? '';
  return h('li', { class: `sb-card${on ? ' on' : ''}`, dataset: { key: c.key } },
    strip(c, pr),
    h('div', { class: 'sb-body' },
      h('div', { class: 'cr-opt-top' }, glyph(c.format, 13), h('span', { class: 'cr-fmt' }, FORMAT_LABEL[c.format] ?? c.format), c.date ? h('span', { class: 'cr-date' }, `${dateFmt.weekday(c.date)} ${dateFmt.dm(c.date)}`) : null, c.styleLabel ? h('span', { class: 'cr-style' }, c.styleLabel) : null),
      h('strong', { class: 'cr-title' }, c.title),
      c.idea ? h('span', { class: 'cr-idea' }, c.idea) : null,
      note && !noting ? h('p', { class: 'sb-note', 'data-state': 'simple-note' }, icon('pin', 12), ' ', note) : null,
      noting ? (() => {
        const ta = h('textarea', { class: 'field', rows: 2, maxlength: 2000, 'data-field': 'simple-note', 'aria-label': `A note for Claude about ${c.title}`, placeholder: 'A note for Claude: who to feature, what to stress, what to avoid' });
        ta.value = note;
        ta.addEventListener('input', () => { sm.notes[c.key] = ta.value; });
        queueMicrotask(() => ta.focus());
        return h('div', { class: 'sb-noting' }, ta, h('button', { class: 'btn sm', type: 'button', 'data-act': 'simple-note-done', onclick: () => { sm.open = null; redraw(); } }, 'Done'));
      })() : null,
      h('div', { class: 'sb-acts' },
        h('button', { class: `btn sm${on ? ' go' : ''}`, type: 'button', 'data-act': 'simple-keep', 'aria-pressed': on ? 'true' : 'false', onclick: () => { if (on) sm.picked.delete(c.key); else sm.picked.add(c.key); redraw(); } }, on ? icon('check', 13) : null, on ? 'Keeping' : 'Keep'),
        c.source !== 'calendar' ? h('button', { class: 'btn sm quiet', type: 'button', 'data-act': 'simple-another', onclick: () => another(c, redraw), title: 'Swap it for a different idea of the same kind' }, 'Another like this') : null,
        h('button', { class: 'btn sm quiet', type: 'button', 'data-act': 'simple-note', onclick: () => { sm.open = noting ? null : c.key; redraw(); } }, icon('pin', 13), note ? 'Edit note' : 'Note for Claude'))));
}

function board(pr, redraw) {
  if (!sm.cards.length && !sm.short) return null;
  const n = sm.cards.filter((c) => sm.picked.has(c.key)).length;
  return h('section', { class: 'cr-card sp-board', 'aria-label': 'The board', 'data-state': 'simple-board' },
    h('header', { class: 'cr-rh' }, h('h3', { class: 'lbl' }, sm.cards.length ? `${plural(sm.cards.length, 'idea')}: keep the ones you like` : 'No ideas yet'),
      sm.cards.length ? h('span', { class: 'muted' }, 'Each strip is a sketch of the post, frame by frame. Nothing is made until you say.') : null),
    sm.short ? h('p', { class: 'cr-note', role: 'note' }, sm.short) : null,
    sm.cards.length ? h('ul', { class: 'sb-cards' }, sm.cards.map((c) => card(c, pr, redraw))) : null,
    sm.cards.length ? h('footer', { class: 'sp-bar', 'data-state': 'simple-bar' },
      h('span', { class: 'cr-count' }, n ? `${plural(n, 'post')} picked` : 'Pick at least one'),
      h('button', { class: 'btn go', type: 'button', 'data-act': 'simple-make', disabled: !n || !!sm.busy, onclick: () => make(pr, redraw, { now: true }), title: 'They go on the calendar and Claude builds them now, one at a time' }, sm.busy === 'making' ? 'Starting…' : `Make ${n === 1 ? 'it' : 'them'} now`),
      h('button', { class: 'btn', type: 'button', 'data-act': 'simple-save', disabled: !n || !!sm.busy, onclick: () => make(pr, redraw, { now: false }), title: 'They wait in the Plan as ideas. Nothing is built until you say' }, 'Save for later'),
      h('span', { class: 'muted sp-cost' }, n ? `Claude builds each one with your Claude usage (about $1 to $2 a post).` : '')) : null);
}

function progress() {
  if (!sm.made.length) return null;
  const rows = sm.made.map((m) => {
    const p = S.byUid.get(m.uid);
    const ready = p && ['built', 'changes', 'signed-off', 'scheduled', 'posted'].includes(p.status);
    return h('li', { class: 'sp-made', 'data-state': ready ? 'ready' : 'making' },
      glyph(m.format, 13), h('b', {}, m.title), ' ',
      !m.now ? h('span', { class: 'muted' }, 'Saved as an idea in the Plan.')
        : ready ? h('a', { class: 'btn sm go', href: `#/s/month?post=${encodeURIComponent(m.uid)}&month=${encodeURIComponent((p.date ?? S.today).slice(0, 7))}`, 'data-act': 'simple-review' }, 'Ready: review it')
          : p?.build ? buildLine(p) : h('span', { class: 'muted' }, 'Waiting to start.'));
  });
  return h('section', { class: 'cr-card sp-progress', 'aria-label': 'Being made', 'data-state': 'simple-progress' },
    h('h3', { class: 'lbl' }, sm.made.some((m) => m.now) ? 'Claude is making these' : 'Saved for later'),
    h('ul', { class: 'sp-mades' }, rows),
    h('p', { class: 'muted' }, 'You can leave this page: each post shows on the calendar, and a notice says when one is ready. ', h('a', { href: '#/s/plan' }, 'Open the plan')));
}

/** The whole Simple page body (the header with the brand and the mode switch is drawn by studio-create.js). */
export function simpleView(pr, redraw) {
  if (sm.brand !== pr.id) Object.assign(sm, { brand: pr.id, cards: [], reserve: [], picked: new Set(), notes: {}, open: null, made: [], claude: null, short: '', error: '' });
  if (sm.claude?.state === 'working' && !sm.timer) watch(pr, redraw);
  return [steps(), askCard(pr, redraw), sm.error ? h('p', { class: 'cr-err', role: 'alert' }, sm.error) : null, board(pr, redraw), progress()].filter(Boolean);
}
