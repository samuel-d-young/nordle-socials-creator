// "Triple check": three layers of checking before a post is shown to the owner.
//   1. AUTO      scripts (checkPost): technical, design, copy, compliance, facts, media-match, uniqueness, and for video speech-cuts, broll, audio.
//   2. DESIGNER  the Claude that built the post looks at the pictures and records an explicit judgement (recordManual).
//   3. REVIEWER  a different Claude, with no memory of building it, re-judges from a self-contained packet (reviewerPacket).
// finishGate says what is still missing or failing. Everything is written to <project>/checks/<doc>.json at the document's version.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { ROOT, readJson, validateDocData } from '../../tools/validate.mjs';
import { checkAudio, renderedVideo } from './audio.mjs';
import { checkBroll } from './broll.mjs';
import { checkBriefLiteral, checkCopy } from './copy.mjs';
import { checkFacts, loadFacts } from './facts.mjs';
import { applyAllowances, entryFindings, error, info, statusOf, summarise, warn } from './findings.mjs';
import { checkMedia } from './media.mjs';
import { checkCompliance } from './packs.mjs';
import { readProjectSettings } from './paths.mjs';
import { speechCuts } from './speech.mjs';
import { loadCatalog, loadChecks, recordCheck, requiredChecks, verificationStatus } from './store.mjs';
import { textSurfaces } from './surfaces.mjs';
import { shownText } from './transcript.mjs';
import { clip, plural, stamp } from './text.mjs';
import { buildTimeline } from './timeline.mjs';
import { checkUniqueness, listDocs, postDateOf } from './uniqueness.mjs';
import { motionReport } from './motion.mjs';
import { packetDir, pageImages, videoStills } from './visuals.mjs';

export const CHECKS = ['technical', 'design', 'copy', 'compliance', 'facts', 'media-match', 'uniqueness', 'brief', 'motion', 'speech-cuts', 'broll', 'audio'];
const EXPLAIN = {
  technical: 'Renders every size and looks for cut-off text, contrast, safe zones and broken files.',
  design: 'Grades hierarchy, spacing, alignment and balance out of 100.',
  copy: 'Hook, one call to action, hashtags, alt text, sentences that stop in the middle.',
  compliance: 'Wording rules (packs) read over every caption, hashtag, alt text, text layer and spoken word.',
  facts: 'Every phone, web address, price, name, title and number comes from facts.json.',
  'media-match': 'Every caption and piece of on-screen text is true of the picture or clip under it.',
  uniqueness: 'No repeated photo, hook, caption or headline within the month.',
  brief: 'Does the post do what the brief asked.',
  motion: 'Videos only: edited and animated like a motion designer made it. No text that just appears, no dead air, a hook in the first half second, varied entrances, a moving background on graphics, a proper ending. Score out of 100, pass 85.',
  'speech-cuts': 'No speaker is cut off; every cut sits on a sentence boundary.',
  broll: 'Cutaways fit what is being said and the voice carries on under them.',
  audio: 'Loudness around -14 LUFS, no clipping, music gives way to speech.',
};

// ---- the document and its version ------------------------------------------------------------------------------------------

export const docFile = (projectDir, docId) => join(projectDir, 'docs', `${docId}.json`);

/** How to write the project on a command line: projects/<id> inside the Nordle folder, else the full path in quotes. */
export function projectRef(projectDir) {
  const rel = relative(ROOT, projectDir);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : `"${projectDir}"`;
}

/** The version the editor would report: the last record in history/<doc>.jsonl (0 when the document was never edited in the editor). */
export function docVersion(projectDir, docId) {
  const f = join(projectDir, 'history', `${docId}.jsonl`);
  if (!existsSync(f)) return 0;
  const lines = readFileSync(f, 'utf8').split('\n').filter(Boolean);
  try { return JSON.parse(lines[lines.length - 1]).v; } catch { return lines.length; }
}

/** A short fingerprint of the document file. A document rebuilt from a spec keeps its version number; its fingerprint changes. */
export function docHash(projectDir, docId) {
  const f = docFile(projectDir, docId);
  return existsSync(f) ? createHash('sha1').update(readFileSync(f)).digest('hex').slice(0, 12) : '';
}

export function loadDoc(projectDir, docId) {
  const f = docFile(projectDir, docId);
  if (!existsSync(f)) throw new Error(`There is no document "${docId}" in ${projectDir} (looked for docs/${docId}.json).`);
  return JSON.parse(readFileSync(f, 'utf8'));
}

export function docIds(projectDir) { return listDocs(projectDir).map((d) => d.id).sort(); }

/** Everything the checks need that does not change between them. */
export function loadContext(projectDir, docId) {
  const doc = loadDoc(projectDir, docId);
  const brand = readJson(join(projectDir, 'brand.json'));
  const { facts, problems } = loadFacts(projectDir);
  const catalog = loadCatalog(projectDir, brand.id);
  const timeline = doc.kind === 'video' ? buildTimeline(doc, projectDir) : null;
  const surfaces = textSurfaces(doc, { projectDir, timeline });
  return { doc, brand, facts, factProblems: problems, catalog, timeline, surfaces, projectDir, v: docVersion(projectDir, docId), hash: docHash(projectDir, docId) };
}

const fromCritique = (i) => ({ level: i.level, rule: i.rule, message: `${i.message}${i.sizes?.length ? ` [${i.sizes.join(', ')}]` : ''}`, ...(i.fix ? { fix: i.fix } : {}), ...(i.page ? { page: i.page } : {}), ...(i.layer ? { layer: i.layer } : {}) });

// ---- layer 1: the scripts --------------------------------------------------------------------------------------------------

/**
 * Run the automatic checks and (unless record is false) write them to the checks record as by:"auto" at the document's version.
 * @param {string} projectDir
 * @param {string} docId
 * @param {{browser?:object, only?:string[], record?:boolean, skipRender?:boolean, measure?:boolean}} opts
 */
export async function checkPost(projectDir, docId, { browser, only, record = true, skipRender = false, measure = true } = {}) {
  const ctx = loadContext(projectDir, docId);
  const { doc, brand, facts, catalog, timeline, surfaces, v, hash } = ctx;
  const wants = (c) => !only?.length || only.includes(c);
  const results = {};
  const put = (check, findings, extra = {}) => {
    const f = applyAllowances(findings, projectDir);
    const status = extra.status ?? statusOf(f);
    results[check] = { check, status, findings: f, summary: extra.summary ?? (status === 'skipped' ? 'not run' : summarise(f)), ...(extra.score !== undefined ? { score: extra.score } : {}), ...(extra.pairs ? { pairs: extra.pairs } : {}), ...(extra.data ? { data: extra.data } : {}) };
  };

  // technical + design: the existing renderer and critique
  const needRender = doc.kind !== 'video' && (wants('technical') || wants('design')) && !skipRender;
  if (doc.kind === 'video') {
    if (wants('technical')) {
      const bad = validateDocData(doc, { brand, projectDir, platforms: readJson(join(ROOT, 'data', 'platforms.json')), assets: true });
      const f = bad.map((i) => ({ level: i.level === 'error' ? 'error' : 'warn', rule: 'document', message: `${i.path}: ${i.message}`, fix: 'Fix the document so it validates (node nordle.mjs validate).' }));
      for (const [id, s] of timeline.sources) if (s.type !== 'image' && !s.media.exists && s.media.mount === null) f.push(error('source-missing', `The source "${id}" (${s.path}) is not in the project folder.`, { fix: 'Copy the file into the project, or mount its folder in nordle.local.json.' }));
      put('technical', f);
    }
  } else if (needRender) {
    const { critiqueDocument } = await import('../render/critique.mjs');
    const { openBrowser } = await import('../render/browser.mjs');
    const own = !browser;
    const b = browser ?? (await openBrowser());
    try {
      const r = await critiqueDocument(docFile(projectDir, docId), { browser: b });
      const tech = r.issues.filter((i) => i.source === 'check').map(fromCritique);
      const design = r.issues.filter((i) => i.source === 'design').map(fromCritique);
      if (r.skipped) { put('technical', [error('document', r.skipped)]); } else {
        if (wants('technical')) put('technical', tech);
        if (wants('design')) {
          const fail = r.counts.error > 0 || r.score < r.passScore;
          put('design', design, { score: r.score, status: fail ? 'fail' : design.some((x) => x.level === 'warn') ? 'warn' : 'pass', summary: `design score ${r.score}/100 (pass mark ${r.passScore}); ${summarise(design)}` });
        }
      }
    } finally { if (own) await b.close(); }
  } else if (doc.kind !== 'video') {
    if (wants('technical')) put('technical', [], { status: 'skipped', summary: 'Rendering was skipped.' });
    if (wants('design')) put('design', [], { status: 'skipped', summary: 'Rendering was skipped.' });
  }

  if (wants('copy')) put('copy', checkCopy(doc, { surfaces }).findings);

  let compliancePacks = [];
  if (wants('compliance')) {
    const r = checkCompliance(doc, { projectDir, brand, facts, surfaces });
    compliancePacks = r.packs;
    const f = [...r.findings, ...ctx.factProblems.map((m) => warn('facts-invalid', m))];
    put('compliance', f, { summary: `${summarise(f)}${r.packs.length ? `; packs: ${r.packs.map((p) => `${p.id} ${p.version}`).join(', ')} (not legal advice, check current AHPRA guidance)` : ''}`, data: { packs: r.packs } });
  }

  if (wants('facts')) {
    const transcriptText = (timeline?.clips ?? []).map((c) => shownText(c.words)).join(' ');
    const r = checkFacts(doc, { projectDir, facts, brand, surfaces, transcriptText });
    const f = [...r.findings, ...ctx.factProblems.map((m) => warn('facts-invalid', m))];
    if (!facts && !r.claims.length && !f.length) f.push(info('no-facts-needed', 'There is no facts.json, and the words contain no phone number, address, price, name or figure that needs one.'));
    put('facts', f, { summary: `${r.claims.length} claim${r.claims.length === 1 ? '' : 's'} read; ${summarise(f)}` });
  }

  let media = { findings: [], pairs: [], skipped: [] };
  if (wants('media-match') || wants('broll')) media = checkMedia(doc, { projectDir, brand, facts, catalog, timeline });
  if (wants('media-match')) put('media-match', media.findings, { pairs: media.pairs.slice(0, 60), summary: `${media.pairs.length} picture${media.pairs.length === 1 ? '' : 's'} compared (${media.pairs.filter((p) => p.verdict === 'match').length} match, ${media.pairs.filter((p) => p.verdict === 'unsure').length} unsure, ${media.pairs.filter((p) => p.verdict === 'mismatch').length} mismatch)${media.skipped.length ? `; skipped: ${media.skipped.slice(0, 4).join('; ')}` : ''}` });

  if (wants('uniqueness')) {
    const r = checkUniqueness(doc, { projectDir, brand });
    put('uniqueness', r.findings, { summary: `${r.compared.length} other post${r.compared.length === 1 ? '' : 's'} compared${r.month ? ` (${r.month})` : ' (no posting date set, so all were compared)'}; ${summarise(r.findings)}` });
  }
  if (wants('brief')) {
    const r = checkBriefLiteral(doc, { surfaces });
    put('brief', r.findings, { summary: `The literal parts of the brief; the reviewer judges the rest. ${summarise(r.findings)}` });
  }

  if (doc.kind === 'video') {
    if (wants('motion')) {
      const r = motionReport(doc);
      const fail = r.findings.some((f) => f.level === 'error') || r.score < r.passScore;
      put('motion', r.findings, { score: r.score, status: fail ? 'fail' : r.findings.some((f) => f.level === 'warn') ? 'warn' : 'pass', summary: `motion score ${r.score}/100 (pass mark ${r.passScore}); longest still stretch ${r.stats.longestStill} s; ${r.stats.entrances.length} kinds of entrance; ${summarise(r.findings)}` });
    }
    if (wants('speech-cuts')) {
      const r = speechCuts(doc, { projectDir, timeline, measure, catalog });
      put('speech-cuts', r.findings, { status: r.skipped && !r.findings.some((f) => f.level !== 'info') ? 'pass' : undefined, summary: r.skipped ?? `${r.cuts.length} cuts looked at; ${summarise(r.findings.filter((f) => f.level !== 'info'))}`, data: { cuts: r.cuts, hook: r.hook } });
    }
    if (wants('broll')) {
      const r = checkBroll(doc, { projectDir, catalog, facts, timeline });
      put('broll', r.findings, { pairs: r.pairs, summary: `${plural(r.cutaways.length, 'cutaway')}; ${summarise(r.findings.filter((f) => f.level !== 'info'))}` });
    }
    if (wants('audio')) {
      const r = checkAudio(doc, { projectDir, timeline });
      put('audio', r.findings, { status: r.skipped && !r.findings.some((f) => f.level === 'error') ? 'skipped' : undefined, summary: r.skipped ?? `${r.measured ? `${r.measured.integrated.toFixed(1)} LUFS, peak ${r.measured.truePeak.toFixed(1)} dBTP; ` : ''}${summarise(r.findings.filter((f) => f.level !== 'info'))}`, data: r.measured ?? undefined });
    }
  }

  if (record) {
    for (const r of Object.values(results)) {
      recordCheck(projectDir, docId, {
        check: r.check, by: 'auto', status: r.status, v, hash, summary: clip(r.summary, 400),
        ...(r.score !== undefined ? { score: r.score } : {}), findings: entryFindings(r.findings), ...(r.pairs?.length ? { pairs: r.pairs } : {}),
      });
    }
  }
  const all = Object.values(results);
  return {
    doc: { id: doc.id, title: doc.title, kind: doc.kind }, v, hash, results, packs: compliancePacks, recorded: record,
    counts: { fail: all.filter((r) => r.status === 'fail').length, warn: all.filter((r) => r.status === 'warn').length, pass: all.filter((r) => r.status === 'pass').length, skipped: all.filter((r) => r.status === 'skipped').length },
    ok: !all.some((r) => r.status === 'fail'),
  };
}

// ---- layers 2 and 3: judgements by the designer and an independent reviewer -------------------------------------------------

export const packetPath = (projectDir, docId) => join(projectDir, 'checks', `${docId}.packet.md`);

const keyOf = (p) => `${p.page ?? ''}|${p.media}|${p.time ?? ''}`;

/** The pairs a judge has to cover for a check: every picture (media-match) or every cutaway (broll). */
export function expectedPairs(projectDir, docId, check) {
  const ctx = loadContext(projectDir, docId);
  if (check === 'media-match') return checkMedia(ctx.doc, ctx).pairs;
  if (check === 'broll' && ctx.doc.kind === 'video') return checkBroll(ctx.doc, ctx).pairs;
  return [];
}

/**
 * Record the designer's or the reviewer's judgement. It has to be an explicit one: a summary saying what was looked at, and for
 * media-match and broll a verdict for every picture. A mismatch means status fail; "unsure" cannot be a pass.
 * @returns {{ok:boolean, errors:string[], entry?:object, gate?:object}}
 */
export function recordManual(projectDir, docId, { check, by, status, summary, pairs, findings, allowOwner = false } = {}) {
  const errors = [];
  const ctx = loadContext(projectDir, docId);
  if (!CHECKS.includes(check)) errors.push(`"${check}" is not a check. The checks are: ${CHECKS.join(', ')}.`);
  if (!['designer', 'reviewer', ...(allowOwner ? ['owner'] : [])].includes(by)) errors.push(by === 'auto' ? 'Automatic results are written by running the checks (node nordle.mjs check), not recorded by hand.' : by === 'owner' ? 'Only the owner can record an owner check, in the editor.' : `"${by}" is not a checker. Use designer or reviewer.`);
  if (!['pass', 'fail', 'warn', 'skipped'].includes(status)) errors.push('status must be pass, fail or warn.');
  if (by !== 'owner' && (!summary || summary.trim().length < 12)) errors.push('Say what you looked at and what you found in the summary (at least a sentence). A bare "pass" is not a judgement.');
  if (by === 'reviewer') {
    const p = packetPath(projectDir, docId);
    const has = existsSync(p) && readFileSync(p, 'utf8').includes(`hash: ${ctx.hash}`);
    if (!has) errors.push(`A reviewer works from the packet for this version of the post. There is none yet (or it is for an older version). Build it first: node nordle.mjs packet <project> ${docId}`);
  }
  if (['media-match', 'broll'].includes(check) && (by === 'designer' || by === 'reviewer')) {
    const need = expectedPairs(projectDir, docId, check);
    const given = pairs ?? [];
    for (const p of given) {
      if (!['match', 'mismatch', 'unsure'].includes(p.verdict)) errors.push(`The verdict for ${p.media ?? 'a picture'} must be match, mismatch or unsure.`);
      if (p.media === undefined) errors.push('Every pair needs the media path.');
    }
    const have = new Set(given.map(keyOf));
    const haveLoose = new Set(given.map((p) => `${p.media}|${p.page ?? ''}`));
    const missing = need.filter((p) => !have.has(keyOf(p)) && !haveLoose.has(`${p.media}|${p.page ?? ''}`));
    if (missing.length) errors.push(`Give a verdict for every picture. Missing: ${missing.slice(0, 6).map((p) => `${p.page ?? p.media}${p.time !== undefined ? ` at ${stamp(p.time)}` : ''}`).join(', ')}${missing.length > 6 ? ', ...' : ''}.`);
    if (status === 'pass' && given.some((p) => p.verdict !== 'match')) errors.push('You cannot pass a post with a picture you marked "mismatch" or "unsure". Use status fail or warn, or fix the post and judge again.');
    if (status === 'pass' && given.some((p) => !p.shows || p.shows.trim().length < 8)) errors.push('For a pass, say in "shows" what you actually see in each picture, in your own words. That is how a judgement is told from a rubber stamp.');
    if (given.some((p) => p.verdict === 'mismatch') && status !== 'fail') errors.push('A picture you marked "mismatch" means status fail.');
  }
  if (errors.length) return { ok: false, errors };
  const entry = {
    check, by, status, v: ctx.v, hash: ctx.hash, summary: clip(summary ?? '', 600),
    ...(pairs?.length ? { pairs: pairs.map((p) => ({ ...(p.page ? { page: p.page } : {}), ...(Number.isFinite(p.time) ? { time: p.time } : {}), media: p.media, ...(p.words ? { words: p.words } : {}), ...(p.shows ? { shows: p.shows } : {}), verdict: p.verdict, ...(p.note ? { note: p.note } : {}) })) } : {}),
    ...(findings?.length ? { findings: findings.slice(0, 40).map((f) => ({ level: f.level ?? 'warn', message: String(f.message), ...(f.fix ? { fix: String(f.fix) } : {}), ...(f.page ? { page: f.page } : {}), ...(f.media ? { media: f.media } : {}), ...(Number.isFinite(f.time) ? { time: f.time } : {}) })) } : {}),
  };
  recordCheck(projectDir, docId, entry);
  return { ok: true, errors: [], entry, gate: finishGate(projectDir, docId) };
}

// ---- the gate --------------------------------------------------------------------------------------------------------------

/** What is still missing or failing before this post can be shown to the owner. */
export function finishGate(projectDir, docId) {
  const doc = loadDoc(projectDir, docId);
  const v = docVersion(projectDir, docId);
  const hash = docHash(projectDir, docId);
  const rec = loadChecks(projectDir, docId);
  const stale = rec.entries.filter((e) => e.hash && e.hash !== hash);
  const current = { ...rec, entries: rec.entries.filter((e) => !e.hash || e.hash === hash) };
  const st = verificationStatus(doc, v, current);
  const latest = new Map();
  for (const e of current.entries.filter((x) => x.v === v)) latest.set(`${e.check}|${e.by}`, e);
  const next = [];
  const ref = `${projectRef(projectDir)} ${docId}`;
  const autoMissing = [...st.missing, ...st.failed].filter((m) => m.includes('(auto)'));
  if (autoMissing.length) next.push(`Run the scripts: node nordle.mjs check ${ref}${st.failed.some((m) => m.includes('(auto)')) ? '   (fix what failed first; each finding says how)' : ''}`);
  for (const m of [...st.missing, ...st.failed].filter((x) => x.includes('(designer)'))) next.push(`Designer: look at the pictures yourself, then record your verdict for ${m.replace(/ \(designer\).*/, '')}: node nordle.mjs record ${ref} --check ${m.split(' ')[0]} --by designer --status pass --summary "what you saw" [--pairs file.json]`);
  const needReviewer = [...st.missing, ...st.failed].filter((x) => x.includes('(reviewer)'));
  if (needReviewer.length) next.push(`Reviewer: a different Claude with no memory of building the post reads node nordle.mjs packet ${ref}, looks at its images, and records ${needReviewer.map((m) => m.split(' ')[0]).join(', ')} with --by reviewer.`);
  return {
    doc: docId, v, hash, verified: st.verified, missing: st.missing, failed: st.failed, warned: st.warned, stale: stale.length ? [...new Set(stale.map((e) => `${e.check} (${e.by})`))] : [], next,
    entries: [...latest.values()].map((e) => ({ check: e.check, by: e.by, status: e.status, summary: e.summary ?? '', at: e.at })),
  };
}

// ---- the reviewer's packet --------------------------------------------------------------------------------------------------

/** Questions put to the reviewer, the same every time. */
export function reviewerQuestions(doc) {
  const q = [];
  const video = doc.kind === 'video';
  q.push('MEDIA-MATCH. For EACH picture/moment below, first write what you actually SEE in it (people, place, equipment, text), then judge: does every word on it, the alt text and the caption sentence that names it tell the truth about that picture? A caption that names something the picture does not show is a mismatch. Say match, mismatch or unsure for each, never skip one.');
  q.push('PEOPLE AND PLACES. Does any picture show an identifiable patient, or a child’s face? Is anyone named in the words someone other than who is pictured? Is a building, town or room named that the picture is not of?');
  q.push('WORDS. Is the caption true, does its first line work as a hook, is there one call to action, and is every sentence finished (nothing cut off, nothing trailing)?');
  q.push('COMPLIANCE. Read every word as an Australian health-advertising regulator would: testimonials or reviews, before-and-after, best/painless/guaranteed/cure/safe, offers or "free" without full conditions, pressure or urgency, claims needing a source, comparisons with other practices, protected titles such as "specialist", implant or healing time periods. Quote anything doubtful. (Not legal advice.)');
  q.push('FACTS. Is every phone number, web address, price, address, opening time, staff name and job title in the words present in the FACTS section below? Quote any that is not.');
  q.push('BRIEF. Does the post do what the brief asks (goal, audience, message, tone), include what it must and avoid what it must avoid?');
  q.push('REPEATS. Does the post reuse a photo, hook, headline or caption from the other posts listed under REPEATS?');
  if (video) {
    q.push('SPEECH CUTS. For each clip with a speaker, do its first words begin a sentence and its last words end one (see the CUTS table)? You cannot hear the audio: judge from the words, and flag any cut whose words start or stop in the middle of a thought.');
    q.push('B-ROLL. For each cutaway, does the picture fit the words said over it? Does it hide a name being said or a number? Does the voice carry on under it?');
    q.push('CAPTIONS AND OVERLAYS. Does the on-screen text match what is said and shown at that moment?');
  } else {
    q.push('DESIGN. Is anything cut off, overlapping, too small or hard to read? Does the first page earn the swipe and the last say what to do next?');
  }
  return q;
}

/** The packet: everything a fresh Claude needs to judge the post, as one markdown file with image paths to open. */
export async function reviewerPacket(projectDir, docId, { browser } = {}) {
  const ctx = loadContext(projectDir, docId);
  const { doc, brand, facts, catalog, timeline } = ctx;
  const mkdir = (d) => mkdirSync(d, { recursive: true });
  const L = [];
  const imgs = [];
  const auto = loadChecks(projectDir, docId).entries.filter((e) => e.by === 'auto' && e.v === ctx.v && (!e.hash || e.hash === ctx.hash));

  L.push(`# Reviewer packet: ${doc.title} (${doc.id})`, '', `hash: ${ctx.hash}`, `version: ${ctx.v}`, `kind: ${doc.kind}${doc.kind === 'video' ? `, ${doc.timeline.duration}s` : `, ${doc.pages.length} page${doc.pages.length === 1 ? '' : 's'}`}`, `brand: ${brand.name ?? brand.id}`, '');
  L.push('## Your job', '',
    'You are the independent reviewer. You did NOT build this post and you have no memory of building it. Do not trust the designer’s notes: look yourself.',
    'Open every image listed below with the Read tool (they are real image files; open each one), then answer the questions at the end.',
    'Be strict: a wrong caption, a wrong name or a cut-off sentence that reaches the owner is a failure of this check. If you cannot tell, say "unsure" rather than "match".', '');

  L.push('## The brief', '');
  const b = doc.brief ?? {};
  for (const k of ['goal', 'audience', 'message', 'tone']) L.push(`- ${k}: ${b[k] ?? '(not written)'}`);
  if (b.mustInclude?.length) L.push(`- must include: ${b.mustInclude.join('; ')}`);
  if (b.mustAvoid?.length) L.push(`- must avoid: ${b.mustAvoid.join('; ')}`);
  if (b.postDate) L.push(`- post date: ${b.postDate}`);
  if (b.notes) L.push(`- notes: ${b.notes}`);
  L.push('');

  L.push('## The caption (exactly as it will be posted)', '', '```', (doc.copy?.caption ?? '(no caption)'), '```');
  if (doc.copy?.cta) L.push(`Call to action field: ${doc.copy.cta}`);
  if (doc.copy?.hashtags?.length) L.push(`Hashtags: ${doc.copy.hashtags.join(' ')}`);
  L.push('');

  // pictures
  let pairs = [];
  let cuts = null;
  if (doc.kind === 'video') {
    const stills = videoStills(projectDir, doc, { timeline });
    const media = checkMedia(doc, ctx);
    const bro = checkBroll(doc, ctx);
    pairs = [...media.pairs, ...bro.pairs];
    const sp = speechCuts(doc, { projectDir, timeline, measure: false, catalog });
    cuts = sp.cuts;
    L.push('## The video, moment by moment', '', 'Each still is a frame from the video (or from the footage if it has not been rendered). Read each image.', '');
    for (const s of stills) {
      L.push(`### ${s.label}`);
      L.push(s.path ? `Image: ${s.path}` : `Image: (none${s.note ? `: ${s.note}` : ''})`);
      if (s.path && s.note) L.push(`Note: ${s.note}`);
      if (s.words) L.push(`Said around now: "${s.words}"`);
      if (s.overlays) L.push(`On-screen text now: "${s.overlays}"`);
      L.push('');
      if (s.path) imgs.push({ label: s.label, path: s.path });
    }
    L.push('## The clips', '');
    for (const c of timeline.clips.filter((x) => x.trackType === 'video')) {
      const m = catalog.items && Object.entries(catalog.items).find(([k]) => k === c.src?.path)?.[1];
      L.push(`- clip "${c.id}" on ${stamp(c.tlStart)}–${stamp(c.tlEnd)} uses ${c.src?.path ?? c.source} (source ${c.in.toFixed(2)}–${c.out.toFixed(2)} s)${c.muted ? ', muted' : ''}. Catalog: ${m ? `"${m.shows}"${m.tags?.length ? ` tags [${m.tags.join(', ')}]` : ''}${m.traps?.length ? ` NOT: ${m.traps.join('; ')}` : ''}` : 'NO CATALOG ENTRY'}`);
      if (c.audible && c.words.length) L.push(`  - says: "${clip(shownText(c.words), 400)}"`);
    }
    L.push('');
    L.push('## CUTS (where speech starts and stops)', '', '| clip | cut | timeline | first or last words | status |', '|---|---|---|---|---|');
    for (const c of cuts) L.push(`| ${c.clip} | ${c.kind} | ${stamp(c.time)} | ${c.kind === 'in' ? c.firstWords : c.lastWords} | ${c.status} |`);
    L.push('');
  } else {
    const pagesImgs = await pageImages(projectDir, doc, { browser, render: true });
    const media = checkMedia(doc, ctx);
    pairs = media.pairs;
    L.push('## The pages', '');
    for (const p of pagesImgs) {
      L.push(`### ${p.label}`, `Image: ${p.path}`, `On-screen words: ${p.words || '(none)'}`);
      const alt = doc.copy?.alt?.[p.page];
      if (alt) L.push(`Alt text: ${alt}`);
      const used = pairs.filter((x) => x.page === p.page);
      for (const u of used) L.push(`Picture used: ${u.media}. Catalog says: ${u.shows}`);
      L.push('');
      imgs.push({ label: p.label, path: p.path });
    }
  }

  // facts
  L.push('## FACTS (the only source for phone numbers, addresses, prices, hours, staff and titles)', '');
  if (!facts) L.push('There is no facts.json. Any phone number, address, price, opening time, staff name or title in the words is unverified: flag it.');
  else {
    for (const p of facts.phones ?? []) L.push(`- phone${p.label ? ` (${p.label})` : ''}: ${p.number}`);
    for (const a of facts.addresses ?? []) L.push(`- address: ${a.text}`);
    for (const h of facts.hours ?? []) L.push(`- hours: ${h.text}`);
    for (const w of facts.websites ?? []) L.push(`- website: ${w.url}`);
    for (const s of facts.social ?? []) L.push(`- ${s.platform}: ${s.handle}`);
    for (const e of facts.emails ?? []) L.push(`- email: ${e.address}`);
    for (const s of facts.staff ?? []) L.push(`- staff: ${s.name}, ${s.title}`);
    for (const s of facts.prices ?? []) L.push(`- price: ${s.text}`);
    for (const s of facts.approvedStats ?? []) L.push(`- approved figure: ${s.text}`);
    if (facts.services?.length) L.push(`- services: ${facts.services.map((s) => (typeof s === 'string' ? s : s.name)).join(', ')}`);
    if (facts.riskStatement?.text) L.push(`- risk statement: ${facts.riskStatement.text}`);
  }
  L.push('');

  // repeats
  const others = listDocs(projectDir).filter((d) => d.id !== doc.id);
  let calendar = null;
  try { calendar = JSON.parse(readFileSync(join(projectDir, 'calendar.json'), 'utf8')); } catch { /* no calendar */ }
  const myMonth = postDateOf(doc, calendar)?.slice(0, 7);
  L.push('## REPEATS (other posts in the same month)', '');
  const same = others.filter((d) => !myMonth || !postDateOf(d.doc, calendar) || postDateOf(d.doc, calendar).slice(0, 7) === myMonth);
  if (!same.length) L.push('(none)');
  for (const d of same.slice(0, 20)) {
    const photos = [...new Set(JSON.stringify(d.doc).match(/"(?:assets|sources)\/[^"]+\.(?:jpe?g|png|webp|mp4|mov)"/gi) ?? [])].map((s) => s.slice(1, -1));
    L.push(`- ${d.id}${postDateOf(d.doc, calendar) ? ` (${postDateOf(d.doc, calendar)})` : ''}: "${clip(d.doc.copy?.caption ?? '', 90)}" ${photos.length ? `[uses ${photos.slice(0, 5).join(', ')}]` : ''}`);
  }
  L.push('');

  // what the scripts found
  const settings = readProjectSettings(projectDir);
  L.push('## What the scripts found (for reference; do not let this replace your own look)', '');
  for (const e of auto) {
    L.push(`- ${e.check}: ${e.status}${e.summary ? ` — ${clip(e.summary, 160)}` : ''}`);
    for (const f of (e.findings ?? []).filter((x) => x.level !== 'info').slice(0, 4)) L.push(`  - ${f.level}: ${clip(f.message, 220)}`);
  }
  if (!auto.length) L.push('(the scripts have not been run on this version yet)');
  const allow = (settings.allow ?? []).filter((a) => a?.why);
  if (allow.length) { L.push('', 'The owner has allowed on purpose:'); for (const a of allow) L.push(`- ${a.rule ?? ''} ${a.text ? `"${a.text}"` : ''}: ${a.why}`); }
  L.push('');

  // questions + how to answer
  const questions = reviewerQuestions(doc);
  L.push('## Questions (answer every one)', '');
  questions.forEach((q, i) => L.push(`${i + 1}. ${q}`));
  L.push('', '## How to record your answer', '',
    'Record one entry per check, with the Nordle tool `nordle_record_check` (or the command line shown). Use by: "reviewer". For media-match give a pair for every picture:', '');
  const checks = requiredChecks(doc).filter((r) => r.by.includes('reviewer')).map((r) => r.check);
  const tmpl = pairs.map((p) => ({ ...(p.page ? { page: p.page } : {}), ...(p.time !== undefined ? { time: p.time } : {}), media: p.media, words: p.words, shows: '<what YOU see, in your own words>', verdict: '<match | mismatch | unsure>' }));
  L.push('```json', JSON.stringify({ project: projectDir.split(/[\\/]/).at(-1), doc: doc.id, check: 'media-match', by: 'reviewer', status: '<pass | warn | fail>', summary: '<what you looked at and what you found>', pairs: tmpl }, null, 2), '```', '',
    `Checks you must record: ${checks.join(', ')}. Command line: node nordle.mjs record ${projectRef(projectDir)} ${doc.id} --check media-match --by reviewer --status pass --summary "..." --pairs pairs.json`,
    'A "pass" needs a verdict of "match" for every picture and what you actually saw in "shows". A "mismatch" anywhere means status "fail". If anything is unsure, use "warn" and say why.', '');

  mkdir(dirname(packetPath(projectDir, docId)));
  const text = `${L.join('\n')}\n`;
  const tmp = `${packetPath(projectDir, docId)}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, packetPath(projectDir, docId));
  return { path: packetPath(projectDir, docId), markdown: text, images: imgs, questions, pairs: tmpl, hash: ctx.hash, v: ctx.v, dir: packetDir(projectDir, docId) };
}

/** For "look at the pictures with the pairs": the pairs table plus the images, for the designer. */
export async function mediaReport(projectDir, docId, { browser } = {}) {
  const ctx = loadContext(projectDir, docId);
  const { doc, timeline } = ctx;
  const media = checkMedia(doc, ctx);
  const bro = doc.kind === 'video' ? checkBroll(doc, ctx) : { pairs: [], findings: [] };
  let images = [];
  if (doc.kind === 'video') images = videoStills(projectDir, doc, { timeline }).filter((s) => s.path).map((s) => ({ label: s.label, path: s.path }));
  else images = (await pageImages(projectDir, doc, { browser, render: true })).map((p) => ({ label: p.label, path: p.path }));
  return { doc: doc.id, v: ctx.v, pairs: [...media.pairs, ...bro.pairs], findings: [...media.findings, ...bro.findings], skipped: media.skipped, images, hasRender: Boolean(renderedVideo(projectDir, docId)) };
}
