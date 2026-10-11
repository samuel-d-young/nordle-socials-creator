// Transcripts: word timings from any tool. Reads Nordle's own format and the shapes that faster-whisper, Whisper and
// similar tools write, and turns them all into one list of { text, start, end } words (seconds in the source file).
//
// Accepted shapes
//   { "words": [ { "text", "start", "end", "fix"? } ] }                         Nordle (nordle.words/0.1)
//   [ { "word"|"text"|"w", "start"|"s", "end"|"e" } ]                            a bare list
//   { "segments": [ { "text", "words": [ { "w"|"word", "s"|"start", "e"|"end" } ] } ] }   faster-whisper and similar
// Optional extras: a word's "fix" (shown instead of what was heard; "" drops the word), a word's "skip": true, and a
// top-level "fixes": { "heard": "shown" } map.

import { readFileSync } from 'node:fs';

export class WordsError extends Error {
  constructor(message) { super(message); this.name = 'WordsError'; }
}

const pick = (o, ...keys) => { for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]; return undefined; };

function normaliseWord(raw, where) {
  if (raw === null || typeof raw !== 'object') throw new WordsError(`${where}: expected a word object.`);
  const text = pick(raw, 'text', 'word', 'w');
  const start = Number(pick(raw, 'start', 's', 'begin'));
  const end = Number(pick(raw, 'end', 'e', 'stop'));
  if (typeof text !== 'string') throw new WordsError(`${where}: the word has no text.`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new WordsError(`${where}: the word "${text.trim()}" has no start and end time.`);
  if (start < 0 || end < start) throw new WordsError(`${where}: the word "${text.trim()}" has times that do not make sense (${start} to ${end}).`);
  const w = { text: text.trim(), start, end };
  if (typeof raw.fix === 'string') w.fix = raw.fix;
  if (raw.skip === true) w.skip = true;
  return w;
}

/** @returns {{ words: Array<{text:string,start:number,end:number,fix?:string,skip?:boolean}>, fixes: Record<string,string>, synthetic: boolean }} */
export function parseWords(data) {
  let list;
  if (Array.isArray(data)) list = data;
  else if (data && Array.isArray(data.words)) list = data.words;
  else if (data && Array.isArray(data.segments)) {
    list = [];
    data.segments.forEach((seg, i) => {
      if (!Array.isArray(seg.words) || !seg.words.length) {
        if (String(seg.text ?? '').trim()) throw new WordsError(`segments/${i}: has text but no word timings. Transcribe with word timestamps on.`);
        return;
      }
      list.push(...seg.words);
    });
  } else throw new WordsError('This is not a word list. Expected {"words": [...]}, a list of words, or {"segments": [{"words": [...]}]}.');
  const words = [];
  list.forEach((raw, i) => words.push(normaliseWord(raw, `word ${i}`)));
  words.sort((a, b) => a.start - b.start || a.end - b.end);
  // a word may not start before the previous one ended: clamp tiny overlaps that whisper produces
  for (let i = 1; i < words.length; i++) {
    if (words[i].start < words[i - 1].end) words[i - 1].end = Math.max(words[i - 1].start, words[i].start);
  }
  const fixes = {};
  if (data && !Array.isArray(data) && data.fixes && typeof data.fixes === 'object') {
    for (const [k, v] of Object.entries(data.fixes)) if (typeof v === 'string') fixes[k] = v;
  }
  return { words, fixes, synthetic: !!(data && data.synthetic) };
}

export function loadWordsFile(file) {
  let data;
  try { data = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { throw new WordsError(`The transcript is not valid JSON: ${e.message}`); }
  return parseWords(data);
}

/** The letters and digits of a word, lower-cased, for matching a fix to what was heard. */
export const bare = (s) => String(s).toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/**
 * Apply the fixes: a word's own "fix", then the file's and the document's "heard -> shown" maps.
 * Punctuation around the heard word is kept ("Noodle," becomes "Nordle,"). Returns new words with `shown`.
 */
export function applyFixes(words, ...maps) {
  const merged = new Map();
  for (const m of maps) for (const [k, v] of Object.entries(m ?? {})) merged.set(bare(k), v);
  const out = [];
  for (const w of words) {
    if (w.skip) continue;
    let shown = w.text;
    if (w.fix !== undefined) shown = w.fix;
    else if (merged.has(bare(w.text))) {
      const b = bare(w.text);
      const i = w.text.toLowerCase().indexOf(b);
      const lead = i > 0 ? w.text.slice(0, i) : '';
      const trail = w.text.slice(i + b.length);
      shown = `${lead}${merged.get(b)}${trail}`;
    }
    if (shown === '') continue;
    out.push({ ...w, shown });
  }
  return out;
}

/** Does this word end a sentence? */
export const endsSentence = (s) => /[.!?…]["')\]]*$/.test(String(s).trim());
