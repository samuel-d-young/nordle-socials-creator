// The owner's choices for reading Buffer by itself: how often, and what to read. Saved in the publishing settings as `autoPull` (src/publish/store.mjs
// keeps unknown top-level keys), read by src/publish/auto-pull.mjs, by "Update from Buffer" (routes/publish.mjs) and shown in the Studio (app/buffer-pull-options.js).
// Every value is one of a short list of choices, so a typo can never ask Buffer for something silly or spend its small request allowance.
//
//   enabled     read Buffer by itself at all (default on)
//   everyHours  how often: 1, 3, 6 (default), 12 or 24 hours
//   results     copy the numbers Buffer has for posts that went out into Insights (default on)
//   handMade    copy posts made by hand in Buffer onto the calendar, read only (default on)
//   days        how far back sent posts are copied from Buffer: 30, 90 (default) or 180 days
//   maxNew      at most this many new posts copied each time: 10, 30 or 60 (default)
//   covers      save each copied post's picture in the project (default on)
import { changeSettings, loadSettings } from './store.mjs';

export const PULL_DEFAULTS = Object.freeze({ enabled: true, everyHours: 6, results: true, handMade: true, days: 90, maxNew: 60, covers: true });
export const PULL_CHOICES = Object.freeze({ everyHours: [1, 3, 6, 12, 24], days: [30, 90, 180], maxNew: [10, 30, 60] });
const FLAGS = ['enabled', 'results', 'handMade', 'covers'];

/** The options in force: what is saved, with anything missing or not one of the choices replaced by its default. */
export function pullOptions(settings = loadSettings()) {
  const saved = settings?.autoPull && typeof settings.autoPull === 'object' ? settings.autoPull : {};
  const out = { ...PULL_DEFAULTS };
  for (const k of FLAGS) if (typeof saved[k] === 'boolean') out[k] = saved[k];
  for (const k of Object.keys(PULL_CHOICES)) if (PULL_CHOICES[k].includes(saved[k])) out[k] = saved[k];
  return out;
}

/** Check what the owner sent (any subset of the options). Returns { value, errors }: `value` holds only the valid keys that were sent. */
export function cleanPullOptions(input) {
  const value = {}, errors = [];
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  for (const k of Object.keys(src)) {
    if (FLAGS.includes(k)) {
      if (typeof src[k] === 'boolean') value[k] = src[k]; else errors.push({ path: `/${k}`, message: `${k} must be true or false.` });
    } else if (PULL_CHOICES[k]) {
      if (PULL_CHOICES[k].includes(src[k])) value[k] = src[k]; else errors.push({ path: `/${k}`, message: `${k} must be one of ${PULL_CHOICES[k].join(', ')}.` });
    } else errors.push({ path: `/${k}`, message: `unknown option "${k}". Options: ${[...FLAGS, ...Object.keys(PULL_CHOICES)].join(', ')}.` });
  }
  return { value, errors };
}

/** Save the owner's choices (merged over what is saved). Returns the options now in force. */
export function savePullOptions(value) {
  return changeSettings((s) => { s.autoPull = { ...pullOptions(s), ...value }; return pullOptions(s); });
}
