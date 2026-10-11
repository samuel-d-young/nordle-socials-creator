// The node side of cutting by words: load the transcript of a source from its project, describe what is kept and what is cut as
// numbered text (for the command line, the MCP tools and the editor's transcript route). The editing itself is src/shared/cutlist.mjs.

import { loadMounts, resolveMediaPath } from './mounts.mjs';
import { loadWordsFile } from './words.mjs';
import { CutError, defaultTrack, speechSource, totalDuration, transcriptLines, wordStates } from '../shared/cutlist.mjs';

/**
 * The words of a source's transcript, exactly as the file lists them (nothing dropped: the numbers a person or Claude uses to pick
 * words are positions in this list). Throws a CutError that says what to fix.
 * @returns {{ source:string, words:{text:string,start:number,end:number,fix?:string,skip?:boolean}[] }}
 */
export function loadSourceWords(projectDir, doc, sourceId) {
  const source = sourceId ?? speechSource(doc);
  if (!source) throw new CutError({ code: 'no-source', message: 'Say which source to cut: this document has no source with a transcript that a clip plays.' });
  const s = (doc.sources ?? []).find((x) => x.id === source);
  if (!s) throw new CutError({ code: 'no-source', message: `There is no source "${source}". Sources: ${(doc.sources ?? []).map((x) => x.id).join(', ') || '(none)'}.` });
  if (!s.transcript) throw new CutError({ code: 'no-transcript', message: `Source "${source}" has no transcript, so there are no words to cut. Transcribe it with word timings and set "transcript" on the source.` });
  let words;
  try { ({ words } = loadWordsFile(resolveMediaPath(projectDir, s.transcript, loadMounts(projectDir)))); } catch (e) {
    throw new CutError({ code: 'transcript', message: `The transcript of "${source}" (${s.transcript}) could not be read: ${e.message}` });
  }
  if (!words.length) throw new CutError({ code: 'no-words', message: `The transcript of "${source}" has no words.` });
  return { source, words };
}

/** m:ss.s for a time in seconds. */
export const clock = (t) => {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
};

/** Everything a person needs to choose words: what is kept, what is cut, and how long the video is. */
export function cutOverview(doc, { track, source }, words) {
  const trackId = track ?? defaultTrack(doc, source);
  const states = wordStates(doc, { track: trackId, source }, words);
  const lines = transcriptLines(states);
  const kept = states.filter((w) => w.kept).length;
  return { track: trackId, source, states, lines, total: totalDuration(doc), keptWords: kept, words: states.length };
}

/** The overview as plain text. all: one entry per word (index:word) instead of one line per sentence. */
export function formatOverview(ov, { all = false } = {}) {
  const head = `Source "${ov.source}" on track "${ov.track}": ${ov.keptWords} of ${ov.words} words kept. The video is ${clock(ov.total)} (${ov.total.toFixed(1)} s) long.`;
  const note = all
    ? 'One entry per word: index:word. A word in (round brackets) is cut out.'
    : 'Each line: word numbers (first-last), where it starts in the video, the words. [cut] = cut out, [part] = partly cut. Cut with the word numbers, for example 12-20.';
  const body = all
    ? ov.lines.map((l) => ov.states.slice(l.i, l.j + 1).map((w) => (w.kept ? `${w.i}:${w.text}` : `(${w.i}:${w.text})`)).join(' ')).join('\n')
    : ov.lines.map((l) => `${`${l.i}-${l.j}`.padEnd(9)}${(l.kept === 'none' ? '[cut]' : clock(l.at ?? l.start)).padEnd(8)}${l.kept === 'some' ? '[part] ' : ''}${l.kept === 'none' ? `(${l.text})` : l.text}`).join('\n');
  return `${head}\n${note}\n${body}`;
}
