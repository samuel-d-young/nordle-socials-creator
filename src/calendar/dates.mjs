// Calendar-date arithmetic on plain ISO strings (YYYY-MM-DD). Everything is done in UTC so a date means the same thing
// on every computer; "today" in the brand's own timezone comes from todayIn().

export const pad = (n) => String(n).padStart(2, '0');
export const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH = /^(\d{4})-(\d{2})$/;

/** True for a real calendar date such as 2026-11-03 (not 2026-02-31). */
export function isDate(s) {
  const m = typeof s === 'string' ? DATE.exec(s) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo);
}
export const isMonth = (s) => { const m = typeof s === 'string' ? MONTH.exec(s) : null; return !!m && Number(m[2]) >= 1 && Number(m[2]) <= 12; };

export const parseDate = (s) => { const m = DATE.exec(s); return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null; };
export const toUTC = (s) => new Date(`${s}T00:00:00Z`);
export const fromUTC = (dt) => dt.toISOString().slice(0, 10);
export const addDays = (s, n) => { const dt = toUTC(s); dt.setUTCDate(dt.getUTCDate() + n); return fromUTC(dt); };
/** Whole days from a to b (b - a). */
export const diffDays = (a, b) => Math.round((toUTC(b) - toUTC(a)) / 86400000);
/** 0 = Sunday ... 6 = Saturday. */
export const weekday = (s) => toUTC(s).getUTCDay();
export const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const weekdayName = (s) => WEEKDAY_NAMES[weekday(s)];
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
export const monthOf = (s) => s.slice(0, 7);
export const monthStart = (month) => `${month}-01`;
export const monthEnd = (month) => { const [y, m] = month.split('-').map(Number); return iso(y, m, daysInMonth(y, m)); };
export function addMonths(month, n) {
  const [y, m] = month.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${pad((idx % 12) + 1)}`;
}
/** ['2026-10', '2026-11', ...] from the month holding `from` to the month holding `to`. */
export function monthsBetween(from, to) {
  const out = [];
  for (let m = monthOf(from); m <= monthOf(to); m = addMonths(m, 1)) out.push(m);
  return out;
}
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (month) => { const [y, m] = month.split('-').map(Number); return `${MONTH_NAMES[m - 1]} ${y}`; };

/** The nth (1..5) given weekday of a month, or the last one when nth is -1. Returns an ISO date or null. */
export function nthWeekday(y, m, wd, nth) {
  const dim = daysInMonth(y, m);
  if (nth === -1) {
    for (let d = dim; d >= 1; d--) if (weekday(iso(y, m, d)) === wd) return iso(y, m, d);
    return null;
  }
  let count = 0;
  for (let d = 1; d <= dim; d++) {
    if (weekday(iso(y, m, d)) === wd && ++count === nth) return iso(y, m, d);
  }
  return null;
}

/** Easter Sunday (Gregorian calendar), by the anonymous Gregorian algorithm. */
export function easterSunday(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31), day = ((h + l - 7 * m + 114) % 31) + 1;
  return iso(y, month, day);
}

export const DEFAULT_TIMEZONE = 'Australia/Melbourne';

/**
 * Today's date in a timezone. NORDLE_TODAY=YYYY-MM-DD overrides it (tests, and dry runs of "what would happen on that day").
 */
export function todayIn(timezone = DEFAULT_TIMEZONE) {
  const forced = process.env.NORDLE_TODAY;
  if (forced && isDate(forced)) return forced;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
