// Import a platform's analytics export (a CSV) into <project>/metrics.json, matched to the calendar's posts.
//
// The export formats of Meta Business Suite and Buffer are not published column by column, and they change, so nothing here is
// tied to one layout: headers are matched case-insensitively against a list of synonyms (see HEADER_SYNONYMS), unknown columns are
// reported and ignored, and `columns` lets the owner say what a column means. Rows are matched to calendar posts by, in order:
//   (a) a calendar item id found in any cell of the row            -> kind 'id'
//   (b) the first 60 characters of the caption equal the post's     -> kind 'caption'
//   (c) publish date within a day AND the caption starts alike      -> kind 'date+caption'
// A row that matches nothing, or more than one post, is reported (unmatched / ambiguous) and never written: no guessing.
// A dry run is the default; `yes` writes.

import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { diffDays, isDate, iso, todayIn } from '../calendar/dates.mjs';
import { loadProject } from '../calendar/service.mjs';
import { METRIC_KEYS, PerformanceError, WINDOWS, cleanMetrics, upsertEntries } from './model.mjs';

// ---- CSV ---------------------------------------------------------------------------------------------------------------------

/** Decode the bytes of an export: UTF-8 (with or without a BOM) or the UTF-16 that Excel's "Unicode text" saves. */
export function decodeExport(buf) {
  if (typeof buf === 'string') return buf.replace(/^﻿/, '');
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2)); b.swap16(); return b.toString('utf16le'); }
  return buf.toString('utf8').replace(/^﻿/, '');
}

function sniffDelimiter(text) {
  const head = text.split(/\r?\n/).find((l) => l.trim() && !/^sep=/i.test(l)) ?? '';
  let best = ',', bestN = 0;
  for (const d of [',', ';', '\t']) {
    let n = 0, q = false;
    for (const c of head) { if (c === '"') q = !q; else if (c === d && !q) n++; }
    if (n > bestN) { best = d; bestN = n; }
  }
  return best;
}

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. Returns { rows:string[][], delimiter }. */
export function parseCsv(text, delimiter) {
  let src = String(text).replace(/^﻿/, '');
  const sep = src.match(/^sep=(.)\r?\n/i);
  if (sep) { delimiter ??= sep[1]; src = src.slice(sep[0].length); }
  const d = delimiter ?? sniffDelimiter(src);
  const rows = [];
  let row = [], cell = '', q = false, i = 0;
  const endCell = () => { row.push(cell); cell = ''; };
  const endRow = () => { endCell(); if (row.some((c) => c.trim() !== '')) rows.push(row); row = []; };
  while (i < src.length) {
    const c = src[i];
    if (q) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i += 2; continue; } q = false; i++; continue; }
      cell += c; i++; continue;
    }
    if (c === '"' && cell === '') { q = true; i++; continue; }
    if (c === d) { endCell(); i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { endRow(); i++; continue; }
    cell += c; i++;
  }
  if (cell !== '' || row.length) endRow();
  return { rows, delimiter: d };
}

// ---- headers -----------------------------------------------------------------------------------------------------------------

export const normHeader = (h) => String(h ?? '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();

const list = (...xs) => xs;
/** Field -> the header spellings (after normHeader) that mean it. The first listed field spelling wins when two columns map to one field. */
export const HEADER_SYNONYMS = {
  // what the row is
  caption: list('description', 'caption', 'post caption', 'text', 'post text', 'message', 'post message', 'content', 'post content', 'copy'),
  captionAlt: list('title', 'post title', 'headline'),
  published: list('publish time', 'published time', 'publish date', 'published', 'published at', 'post created', 'post created at', 'post date', 'date published', 'time published', 'posted at', 'posted', 'sent at', 'created', 'created at', 'created time', 'creation time', 'date'),
  permalink: list('permalink', 'post link', 'post url', 'permalink url', 'link', 'url', 'post permalink'),
  postId: list('post id', 'media id', 'id', 'update id'),
  type: list('post type', 'media type', 'content type', 'type', 'format'),
  platform: list('platform', 'network', 'social network', 'channel type'),
  account: list('account username', 'account name', 'username', 'profile', 'channel', 'channel name', 'account'),
  // numbers
  reach: list('reach', 'accounts reached', 'post reach', 'people reached', 'unique reach', 'organic reach', 'lifetime post total reach'),
  impressions: list('impressions', 'post impressions', 'total impressions', 'lifetime post total impressions'),
  views: list('views', 'video views', 'post views', 'total views'),
  plays: list('plays', 'video plays', 'reel plays', 'reels plays', 'ig reels plays', 'initial plays', 'total plays'),
  likes: list('likes', 'like', 'post likes', 'reactions', 'total reactions', 'likes and reactions'),
  comments: list('comments', 'comment', 'post comments', 'comments count', 'replies'),
  shares: list('shares', 'share', 'post shares', 'reposts', 'shares reposts'),
  saves: list('saves', 'save', 'saved', 'post saves', 'bookmarks'),
  follows: list('follows', 'follow', 'follower gain', 'followers gained', 'new followers', 'follows from post'),
  profileVisits: list('profile visits', 'profile views', 'profile visit'),
  linkClicks: list('link clicks', 'link click', 'clicks', 'website clicks', 'post clicks', 'outbound clicks'),
  watchTimeSec: list('watch time', 'total watch time', 'video watch time', 'view time', 'total view time'),
  avgWatchSec: list('average watch time', 'avg watch time', 'average time watched', 'avg time watched', 'average view duration', 'avg view duration', 'average video watch time', 'average view time'),
  completionRate: list('completion rate', 'video completion rate', 'watched to end', 'completion'),
  dmStarts: list('dm starts', 'messages started', 'conversations started', 'messaging conversations started', 'new messaging conversations'),
  swipes: list('swipes', 'carousel swipes', 'swipe throughs'),
};
const FIELD_OF = new Map();
for (const [field, names] of Object.entries(HEADER_SYNONYMS)) names.forEach((n, i) => { if (!FIELD_OF.has(n)) FIELD_OF.set(n, { field, rank: i }); });
const META_FIELDS = new Set(['caption', 'captionAlt', 'published', 'permalink', 'postId', 'type', 'platform', 'account']);

/** "(ms)", "(min)", "(hours)" in a header: seconds per unit. */
function unitOf(header) {
  const h = String(header).toLowerCase();
  if (/\b(ms|milliseconds?)\b/.test(h)) return 0.001;
  if (/\b(min|mins|minutes?)\b/.test(h)) return 60;
  if (/\b(hr|hrs|hours?)\b/.test(h)) return 3600;
  return 1;
}

/** Work out what each column is. columns: { 'Header as written': 'metricKey' | 'caption' | 'ignore' ... } overrides. */
export function mapHeaders(headers, columns = {}) {
  const override = new Map(Object.entries(columns).map(([k, v]) => [normHeader(k), v]));
  const mapped = [], unknown = [];
  const taken = new Map();
  headers.forEach((raw, index) => {
    const n = normHeader(raw);
    if (!n) return;
    let hit = null;
    if (override.has(n)) hit = override.get(n) === 'ignore' ? null : { field: override.get(n), rank: -1 };
    else hit = FIELD_OF.get(n) ?? null;
    if (!hit) { unknown.push(String(raw).trim()); return; }
    if (override.has(n) && hit && ![...META_FIELDS, ...METRIC_KEYS].includes(hit.field)) { unknown.push(String(raw).trim()); return; }
    const prev = taken.get(hit.field);
    if (prev && prev.rank <= hit.rank) { unknown.push(`${String(raw).trim()} (second column for ${hit.field}: ignored)`); return; }
    if (prev) unknown.push(`${String(prev.raw).trim()} (second column for ${hit.field}: ignored)`);
    taken.set(hit.field, { index, raw, rank: hit.rank });
  });
  for (const [field, v] of taken) mapped.push({ header: String(v.raw).trim(), field, index: v.index, unit: unitOf(v.raw) });
  return { mapped, unknown };
}

// ---- values ------------------------------------------------------------------------------------------------------------------

/** "1,234", "1.2K", "3M", "45%", "-" -> number (or null). Percentages are returned as the number before the % sign. */
export function parseNumber(s, { decimalComma = false } = {}) {
  let t = String(s ?? '').trim();
  if (!t || /^(-|--|–|—|n\/?a|null|none|unavailable|\.\.\.)$/i.test(t)) return null;
  t = t.replace(/\s/g, '');
  const pct = t.endsWith('%');
  t = t.replace(/%$/, '');
  if (decimalComma || /^\d{1,3}(\.\d{3})+,\d+$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else t = t.replace(/,/g, '');
  const m = /^(-?\d*\.?\d+)([kKmM])?$/.exec(t);
  if (!m) return null;
  let n = Number(m[1]);
  if (m[2]) n *= m[2].toLowerCase() === 'k' ? 1e3 : 1e6;
  return pct ? { pct: n } : n;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const hhmm = (h, m, ap) => {
  let hr = Number(h);
  if (ap) { hr %= 12; if (/pm/i.test(ap)) hr += 12; }
  return `${String(hr).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
};
const validDate = (y, m, d) => isDate(iso(y, m, d));

/** The brand's local date and time of a UTC instant. */
function localParts(ms, timezone) {
  try {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
    const g = (t) => f.find((p) => p.type === t).value;
    return { date: `${g('year')}-${g('month')}-${g('day')}`, time: `${g('hour')}:${g('minute')}` };
  } catch { const d = new Date(ms).toISOString(); return { date: d.slice(0, 10), time: d.slice(11, 16) }; }
}

/**
 * A date (and time) in whatever form an export uses. Returns candidates [{date, time|null, ambiguous}]: a slash date such as
 * 03/11/2026 has two readings unless `order` ('dmy' or 'mdy') says which. Zoned ISO times are converted to the brand's timezone.
 */
export function parseWhen(value, { order, timezone = 'Australia/Melbourne' } = {}) {
  const s = String(value ?? '').trim();
  if (!s) return [];
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s);
  if (m) {
    if (!validDate(+m[1], +m[2], +m[3])) return [];
    if (m[4] !== undefined && m[7]) {
      const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4].padStart(2, '0')}:${m[5]}:${m[6] ?? '00'}${m[7] === 'Z' ? 'Z' : m[7].length === 5 ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : m[7]}`);
      if (Number.isFinite(ms)) return [{ ...localParts(ms, timezone), ambiguous: false }];
    }
    return [{ date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4] !== undefined ? hhmm(m[4], m[5]) : null, ambiguous: false }];
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})(?:[,\sT]+(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?)?$/i.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    const time = m[4] !== undefined ? hhmm(m[4], m[5], m[6]) : null;
    const dmy = validDate(y, +m[2], +m[1]) ? { date: iso(y, +m[2], +m[1]), time } : null;
    const mdy = validDate(y, +m[1], +m[2]) ? { date: iso(y, +m[1], +m[2]), time } : null;
    if (order === 'dmy') return dmy ? [{ ...dmy, ambiguous: false }] : [];
    if (order === 'mdy') return mdy ? [{ ...mdy, ambiguous: false }] : [];
    if (dmy && mdy && dmy.date !== mdy.date) return [{ ...dmy, ambiguous: true }, { ...mdy, ambiguous: true }];
    const one = dmy ?? mdy;
    return one ? [{ ...one, ambiguous: false }] : [];
  }
  m = /^(?:[A-Za-z]+,?\s+)?(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4})(?:[,\sat]+(\d{1,2}):(\d{2})\s*(am|pm)?)?$/i.exec(s)
    ?? null;
  if (m) {
    const mo = MONTHS.indexOf(m[2].toLowerCase()) + 1;
    if (mo && validDate(+m[3], mo, +m[1])) return [{ date: iso(+m[3], mo, +m[1]), time: m[4] !== undefined ? hhmm(m[4], m[5], m[6]) : null, ambiguous: false }];
  }
  m = /^(?:[A-Za-z]+,?\s+)?([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})(?:[,\sat]+(\d{1,2}):(\d{2})\s*(am|pm)?)?$/i.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[1].toLowerCase()) + 1;
    if (mo && validDate(+m[3], mo, +m[2])) return [{ date: iso(+m[3], mo, +m[2]), time: m[4] !== undefined ? hhmm(m[4], m[5], m[6]) : null, ambiguous: false }];
  }
  return [];
}

// ---- text matching -----------------------------------------------------------------------------------------------------------

/** Lower case, no accents, no links, no hashtags marks or punctuation, single spaces: so a caption compares the same in any export. */
export function normText(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/https?:\/\/\S+/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}
const bigrams = (s) => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
/** 0..1 how alike the openings of two captions are (Dice coefficient over letter pairs of the first 100 characters). */
export function captionSimilarity(a, b, n = 100) {
  const x = normText(a).slice(0, n), y = normText(b).slice(0, n);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const k = Math.min(x.length, y.length);
  if (k >= 20 && x.slice(0, k) === y.slice(0, k)) return 0.97;
  const bx = bigrams(x), by = bigrams(y);
  let hit = 0;
  for (const [g, c] of bx) hit += Math.min(c, by.get(g) ?? 0);
  return (2 * hit) / (Math.max(1, x.length - 1) + Math.max(1, y.length - 1));
}
/** True when the first 60 normalised characters agree (or, for a shorter caption, all of it, at least 25 characters). */
export function samePrefix60(a, b) {
  const x = normText(a).slice(0, 60), y = normText(b).slice(0, 60);
  const k = Math.min(x.length, y.length);
  return k >= 25 && x.slice(0, k) === y.slice(0, k);
}

const FORMAT_OF = [[/reel|short|vertical video|clip/i, 'reel'], [/carousel|album|multi|sidecar|swipe/i, 'carousel'], [/story|stories/i, 'story'], [/image|photo|picture|static|single/i, 'post'], [/video/i, 'reel']];
const formatOfType = (t) => FORMAT_OF.find(([re]) => re.test(String(t ?? '')))?.[1] ?? null;
const PLATFORM_OF = [[/insta|^ig$/i, 'instagram'], [/face|^fb$/i, 'facebook'], [/tiktok|tik tok/i, 'tiktok'], [/linked/i, 'linkedin'], [/youtube|^yt$/i, 'youtube'], [/twitter|^x$/i, 'x'], [/threads/i, 'threads'], [/pinterest/i, 'pinterest']];
const platformOf = (t) => PLATFORM_OF.find(([re]) => re.test(String(t ?? '').trim()))?.[1] ?? null;

// ---- the calendar's side of the match ----------------------------------------------------------------------------------------

const readJson = (file) => { try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null; } catch { return null; } };

/** The calendar's items with the words a post went out with (the built post's caption, or an outside post's). */
export function calendarIndex(projectDir) {
  const p = loadProject(projectDir);
  const items = p.cal.items.filter((i) => i.status !== 'rejected').map((item) => {
    const doc = item.doc ? readJson(join(projectDir, 'docs', `${item.doc}.json`)) : null;
    const caption = doc?.copy?.caption ?? item.external?.caption ?? '';
    return { item, caption, hook: item.hook ?? '', normCaption: normText(caption) };
  });
  return { items, project: p };
}

/** Item ids sit in captions, UTM links or notes as whole tokens: find every id a text contains (longest first). */
function idsIn(text, ids) {
  const t = String(text ?? '').toLowerCase();
  const found = [];
  for (const id of ids) {
    let from = 0;
    for (;;) {
      const at = t.indexOf(id, from);
      if (at < 0) break;
      const before = t[at - 1], after = t[at + id.length];
      if (!(before && /[a-z0-9_-]/.test(before)) && !(after && /[a-z0-9_-]/.test(after))) { found.push(id); break; }
      from = at + 1;
    }
  }
  return found.filter((id, _i, all) => !all.some((o) => o !== id && o.includes(id)));
}

// ---- the import --------------------------------------------------------------------------------------------------------------

const KIND_RANK = { id: 4, 'caption+date': 3, caption: 2, 'date+caption': 1 };

/**
 * Match and (with yes) write. Options: platform (default instagram), window ('7d'), capturedAt (default today), dateOrder ('dmy'|'mdy'),
 * columns (header -> field overrides), account (only rows whose account contains this), yes, role, today, filename, delimiter.
 * Returns a report; nothing is written unless yes is true.
 */
export async function importCsvText(projectDir, text, opts = {}) {
  const dir = resolve(projectDir);
  const window = opts.window ?? '7d';
  if (!WINDOWS.includes(window)) throw new PerformanceError(400, `window must be one of ${WINDOWS.join(', ')}`);
  const { items, project } = calendarIndex(dir);
  const today = opts.today ?? todayIn(project.timezone);
  const capturedAt = opts.capturedAt ?? today;
  if (!isDate(capturedAt)) throw new PerformanceError(400, 'capturedAt must be a date (YYYY-MM-DD)');
  const defaultPlatform = String(opts.platform ?? 'instagram').toLowerCase();

  const { rows, delimiter } = parseCsv(text, opts.delimiter);
  // the header row: the first of the first ten rows that has at least two columns we know (some exports start with a title line)
  let headerAt = -1, mapping = null;
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const m = mapHeaders(rows[r], opts.columns);
    const known = m.mapped.length;
    if (known >= 2 && m.mapped.some((x) => METRIC_KEYS.includes(x.field))) { headerAt = r; mapping = m; break; }
  }
  if (headerAt < 0) {
    throw new PerformanceError(422, `That file has no row of column names I recognise (looked for Reach, Likes, Views, Plays, Saves, Shares, Comments, Publish time, Description ...). Columns seen on the first row: ${(rows[0] ?? []).slice(0, 12).join(' | ')}. If a column has an unusual name, say what it means (performance import ... --map "Header=reach").`);
  }
  const col = Object.fromEntries(mapping.mapped.map((m) => [m.field, m]));
  const decimalComma = delimiter === ';';
  const body = rows.slice(headerAt + 1);

  // slash dates: decide day-first or month-first for the whole file when the data says so
  let order = opts.dateOrder;
  let orderNote = order ? `${order} (you said)` : null;
  if (!order && col.published) {
    let dmy = false, mdy = false;
    for (const r of body) {
      const m = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/.exec(String(r[col.published.index] ?? '').trim());
      if (m) { if (+m[1] > 12) dmy = true; if (+m[2] > 12) mdy = true; }
    }
    if (dmy && !mdy) { order = 'dmy'; orderNote = 'day first (inferred from the dates)'; } else if (mdy && !dmy) { order = 'mdy'; orderNote = 'month first (inferred from the dates)'; }
  }

  const report = {
    file: opts.filename ?? null, project: project.id, platform: defaultPlatform, window, capturedAt, delimiter, dryRun: !opts.yes,
    columns: { mapped: mapping.mapped.map((m) => ({ header: m.header, field: m.field })), unknown: mapping.unknown },
    dateOrder: orderNote ?? (col.published ? 'ambiguous slash dates are matched both ways' : null),
    rows: body.length, matched: [], ambiguous: [], unmatched: [], skipped: [], warnings: [], written: null,
  };
  if (!Object.keys(col).some((k) => METRIC_KEYS.includes(k))) report.warnings.push('No column with numbers was recognised.');
  if (!col.caption && !col.published) report.warnings.push('The file has no caption or publish-time column, so rows can only be matched by an item id inside the row.');

  const ids = items.map((x) => x.item.id).sort((a, b) => b.length - a.length);
  const taken = new Map();   // entry key -> row number, to catch two rows for one post
  const pending = [];

  body.forEach((cells, n) => {
    const rowNo = headerAt + 2 + n;                 // the line number in the file (1-based, counting the header)
    const cell = (f) => (col[f] ? String(cells[col[f].index] ?? '').trim() : '');
    if (opts.account && col.account && !cell('account').toLowerCase().includes(String(opts.account).toLowerCase())) { report.skipped.push({ row: rowNo, reason: `another account (${cell('account')})` }); return; }
    const caption = cell('caption') || cell('captionAlt');
    const whens = parseWhen(cell('published'), { order, timezone: project.timezone });
    const label = { row: rowNo, caption: caption.slice(0, 90), published: cell('published') || null, permalink: cell('permalink') || null, type: cell('type') || null };

    // numbers
    const raw = {};
    for (const f of METRIC_KEYS) {
      if (!col[f]) continue;
      const v = parseNumber(cells[col[f].index], { decimalComma });
      if (v === null) continue;
      if (typeof v === 'object') { if (f === 'completionRate') raw[f] = v.pct / 100; continue; }
      raw[f] = f === 'watchTimeSec' || f === 'avgWatchSec' ? v * col[f].unit : v;
    }
    const clean = cleanMetrics(raw);
    if (clean.errors.length && !Object.keys(clean.metrics).length) { report.unmatched.push({ ...label, reason: 'the row has no usable numbers' }); return; }

    // candidates
    const cands = [];
    const rowIds = idsIn(cells.join(' \n '), ids);
    for (const id of rowIds) { const it = items.find((x) => x.item.id === id); cands.push({ item: it.item, kind: 'id', score: 1, dateOk: null }); }
    if (!cands.length) {
      for (const it of items) {
        const dayGap = whens.length ? Math.min(...whens.map((w) => Math.abs(diffDays(w.date, it.item.date)))) : null;
        const dateOk = dayGap !== null && dayGap <= 1;
        const words = it.caption || '';
        if (caption && words && samePrefix60(caption, words)) { cands.push({ item: it.item, kind: dateOk ? 'caption+date' : 'caption', score: dateOk ? 0.98 : 0.95, dateOk, dayGap }); continue; }
        if (caption && dateOk) {
          const sim = captionSimilarity(caption, words || it.hook);
          if (sim >= 0.6) cands.push({ item: it.item, kind: 'date+caption', score: Math.round((0.5 + sim * 0.4) * 100) / 100, dateOk, dayGap, sim: Math.round(sim * 100) / 100 });
        }
      }
    }
    cands.sort((a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind] || b.score - a.score || (a.dayGap ?? 9) - (b.dayGap ?? 9));
    if (!cands.length) {
      const sameDay = whens.length ? items.filter((it) => whens.some((w) => w.date === it.item.date)) : [];
      report.unmatched.push({ ...label, reason: caption || whens.length ? 'no post on the calendar matches this caption and date (it may have been posted outside Nordle)' : 'no caption, date or item id to match on', ...(sameDay.length ? { sameDay: sameDay.map((x) => x.item.id) } : {}) });
      return;
    }
    const top = cands[0];
    const rivals = cands.filter((c) => c.item.id !== top.item.id && KIND_RANK[c.kind] === KIND_RANK[top.kind] && Math.abs(c.score - top.score) < 0.05 && (c.dayGap ?? 9) === (top.dayGap ?? 9));
    if (rivals.length) {
      report.ambiguous.push({ ...label, reason: top.kind === 'id' ? 'the row names more than one post' : 'two or more posts match equally well (same or very alike captions)', candidates: [top, ...rivals].map((c) => ({ item: c.item.id, date: c.item.date, title: c.item.title, kind: c.kind, score: c.score })) });
      return;
    }
    // the platform and what the row says it is
    const rowPlatform = platformOf(cell('platform')) ?? defaultPlatform;
    const key = `${top.item.id}|${rowPlatform}|${window}`;
    if (taken.has(key)) {
      const first = pending.find((p) => p.key === key);
      if (first && !first.dup) { first.dup = true; report.ambiguous.push({ row: first.row, caption: first.caption, reason: `rows ${first.row} and ${rowNo} both match "${top.item.id}"`, candidates: [{ item: top.item.id, date: top.item.date, title: top.item.title, kind: first.kind, score: first.score }] }); }
      report.ambiguous.push({ ...label, reason: `rows ${taken.get(key)} and ${rowNo} both match "${top.item.id}"`, candidates: [{ item: top.item.id, date: top.item.date, title: top.item.title, kind: top.kind, score: top.score }] });
      return;
    }
    taken.set(key, rowNo);
    const warn = [];
    const fmt = formatOfType(cell('type'));
    if (fmt && top.item.format !== fmt && !(fmt === 'post' && top.item.format === 'carousel')) warn.push(`the file calls it a ${cell('type')}; the calendar has a ${top.item.format}`);
    if (!['posted', 'scheduled', 'signed-off', 'built'].includes(top.item.status)) warn.push(`the calendar status is "${top.item.status}", not posted`);
    else if (top.item.status !== 'posted') warn.push(`the calendar status is "${top.item.status}": mark it posted when it has gone out`);
    if (top.dateOk === false) warn.push(`the file's date (${whens.map((w) => w.date).join(' or ')}) is not the calendar's (${top.item.date})`);
    if (top.item.date > today) warn.push(`the calendar date ${top.item.date} is in the future`);
    const when = whens.find((w) => Math.abs(diffDays(w.date, top.item.date)) <= 1) ?? whens[0];
    const entry = {
      post: top.item.id, platform: rowPlatform, ...(when ? { publishedAt: when.time ? `${when.date}T${when.time}` : when.date } : {}), capturedAt, window,
      metrics: clean.metrics, source: opts.source ?? 'csv', note: `imported from ${opts.filename ? basename(opts.filename) : 'a CSV export'}`,
    };
    pending.push({ key, row: rowNo, caption: label.caption, kind: top.kind, score: top.score, entry });
    report.matched.push({ ...label, item: top.item.id, itemDate: top.item.date, title: top.item.title, kind: top.kind, score: top.score, metrics: clean.metrics, ...(warn.length ? { warnings: warn } : {}) });
  });

  // a duplicate flagged after its first row was queued must not be written
  const ok = pending.filter((p) => !p.dup);
  const keep = new Set(ok.map((p) => p.row));
  report.matched = report.matched.filter((m) => keep.has(m.row));
  report.entries = ok.map((p) => p.entry);
  if (opts.yes && !report.entries.length) report.written = { added: 0, replaced: 0, rejected: 0 };
  else if (opts.yes) {
    const r = await upsertEntries(dir, report.entries, { role: opts.role ?? 'human', today, defaults: {}, requirePost: true });
    report.written = { added: r.added.length, replaced: r.replaced.length, rejected: r.rejected.length };
    if (r.rejected.length) report.warnings.push(`${r.rejected.length} entries were refused: ${r.rejected[0].errors.map((e) => e.message).join('; ')}`);
  }
  return report;
}

/** Read a CSV file (UTF-8 or Excel's UTF-16) and import it. */
export async function importCsvFile(projectDir, file, opts = {}) {
  const abs = resolve(file);
  if (!existsSync(abs)) throw new PerformanceError(404, `There is no file "${file}".`);
  if (/\.zip$/i.test(abs)) throw new PerformanceError(400, 'That is a zip. Buffer exports a zip of several CSVs: unzip it and import its Posts file.');
  return importCsvText(projectDir, decodeExport(readFileSync(abs)), { ...opts, filename: abs });
}
