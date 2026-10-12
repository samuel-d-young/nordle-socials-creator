// Finding what a voice-over says, and when. A reel made of motion graphics that follows a voice-over names the words each scene covers (`say`); this turns those
// words into times using the recording's word timings. Pure, so the reel builder (and the editor) can use it.
//
//   findPhrase(words, "a clean smile", { after: 4.2 })  ->  { start, end, first, last }   (seconds in the recording)
//
// Matching ignores case, punctuation and the little differences speech-to-text makes with hyphens and apostrophes. The search starts after `after` (or after the
// previous phrase) so a phrase said twice is found where the scene order expects it. A phrase may use "..." to skip: "first visit ... no pressure" runs from the
// first words to the last ones.

const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
const tokens = (s) => norm(s).split(' ').filter(Boolean);

/** The words of a transcript as { text, start, end } with the owner's fixes applied and skipped words left out. */
export function spokenWords(words) {
  return (words ?? []).filter((w) => !w.skip && (w.fix === undefined || w.fix !== '')).map((w) => ({ text: w.fix ?? w.text, start: w.start, end: w.end }));
}

function findRun(toks, seq, from) {
  outer: for (let i = from; i + seq.length <= toks.length; i++) {
    for (let k = 0; k < seq.length; k++) if (toks[i + k] !== seq[k]) continue outer;
    return i;
  }
  return -1;
}

/**
 * @param {{text:string,start:number,end:number}[]} words  spokenWords(...) output
 * @param {string} phrase  what is said; "a ... b" runs from a to b
 * @param {{ after?: number }} [o]  start looking at the first word that begins at or after this time (seconds)
 * @returns {{ start:number, end:number, first:number, last:number } | null}
 */
export function findPhrase(words, phrase, { after = 0 } = {}) {
  const parts = String(phrase).split(/\s*\.\.\.\s*|\s*…\s*/).map(tokens).filter((p) => p.length);
  if (!parts.length) return null;
  const toks = words.map((w) => norm(w.text));
  // a word of the transcript may hold several tokens ("e-mail" -> "e mail"); flatten with a map back to the word
  const flat = [], owner = [];
  toks.forEach((t, i) => { for (const x of t.split(' ').filter(Boolean)) { flat.push(x); owner.push(i); } });
  let from = Math.max(0, owner.findIndex((o) => words[o].start >= after - 1e-6));
  if (from < 0) return null;
  let first = -1, lastTok = -1;
  for (const seq of parts) {
    const at = findRun(flat, seq, from);
    if (at < 0) return null;
    if (first < 0) first = at;
    lastTok = at + seq.length - 1;
    from = lastTok + 1;
  }
  const a = owner[first], b = owner[lastTok];
  return { start: words[a].start, end: words[b].end, first: a, last: b };
}
