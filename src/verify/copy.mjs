// The words around a post: the caption's hook, a single call to action, hashtags, alt text, and sentences that stop in the middle.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../tools/validate.mjs';
import { error, info, warn } from './findings.mjs';
import { allText, textSurfaces } from './surfaces.mjs';
import { clip, lower, normalise, sentences, tokens } from './text.mjs';

let rubric;
const hookChars = () => { try { return (rubric ??= JSON.parse(readFileSync(join(ROOT, 'data', 'design-rubric.json'), 'utf8'))).caption?.hookChars ?? 125; } catch { return 125; } };

const CTA_START = /^(?:(?:please|and|so|or)\s+)?(?:book|call|visit|follow|swipe|shop|order|dm|message|learn|sign|join|come|tap|find|save|share|try|get|reserve|contact|enquire|email|subscribe|download|click|ask|tell|comment|tag|send|check|read|watch|pop in|drop in|stop by|text|phone|ring|see us|say hi|reply)\b/i;
const CTA_ANYWHERE = /\b(?:link in (?:my )?bio|book (?:now|online|today|your|a )|call (?:us|now|on)|message us|dm us|visit us|find us at|tap the link)\b/i;
// words a sentence cannot end on (one that does has lost its ending)
const DANGLING = new Set(['and', 'or', 'but', 'the', 'a', 'an', 'of', 'to', 'with', 'from', 'our', 'your', 'my', 'their', 'is', 'are', 'was', 'were', 'if', 'than', 'when', 'while', 'because', 'into']);

/** Caption text without trailing hashtag lines, mentions and emoji, to judge how it ends. */
function bodyOf(caption) {
  let t = normalise(caption);
  for (;;) {
    const before = t;
    t = t.replace(/(?:^|\s)[#@][\p{L}\p{N}_.]+\s*$/u, '').replace(/[\s\p{Extended_Pictographic}️‍]+$/u, '').trimEnd();
    if (t === before) break;
  }
  return t;
}

export const ctaSentences = (caption) => sentences(caption).map((s) => s.text).filter((s) => !/^[#@]/.test(s) && (CTA_START.test(s) || CTA_ANYWHERE.test(s)));

/** How a sentence ends, as a problem to report or null. */
export function dangling(text, { allowColon = false } = {}) {
  const t = normalise(text).replace(/["')\]”]+$/, '');
  if (!t) return null;
  if ((allowColon ? /[,;–-]$/ : /[,;:–-]$/).test(t)) return `ends with "${t.slice(-1)}"`;
  if (/(?:\.\.\.|…)$/.test(t)) return 'trails off with "..."';
  const last = tokens(t.replace(/[.!?]+$/, '')).at(-1);
  if (last && DANGLING.has(last)) return `ends on the word "${last}"`;
  return null;
}

export function checkCopy(doc, { surfaces = textSurfaces(doc) } = {}) {
  const findings = [];
  const copy = doc.copy ?? {};
  const caption = copy.caption ?? '';
  const where = { layer: 'copy' };

  if (!caption.trim()) {
    findings.push(error('no-caption', 'The post has no caption.', { fix: 'Write the caption: a hook in the first line, the point, one call to action.' }));
  } else {
    // the hook must be a whole sentence inside the part the feed shows
    const limit = hookChars();
    const first = sentences(caption)[0];
    if (caption.length > limit && first && first.end > limit) {
      findings.push(warn('hook-too-long', `The caption's first sentence runs to ${first.end} characters. Feeds show only about ${limit} before "more", so the hook would be cut off.`, { ...where, fix: `Open with a sentence of about ${limit} characters or fewer that stands on its own, then the rest.` }));
    }
    if (first && tokens(first.text).length < 3 && sentences(caption).length > 1) {
      findings.push(info('hook-weak', `The caption opens with "${first.text}", which says very little. The first line is what stops the scroll.`, { ...where, fix: 'Open with the most interesting true thing the post says.' }));
    }

    // one call to action
    const ctas = ctaSentences(caption);
    const cta = copy.cta ? normalise(copy.cta) : '';
    const distinct = ctas.filter((s) => !cta || lower(s) !== lower(cta));
    if (!ctas.length && !cta) findings.push(warn('no-cta', 'The caption does not ask the reader to do anything.', { ...where, fix: 'End with one clear call to action: book, call, visit, follow, message.' }));
    else if (distinct.length >= 2 || (cta && distinct.length >= 1 && !caption.includes(copy.cta))) {
      const list = (cta && !caption.includes(copy.cta) ? [cta, ...distinct] : distinct).slice(0, 3);
      findings.push(warn('several-ctas', `The post asks the reader to do more than one thing (${list.map((c) => `"${clip(c, 50)}"`).join('; ')}). One call to action works better.`, { ...where, fix: 'Keep the one that matters most and cut the rest.' }));
    }

    // how it ends
    const body = bodyOf(caption);
    const lastLine = body.split('\n').at(-1) ?? '';
    const cut = dangling(lastLine);
    if (cut) findings.push(error('caption-cut-off', `The caption looks cut off: its last line ${cut} ("${clip(lastLine.slice(-60), 70)}").`, { ...where, fix: 'Finish the sentence, or take out the unfinished part.' }));
  }
  for (const [platform, o] of Object.entries(copy.platforms ?? {})) {
    if (o.caption) {
      const cut = dangling(bodyOf(o.caption).split('\n').at(-1) ?? '');
      if (cut) findings.push(error('caption-cut-off', `The ${platform} caption looks cut off: its last line ${cut}.`, { ...where, fix: 'Finish the sentence.' }));
    }
  }

  // text mistakes
  const all = [caption, ...surfaces.filter((s) => s.scope === 'layers.text').map((s) => s.text)].join('\n');
  const twice = /\b(\p{L}{2,})\s+\1\b/iu.exec(all);
  if (twice && !/^(?:had|that|is)$/i.test(twice[1])) findings.push(warn('repeated-word', `A word is repeated: "${twice[0]}".`, { fix: 'Delete one of them.' }));
  const noSpace = /[a-z]{3}[.!?][A-Z][a-z]{2}/.exec(caption);
  if (noSpace) findings.push(warn('missing-space', `There is no space after the full stop in "${noSpace[0]}".`, { ...where, fix: 'Add a space after the full stop.' }));
  if (/ {2,}/.test(caption)) findings.push(info('double-space', 'The caption has double spaces.', { ...where, fix: 'Use single spaces.' }));

  // hashtags
  const tags = new Set([...(copy.hashtags ?? []), ...(caption.match(/#[\p{L}\p{N}_]+/gu) ?? [])].map((h) => String(h).replace(/^#/, '').toLowerCase()));
  if (tags.size < 3) findings.push(warn('few-hashtags', `The post has ${tags.size} hashtag${tags.size === 1 ? '' : 's'}; 3 to 8 works best.`, { fix: 'Add a few specific hashtags (the town, the topic, the brand).' }));
  else if (tags.size > 8) findings.push(warn('many-hashtags', `The post has ${tags.size} hashtags; more than 8 looks like spam.`, { fix: 'Keep the 5 to 8 that are most specific.' }));

  // alt text for every page
  const need = doc.kind === 'video' ? [{ id: 'video', label: 'the video' }] : (doc.pages ?? []).map((p) => ({ id: p.id, label: `page "${p.id}"` }));
  for (const n of need) {
    const alt = copy.alt?.[n.id];
    if (!alt || !alt.trim()) findings.push(error('alt-missing', `There is no alt text for ${n.label}.`, { ...(n.id === 'video' ? where : { page: n.id }), fix: 'Write one sentence describing what the picture shows, for someone who cannot see it.' }));
    else if (alt.trim().length < 12) findings.push(warn('alt-short', `The alt text for ${n.label} is only "${alt}". It should describe what is shown.`, { ...(n.id === 'video' ? where : { page: n.id }), fix: 'Describe who or what is in the picture and what the words say.' }));
    else if (/^(?:image|picture|photo|photograph) of\b/i.test(alt.trim())) findings.push(info('alt-redundant', `The alt text for ${n.label} starts with "${alt.trim().split(/\s+/).slice(0, 2).join(' ')}"; screen readers already say it is a picture.`, { page: n.id, fix: 'Start with what is in the picture.' }));
  }

  // sentences that stop in the middle, on the pictures
  for (const s of surfaces.filter((x) => x.scope === 'layers.text')) {
    const text = normalise(s.text);
    const cut = dangling(text.split('\n').at(-1), { allowColon: true });
    if (cut && tokens(text).length >= 2) findings.push(error('text-cut-off', `${s.label} looks cut off: it ${cut} ("${clip(text, 70)}").`, { ...(s.page ? { page: s.page } : {}), ...(s.layer ? { layer: s.layer } : {}), ...(s.time ? { time: s.time.start } : {}), fix: 'Finish the line, or shorten it so it ends on a complete thought.' }));
  }
  return { findings };
}

/** The brief's literal musts: words it said to include and to avoid. */
export function checkBriefLiteral(doc, { surfaces = textSurfaces(doc) } = {}) {
  const findings = [];
  const b = doc.brief;
  if (!b) return { findings: [warn('no-brief', 'The post has no brief, so there is nothing to check it against.', { fix: 'Write the brief first (nordle_set_brief): the goal, the audience, the one message.' })] };
  const hay = lower(allText(surfaces));
  for (const m of b.mustInclude ?? []) if (!hay.includes(lower(m))) findings.push(warn('must-include-missing', `The brief says to include "${m}", and the post's words do not contain it.`, { fix: `Add "${m}" where it fits, or change the brief if it no longer applies.` }));
  for (const m of b.mustAvoid ?? []) if (hay.includes(lower(m))) findings.push(error('must-avoid-present', `The brief says to avoid "${m}", and the post uses it.`, { fix: `Take "${m}" out.` }));
  for (const k of ['goal', 'audience', 'message']) if (!b[k]) findings.push(info('brief-incomplete', `The brief has no ${k}.`, { fix: `Add the ${k} to the brief.` }));
  return { findings };
}
