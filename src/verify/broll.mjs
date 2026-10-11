// B-roll must make sense for what is being said. A cutaway is a picture clip shown while someone is speaking on another clip. For each one:
// it must be catalogued (so we know what it shows), it must not show a patient, it must not hide the moment a person says their
// name, it must fit the words under it, it must not be so short it flashes by, and the speaker's voice must keep going beneath it.

import { probe } from './ff.mjs';
import { error, info, warn } from './findings.mjs';
import { judgePair, lookupMedia } from './media.mjs';
import { clip, keywords, stamp } from './text.mjs';
import { shownText } from './transcript.mjs';
import { buildTimeline, pictureClips, spokenDuring } from './timeline.mjs';

export const MIN_CUTAWAY = 0.8; // seconds
const FILLERS = new Set(['um', 'uh', 'er', 'ah', 'hmm', 'mm', 'erm', 'umm', 'uhh']);
const NUMBER_WORDS = new Set(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand', 'percent']);
const bare = (w) => w.text.toLowerCase().replace(/[^a-z0-9']/g, '');
const EPS = 0.001;

/** Moments where someone is named in speech: "I'm Sam", "my name is Sam", "this is Dr Jones", "meet Sam". */
export function introductions(words, staffFirstNames = []) {
  const out = [];
  const isName = (w) => w && (/^[A-Z]/.test(w.text.replace(/^[^A-Za-z]+/, '')) || staffFirstNames.includes(bare(w))) && !['a', 'an', 'the', 'here', 'going', 'so', 'just', 'not'].includes(bare(w));
  for (let i = 0; i < words.length; i++) {
    const w = bare(words[i]);
    const at = (k) => words[i + k];
    let nameAt = -1;
    if (w === 'my' && bare(at(1) ?? { text: '' }) === 'name' && bare(at(2) ?? { text: '' }) === 'is') nameAt = 3;
    else if (w === "i'm" || w === 'im') nameAt = 1;
    else if (w === 'i' && bare(at(1) ?? { text: '' }) === 'am') nameAt = 2;
    else if (w === 'this' && bare(at(1) ?? { text: '' }) === 'is') nameAt = 2;
    else if (w === 'meet') nameAt = 1;
    else if (w === 'dr' || w === 'doctor') nameAt = 1;
    if (nameAt > 0) {
      let n = at(nameAt);
      if (n && ['dr', 'doctor'].includes(bare(n))) { nameAt += 1; n = at(nameAt); }
      if (isName(n)) out.push({ start: words[i].tlStart, end: n.tlEnd, text: words.slice(i, i + nameAt + 1).map((x) => x.text).join(' '), name: n.text.replace(/[^\p{L}'-]/gu, '') });
    }
  }
  return out;
}

/**
 * @returns {{findings:object[], pairs:object[], cutaways:object[], skipped?:string}}
 */
export function checkBroll(doc, { projectDir, catalog, facts, timeline = buildTimeline(doc, projectDir) } = {}) {
  const findings = [];
  const pairs = [];
  const cutaways = [];
  if (doc.kind !== 'video' || !timeline) return { findings, pairs, cutaways, skipped: 'This is not a video.' };

  const staffFirst = (facts?.staff ?? []).map((s) => s.name.replace(/^(?:dr|doctor)\.?\s+/i, '').split(/\s+/)[0].toLowerCase());
  const topic = [doc.brief?.message, doc.brief?.goal].filter(Boolean).join('. ');
  const frame = 1.5 / (timeline.fps || 30);

  for (const p of pictureClips(timeline)) {
    const a = p.tlStart;
    const b = p.tlEnd;
    if (p.audible && p.words.length) continue; // this clip is itself the speaker
    const under = spokenDuring(timeline, a, b, { except: p.id, audibleOnly: false });
    const src = p.src;
    const ref = src?.path ?? p.source;
    const label = `The B-roll "${p.id}" (${ref}, ${stamp(a)}–${stamp(b)})`;
    const where = { media: ref, time: a };

    // a picture between two clips of the same speaker, on one track: the words in between must not be lost
    const A = timeline.clips.find((x) => x.audible && x.words.length && x.trackIndex === p.trackIndex && Math.abs(x.tlEnd - a) <= frame);
    const B = A && timeline.clips.find((x) => x.audible && x.words.length && x.source === A.source && x.trackIndex === p.trackIndex && Math.abs(x.tlStart - b) <= frame);
    if (A && B) {
      const gap = B.in - A.out;
      const dropped = A.src.words.filter((w) => w.start >= A.out - EPS && w.end <= B.in + EPS && !FILLERS.has(bare(w)));
      if (dropped.length >= 2 && gap > 0) {
        const same = Math.abs(gap - (b - a)) <= 0.35;
        findings.push(same
          ? error('broll-drops-speaker', `The speaker carries on talking while "${p.id}" is shown ("${clip(dropped.map((w) => w.text).join(' '), 90)}"), but that part of their sound is cut: the B-roll sits between two speaker clips on the same track, so their voice stops under it.`, {
            ...where, fix: 'Put the B-roll on a track above the speaker and keep the speaker\'s clip running underneath, so the voice does not drop out.',
          })
          : warn('broll-removes-words', `Between "${A.id}" and "${B.id}" the words "${clip(dropped.map((w) => w.text).join(' '), 90)}" are cut out while "${p.id}" is shown.`, { ...where, fix: 'If the speaker should keep talking, put the B-roll on a track above and let the speaker\'s clip run.' }));
      }
    }
    if (!under.length) continue; // nobody is speaking on another clip: not a cutaway over speech
    const heard = under.filter((w) => w.audible);
    const words = shownText(heard.length ? heard : under);
    const entry = { clip: p.id, media: ref, start: Math.round(a * 100) / 100, end: Math.round(b * 100) / 100, words: clip(words, 300), verdict: 'unsure' };
    cutaways.push(entry);

    const hit = lookupMedia(catalog, ref);
    if (!hit) {
      findings.push(error('broll-not-catalogued', `${label} is shown while someone is speaking, but it has no entry in sources/catalog.json, so nothing says what it shows and no one can tell if it fits the words.`, {
        ...where, fix: `Look at the clip, then add an entry to sources/catalog.json: "${ref}": { "shows": "one plain sentence", "tags": ["words someone might say over it"], "traps": ["what it is NOT"] }.`,
      }));
    } else {
      const m = hit.item;
      if (m.doNotUse) findings.push(error('broll-do-not-use', `${label} is marked do-not-use in the catalog: ${m.doNotUse}`, { ...where, fix: 'Use another clip.' }));
      if (m.patientVisible) findings.push(error('broll-patient', `${label} shows an identifiable patient according to the catalog. Patients must not appear in posts.`, { ...where, fix: 'Use a clip of staff, rooms or equipment only.' }));
      const j = judgePair({ strong: words, weak: topic, media: m, staffNames: (facts?.staff ?? []).map((s) => s.name) });
      entry.verdict = j.verdict;
      entry.shows = clip(m.shows, 200);
      pairs.push({ page: p.id, time: Math.round(a * 100) / 100, media: ref, words: clip(`While the picture is shown, the speaker says: ${words}`, 400), shows: clip([m.shows, (m.tags ?? []).length ? `[${m.tags.join(', ')}]` : '', (m.traps ?? []).length ? `NOT: ${m.traps.join('; ')}` : ''].filter(Boolean).join(' '), 400), verdict: j.verdict, note: j.note });
      if (j.verdict === 'mismatch') {
        findings.push(error('broll-contradicts-words', `${label} does not fit what is being said. ${j.note} The speaker says: "${clip(words, 120)}".`, { ...where, fix: 'Use a clip that shows what is being talked about, or move this one to where it fits.' }));
      } else if (j.verdict === 'unsure' && j.reason === 'no-overlap' && [...keywords(words)].length >= 3) {
        findings.push(warn('broll-not-obviously-related', `${label} shows "${clip(m.shows, 80)}", and nothing the speaker says over it ("${clip(words, 100)}") is in that description. Check it makes sense.`, { ...where, fix: 'Look at the clip while reading the words. If it does not fit, use another clip or move it.' }));
      }
    }

    if (b - a < MIN_CUTAWAY - EPS) {
      findings.push(warn('broll-too-short', `${label} lasts only ${(b - a).toFixed(2)} s, which is too quick to take in while someone is talking (the least is ${MIN_CUTAWAY} s).`, { ...where, fix: `Make it at least ${MIN_CUTAWAY} s long, or take it out.` }));
    }

    // hiding the moment a person is named, or a number is said
    for (const intro of introductions(under, staffFirst)) {
      if (intro.end > a && intro.start < b) {
        findings.push(error('broll-hides-introduction', `${label} covers the moment the speaker says "${intro.text}" (${stamp(intro.start)}). People should see someone while they are being introduced.`, {
          ...where, time: intro.start, fix: `Start the B-roll after ${stamp(intro.end + 0.3)}, or move it to a later sentence.`,
        }));
      }
    }
    const nums = under.filter((w) => /\d/.test(w.text) || NUMBER_WORDS.has(bare(w)));
    if (nums.length) {
      findings.push(warn('broll-covers-number', `${label} covers a number being said ("${clip(nums.slice(0, 4).map((w) => w.text).join(' '), 40)}" at ${stamp(nums[0].tlStart)}). A figure, price or phone number is easier to follow with the speaker on screen.`, { ...where, time: nums[0].tlStart, fix: 'Keep the speaker on screen while the figure is said.' }));
    }

    // the voice must go on under the picture
    if (!heard.length) {
      findings.push(error('broll-speaker-muted', `${label} covers speech ("${clip(words, 80)}"), but nothing carries the speaker's sound at that time: the clip or its track is muted. The viewer sees B-roll in silence.`, {
        ...where, fix: 'Un-mute the speaker\'s clip (put the B-roll on its own track above it and mute only the B-roll).',
      }));
    }
    if (p.audible && src?.media?.exists) {
      const pr = probe(src.media.abs);
      if (pr?.hasAudio && !(p.duck)) findings.push(warn('broll-own-sound', `${label} has its own sound and is not muted, so it will play over the speaker.`, { ...where, fix: `Set "mute": true on clip "${p.id}" (or lower its gainDb) unless the sound is wanted.` }));
    }
  }
  if (!cutaways.length) findings.push(info('no-cutaways', 'No clip is shown over someone speaking, so there is no B-roll to match to words.'));
  return { findings, pairs, cutaways };
}
