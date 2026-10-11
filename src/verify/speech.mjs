// A speaker's sentence must never be cut off. For every clip with someone talking, this reads the transcript of its source and checks
// that the cut-in sits just before a word that starts a sentence, that the cut-out sits just after a word that ends one, that
// neither cuts through a word, and (with ffmpeg) that the voice has really gone quiet where the clip ends.

import { decodeAudio, ffmpegAvailable, levelDb } from './ff.mjs';
import { error, info, warn } from './findings.mjs';
import { lookupMedia } from './media.mjs';
import { isSentenceEnd, NEW_THOUGHT_GAP, segmentSentences, shownText, startsSentence } from './transcript.mjs';
import { clip as clipText, stamp } from './text.mjs';
import { buildTimeline } from './timeline.mjs';

export const LEAD_MIN = 0.02; // seconds of room before the first word
export const LEAD_MAX = 0.4;
export const TAIL_MIN = 0.08; // seconds after the last word
export const TAIL_MAX = 1.0;
const FILLERS = new Set(['um', 'uh', 'er', 'ah', 'hmm', 'mm', 'erm', 'umm', 'uhh']);
const EPS = 0.001;
const r3 = (n) => Math.round(n * 1000) / 1000;

const bare = (w) => w.text.toLowerCase().replace(/[^a-z']/g, '');

/** Where to move a cut-in so it sits just before word i without touching the word before it. */
function suggestIn(words, i) {
  const prevEnd = i > 0 ? words[i - 1].end : 0;
  const room = words[i].start - prevEnd;
  const lead = Math.min(0.09, Math.max(LEAD_MIN + 0.01, room / 2));
  return r3(Math.max(prevEnd + 0.01, words[i].start - lead, 0));
}

/** Where to move a cut-out so it sits just after word j without touching the word after it. */
function suggestOut(words, j) {
  const nextStart = j + 1 < words.length ? words[j + 1].start : Infinity;
  const room = nextStart - words[j].end;
  const tail = Math.min(0.14, Math.max(TAIL_MIN + 0.02, room / 2));
  return r3(Math.min(words[j].end + tail, nextStart - 0.01));
}

const quote = (words, i0, i1, max = 7) => {
  const part = words.slice(i0, i1 + 1).map((w) => w.text);
  return part.length > max ? `${part.slice(0, 3).join(' ')} … ${part.slice(-3).join(' ')}` : part.join(' ');
};

/**
 * @param {object} doc a video document
 * @param {{projectDir:string, timeline?:object, measure?:boolean}} opts measure=false skips reading the audio
 * @returns {{findings:object[], cuts:object[], hook:string|null, skipped?:string}}
 */
export function speechCuts(doc, { projectDir, timeline = buildTimeline(doc, projectDir), measure = true, catalog } = {}) {
  const findings = [];
  const cuts = [];
  if (doc.kind !== 'video' || !timeline) return { findings, cuts, hook: null, skipped: 'This is not a video.' };

  // footage the catalog says has speech, but with no transcript: nobody can say whether a cut lands on a sentence
  if (catalog) {
    for (const c of timeline.clips) {
      if (!c.audible || c.src?.type !== 'video' || c.src.words.length) continue;
      const said = lookupMedia(catalog, c.src.path)?.item.speech;
      if (said && said.trim()) {
        findings.push(error('speech-without-transcript', `Clip "${c.id}" (${c.src.path}) is played with its sound, and the catalog says it has speech ("${clipText(said, 70)}"), but the source has no transcript, so its cuts cannot be checked.`, {
          time: c.tlStart, fix: `Transcribe the footage with word timings, save it as a words file, and set "transcript" on source "${c.source}".`,
        }));
      }
    }
  }

  const speakers = timeline.clips.filter((c) => c.src?.words?.length && c.audible && c.words.length);
  for (const c of timeline.clips) {
    if (c.src?.type !== 'audio' && c.src?.words?.length === 0 && c.src?.transcript && c.audible) {
      findings.push(warn('transcript-empty', `The transcript of "${c.src.id}" (${c.src.transcript}) has no words${c.src.wordsError ? `: ${c.src.wordsError}` : ''}, so speech in clip "${c.id}" cannot be checked.`, { time: c.tlStart, fix: 'Regenerate the transcript with word timings.' }));
    }
  }
  if (!speakers.length) {
    return { findings, cuts, hook: null, skipped: 'No clip with speech and a transcript, so there is no speaker to cut off.' };
  }

  // what is joined to what: the end of one clip and the start of the next from the same source
  const next = new Map();
  const prev = new Map();
  const frame = 1.5 / (timeline.fps || 30);
  for (const a of speakers) {
    const b = speakers.find((x) => x !== a && x.source === a.source && x.trackIndex === a.trackIndex && Math.abs(x.tlStart - a.tlEnd) <= frame);
    if (b) { next.set(a, b); prev.set(b, a); }
  }

  // one audio read per clip, only if needed
  const audioOf = (c) => {
    if (!measure || !ffmpegAvailable() || !c.src?.media?.exists) return null;
    return decodeAudio(c.src.media.abs, { start: Math.max(0, c.in - 0.3), duration: c.out - c.in + 0.6 });
  };

  for (const c of speakers) {
    const words = c.src.words;
    const punctuated = words.filter(isSentenceEnd).length >= Math.max(1, words.length / 40);
    const endsHere = (j) => isSentenceEnd(words[j]) || (!punctuated && (j === words.length - 1 || words[j + 1].start - words[j].end >= NEW_THOUGHT_GAP));
    const startsHere = (i) => (punctuated ? startsSentence(words, i) : (i === 0 || words[i].start - words[i - 1].end >= NEW_THOUGHT_GAP));
    const sents = segmentSentences(words);
    const sentenceAt = (i) => sents.find((s) => s.i0 <= i && i <= s.i1);
    const iFirst = words.findIndex((w) => w.end > c.in + EPS && w.start < c.out - EPS);
    let jLast = -1;
    for (let k = words.length - 1; k >= 0; k--) if (words[k].start < c.out - EPS && words[k].end > c.in + EPS) { jLast = k; break; }
    if (iFirst < 0 || jLast < 0) continue;
    const where = (t, extra = {}) => ({ time: t, ...extra });
    const ref = `clip "${c.id}"`;
    const firstWords = quote(words, iFirst, Math.min(jLast, iFirst + 5), 6);
    const lastWords = quote(words, Math.max(iFirst, jLast - 5), jLast, 6);
    const audio = audioOf(c);
    const joinedBefore = prev.get(c);
    const joinedAfter = next.get(c);

    // a cut that lands inside a word: say where the nearest whole-sentence cuts are
    const inWordInFix = (i) => {
      if (startsHere(i)) return `Set in to ${suggestIn(words, i)} (just before "${words[i].text}").`;
      const s = sentenceAt(i);
      const nextS = sents[sents.indexOf(s) + 1];
      return `Set in to ${suggestIn(words, s.i0)} to start at the beginning of the sentence ("${quote(words, s.i0, s.i1, 5)}")${nextS && nextS.start < c.out - 0.3 ? `, or to ${suggestIn(words, nextS.i0)} to start at the next one ("${quote(words, nextS.i0, nextS.i1, 5)}")` : ''}.`;
    };
    const inWordOutFix = (j) => {
      if (endsHere(j)) return `Set out to ${suggestOut(words, j)} (just after "${words[j].text}").`;
      const s = sentenceAt(j);
      const before = sents[sents.indexOf(s) - 1];
      return `Set out to ${suggestOut(words, s.i1)} to let the speaker finish the sentence${before && before.end > c.in + 0.3 ? `, or to ${suggestOut(words, before.i1)} to end on the sentence before ("${quote(words, before.i0, before.i1, 5)}")` : ''}.`;
    };

    // a join is fine when nothing but silence or fillers is removed between the two clips
    const seamless = (a, b) => {
      const gap = b.in - a.out;
      if (Math.abs(gap) <= 0.04) return 'contiguous';
      if (gap < 0) return null;
      const dropped = words.filter((w) => w.start >= a.out - EPS && w.end <= b.in + EPS);
      return dropped.every((w) => FILLERS.has(bare(w))) ? 'fillers' : null;
    };

    // ---- cut in ----
    const w0 = words[iFirst];
    const cutIn = { clip: c.id, kind: 'in', time: r3(c.tlStart), sourceTime: c.in, firstWords, status: 'ok' };
    const joinIn = joinedBefore ? seamless(joinedBefore, c) : null;
    if (joinIn === 'contiguous') cutIn.status = 'joined';
    else if (w0.start < c.in - EPS) {
      cutIn.status = 'in-word';
      findings.push(error('cut-in-word', `${ref} starts ${Math.round((c.in - w0.start) * 1000)} ms into the word "${w0.text}" (at ${stamp(c.tlStart)} on the timeline), so the speaker's first word is clipped.`, {
        ...where(c.tlStart), fix: inWordInFix(iFirst),
      }));
    } else if (!startsHere(iFirst) && joinIn !== 'fillers') {
      const s = sentenceAt(iFirst);
      cutIn.status = 'mid-sentence';
      const nextS = sents[sents.indexOf(s) + 1];
      findings.push(error('starts-mid-sentence', `${ref} starts in the middle of a sentence, at "${firstWords}" (${stamp(c.tlStart)} on the timeline). The sentence begins "${quote(words, s.i0, s.i1)}".`, {
        ...where(c.tlStart),
        fix: `Set in to ${suggestIn(words, s.i0)} to start at the beginning of that sentence${nextS && nextS.start < c.out ? `, or to ${suggestIn(words, nextS.i0)} to start at the next one ("${quote(words, nextS.i0, nextS.i1, 5)}")` : ''}.`,
      }));
    } else {
      const lead = w0.start - c.in;
      cutIn.lead = r3(lead);
      if (lead < LEAD_MIN && joinIn !== 'fillers') {
        cutIn.status = 'tight';
        findings.push(error('in-too-tight', `${ref} starts only ${Math.round(Math.max(0, lead) * 1000)} ms before "${w0.text}" (${stamp(c.tlStart)} on the timeline). The first sound of the word can be clipped; there should be at least ${LEAD_MIN * 1000} ms.`, {
          ...where(c.tlStart), fix: `Set in to ${suggestIn(words, iFirst)}.`,
        }));
      } else if (lead > LEAD_MAX) {
        cutIn.status = 'dead-air';
        findings.push(warn('dead-air-start', `${ref} starts ${lead.toFixed(2)} s before the first word, so there is a pause before the speaker starts (${stamp(c.tlStart)}).`, { ...where(c.tlStart), fix: `Set in to ${suggestIn(words, iFirst)}.` }));
      }
    }
    if (audio && cutIn.status !== 'joined') {
      const ref0 = speechLevel(audio, words, c);
      const at = levelDb(audio, c.in, c.in + 0.04);
      if (ref0 !== null && at !== null) {
        cutIn.levelDb = Math.round(at); cutIn.speechDb = Math.round(ref0);
        if (at > ref0 - 12 && cutIn.status === 'ok' && !(c.fade?.in >= 0.05)) {
          cutIn.status = 'loud';
          findings.push(error('loud-at-cut-in', `${ref} starts while the voice is already loud (${Math.round(at)} dB against ${Math.round(ref0)} dB for the speech), so it starts on the middle of a sound.`, { ...where(c.tlStart), fix: `Set in to ${suggestIn(words, iFirst)}, or add a short audio fade-in.` }));
        }
      }
    }
    cuts.push(cutIn);

    // ---- cut out ----
    const wl = words[jLast];
    const cutOut = { clip: c.id, kind: 'out', time: r3(c.tlEnd), sourceTime: c.out, lastWords, status: 'ok' };
    const joinOut = joinedAfter ? seamless(c, joinedAfter) : null;
    const outFix = (j) => suggestOut(words, j);
    if (joinOut === 'contiguous') cutOut.status = 'joined';
    else if (wl.end > c.out + EPS) {
      cutOut.status = 'in-word';
      findings.push(error('cut-in-word', `${ref} ends ${Math.round((wl.end - c.out) * 1000)} ms before the end of the word "${wl.text}" (${stamp(c.tlEnd)} on the timeline), so the speaker's last word is cut off.`, {
        ...where(c.tlEnd), fix: inWordOutFix(jLast),
      }));
    } else if (!endsHere(jLast) && joinOut !== 'fillers') {
      const s = sentenceAt(jLast);
      cutOut.status = 'mid-sentence';
      const before = sents[sents.indexOf(s) - 1];
      findings.push(error('ends-mid-sentence', `${ref} ends in the middle of a sentence, after "${lastWords}" (${stamp(c.tlEnd)} on the timeline). The sentence goes on: "${quote(words, s.i0, s.i1)}".`, {
        ...where(c.tlEnd),
        fix: `Set out to ${outFix(s.i1)} to let the speaker finish${before && before.end > c.in ? `, or to ${outFix(before.i1)} to end on the sentence before ("${quote(words, before.i0, before.i1, 5)}")` : ''}.`,
      }));
    } else {
      const tail = c.out - wl.end;
      cutOut.tail = r3(tail);
      if (tail < TAIL_MIN && joinOut !== 'fillers') {
        cutOut.status = 'tight';
        findings.push(error('out-too-tight', `${ref} ends only ${Math.round(Math.max(0, tail) * 1000)} ms after "${wl.text}" (${stamp(c.tlEnd)} on the timeline). The last sound can be clipped; there should be at least ${TAIL_MIN * 1000} ms.`, { ...where(c.tlEnd), fix: `Set out to ${outFix(jLast)}.` }));
      } else if (tail > TAIL_MAX) {
        cutOut.status = 'dead-air';
        findings.push(warn('dead-air-end', `${ref} stays ${tail.toFixed(1)} s after the last word, so there is a long pause at the end (${stamp(c.tlEnd)}).`, { ...where(c.tlEnd), fix: `Set out to ${outFix(jLast)}.` }));
      }
    }
    if (audio && cutOut.status !== 'joined') {
      const ref0 = speechLevel(audio, words, c);
      const at = levelDb(audio, c.out - 0.04, c.out);
      if (ref0 !== null && at !== null) {
        cutOut.levelDb = Math.round(at); cutOut.speechDb = Math.round(ref0);
        const rel = at - ref0;
        if (!(c.fade?.out >= 0.1)) {
          if (rel > -12 && cutOut.status === 'ok') {
            cutOut.status = 'loud';
            findings.push(error('loud-at-cut-out', `${ref} ends while the voice is still going (${Math.round(at)} dB at the cut against ${Math.round(ref0)} dB for the speech, ${stamp(c.tlEnd)} on the timeline). The audio is cut off, whatever the transcript says.`, { ...where(c.tlEnd), fix: `Set out to ${outFix(jLast)}, then run the check again; the transcript timings may be a little early here.` }));
          } else if (rel > -20 && cutOut.status === 'ok') {
            findings.push(warn('loud-ish-at-cut-out', `${ref} ends with some sound still at the cut (${Math.round(at)} dB against ${Math.round(ref0)} dB for the speech, ${stamp(c.tlEnd)}).`, { ...where(c.tlEnd), fix: `Listen to the end of "${lastWords}". If it sounds clipped, set out to ${outFix(jLast)}.` }));
          }
        }
      }
    }
    cuts.push(cutOut);
  }

  // the hook: the first words the viewer hears
  const first = speakers.slice().sort((a, b) => a.tlStart - b.tlStart)[0];
  const hookClips = speakers.filter((c) => c.tlStart < Math.max(8, first.tlEnd) && c.tlStart - first.tlStart < 8).sort((a, b) => a.tlStart - b.tlStart);
  const hook = hookClips.map((c) => shownText(c.words)).join(' ');

  // transcript hygiene and captions
  for (const [id, s] of timeline.sources) {
    if (!s.words.length) continue;
    let bad = 0;
    for (let k = 1; k < s.words.length; k++) if (s.words[k].start < s.words[k - 1].end - 0.08) bad++;
    if (bad) findings.push(warn('transcript-overlap', `The transcript of "${id}" has ${bad} word${bad === 1 ? '' : 's'} that start before the previous word ends, so word times near them may be wrong.`, { fix: 'Regenerate the transcript, or correct the timings by hand.' }));
    if (s.duration && s.words.at(-1).end > s.duration + 0.5) findings.push(warn('transcript-past-end', `The transcript of "${id}" has words after the end of the footage (${s.words.at(-1).end.toFixed(1)} s against ${s.duration} s).`));
  }
  const cap = doc.timeline?.captions;
  if (cap && cap.enabled !== false) {
    const src = timeline.sources.get(cap.source);
    const heard = speakers.some((c) => c.source === cap.source);
    if (src && !src.words.length) findings.push(warn('captions-no-words', `Captions are on, but the transcript of "${cap.source}" has no words to show.`, { fix: 'Add a transcript with word timings, or turn captions off.' }));
    else if (src && !heard) findings.push(warn('captions-not-heard', `Captions use the transcript of "${cap.source}", but no clip of it is heard in the video, so the captions would show words nobody says.`, { fix: 'Point captions at a source that is heard, or turn them off.' }));
    const others = [...new Set(speakers.filter((c) => c.source !== cap.source).map((c) => c.source))];
    if (others.length) findings.push(warn('speech-not-captioned', `Speech from ${others.map((o) => `"${o}"`).join(', ')} is heard but the captions only follow "${cap.source}", so those words appear without captions.`, { fix: 'Caption every source that is heard, or leave their speech out.' }));
  }
  if (first && hook) findings.push(info('hook', `The video opens with: "${clipText(hook, 200)}"`, { time: first.tlStart }));
  return { findings, cuts, hook };
}

/** How loud the speaker is in this clip: the 90th percentile of the level over 20 ms steps inside the words. */
function speechLevel(audio, words, c) {
  const levels = [];
  for (const w of words) {
    if (w.end <= c.in || w.start >= c.out) continue;
    for (let t = Math.max(w.start, c.in); t + 0.02 <= Math.min(w.end, c.out); t += 0.02) {
      const l = levelDb(audio, t, t + 0.02);
      if (l !== null && l > -100) levels.push(l);
    }
  }
  if (levels.length < 5) return null;
  levels.sort((a, b) => a - b);
  return levels[Math.floor(levels.length * 0.9)];
}

