// Captions and speech checks. Word timings (from any transcription tool) become caption lines that follow what is
// actually used on the timeline: only words from the part of the source that plays, moved to where it plays.

import { applyFixes, endsSentence, loadWordsFile, WordsError } from './words.mjs';

const GAP_BREAK = 0.7;          // a pause this long ends a caption line
const HOLD = 0.35;              // a line stays up this long after its last word if nothing follows quickly
const CONTINUOUS = 0.6;         // words closer than this are one flow of speech

/** Load the transcripts of every source that has one, once per plan. */
export async function ensureTranscripts(plan, doc) {
  if (plan.transcripts) return plan.transcripts;
  plan.transcripts = new Map();
  const docFixes = doc.timeline?.captions?.fixes ?? {};
  for (const src of plan.sources.values()) {
    if (!src.transcriptAbs) continue;
    try {
      const { words, fixes } = loadWordsFile(src.transcriptAbs);
      plan.transcripts.set(src.id, { heard: words, words: applyFixes(words, fixes, docFixes) });
    } catch (e) {
      if (!(e instanceof WordsError)) throw e;
      plan.issues.push({ level: 'error', code: 'transcript-invalid', message: `Source "${src.id}": the transcript is not usable: ${e.message}`, source: src.id });
    }
  }
  return plan.transcripts;
}

/** Clips whose sound is heard and whose source has a transcript, for one source (or all). */
const speakingClips = (plan, sourceId) => plan.clips.filter((c) => !c.mute && !c.isImage && c.src?.probe?.hasAudio && plan.transcripts?.has(c.sourceId) && (!sourceId || c.sourceId === sourceId));

/** The words of a source as they land on the timeline (only the parts that play): { shown, text, start, end, clipId } */
export function timelineWords(plan, sourceId) {
  const t = plan.transcripts?.get(sourceId);
  if (!t) return [];
  const out = [];
  for (const c of speakingClips(plan, sourceId).sort((a, b) => a.at - b.at)) {
    const eps = 0.02;
    for (const w of t.words) {
      if (w.start < c.in - eps || w.end > c.out + eps) continue;
      const start = c.at + (Math.max(w.start, c.in) - c.in) / c.speed;
      const end = c.at + (Math.min(w.end, c.out) - c.in) / c.speed;
      if (start >= plan.duration) continue;
      out.push({ shown: w.shown, text: w.text, start, end: Math.min(end, plan.duration), clipId: c.id });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** What is said between two timeline times, as one line of text. */
export function speechIn(plan, start, end) {
  const words = [];
  for (const id of plan.transcripts?.keys() ?? []) words.push(...timelineWords(plan, id).filter((w) => w.end > start && w.start < end));
  return words.sort((a, b) => a.start - b.start).map((w) => w.shown).join(' ');
}

function groupLines(words, { maxWords, maxChars }) {
  const lines = [];
  let cur = [];
  let chars = 0;
  for (const w of words) {
    if (cur.length) {
      const prev = cur.at(-1);
      const brk = cur.length >= maxWords || endsSentence(prev.shown) || w.start - prev.end > GAP_BREAK || w.clipId !== prev.clipId || chars + 1 + w.shown.length > maxChars;
      if (brk) { lines.push(cur); cur = []; chars = 0; }
    }
    cur.push(w);
    chars += (cur.length > 1 ? 1 : 0) + w.shown.length;
  }
  if (cur.length) lines.push(cur);
  return lines;
}

/**
 * Caption lines for the document's captions block. Also resolves the look from the brand's captionStyle.
 * @returns {Promise<{ enabled:boolean, cfg:object, events:Array, style:object, highlightColor:string, issues:Array }>}
 */
export async function buildCaptions(plan, doc, brand) {
  const cfg = doc.timeline.captions;
  await ensureTranscripts(plan, doc);
  const out = { enabled: false, cfg: cfg ?? null, events: [], style: {}, highlightColor: null, issues: [] };
  if (!cfg || cfg.enabled === false) return out;
  if (!plan.sources.has(cfg.source)) { out.issues.push({ level: 'error', code: 'captions-source', message: `Captions use source "${cfg.source}", which is not in the document.` }); return out; }
  if (!plan.transcripts.has(cfg.source)) {
    out.issues.push({ level: 'warn', code: 'captions-no-transcript', message: `Captions are on, but source "${cfg.source}" has no usable transcript, so no words can be shown.` });
    return out;
  }
  const maxWords = cfg.maxWordsPerLine ?? 4;
  const words = timelineWords(plan, cfg.source);
  if (!words.length) out.issues.push({ level: 'warn', code: 'captions-empty', message: `No words from source "${cfg.source}" fall inside the clips that play, so there are no captions.` });
  const lines = groupLines(words, { maxWords, maxChars: 30 });
  lines.forEach((line, i) => {
    const last = line.at(-1);
    const nextStart = lines[i + 1]?.[0].start ?? Infinity;
    const clip = plan.clips.find((c) => c.id === line[0].clipId);
    const clipEnd = clip ? clip.at + clip.dur : plan.duration;
    let end = nextStart - last.end <= HOLD ? nextStart : last.end + HOLD;
    end = Math.min(end, clipEnd, plan.duration);
    const shown = line.map((w) => ({ text: w.shown, start: w.start, end: w.end }));
    // a trailing full stop or comma looks fussy on a caption
    shown[shown.length - 1].text = shown.at(-1).text.replace(/[.,;:]+$/, '');
    out.events.push({ id: `cap-${i}`, start: line[0].start, end: Math.max(end, line[0].start + 0.1), words: shown, clipId: line[0].clipId });
  });
  out.enabled = true;

  const bs = brand.captionStyle ?? {};
  const base = {
    font: bs.font ?? '$brand.fonts.display', size: bs.size ?? 64, weight: bs.weight ?? 700,
    color: bs.color ?? '#FFFFFF', uppercase: bs.uppercase ?? false,
  };
  out.style = { ...base, ...(cfg.style ?? {}) };
  out.highlightColor = cfg.highlightColor ?? bs.highlightColor ?? (brand.colors?.accent ? '$brand.colors.accent' : '#FFD400');
  return out;
}

/** Speakers must not be cut off: find clips that start or end inside a word or a sentence. */
export async function checkSpeechCuts(plan) {
  const issues = [];
  if (!plan.transcripts) return issues;
  for (const [sourceId, t] of plan.transcripts) {
    const words = t.words;
    if (!words.length) continue;
    const sentenceEnds = words.filter((w) => endsSentence(w.shown)).length;
    const punctuated = sentenceEnds >= Math.max(1, words.length / 60);
    if (!punctuated) issues.push({ level: 'info', code: 'transcript-unpunctuated', message: `The transcript of "${sourceId}" has almost no full stops, so only cuts through the middle of a word can be found, not cuts mid-sentence.`, source: sourceId });
    for (const c of speakingClips(plan, sourceId)) {
      const q = (s) => `"${s}"`;
      const straddlesIn = words.find((w) => w.start < c.in - 0.03 && w.end > c.in + 0.03);
      const straddlesOut = words.find((w) => w.start < c.out - 0.03 && w.end > c.out + 0.03);
      if (straddlesIn) issues.push({ level: 'error', code: 'speech-cut-word', message: `Clip "${c.id}" starts in the middle of the word ${q(straddlesIn.shown)} (${straddlesIn.start.toFixed(2)}s to ${straddlesIn.end.toFixed(2)}s in the source). Move "in" to ${Math.max(0, straddlesIn.start - 0.05).toFixed(2)}s or after ${straddlesIn.end.toFixed(2)}s.`, clip: c.id });
      if (straddlesOut) issues.push({ level: 'error', code: 'speech-cut-word', message: `Clip "${c.id}" ends in the middle of the word ${q(straddlesOut.shown)} (${straddlesOut.start.toFixed(2)}s to ${straddlesOut.end.toFixed(2)}s in the source). Move "out" to ${(straddlesOut.end + 0.15).toFixed(2)}s.`, clip: c.id });
      if (!punctuated) continue;
      const inside = words.filter((w) => w.start >= c.in - 0.03 && w.end <= c.out + 0.03);
      if (!inside.length) continue;
      const first = inside[0];
      const last = inside.at(-1);
      const before = words[words.indexOf(first) - 1];
      const after = words[words.indexOf(last) + 1];
      if (after && !endsSentence(last.shown) && after.start - last.end < CONTINUOUS && !straddlesOut) {
        issues.push({ level: 'warn', code: 'speech-cut-sentence', message: `Clip "${c.id}" stops before the sentence is finished: it ends on ${q(last.shown)} and the speaker goes on with ${q(words.slice(words.indexOf(after), words.indexOf(after) + 4).map((w) => w.shown).join(' '))}. Let the sentence finish (out to ${(sentenceEndAfter(words, words.indexOf(after)) + 0.15).toFixed(2)}s) or cut earlier.`, clip: c.id });
      }
      if (before && !endsSentence(before.shown) && first.start - before.end < CONTINUOUS && !straddlesIn) {
        issues.push({ level: 'warn', code: 'speech-start-sentence', message: `Clip "${c.id}" starts in the middle of a sentence, on ${q(first.shown)} (after ${q(before.shown)}). Start at the beginning of the sentence if the viewer needs the whole thought.`, clip: c.id });
      }
    }
  }
  return issues;
}

function sentenceEndAfter(words, from) {
  for (let i = from; i < words.length; i++) if (endsSentence(words[i].shown)) return words[i].end;
  return words.at(-1).end;
}
