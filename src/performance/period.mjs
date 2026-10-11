// Review periods: an ISO week ('2026-W45', Monday to Sunday) or a calendar month ('2026-11'). Plain ISO date strings, UTC arithmetic
// (see src/calendar/dates.mjs), so a period means the same on every computer.

import { addDays, addMonths, isDate, isMonth, iso, monthEnd, monthName, monthStart, weekday } from '../calendar/dates.mjs';

const WEEK = /^(\d{4})-W(\d{2})$/;

/** Monday of ISO week 1 of a year (the week that holds 4 January). */
function week1Monday(year) {
  const jan4 = iso(year, 1, 4);
  return addDays(jan4, -((weekday(jan4) + 6) % 7));
}

/** The ISO week id ('2026-W45') that holds a date. */
export function weekOf(date) {
  const monday = addDays(date, -((weekday(date) + 6) % 7));
  const thursday = addDays(monday, 3);
  const year = Number(thursday.slice(0, 4));
  const n = Math.round((Date.parse(`${monday}T00:00:00Z`) - Date.parse(`${week1Monday(year)}T00:00:00Z`)) / (7 * 86400000)) + 1;
  return `${year}-W${String(n).padStart(2, '0')}`;
}

export const isWeek = (s) => {
  const m = typeof s === 'string' ? WEEK.exec(s) : null;
  if (!m) return false;
  const n = Number(m[2]);
  return n >= 1 && n <= 53 && weekOf(addDays(week1Monday(Number(m[1])), (n - 1) * 7)) === s;
};

/** { kind:'week'|'month', id, from, to, label } or null for something that is not a period. */
export function parsePeriod(s) {
  if (isMonth(s)) return { kind: 'month', id: s, from: monthStart(s), to: monthEnd(s), label: monthName(s) };
  if (isWeek(s)) {
    const m = WEEK.exec(s);
    const from = addDays(week1Monday(Number(m[1])), (Number(m[2]) - 1) * 7);
    return { kind: 'week', id: s, from, to: addDays(from, 6), label: `Week ${Number(m[2])}, ${m[1]} (${from} to ${addDays(from, 6)})` };
  }
  return null;
}

export const periodOf = (date, kind = 'month') => parsePeriod(kind === 'week' ? weekOf(date) : date.slice(0, 7));

/** The period before this one. */
export function previousPeriod(p) {
  const period = typeof p === 'string' ? parsePeriod(p) : p;
  return period.kind === 'week' ? parsePeriod(weekOf(addDays(period.from, -7))) : parsePeriod(addMonths(period.id, -1));
}
export function nextPeriod(p) {
  const period = typeof p === 'string' ? parsePeriod(p) : p;
  return period.kind === 'week' ? parsePeriod(weekOf(addDays(period.from, 7))) : parsePeriod(addMonths(period.id, 1));
}

/** The most recent period of that kind that has completely finished before `today`. */
export function lastCompletePeriod(today, kind = 'month') {
  if (!isDate(today)) throw new Error('today must be a date (YYYY-MM-DD)');
  return kind === 'week' ? parsePeriod(weekOf(addDays(today, -((weekday(today) + 6) % 7) - 1))) : parsePeriod(addMonths(today.slice(0, 7), -1));
}

/** The period that holds today (a review of "so far"). */
export const currentPeriod = (today, kind = 'month') => periodOf(today, kind);

export const inPeriod = (date, p) => typeof date === 'string' && date.slice(0, 10) >= p.from && date.slice(0, 10) <= p.to;
