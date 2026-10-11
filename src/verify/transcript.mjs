// Transcripts: the words of a spoken clip with their times, and where sentences begin and end.
// Reads the Nordle format ({words:[{text,start,end}]}) and the shapes Whisper-style tools write.

import { endsWithAbbreviation, normalise } from './text.mjs';
import { readFileSync } from 'node:fs';

/** Words in whatever shape a transcript file has, as [{text, start, end, final?}] sorted by time. Times are seconds in the source. */
export function normaliseWords(data) {
  let list = [];
  if (Array.isArray(data)) list = data;
  else if (Array.isArray(data?.words)) list = data.words;
  else if (Array.isArray(data?.segments)) list = data.segments.flatMap((s) => s.words ?? []);
  const out = [];
  for (const w of list) {
    const text = String(w.text ?? w.word ?? w.w ?? '').trim();
    const start = Number(w.start ?? w.s);
    const end = Number(w.end ?? w.e);
    if (!text || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    const flag = w.final ?? w.sentenceEnd ?? w.endOfSentence;
    // a word may carry a correction for what is shown ("fix", "" drops it) or be marked "skip": the sound is still there, the caption is not
    const skip = w.skip === true || w.fix === '';
    const shown = skip ? '' : typeof w.fix === 'string' ? w.fix : text;
    out.push({ text, start, end: Math.max(end, start), shown, ...(skip ? { skip: true } : {}), ...(typeof flag === 'boolean' ? { final: flag } : {}) });
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** The words as a viewer reads them (corrections applied, skipped words left out). */
export const shownText = (words) => words.map((w) => w.shown ?? w.text).filter(Boolean).join(' ');

export function readWordsFile(file) {
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    return { words: normaliseWords(data), synthetic: Boolean(data?.synthetic), error: null };
  } catch (e) {
    return { words: [], synthetic: false, error: e.message };
  }
}

/** Does this word end a sentence? The transcript may say so itself (final: true); otherwise . ? ! decide, except abbreviations. */
export function isSentenceEnd(word) {
  if (!word) return false;
  if (typeof word.final === 'boolean') return word.final;
  const ends = (s) => {
    const t = normalise(s).replace(/["')\]”]+$/, '');
    if (/(\.\.\.|…)$/.test(t)) return false; // trailing off, not finished
    return /[.!?]$/.test(t) && !endsWithAbbreviation(t);
  };
  return ends(word.text) || (typeof word.shown === 'string' && word.shown !== word.text && ends(word.shown));
}

/** A gap this long before a word counts as a new thought even without punctuation. */
export const NEW_THOUGHT_GAP = 0.6;

/** Is the word at index i the first of a sentence (after a finished sentence, a long pause, or nothing)? */
export function startsSentence(words, i, gap = NEW_THOUGHT_GAP) {
  if (i <= 0) return true;
  if (isSentenceEnd(words[i - 1])) return true;
  return words[i].start - words[i - 1].end >= gap;
}

/** Sentences as {i0, i1, start, end, text} over word indexes (inclusive). */
export function segmentSentences(words, gap = NEW_THOUGHT_GAP) {
  const out = [];
  let from = 0;
  for (let i = 0; i < words.length; i++) {
    const last = i === words.length - 1;
    if (last || isSentenceEnd(words[i]) || words[i + 1].start - words[i].end >= gap) {
      out.push({ i0: from, i1: i, start: words[from].start, end: words[i].end, text: words.slice(from, i + 1).map((w) => w.text).join(' '), finished: isSentenceEnd(words[i]) });
      from = i + 1;
    }
  }
  return out;
}

/** The words that overlap a time range. */
export const wordsIn = (words, a, b) => words.filter((w) => w.end > a && w.start < b);

/** Number words ("twenty five") as digits, so a spoken figure can be matched with a written one. */
const ONES = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
export function numberWordsToDigits(text) {
  const parts = String(text).split(/(\s+)/);
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const w = parts[i].toLowerCase().replace(/[^a-z-]/g, '');
    const [a, b] = w.split('-');
    if (TENS[a] !== undefined && b && ONES[b] !== undefined && ONES[b] < 10) { out.push(String(TENS[a] + ONES[b])); continue; }
    if (TENS[w] !== undefined) {
      const next = (parts[i + 2] ?? '').toLowerCase().replace(/[^a-z]/g, '');
      if (ONES[next] !== undefined && ONES[next] > 0 && ONES[next] < 10 && /^\s+$/.test(parts[i + 1] ?? '')) { out.push(String(TENS[w] + ONES[next])); i += 2; continue; }
      out.push(String(TENS[w])); continue;
    }
    if (ONES[w] !== undefined) { out.push(String(ONES[w])); continue; }
    out.push(parts[i]);
  }
  return out.join('');
}
