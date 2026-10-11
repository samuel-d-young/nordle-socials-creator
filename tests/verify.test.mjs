// Triple-check: every rule has a case that fails and a case that passes. Uses the fictional sample project copied to a temp folder,
// plus synthetic catalogs, transcripts and generated sound. Nothing here touches a real client's files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ROOT, validateAll, validators } from '../tools/validate.mjs';
import { openBrowser } from '../src/render/browser.mjs';
import { endsWithAbbreviation, jaccard, keywords, sentences, tokens } from '../src/verify/text.mjs';
import { isSentenceEnd, normaliseWords, numberWordsToDigits, segmentSentences, startsSentence } from '../src/verify/transcript.mjs';
import { resolveMedia } from '../src/verify/paths.mjs';
import { textSurfaces } from '../src/verify/surfaces.mjs';
import { evaluatePack, loadPacks, phraseRegex, checkCompliance } from '../src/verify/packs.mjs';
import { checkFacts, extractClaims } from '../src/verify/facts.mjs';
import { checkMedia, judgePair, lookupMedia } from '../src/verify/media.mjs';
import { speechCuts } from '../src/verify/speech.mjs';
import { checkBroll, introductions } from '../src/verify/broll.mjs';
import { checkAudio, measureLoudness } from '../src/verify/audio.mjs';
import { checkUniqueness } from '../src/verify/uniqueness.mjs';
import { checkBriefLiteral, checkCopy, dangling } from '../src/verify/copy.mjs';
import { applyAllowances } from '../src/verify/findings.mjs';
import { ffmpegAvailable, run as ff, ffmpegPath } from '../src/verify/ff.mjs';
import { requiredChecks, verificationStatus } from '../src/verify/store.mjs';
import { checkPost, docHash, finishGate, recordManual, reviewerPacket } from '../src/verify/run.mjs';
import verifyTools from '../src/mcp/tools/verify.mjs';
import cliCommands from '../src/cli/verify.mjs';

const HAS_FF = ffmpegAvailable();
const rules = (findings) => findings.map((f) => f.rule);
const levelOf = (findings, rule) => findings.find((f) => f.rule === rule)?.level;
const has = (findings, rule) => findings.some((f) => f.rule === rule);

let work; let P; let browser;
const put = (rel, data) => {
  const f = join(P, rel);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, typeof data === 'string' || Buffer.isBuffer(data) ? data : `${JSON.stringify(data, null, 2)}\n`);
  return f;
};

// ---- a synthetic talking source ---------------------------------------------------------------------------------------------
// Four sentences at known times. The sound has a tone exactly where each word is, silence elsewhere.
const W = (text, start, end) => ({ text, start, end });
const WORDS = [
  W('Hello', 2.0, 2.4), W('and', 2.5, 2.7), W('welcome', 2.8, 3.3), W('to', 3.4, 3.55), W('our', 3.65, 3.85), W('practice.', 3.95, 4.5),
  W('We', 5.2, 5.4), W('look', 5.5, 5.8), W('after', 5.9, 6.3), W('the', 6.4, 6.55), W('whole', 6.65, 7.0), W('family.', 7.1, 7.7),
  W('Our', 8.0, 8.2), W('x-ray', 8.3, 8.7), W('room', 8.8, 9.1), W('is', 9.2, 9.3), W('just', 9.4, 9.6), W('down', 9.7, 9.9), W('the', 10.0, 10.1), W('hall.', 10.2, 10.6),
  W("I'm", 11.5, 11.7), W('Sam', 11.8, 12.1), W('and', 12.2, 12.3), W('I', 12.4, 12.5), W('look', 12.6, 12.8), W('after', 12.9, 13.2), W('the', 13.3, 13.4), W('team.', 13.5, 14.0),
];
/** 1 while any of the words is being said (shifted to a timeline position, optionally letting each word ring on). */
const voice = (words, { shift = 0, ring = 0 } = {}) => (t) => (words.some((w) => t >= w.start - shift && t < w.end + ring - shift) ? 1 : 0);
/** A mono 16-bit WAV written straight from a function of time, so the sound is exactly what the test says it is. */
function wav(rel, fn, seconds = 15, sr = 16000) {
  const n = Math.round(seconds * sr);
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(fn(i / sr) * 32767))), 44 + i * 2);
  return put(rel, b);
}
/** The same sound as an AAC .mp4, the shape of a rendered video. */
function mp4(rel, fn, seconds) {
  const src = wav(`${rel}.tmp.wav`, fn, seconds, 44100);
  const out = join(P, rel);
  const r = ff(ffmpegPath(), ['-y', '-v', 'error', '-i', src, '-c:a', 'aac', '-b:a', '160k', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  rmSync(src);
  return out;
}
const tone = (hz, amp) => (t) => amp * Math.sin(2 * Math.PI * hz * t);

before(async () => {
  work = mkdtempSync(join(tmpdir(), 'nordle-verify-'));
  P = join(work, 'little-gannet');
  cpSync(join(ROOT, 'samples', 'little-gannet'), P, { recursive: true, filter: (s) => !/[\\/](out|sources)([\\/]|$)/.test(s) });
  put('nordle.project.json', { packs: ['plain-claims/pack.json', 'ahpra-dental/pack.json'] });
  put('sources/talk.words.json', { schema: 'nordle.words/0.1', synthetic: true, words: WORDS });
  wav('sources/talk.wav', (t) => tone(220, 0.5)(t) * voice(WORDS)(t));
  wav('sources/late.wav', (t) => tone(220, 0.5)(t) * voice(WORDS, { ring: 0.3 })(t));
  browser = await openBrowser();
});
after(async () => {
  await browser?.close();
  rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

// ---- text helpers ------------------------------------------------------------------------------------------------------------

test('sentences: abbreviations, initials, decimals and new lines do not fool the splitter', () => {
  assert.deepEqual(sentences('Meet Dr. Sam Smith. Open 9 a.m. today! Cost is 3.5 mm. Come in').map((s) => s.text), ['Meet Dr. Sam Smith.', 'Open 9 a.m. today!', 'Cost is 3.5 mm.', 'Come in']);
  assert.deepEqual(sentences('Line one\nLine two').map((s) => s.text), ['Line one', 'Line two']);
  assert.equal(sentences('We close at 5 pm. See you').length, 2, '"pm." can end a sentence');
  assert.ok(endsWithAbbreviation('Dr.') && endsWithAbbreviation('J.') && !endsWithAbbreviation('town.'));
});

test('transcripts: formats, sentence ends, new-thought gaps and spoken numbers', () => {
  const whisper = normaliseWords({ segments: [{ words: [{ word: ' Hi', start: 0, end: 0.3 }, { word: 'there.', start: 0.4, end: 0.8 }] }] });
  assert.deepEqual(whisper.map((w) => w.text), ['Hi', 'there.']);
  assert.ok(isSentenceEnd(whisper[1]) && !isSentenceEnd(whisper[0]));
  assert.ok(!isSentenceEnd({ text: 'Dr.' }) && !isSentenceEnd({ text: 'so...' }) && isSentenceEnd({ text: 'ok?"' }));
  assert.ok(isSentenceEnd({ text: 'unpunctuated', final: true }), 'the transcript may mark an end itself');
  assert.ok(startsSentence(WORDS, 6) && !startsSentence(WORDS, 7) && startsSentence(WORDS, 0));
  const gap = [W('a', 0, 0.2), W('b', 1.2, 1.4)];
  assert.ok(startsSentence(gap, 1), 'a pause of 0.6 s or more starts a new thought');
  assert.equal(segmentSentences(WORDS).length, 4);
  assert.equal(numberWordsToDigits('over twenty five years and three patients'), 'over 25 years and 3 patients');
});

test('keywords meet across wording: scanner and x-ray are one idea, stop words are dropped', () => {
  assert.ok(keywords('Our X-ray scanner').has('xray'));
  assert.ok(keywords('sterilising the instruments').has('steriliser'));
  assert.ok(!keywords('Come and visit us today').has('come'));
  assert.ok(jaccard(tokens('a b c'), tokens('a b d')) > 0.49);
});

// ---- wording packs -----------------------------------------------------------------------------------------------------------

const doc0 = (copy = {}, extra = {}) => ({ schema: 'nordle.doc/0.1', id: 't', title: 't', kind: 'graphic', brand: 'little-gannet', sizes: ['ig-feed-4x5'], copy, pages: [{ id: 'p1', layers: [] }], ...extra });
const AHPRA = () => JSON.parse(readFileSync(join(ROOT, 'examples', 'packs', 'ahpra-dental', 'pack.json'), 'utf8'));
const ahpra = (doc) => evaluatePack(AHPRA(), doc, textSurfaces(doc));

test('the AHPRA dental pack is a valid pack and ships with its disclaimer', () => {
  const pack = AHPRA();
  assert.ok(validators().pack(pack), JSON.stringify(validators().pack.errors));
  assert.match(pack.disclaimer, /not legal advice/i);
  assert.match(pack.disclaimer, /AHPRA/);
  assert.equal(pack.runsCode, false);
  const results = validateAll([join(ROOT, 'examples')], { assets: true });
  assert.deepEqual(results.flatMap((r) => r.issues.filter((i) => i.level === 'error').map((i) => `${r.file}: ${i.message}`)), []);
});

test('every phrase the practice already vetted is caught by the AHPRA pack', () => {
  const phrases = ['best', 'painless', 'pain-free', 'guarantee', 'cheapest', 'leading', 'world-class', 'perfect', 'safest', 'safe', 'no risk', '#1', 'number one', 'free', '20% off', 'reviews', 'testimonial',
    'before and after', 'before & after', 'happy patients', 'dream smile', 'hollywood', 'confidence', 'self-esteem', 'specialist', 'expert', 'permanent', 'lifetime', 'instant', 'same-day'];
  const missed = phrases.filter((p) => !ahpra(doc0({ caption: `We offer ${p} care in town.` })).length);
  assert.deepEqual(missed, []);
});

test('pack rules read every text surface: caption, hashtags, alt text, text layers, runs, overlay text and speech', () => {
  const where = (doc) => ahpra(doc).filter((f) => f.rule === 'ahpra-dental/painless').map((f) => f.message);
  assert.equal(where(doc0({ caption: 'Painless dentistry.' })).length, 1);
  assert.equal(where(doc0({ hashtags: ['#PainFreeCare'] })).length, 1, 'camel-case hashtags are read as words');
  assert.equal(where(doc0({ alt: { p1: 'A sign that says painless' } })).length, 1);
  const layered = doc0({}, { pages: [{ id: 'p1', layers: [{ id: 'h', type: 'text', runs: [{ text: 'Totally ' }, { text: 'pain free', style: { italic: true } }] }, { id: 'g', type: 'group', children: [{ id: 'k', type: 'text', text: 'No pain', overrides: { 'ig-feed-4x5': { text: 'Zero pain' } } }] }] }] });
  assert.equal(where(layered).length, 3, 'runs, nested layers and per-size text are all read');
  const video = { ...doc0({}), kind: 'video', layers: [{ id: 'ov', type: 'text', text: 'It is painless', time: { start: 0, end: 2 } }] };
  delete video.pages;
  assert.equal(where(video).length, 1, 'overlay text on a video is read');
  assert.equal(where(doc0({ caption: 'Gentle, careful dentistry.' })).length, 0);
});

test('pack rules: exceptions, whole words, offers, pressure, testimonials, titles and comparisons', () => {
  const r = (caption) => rules(ahpra(doc0({ caption })));
  assert.ok(!r('Feel free to call us.').includes('ahpra-dental/free'), '"feel free" is not an offer');
  assert.ok(r('Free whitening this week.').includes('ahpra-dental/free'));
  assert.ok(r('20% off all check-ups').includes('ahpra-dental/percent-off'));
  assert.ok(r('Book now. Limited time only!').includes('ahpra-dental/pressure'));
  assert.ok(r('Our patients say we are great').includes('ahpra-dental/testimonials'));
  assert.ok(r('Our specialist team').includes('ahpra-dental/specialist-title'));
  assert.ok(r('Better than other dentists').includes('ahpra-dental/comparisons'));
  assert.ok(r('Dentists recommend us').includes('ahpra-dental/testimonials') || r('Dentists recommend us').includes('ahpra-dental/dentist-recommended'));
  assert.ok(!r('The best practice is to brush twice a day.').includes('ahpra-dental/superlatives'), 'an exception keeps "best practice"');
  assert.ok(!r('A cleaner, brighter workplace').includes('ahpra-dental/superlatives'));
  assert.ok(!phraseRegex('best', { wholeWord: true }).test('bestow'), 'whole words only');
});

test('implant and healing time periods are caught in either word order, and "same day" is a warning', () => {
  const f = (caption) => ahpra(doc0({ caption }));
  assert.equal(levelOf(f('Dental implants healed in 3 weeks'), 'ahpra-dental/implant-healing-time'), 'error');
  assert.equal(levelOf(f('Within 6 months your new implants are ready'), 'ahpra-dental/implant-healing-time-before'), 'error');
  assert.equal(levelOf(f('Teeth in a day, no waiting'), 'ahpra-dental/teeth-in-a-day'), 'error');
  assert.equal(levelOf(f('Most people recover within 2 days'), 'ahpra-dental/healing-time'), 'warn');
  assert.equal(levelOf(f('Same day appointments'), 'ahpra-dental/same-day'), 'warn');
  assert.ok(!rules(f('Ask about dental implants at your check-up.')).includes('ahpra-dental/implant-healing-time'));
});

test('requireText: tagged implant posts must carry the risk wording; untagged posts are not asked', () => {
  const tagged = (caption) => ahpra({ ...doc0({ caption }), tags: ['implant'] });
  assert.ok(rules(tagged('Ask us about implants.')).includes('ahpra-dental/risk-wording'));
  assert.ok(!rules(tagged('Ask us about implants. Any surgical procedure carries risks. Seek a second opinion.')).includes('ahpra-dental/risk-wording'));
  assert.ok(!rules(ahpra(doc0({ caption: 'Ask us about implants.' }))).includes('ahpra-dental/risk-wording'));
});

test('a project lists packs in nordle.project.json; a missing pack is an error, no pack is a warning; the owner can allow one wording with a reason', () => {
  const loaded = loadPacks(P);
  assert.deepEqual(loaded.packs.map((p) => p.pack.id), ['plain-claims', 'ahpra-dental']);
  assert.deepEqual(loadPacks(P, { packs: ['nope/pack.json'] }).problems.length, 1);
  assert.equal(loadPacks(P, { packs: ['../../etc/passwd'] }).problems.length, 1, 'a path that leaves the project is refused');
  const doc = doc0({ caption: 'Free whitening for everyone this week!', hashtags: ['#a', '#b', '#c'] });
  const brand = JSON.parse(readFileSync(join(P, 'brand.json'), 'utf8'));
  const res = checkCompliance(doc, { projectDir: P, brand });
  assert.ok(has(res.findings, 'ahpra-dental/free'));
  assert.equal(res.packs.length, 2);
  const allowed = applyAllowances(res.findings, P, { allow: [{ rule: 'ahpra-dental/free', text: 'free whitening', why: 'Approved offer; terms are in the caption.' }] });
  assert.equal(allowed.find((f) => f.rule === 'ahpra-dental/free').level, 'info');
  const noReason = applyAllowances(res.findings, P, { allow: [{ rule: 'ahpra-dental/free' }] });
  assert.equal(noReason.find((f) => f.rule === 'ahpra-dental/free').level, 'error', 'an allowance without a reason does nothing');
  const bare = mkdtempSync(join(tmpdir(), 'nordle-nopack-'));
  try {
    writeFileSync(join(bare, 'brand.json'), '{}');
    assert.ok(has(checkCompliance(doc0({ caption: 'Hello' }), { projectDir: bare, brand: {} }).findings, 'no-packs'));
  } finally { rmSync(bare, { recursive: true, force: true }); }
});

test('brand banned phrases and facts bannedClaims are read over every surface, including alt text', () => {
  const brand = { voice: { bannedPhrases: ["world's best"] } };
  const doc = doc0({ caption: 'Hello', alt: { p1: 'The world\u2019s best coffee' } });
  const res = checkCompliance(doc, { projectDir: P, brand, facts: { bannedClaims: ['cures your tiredness'] } });
  assert.ok(has(res.findings, 'brand-banned'));
  const res2 = checkCompliance(doc0({ caption: 'It cures your tiredness' }), { projectDir: P, brand, facts: { bannedClaims: ['cures your tiredness'] } });
  assert.ok(has(res2.findings, 'facts-banned-claim'));
});

// ---- facts -------------------------------------------------------------------------------------------------------------------

const FACTS = () => JSON.parse(readFileSync(join(ROOT, 'examples', 'facts', 'little-gannet.facts.json'), 'utf8'));
const factsOf = (caption, extra = {}, facts = FACTS()) => checkFacts(doc0({ caption }, extra), { projectDir: P, facts }).findings;

test('facts: the right phone number passes, a wrong one is an error with the real numbers in the fix', () => {
  assert.deepEqual(factsOf('Call 03 5550 0142 to book.'), []);
  assert.deepEqual(factsOf('Call (03) 5550 0142 or +61 3 5550 0142.'), [], 'the same number written differently is the same number');
  const bad = factsOf('Call 03 5550 0143 to book.');
  assert.equal(levelOf(bad, 'unknown-phone'), 'error');
  assert.match(bad[0].fix, /03 5550 0142/);
  assert.ok(has(factsOf('Call 1300 123 456'), 'unknown-phone'));
});

test('facts: web addresses, emails, handles, addresses and prices are checked against facts.json', () => {
  assert.deepEqual(factsOf('Visit example.com or https://www.example.com/menu, hello@example.com, @littlegannet. 12 Quay Street. Latte $6.50.'), []);
  assert.ok(has(factsOf('Visit cheapcoffee.com.au'), 'unknown-url'));
  assert.ok(has(factsOf('Email bob@other.com'), 'unknown-email'));
  assert.ok(has(factsOf('Follow @someoneelse'), 'unknown-handle'));
  assert.ok(has(factsOf('Find us at 99 Bad Road'), 'unknown-address'));
  assert.ok(has(factsOf('Only $9.00 today'), 'unknown-price'));
  assert.equal(levelOf(factsOf('Only $9.00 today'), 'unknown-price'), 'error');
});

test('facts: statistics, years in business and opening times need a source; odd numbers are warnings', () => {
  assert.equal(levelOf(factsOf('95% of customers love us'), 'unknown-percent'), 'error');
  assert.equal(levelOf(factsOf('Roasting since 2015'), 'unknown-since'), 'error');
  assert.deepEqual(factsOf('Roasting small batches since 2019'), []);
  assert.equal(levelOf(factsOf('Over 20 years of experience'), 'unknown-years'), 'error');
  assert.equal(levelOf(factsOf('Open until 8 pm'), 'unknown-time'), 'error');
  assert.deepEqual(factsOf('Open from 7 am to 3 pm'), []);
  assert.equal(levelOf(factsOf('Steep for 4 minutes'), 'unknown-unit'), 'warn');
  assert.equal(levelOf(factsOf('1200 happy customers'), 'unknown-count'), 'error');
  const noHours = factsOf('Open from 7 am', {}, { ...FACTS(), hours: [] });
  assert.equal(levelOf(noHours, 'hours-not-in-facts'), 'warn');
});

test('facts: a claim the brief supplies passes with a note; with no facts.json every claim is unknown', () => {
  const doc = doc0({ caption: 'Every cup is $9.00 this week.' }, { brief: { goal: 'Tell people the weekly special is $9.00' } });
  const r = checkFacts(doc, { projectDir: P, facts: FACTS() }).findings;
  assert.equal(levelOf(r, 'claim-from-brief'), 'info');
  assert.ok(!r.some((f) => f.level === 'error'));
  const none = checkFacts(doc0({ caption: 'Call 03 5550 0142' }), { projectDir: P, facts: null }).findings;
  assert.equal(levelOf(none, 'unknown-phone'), 'error');
});

test('facts: staff names and titles. A wrong title and an unknown "Dr" are errors; the right one passes', () => {
  assert.deepEqual(factsOf('Tom Rowe is our barista.'), []);
  assert.deepEqual(factsOf('Meet Maya, our head roaster.'), []);
  const wrong = factsOf('Meet Maya, our barista.');
  assert.equal(levelOf(wrong, 'wrong-staff-title'), 'error');
  assert.match(wrong[0].fix, /Head roaster/);
  assert.equal(levelOf(factsOf('Tom Rowe is our head roaster. Meet Maya, our head roaster.'), 'wrong-staff-title'), 'error', 'a title belongs to the name in its own sentence');
  assert.equal(levelOf(factsOf('Say hello to Dr Nobody'), 'unknown-staff-name'), 'error');
  assert.equal(levelOf(factsOf('Our barista Priya makes the best flat white'), 'unknown-staff-name'), 'error');
  assert.equal(levelOf(factsOf('Priya, our barista, will see you now'), 'unknown-staff-name'), 'error');
  for (const fine of ['Barista Training Days Are Back', 'Visit our barista Monday', 'Barista Appointments', 'Book a time with a barista', 'Dr Jane Citizen is our principal dentist, and Maya is our head roaster.']) {
    assert.ok(!has(factsOf(fine, {}, { ...FACTS(), staff: [...FACTS().staff, { name: 'Dr Jane Citizen', title: 'Principal dentist', source: 'x' }] }), 'unknown-staff-name'), fine);
  }
  assert.ok(!has(factsOf('Dr Jane Citizen is our principal dentist, and Maya is our head roaster.', {}, { ...FACTS(), staff: [...FACTS().staff, { name: 'Dr Jane Citizen', title: 'Principal dentist', source: 'x' }] }), 'wrong-staff-title'), 'each title goes with the name before it');
  const doc = doc0({}, { pages: [{ id: 'p1', layers: [{ id: 'card', type: 'group', children: [{ id: 'name', type: 'text', text: 'Maya' }, { id: 'role', type: 'text', text: 'Barista' }] }] }] });
  assert.equal(levelOf(checkFacts(doc, { projectDir: P, facts: FACTS() }).findings, 'wrong-staff-title'), 'error', 'a name card is checked as a pair');
});

test('facts: services, approved calls to action, brand links and the practice\'s own risk statement', () => {
  assert.equal(levelOf(factsOf('Try our new veneers'), 'service-not-in-facts'), 'warn');
  assert.ok(!has(factsOf('Try our cold brew'), 'service-not-in-facts'));
  const cta = checkFacts(doc0({ caption: 'Hi', cta: 'Buy now!!' }), { projectDir: P, facts: FACTS() }).findings;
  assert.equal(levelOf(cta, 'cta-not-approved'), 'warn');
  const brand = { links: { handle: '@brandhandle', website: 'https://brand.example' } };
  assert.deepEqual(checkFacts(doc0({ caption: 'Follow @brandhandle at brand.example' }), { projectDir: P, facts: FACTS(), brand }).findings, []);
  const dental = { ...FACTS(), riskStatement: { text: 'Any surgical procedure carries risks. Seek a second opinion.' } };
  assert.equal(levelOf(factsOf('Ask us about implants.', {}, dental), 'risk-statement-missing'), 'error');
  assert.ok(!has(factsOf('Ask us about implants. Any surgical procedure carries risks. Seek a second opinion.', {}, dental), 'risk-statement-missing'));
});

test('facts: claims are pulled from text without being fooled by dates and years', () => {
  const y = new Date().getFullYear();
  assert.deepEqual(extractClaims(`In ${y} ${y + 1} we did lots`).map((c) => c.type), [], 'two years side by side are not a phone number, and this year is not odd');
  assert.deepEqual(extractClaims('Founded in 1998, with awards in 2031').map((c) => c.type), ['since', 'year']);
  assert.deepEqual(extractClaims('Call 08 9725 8812 or 0412 345 678').map((c) => c.type), ['phone', 'phone']);
  assert.deepEqual(extractClaims('$6.50 for 2 hours').map((c) => c.type), ['price', 'unit']);
});

// ---- pictures and words ------------------------------------------------------------------------------------------------------

const brandOf = () => JSON.parse(readFileSync(join(P, 'brand.json'), 'utf8'));
const CAT = (items) => ({ schema: 'nordle.catalog/0.1', brand: 'little-gannet', items });
const photoDoc = (pages, extra = {}) => ({
  schema: 'nordle.doc/0.1', id: 'pics', title: 'Pics', kind: 'carousel', brand: 'little-gannet', sizes: ['ig-feed-4x5'], copy: { caption: 'Hello there.', alt: {}, ...(extra.copy ?? {}) },
  pages: pages.map(([id, text, src, alt]) => ({ id, layers: [{ id: 'h', type: 'text', text }, ...(src ? [{ id: 'img', type: 'image', src, alt: alt ?? '' }] : [])] })),
});
const photo = (name) => { put(`assets/photos/${name}`, `jpeg-${name}`); return `assets/photos/${name}`; };

test('media: a picture with no catalog entry is an error that says how to add one', () => {
  const src = photo('a.jpg');
  const r = checkMedia(photoDoc([['p1', 'Meet the team', src]]), { projectDir: P, brand: brandOf(), catalog: CAT({}) });
  assert.equal(levelOf(r.findings, 'not-catalogued'), 'error');
  assert.match(r.findings[0].fix, /assets\/catalog\.json/);
  assert.equal(r.pairs.length, 0);
});

test('media: do-not-use and patient-visible pictures are refused', () => {
  const src = photo('b.jpg');
  const r1 = checkMedia(photoDoc([['p1', 'Our rooms', src]]), { projectDir: P, brand: brandOf(), catalog: CAT({ [src]: { shows: 'An empty treatment room', doNotUse: 'Shows a client logo we may not use' } }) });
  assert.equal(levelOf(r1.findings, 'do-not-use'), 'error');
  const r2 = checkMedia(photoDoc([['p1', 'Our rooms', src]]), { projectDir: P, brand: brandOf(), catalog: CAT({ [src]: { shows: 'A patient in the chair with the dentist', patientVisible: true } }) });
  assert.equal(levelOf(r2.findings, 'patient-visible'), 'error');
});

test('media: words that name what the catalog says the picture is NOT are a mismatch (trap hit)', () => {
  const src = photo('c.jpg');
  const cat = CAT({ [src]: { shows: 'The steriliser on the back bench', tags: ['steriliser', 'instruments'], traps: ['is the steriliser, not the X-ray scanner'] } });
  const bad = checkMedia(photoDoc([['p1', 'Our X-ray scanner keeps images sharp', src]]), { projectDir: P, brand: brandOf(), catalog: cat });
  assert.equal(bad.pairs[0].verdict, 'mismatch');
  assert.equal(levelOf(bad.findings, 'media-mismatch'), 'error');
  assert.match(bad.findings.find((f) => f.rule === 'media-mismatch').message, /not the X-ray scanner/);
  const good = checkMedia(photoDoc([['p1', 'Every instrument is sterilised between patients', src]]), { projectDir: P, brand: brandOf(), catalog: cat });
  assert.equal(good.pairs[0].verdict, 'match');
  assert.ok(!has(good.findings, 'media-mismatch'));
});

test('media: usage notes and "no X in frame" traps never fire, and common words neither prove nor disprove a picture', () => {
  const src = photo('h.jpg');
  const notes = CAT({ [src]: { shows: 'A treatment room with a chair and an overhead light', tags: ['surgery'], traps: ['no clinic name or logo is in frame; use as anonymous practice life', 'used by the owner as the Meet the team cover'] } });
  const doc = photoDoc([['p1', 'Meet the team: practice life in our clinic, a carousel cover', src, 'A photo of the clinic']], { copy: { caption: 'Meet the team. A shot of practice life, no name or logo.', alt: {} } });
  const r = checkMedia(doc, { projectDir: P, brand: brandOf(), catalog: notes });
  assert.notEqual(r.pairs[0].verdict, 'mismatch');
  assert.ok(!has(r.findings, 'media-mismatch'));
  assert.equal(r.pairs[0].verdict, 'unsure', 'only common words in common: a person has to look');
  const real = CAT({ [src]: { shows: 'The X-ray plate scanner', tags: ['xray'], traps: ['is NOT a sterilisation room', 'is the X-ray plate scanner, not the steriliser'] } });
  assert.equal(checkMedia(photoDoc([['p1', 'Every instrument is sterilised here', src]]), { projectDir: P, brand: brandOf(), catalog: real }).pairs[0].verdict, 'mismatch');
  assert.notEqual(checkMedia(photoDoc([['p1', 'Our practice room at the clinic', src]]), { projectDir: P, brand: brandOf(), catalog: real }).pairs[0].verdict, 'mismatch', 'the word room alone is not what the trap is about');
});

test('media: general words are "unsure", never a guess, and the script says so once', () => {
  const src = photo('d.jpg');
  const cat = CAT({ [src]: { shows: 'The front desk with a vase of flowers', tags: ['reception'] } });
  const r = checkMedia(photoDoc([['p1', 'Good things take time', src]]), { projectDir: P, brand: brandOf(), catalog: cat });
  assert.equal(r.pairs[0].verdict, 'unsure');
  assert.equal(levelOf(r.findings, 'media-unsure'), 'warn');
  const m = checkMedia(photoDoc([['p1', 'Reception is open from 7 am', src]]), { projectDir: P, brand: brandOf(), catalog: cat });
  assert.equal(m.pairs[0].verdict, 'match');
});

test('media: the words attached to a page include its alt text and the caption sentence that names it', () => {
  const src = photo('e.jpg');
  const cat = CAT({ [src]: { shows: 'The steriliser on the back bench', tags: ['steriliser'], traps: ['not the X-ray scanner'] } });
  const doc = photoDoc([['p1', 'Our back room', src, 'The X-ray scanner in our back room']]);
  assert.equal(checkMedia(doc, { projectDir: P, brand: brandOf(), catalog: cat }).pairs[0].verdict, 'mismatch', 'alt text is read');
  const doc2 = photoDoc([['p1', 'Our back room', src, 'A machine on a bench']], { copy: { caption: 'Our back room is where the X-ray scanner lives.', alt: {} } });
  assert.equal(checkMedia(doc2, { projectDir: P, brand: brandOf(), catalog: cat }).pairs[0].verdict, 'mismatch', 'the caption sentence that names the page is read');
});

test('media: naming a person the catalog says is not pictured is a mismatch', () => {
  const src = photo('f.jpg');
  const facts = FACTS();
  const cat = CAT({ [src]: { shows: 'Tom at the espresso machine', people: ['Tom Rowe'] } });
  const bad = checkMedia(photoDoc([['p1', 'Meet Maya', src]]), { projectDir: P, brand: brandOf(), catalog: cat, facts });
  assert.equal(bad.pairs[0].verdict, 'mismatch');
  assert.match(bad.pairs[0].note, /Tom Rowe/);
  const good = checkMedia(photoDoc([['p1', 'Meet Tom', src]]), { projectDir: P, brand: brandOf(), catalog: cat, facts });
  assert.equal(good.pairs[0].verdict, 'match');
});

test('media: a repeated picture in one post, a catalog usedIn conflict, logos and pages with no picture', () => {
  const src = photo('g.jpg');
  const cat = CAT({ [src]: { shows: 'The shopfront in the morning light', tags: ['exterior'], usedIn: ['another-post'] } });
  const r = checkMedia(photoDoc([['p1', 'Find us', src], ['p2', 'Find us again', src], ['p3', 'Thanks']]), { projectDir: P, brand: brandOf(), catalog: cat });
  assert.ok(has(r.findings, 'picture-repeated'));
  assert.ok(has(r.findings, 'used-in-other-post'));
  assert.deepEqual(r.skipped, ['p3: no picture']);
  const logo = checkMedia(photoDoc([['p1', 'Hello', 'assets/logo.svg']]), { projectDir: P, brand: brandOf(), catalog: CAT({}) });
  assert.ok(!has(logo.findings, 'not-catalogued'), 'the brand logo needs no catalog entry');
});

test('media: catalog entries are found when the path is written differently', () => {
  const cat = CAT({ 'assets/photos/x.jpg': { shows: 'Something real here' }, 'mount:footage/Videos/C1.MP4': { shows: 'A talking clip' } });
  assert.equal(lookupMedia(cat, './assets\\photos\\x.jpg').via, 'normalised');
  assert.equal(lookupMedia(cat, 'Videos/C1.MP4').via, 'by the end of its path');
  assert.equal(lookupMedia(cat, 'assets/photos/nope.jpg'), null);
});

test('judgePair is careful: only a trap, a wrong name or an opposite is a mismatch', () => {
  const media = { shows: 'The shopfront at night, lights on', tags: ['exterior', 'night'] };
  assert.equal(judgePair({ strong: 'Open late into the night', media: { ...media, shows: 'The shopfront in daytime sun', tags: ['exterior', 'daytime'] } }).verdict, 'mismatch');
  assert.equal(judgePair({ strong: 'Come to our indoor garden', media: { shows: 'The outdoor courtyard with tables', tags: ['outdoor'] } }).verdict, 'mismatch');
  assert.equal(judgePair({ strong: 'Hello there', media }).verdict, 'unsure');
});

// ---- speech cuts -------------------------------------------------------------------------------------------------------------

const talkDoc = (clips, { sources, tracks, extra } = {}) => ({
  schema: 'nordle.doc/0.1', id: 'talk', title: 'Talk', kind: 'video', brand: 'little-gannet', sizes: ['ig-reel-9x16'], copy: { caption: 'Hello there.', alt: { video: 'Someone talking' } },
  sources: sources ?? [
    { id: 'talk', type: 'video', path: 'sources/talk.wav', duration: 15, transcript: 'sources/talk.words.json' },
    { id: 'late', type: 'video', path: 'sources/late.wav', duration: 15, transcript: 'sources/talk.words.json' },
    { id: 'pour', type: 'video', path: 'sources/pour.mp4', duration: 10 },
    { id: 'music', type: 'audio', path: 'sources/music.wav', duration: 20 },
  ],
  timeline: { fps: 30, duration: 30, tracks: tracks ?? [{ id: 'v1', type: 'video', clips }] },
  ...extra,
});
const clipOf = (inn, out, at = 0, extra = {}) => ({ id: 'a', source: 'talk', in: inn, out, at, ...extra });
const cuts = (clips, opts = {}) => speechCuts(talkDoc(clips), { projectDir: P, measure: false, ...opts });

test('speech: a clip that starts just before a sentence and ends just after one is clean', () => {
  const r = cuts([clipOf(1.94, 4.62)]);
  assert.deepEqual(r.findings.filter((f) => f.level !== 'info'), []);
  assert.equal(r.cuts.length, 2);
  assert.match(r.hook, /Hello and welcome to our practice\./);
});

test('speech: a cut-out in the middle of a sentence is an error and suggests the nearest sentence boundaries', () => {
  const r = cuts([clipOf(1.94, 6.4)]);
  const f = r.findings.find((x) => x.rule === 'ends-mid-sentence');
  assert.equal(f.level, 'error');
  assert.match(f.message, /We look after the whole family\./);
  assert.match(f.fix, /Set out to 7\.\d+/, 'finish the sentence');
  assert.match(f.fix, /or to 4\.\d+/, 'or end on the one before');
  assert.ok(Math.abs(f.time - 4.46) < 0.001, 'the finding says where on the timeline');
});

test('speech: a cut that lands inside a word is an error at either end', () => {
  const out = cuts([clipOf(1.94, 3.0)]).findings.find((x) => x.rule === 'cut-in-word');
  assert.equal(out.level, 'error');
  assert.match(out.message, /welcome/);
  const inn = cuts([clipOf(2.1, 4.62)]).findings.find((x) => x.rule === 'cut-in-word');
  assert.equal(inn.level, 'error');
  assert.match(inn.message, /Hello/);
  assert.match(inn.fix, /1\.9\d/);
});

test('speech: a clip that starts on the second half of a sentence, or too tight on a word, is an error', () => {
  const mid = cuts([clipOf(5.45, 7.82)]).findings.find((x) => x.rule === 'starts-mid-sentence');
  assert.equal(mid.level, 'error');
  assert.match(mid.fix, /5\.1\d/);
  assert.equal(cuts([clipOf(2.0, 4.62)]).findings.find((x) => x.rule === 'in-too-tight').level, 'error');
  assert.equal(cuts([clipOf(1.94, 4.53)]).findings.find((x) => x.rule === 'out-too-tight').level, 'error');
  assert.equal(cuts([clipOf(1.0, 4.62)]).findings.find((x) => x.rule === 'dead-air-start').level, 'warn');
});

test('speech: two clips joined without losing a word are fine; joined across a lost sentence they are not', () => {
  const clips = [clipOf(1.94, 4.62, 0), { id: 'b', source: 'talk', in: 5.14, out: 7.82, at: 2.68 }];
  assert.deepEqual(cuts(clips).findings.filter((f) => f.level === 'error'), [], 'a jump cut between two whole sentences is fine');
  const bad = [clipOf(1.94, 3.0, 0), { id: 'b', source: 'talk', in: 3.35, out: 4.62, at: 1.06 }];
  assert.ok(cuts(bad).findings.some((f) => f.level === 'error'), 'cutting out the middle of a sentence is flagged');
  const contiguous = [clipOf(1.94, 4.0, 0), { id: 'b', source: 'talk', in: 4.0, out: 4.62, at: 2.06 }];
  assert.deepEqual(cuts(contiguous).findings.filter((f) => f.level === 'error'), [], 'two clips that run on from each other are one cut');
});

test('speech: with a speaker the transcript says is finished but the sound is still going, the cut is an error', { skip: !HAS_FF }, () => {
  const ok = speechCuts(talkDoc([clipOf(1.94, 4.62)]), { projectDir: P });
  assert.deepEqual(ok.findings.filter((f) => f.level !== 'info'), [], 'silence at the cut: clean');
  const late = speechCuts(talkDoc([{ id: 'a', source: 'late', in: 1.94, out: 4.62, at: 0 }]), { projectDir: P });
  const f = late.findings.find((x) => x.rule === 'loud-at-cut-out');
  assert.equal(f.level, 'error');
  assert.match(f.message, /still going/);
  assert.equal(late.cuts.find((c) => c.kind === 'out').status, 'loud');
});

test('speech: footage the catalog says has speech but has no transcript cannot be verified', () => {
  const doc = talkDoc([{ id: 'c', source: 'pour', in: 0, out: 3, at: 0 }]);
  const catalog = CAT({ 'sources/pour.mp4': { shows: 'A person talking to camera', speech: 'Talks about the roast' } });
  const r = speechCuts(doc, { projectDir: P, measure: false, catalog });
  assert.equal(levelOf(r.findings, 'speech-without-transcript'), 'error');
  assert.ok(r.skipped, 'and there is no speaker to check');
});

test('speech: captions must follow a source that is heard', () => {
  const doc = talkDoc([clipOf(1.94, 4.62)], { extra: {} });
  doc.timeline.captions = { source: 'late' };
  assert.ok(has(speechCuts(doc, { projectDir: P, measure: false }).findings, 'captions-not-heard'));
});

// ---- B-roll ------------------------------------------------------------------------------------------------------------------

const brollDoc = (cut, speaker = clipOf(7.9, 10.7, 0), extra = {}) => talkDoc(null, {
  tracks: [{ id: 'v1', type: 'video', clips: [speaker] }, { id: 'v2', type: 'video', clips: [cut] }], ...extra,
});
const POUR = { id: 'cut', source: 'pour', in: 0, out: 2, at: 0.5, mute: true };
const bro = (cut, cat, speaker, extra) => checkBroll(brollDoc(cut, speaker, extra), { projectDir: P, catalog: CAT(cat), facts: FACTS() });

test('b-roll: a cutaway over speech must be catalogued', () => {
  const r = bro(POUR, {});
  assert.equal(levelOf(r.findings, 'broll-not-catalogued'), 'error');
  assert.equal(r.cutaways.length, 1);
});

test('b-roll: a clip that contradicts the words (trap hit) is an error; one that fits is a match', () => {
  const steriliser = { 'sources/pour.mp4': { shows: 'The steriliser on the bench', tags: ['steriliser'], traps: ['is the steriliser, not the X-ray room'] } };
  const bad = bro(POUR, steriliser);
  assert.equal(levelOf(bad.findings, 'broll-contradicts-words'), 'error');
  assert.equal(bad.pairs[0].verdict, 'mismatch');
  const xray = bro(POUR, { 'sources/pour.mp4': { shows: 'The X-ray room with the chair', tags: ['xray', 'surgery'] } });
  assert.equal(xray.pairs[0].verdict, 'match');
  assert.deepEqual(xray.findings.filter((f) => f.level === 'error'), []);
  const unrelated = bro(POUR, { 'sources/pour.mp4': { shows: 'A cup of coffee being poured', tags: ['coffee', 'pour'] } });
  assert.equal(levelOf(unrelated.findings, 'broll-not-obviously-related'), 'warn');
});

test('b-roll: patients, do-not-use clips and cutaways that are too short', () => {
  assert.equal(levelOf(bro(POUR, { 'sources/pour.mp4': { shows: 'A patient smiling in the chair', patientVisible: true } }).findings, 'broll-patient'), 'error');
  assert.equal(levelOf(bro(POUR, { 'sources/pour.mp4': { shows: 'A clip we may not use', doNotUse: 'Licence expired' } }).findings, 'broll-do-not-use'), 'error');
  const quick = bro({ ...POUR, out: 0.5 }, { 'sources/pour.mp4': { shows: 'The X-ray room with the chair', tags: ['xray'] } });
  assert.equal(levelOf(quick.findings, 'broll-too-short'), 'warn');
});

test('b-roll: a cutaway must not hide the moment the speaker says their name', () => {
  const cat = { 'sources/pour.mp4': { shows: 'The team in the back room', tags: ['team'] } };
  const hides = bro({ ...POUR, at: 0.2, out: 2 }, cat, clipOf(11.4, 14.1, 0));
  assert.equal(levelOf(hides.findings, 'broll-hides-introduction'), 'error');
  assert.match(hides.findings.find((f) => f.rule === 'broll-hides-introduction').message, /I'm Sam/);
  const after = bro({ ...POUR, at: 1.0, out: 2 }, cat, clipOf(11.4, 14.1, 0));
  assert.ok(!has(after.findings, 'broll-hides-introduction'), 'after the name has been said, a cutaway is fine');
  assert.equal(introductions([{ text: 'My', tlStart: 0, tlEnd: 0.2 }, { text: 'name', tlStart: 0.2, tlEnd: 0.4 }, { text: 'is', tlStart: 0.4, tlEnd: 0.5 }, { text: 'Priya', tlStart: 0.5, tlEnd: 0.9 }])[0].name, 'Priya');
});

test('b-roll: the speaker\'s voice must carry on under the picture (no accidental mute)', () => {
  const cat = { 'sources/pour.mp4': { shows: 'The X-ray room with the chair', tags: ['xray'] } };
  const speaker = { ...clipOf(7.9, 10.7, 0), mute: true };
  assert.equal(levelOf(bro(POUR, cat, speaker).findings, 'broll-speaker-muted'), 'error');
  // the b-roll sits between two speaker clips on ONE track and replaces the sound for as long as it plays
  const one = talkDoc([clipOf(7.9, 9.0, 0), { id: 'cut', source: 'pour', in: 0, out: 1.6, at: 1.1, mute: true }, { id: 'b', source: 'talk', in: 10.6, out: 14.1, at: 2.7 }]);
  const r = checkBroll(one, { projectDir: P, catalog: CAT(cat) });
  assert.equal(levelOf(r.findings, 'broll-drops-speaker'), 'error');
  assert.match(r.findings.find((f) => f.rule === 'broll-drops-speaker').message, /hall/);
});

test('b-roll: no clip over speech means nothing to match', () => {
  const doc = talkDoc([clipOf(1.94, 4.62, 0), { id: 'cut', source: 'pour', in: 0, out: 2, at: 2.7, mute: true }]);
  const r = checkBroll(doc, { projectDir: P, catalog: CAT({}) });
  assert.equal(r.cutaways.length, 0);
});

// ---- sound -------------------------------------------------------------------------------------------------------------------

test('audio: loudness is measured; quiet, loud and clipped files are told apart', { skip: !HAS_FF }, () => {
  const quiet = measureLoudness(mp4('out/au-quiet.mp4', tone(997, 0.05), 6));
  const target = measureLoudness(mp4('out/au-good.mp4', tone(997, 0.28), 6));
  assert.ok(quiet.integrated < -25, `quiet: ${quiet.integrated}`);
  assert.ok(Math.abs(target.integrated + 14) < 1.5, `target: ${target.integrated}`);
  const doc = (id) => ({ ...talkDoc([clipOf(1.94, 4.62)]), id });
  assert.equal(levelOf(checkAudio(doc('au-quiet'), { projectDir: P }).findings, 'loudness-off-target'), 'error');
  const good = checkAudio(doc('au-good'), { projectDir: P });
  assert.ok(!has(good.findings, 'loudness-off-target') && !has(good.findings, 'clipping'));
  mp4('out/au-clip.mp4', (t) => 1.6 * Math.sin(2 * Math.PI * 997 * t), 4);
  const clipped = checkAudio(doc('au-clip'), { projectDir: P });
  assert.ok(has(clipped.findings, 'clipping') || has(clipped.findings, 'peak-hot'), `peak: ${clipped.measured?.truePeak}`);
  assert.match(checkAudio(doc('au-missing'), { projectDir: P }).skipped, /no rendered video/i);
});

test('audio: music over speech must duck under it', () => {
  const music = (m) => ({ id: 'bed', source: 'music', in: 0, out: 5, at: 1, ...m });
  const mk = (m) => talkDoc(null, { tracks: [{ id: 'v1', type: 'video', clips: [clipOf(1.94, 4.62, 0)] }, { id: 'music', type: 'audio', clips: [music(m)] }] });
  assert.equal(levelOf(checkAudio(mk({}), { projectDir: P }).findings, 'music-not-ducked'), 'error');
  assert.ok(!has(checkAudio(mk({ gainDb: -14, duck: { under: 'v1', amountDb: -12 } }), { projectDir: P }).findings, 'music-not-ducked'));
  assert.equal(levelOf(checkAudio(mk({ duck: { under: 'v1', amountDb: -3 } }), { projectDir: P }).findings, 'music-duck-shallow'), 'warn');
  assert.equal(levelOf(checkAudio(mk({ duck: { under: 'music', amountDb: -12 }, gainDb: -3 }), { projectDir: P }).findings, 'music-ducks-wrong-track'), 'warn');
});

test('audio: a mix where the music is as loud as the voice is flagged', { skip: !HAS_FF }, () => {
  const speech = voice(WORDS.slice(0, 6), { shift: 1.94 }); // the first clip, as it sits on the timeline
  const doc = { ...talkDoc(null, { tracks: [{ id: 'v1', type: 'video', clips: [clipOf(1.94, 4.62, 0)] }, { id: 'music', type: 'audio', clips: [{ id: 'bed', source: 'music', in: 0, out: 8, at: 0, gainDb: -30, duck: { under: 'v1', amountDb: -12 } }] }] }), id: 'au-mix' };
  mp4('out/au-mix.mp4', (t) => tone(330, 0.3)(t) + tone(880, 0.01)(t) * speech(t), 8);
  assert.equal(levelOf(checkAudio(doc, { projectDir: P }).findings, 'music-masks-speech'), 'warn');
  mp4('out/au-mix.mp4', (t) => tone(330, 0.05)(t) + tone(880, 0.4)(t) * speech(t), 8);
  assert.ok(has(checkAudio(doc, { projectDir: P }).findings, 'ducking-ok'));
});

// ---- repeats within a month --------------------------------------------------------------------------------------------------

function uniqueProject() {
  const dir = mkdtempSync(join(tmpdir(), 'nordle-uniq-'));
  mkdirSync(join(dir, 'docs'), { recursive: true });
  mkdirSync(join(dir, 'assets', 'photos'), { recursive: true });
  writeFileSync(join(dir, 'brand.json'), JSON.stringify({ id: 'x', name: 'X' }));
  writeFileSync(join(dir, 'assets/photos/one.jpg'), 'same bytes');
  writeFileSync(join(dir, 'assets/photos/one-copy.jpg'), 'same bytes');
  writeFileSync(join(dir, 'assets/photos/two.jpg'), 'other bytes');
  const add = (id, date, caption, src, headline) => writeFileSync(join(dir, 'docs', `${id}.json`), JSON.stringify({
    schema: 'nordle.doc/0.1', id, title: id, kind: 'graphic', brand: 'x', sizes: ['ig-feed-4x5'], brief: { postDate: date }, copy: { caption },
    pages: [{ id: 'p1', layers: [{ id: 'h', type: 'text', text: headline, style: { size: 100 } }, { id: 'i', type: 'image', src, alt: '' }] }],
  }));
  return { dir, add };
}

test('uniqueness: the same photo twice in a month is an error; the same photo in another month is fine', () => {
  const { dir, add } = uniqueProject();
  try {
    add('oct-1', '2026-10-05', 'We love our new surgery. Come and see it for yourself soon.', 'assets/photos/one.jpg', 'The new surgery');
    add('oct-2', '2026-10-20', 'A completely different caption about hygiene visits and floss.', 'assets/photos/one.jpg', 'Floss daily');
    add('nov-1', '2026-11-03', 'Another caption about something else entirely, mouthguards for sport.', 'assets/photos/one.jpg', 'Mouthguards');
    const r = checkUniqueness(JSON.parse(readFileSync(join(dir, 'docs/oct-1.json'), 'utf8')), { projectDir: dir, brand: { id: 'x' } });
    assert.equal(levelOf(r.findings, 'reused-photo'), 'error');
    assert.deepEqual(r.compared, ['oct-2'], 'only posts in the same month are compared');
    assert.match(r.findings[0].message, /2026-10-20/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('uniqueness: the same picture saved under another name is still the same picture', () => {
  const { dir, add } = uniqueProject();
  try {
    add('a', '2026-10-05', 'First caption has its own words about teeth cleaning appointments.', 'assets/photos/one.jpg', 'Cleaning');
    add('b', '2026-10-12', 'Second caption talks about sports mouthguards for kids matches.', 'assets/photos/one-copy.jpg', 'Mouthguards');
    const r = checkUniqueness(JSON.parse(readFileSync(join(dir, 'docs/a.json'), 'utf8')), { projectDir: dir, brand: { id: 'x' } });
    assert.match(r.findings.find((f) => f.rule === 'reused-photo').message, /same picture saved as/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('uniqueness: a reused hook, a near-duplicate caption and a reused headline', () => {
  const { dir, add } = uniqueProject();
  try {
    add('a', '2026-10-05', 'Do you know why gums bleed? Brush gently twice a day and floss every night before bed.', 'assets/photos/one.jpg', 'Why gums bleed');
    add('b', '2026-10-09', 'Do you know why gums bleed? Brush gently twice a day and floss every night before sleep.', 'assets/photos/two.jpg', 'Why gums bleed');
    const r = checkUniqueness(JSON.parse(readFileSync(join(dir, 'docs/a.json'), 'utf8')), { projectDir: dir, brand: { id: 'x' } });
    assert.equal(levelOf(r.findings, 'reused-hook'), 'error');
    assert.equal(levelOf(r.findings, 'near-duplicate-caption'), 'error');
    assert.equal(levelOf(r.findings, 'reused-headline'), 'warn');
    assert.ok(!has(r.findings, 'reused-photo'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('uniqueness: when the month of a post is not known it is compared anyway, as a warning', () => {
  const { dir, add } = uniqueProject();
  try {
    add('a', '2026-10-05', 'Alpha beta gamma delta epsilon zeta eta theta iota kappa.', 'assets/photos/one.jpg', 'Alpha');
    add('b', undefined, 'Totally unrelated words about something else, mouthguards and sport.', 'assets/photos/one.jpg', 'Beta');
    const doc = JSON.parse(readFileSync(join(dir, 'docs/a.json'), 'utf8'));
    assert.equal(levelOf(checkUniqueness(doc, { projectDir: dir, brand: { id: 'x' } }).findings, 'reused-photo'), 'warn');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- copy and brief ----------------------------------------------------------------------------------------------------------

const cp = (copy, extra = {}) => checkCopy(doc0({ alt: { p1: 'A cup of coffee on the counter' }, hashtags: ['#a', '#b', '#c'], ...copy }, extra)).findings;

test('copy: a long dash used as a pause is flagged; a range and a plain hyphen are not', () => {
  const ok = 'Open 9–5 daily. Our pour-over is slow-brewed. Book a table today.';
  assert.equal(levelOf(cp({ caption: ok }), 'long-dash'), undefined);
  assert.equal(levelOf(cp({ caption: 'Spring menu is here — three new pours. Book a table today.' }), 'long-dash'), 'warn');
  assert.equal(levelOf(cp({ caption: 'Spring menu is here – three new pours. Book a table today.' }), 'long-dash'), 'warn');
  assert.match(cp({ caption: 'Spring menu is here — three new pours. Book a table today.' }).find((f) => f.rule === 'long-dash').message, /long dash.*once/);
});

test('copy: caption hook, one call to action, cut-off endings, hashtags and alt text', () => {
  assert.deepEqual(cp({ caption: 'Spring menu is here. Three new pours. Book a table today.' }).filter((f) => f.level !== 'info'), []);
  assert.equal(levelOf(cp({ caption: '' }), 'no-caption'), 'error');
  assert.equal(levelOf(cp({ caption: `${'A long opening sentence with many many words that goes on and on '.repeat(3)}and ends.` }), 'hook-too-long'), 'warn');
  assert.equal(levelOf(cp({ caption: 'We make coffee every day and' }), 'caption-cut-off'), 'error');
  assert.equal(levelOf(cp({ caption: 'Come and see our new menu, with' }), 'caption-cut-off'), 'error');
  assert.equal(levelOf(cp({ caption: 'Fresh beans arrive daily. Book now. Call us today. Follow us for more.' }), 'several-ctas'), 'warn');
  assert.equal(levelOf(cp({ caption: 'Fresh beans arrive daily.' }), 'no-cta'), 'warn');
  assert.equal(levelOf(cp({ caption: 'Fresh beans. Call us.', hashtags: ['#a'] }), 'few-hashtags'), 'warn');
  assert.equal(levelOf(cp({ caption: 'Fresh beans. Call us.', hashtags: Array.from({ length: 9 }, (_, i) => `#t${i}`) }), 'many-hashtags'), 'warn');
  assert.equal(levelOf(cp({ caption: 'Fresh beans. Call us.', alt: {} }), 'alt-missing'), 'error');
  assert.equal(levelOf(cp({ caption: 'Fresh beans. Call us.', alt: { p1: 'cup' } }), 'alt-short'), 'warn');
  assert.equal(levelOf(cp({ caption: 'Fresh beans. the the coffee. Call us.' }), 'repeated-word'), 'warn');
  assert.ok(!has(cp({ caption: 'Fresh beans arrive daily! Book a table 🙂 #coffee' }), 'caption-cut-off'), 'hashtags and emoji at the end are not a cut-off');
});

test('copy: text on the pictures that stops in the middle is an error; a label ending in a colon is not', () => {
  const layered = (text) => doc0({ caption: 'Hello. Call us.', alt: { p1: 'A cup of coffee on the counter' }, hashtags: ['#a', '#b', '#c'] }, { pages: [{ id: 'p1', layers: [{ id: 'h', type: 'text', text }] }] });
  assert.equal(levelOf(checkCopy(layered('Why our beans are')).findings, 'text-cut-off'), 'error');
  assert.ok(!has(checkCopy(layered('Opening hours:')).findings, 'text-cut-off'));
  assert.ok(!has(checkCopy(layered('Here for you')).findings, 'text-cut-off'));
  assert.equal(dangling('Our team and'), 'ends on the word "and"');
  assert.equal(dangling('Done.'), null);
});

test('brief: words the brief says to include and avoid are checked literally', () => {
  const doc = doc0({ caption: 'Come and see us at Quay Street.' }, { brief: { goal: 'g', audience: 'a', message: 'm', mustInclude: ['Quay Street', 'cold brew'], mustAvoid: ['discount'] } });
  const f = checkBriefLiteral(doc).findings;
  assert.equal(f.filter((x) => x.rule === 'must-include-missing').length, 1);
  assert.ok(!has(f, 'must-avoid-present'));
  const bad = checkBriefLiteral({ ...doc, copy: { caption: 'Big discount on cold brew at Quay Street' } }).findings;
  assert.equal(levelOf(bad, 'must-avoid-present'), 'error');
  assert.equal(levelOf(checkBriefLiteral(doc0({})).findings, 'no-brief'), 'warn');
});

// ---- paths -------------------------------------------------------------------------------------------------------------------

test('mounted footage: mount:<name>/path resolves through nordle.local.json and never leaves its folder', () => {
  const local = { mounts: { footage: work } };
  assert.equal(resolveMedia(P, 'mount:footage/little-gannet/brand.json', local).exists, true);
  assert.equal(resolveMedia(P, 'mount:nowhere/a.mp4', local).exists, false);
  assert.match(resolveMedia(P, 'mount:nowhere/a.mp4', local).reason, /not set up/);
  assert.equal(resolveMedia(P, 'mount:footage/../x.mp4', local).abs, null);
  assert.equal(resolveMedia(P, '../brand.json', local).abs, null);
  assert.equal(resolveMedia(P, 'assets/logo.svg', local).exists, true);
});

// ---- the record, the gate and the packet --------------------------------------------------------------------------------------

test('the record: skipped counts as not done, a failed check blocks, and each (check, by) keeps its newest entry per version', () => {
  const doc = { kind: 'graphic' };
  const rec = { entries: [{ check: 'technical', by: 'auto', status: 'skipped', v: 3, at: 'x' }, { check: 'compliance', by: 'auto', status: 'fail', v: 3, at: 'x' }] };
  const st = verificationStatus(doc, 3, rec);
  assert.ok(st.missing.includes('technical (auto) was skipped'));
  assert.deepEqual(st.failed, ['compliance (auto)']);
  assert.ok(requiredChecks(doc).some((r) => r.check === 'uniqueness') && requiredChecks(doc).some((r) => r.check === 'copy' && r.by.includes('auto')));
  assert.ok(requiredChecks({ kind: 'video' }).some((r) => r.check === 'broll' && r.by.includes('auto')));
  assert.ok(!requiredChecks({ kind: 'video' }).some((r) => r.check === 'design'));
});

const SPRING = 'spring-menu-carousel';
function readyProject() {
  put('facts.json', {
    schema: 'nordle.facts/0.1', brand: 'little-gannet',
    prices: [{ text: '$6.50', source: 'menu' }, { text: '$7.00', source: 'menu' }, { text: '$5.50', source: 'menu' }],
    hours: [{ text: 'Open every day from 7 am to 3 pm', source: 'door sign' }],
    addresses: [{ text: '12 Quay Street, Port Wren VIC 3999', source: 'door sign' }],
  });
}

test('the whole chain: scripts, then the designer, then an independent reviewer; each step is needed and each is enforced', async () => {
  readyProject();
  const r = await checkPost(P, SPRING, { browser });
  assert.deepEqual(Object.keys(r.results).sort(), ['brief', 'compliance', 'copy', 'design', 'facts', 'media-match', 'technical', 'uniqueness']);
  assert.equal(r.results.design.score >= 88, true);
  const failed = Object.values(r.results).filter((c) => c.status === 'fail');
  assert.deepEqual(failed.map((c) => `${c.check}: ${c.findings.filter((f) => f.level === 'error').map((f) => f.message).join(' | ')}`), []);
  const rec = JSON.parse(readFileSync(join(P, 'checks', `${SPRING}.json`), 'utf8'));
  assert.ok(validators().checks(rec), JSON.stringify(validators().checks.errors));
  assert.ok(rec.entries.every((e) => e.by === 'auto' && e.hash === docHash(P, SPRING)));

  let gate = finishGate(P, SPRING);
  assert.equal(gate.verified, false);
  assert.ok(gate.missing.includes('copy (designer)') && gate.missing.includes('media-match (reviewer)') && gate.missing.includes('brief (reviewer)'));
  assert.ok(gate.next.some((n) => /Reviewer/.test(n)));

  // a bare pass is not a judgement
  assert.equal(recordManual(P, SPRING, { check: 'copy', by: 'designer', status: 'pass', summary: 'ok' }).ok, false);
  // the reviewer cannot answer before a packet exists
  const early = recordManual(P, SPRING, { check: 'brief', by: 'reviewer', status: 'pass', summary: 'I read the packet and the post does what the brief asks.' });
  assert.equal(early.ok, false);
  assert.match(early.errors[0], /packet/);
  // automatic results cannot be written by hand
  assert.equal(recordManual(P, SPRING, { check: 'facts', by: 'auto', status: 'pass', summary: 'trust me, it is fine' }).ok, false);

  const say = 'I opened every page: the words fit the artwork and the caption is true and finished.';
  assert.equal(recordManual(P, SPRING, { check: 'copy', by: 'designer', status: 'pass', summary: say }).ok, true);
  assert.equal(recordManual(P, SPRING, { check: 'media-match', by: 'designer', status: 'pass', summary: say, pairs: [] }).ok, true);

  const packet = await reviewerPacket(P, SPRING, { browser });
  assert.ok(existsSync(packet.path));
  assert.match(packet.markdown, new RegExp(`hash: ${docHash(P, SPRING)}`));
  assert.equal(packet.images.length, 5, 'one image per page');
  assert.ok(packet.images.every((i) => existsSync(i.path)));
  for (const need of ['## The brief', '## The caption', '## FACTS', '## REPEATS', '## Questions', 'MEDIA-MATCH', 'COMPLIANCE', 'Honey lavender']) assert.ok(packet.markdown.includes(need), need);

  const r1 = recordManual(P, SPRING, { check: 'media-match', by: 'reviewer', status: 'pass', summary: say, pairs: [] });
  const r2 = recordManual(P, SPRING, { check: 'brief', by: 'reviewer', status: 'pass', summary: 'The post does what the brief asked: it announces the spring menu and says where and when.' });
  assert.equal(r1.ok && r2.ok, true);
  gate = finishGate(P, SPRING);
  assert.deepEqual([gate.missing, gate.failed], [[], []]);
  assert.equal(gate.verified, true);

  // the post is rebuilt from a spec: same version number, different content. Every old check stops counting.
  const file = join(P, 'docs', `${SPRING}.json`);
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  doc.copy.caption = `${doc.copy.caption} Free coffee for everyone!`;
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  gate = finishGate(P, SPRING);
  assert.equal(gate.verified, false);
  assert.ok(gate.stale.length > 0 && gate.missing.length > 0);
  const again = await checkPost(P, SPRING, { browser, only: ['compliance'] });
  assert.equal(again.results.compliance.status, 'fail', 'the new caption has an AHPRA problem and is caught');
  assert.ok(again.results.compliance.findings.some((f) => f.rule === 'ahpra-dental/free'));
});

test('judgements: a pass needs a verdict for every picture; a mismatch means fail; unsure cannot pass; "shows" must say what was seen', () => {
  const pics = ['one', 'two'].map((n) => photo(`j-${n}.jpg`));
  const doc = photoDoc([['p1', 'Our X-ray room', pics[0], 'The X-ray room'], ['p2', 'The front desk team', pics[1], 'The team']]);
  doc.id = 'judge-me';
  put('docs/judge-me.json', doc);
  put('assets/catalog.json', CAT({ [pics[0]]: { shows: 'The X-ray room with the chair', tags: ['xray'] }, [pics[1]]: { shows: 'Three staff at the front desk', tags: ['team', 'reception'] } }));
  const said = 'I looked at both pages beside their words and the picture under each one.';
  const pair = (media, page, verdict, shows = 'The X-ray room with a chair and a screen') => ({ media, page, verdict, shows });
  const base = { check: 'media-match', by: 'designer', summary: said };
  assert.match(recordManual(P, 'judge-me', { ...base, status: 'pass', pairs: [pair(pics[0], 'p1', 'match')] }).errors.join(' '), /every picture/i);
  assert.match(recordManual(P, 'judge-me', { ...base, status: 'pass', pairs: [pair(pics[0], 'p1', 'match'), pair(pics[1], 'p2', 'unsure')] }).errors.join(' '), /cannot pass/i);
  assert.match(recordManual(P, 'judge-me', { ...base, status: 'pass', pairs: [pair(pics[0], 'p1', 'match'), pair(pics[1], 'p2', 'match', '')] }).errors.join(' '), /what you actually see/i);
  assert.match(recordManual(P, 'judge-me', { ...base, status: 'warn', pairs: [pair(pics[0], 'p1', 'match'), pair(pics[1], 'p2', 'mismatch')] }).errors.join(' '), /fail/i);
  const ok = recordManual(P, 'judge-me', { ...base, status: 'fail', pairs: [pair(pics[0], 'p1', 'match'), pair(pics[1], 'p2', 'mismatch', 'Only an empty reception desk')] });
  assert.equal(ok.ok, true);
  assert.equal(finishGate(P, 'judge-me').failed.includes('media-match (designer)'), true, 'a recorded fail blocks the post');
  const good = recordManual(P, 'judge-me', { ...base, status: 'pass', pairs: [pair(pics[0], 'p1', 'match'), pair(pics[1], 'p2', 'match', 'Three people at a front desk')] });
  assert.equal(good.ok, true);
  assert.equal(finishGate(P, 'judge-me').failed.includes('media-match (designer)'), false, 'the newest judgement at this version replaces the earlier one');
  rmSync(join(P, 'assets/catalog.json'));
});

test('the CLI: check, finish and record work from the command line and the exit code says whether the post is ready', () => {
  const node = (args) => spawnSync(process.execPath, [join(ROOT, 'nordle.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  const names = cliCommands.map((c) => c.name);
  assert.deepEqual(names, ['check', 'packet', 'record', 'finish']);
  const fin = node(['finish', P, 'open-late-story']);
  assert.equal(fin.status, 1);
  assert.match(fin.stdout, /NOT VERIFIED open-late-story/);
  const json = JSON.parse(node(['finish', P, 'open-late-story', '--json']).stdout);
  assert.equal(json.verified, false);
  const rec = node(['record', P, 'open-late-story', '--check', 'copy', '--by', 'designer', '--status', 'pass', '--summary', 'ok']);
  assert.equal(rec.status, 1);
  assert.match(rec.stdout, /NOT RECORDED/);
  const chk = node(['check', P, 'open-late-story', '--json', '--only', 'facts,copy', '--no-render']);
  const out = JSON.parse(chk.stdout);
  assert.deepEqual(Object.keys(out.results).sort(), ['copy', 'facts']);
  assert.equal(node(['help']).status, 0);
  assert.match(node(['help']).stdout, /finish <project> <doc\|--all>/);
});

// ---- server routes and MCP tools ---------------------------------------------------------------------------------------------

test('routes: the agent can run checks and record judgements; the owner\'s record is human-only; the agent cannot record as the owner', async () => {
  const TOKEN = 'verify-owner-token-0123456789abcdef';
  const AGENT = 'verify-agent-token-0123456789abcdef';
  const roots = join(work, 'serve');
  mkdirSync(roots, { recursive: true });
  cpSync(P, join(roots, 'little-gannet'), { recursive: true, filter: (s) => !/[\\/]checks([\\/]|$)/.test(s) });
  const { createNordleServer } = await import('../src/server/http.mjs'); // loaded here so the rest of this file runs even if another feature's route is mid-edit
  const app = createNordleServer({ roots: [roots], token: TOKEN, agentToken: AGENT });
  const port = await app.listen(0);
  const call = async (token, path, method = 'GET', body) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/projects/little-gannet/checks${path}`, { method, headers: { 'x-nordle-token': token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  try {
    const list = await call(AGENT, '');
    assert.equal(list.status, 200);
    assert.ok(list.json.docs.some((d) => d.id === SPRING));
    const run = await call(AGENT, `/${SPRING}`, 'POST', { only: ['facts', 'copy'] });
    assert.equal(run.status, 200);
    assert.deepEqual(run.json.checks.map((c) => c.check).sort(), ['copy', 'facts']);
    assert.ok(run.json.gate.missing.length > 0);
    const status = await call(AGENT, `/${SPRING}`);
    assert.equal(status.json.record.entries.length >= 2, true);
    assert.ok(status.json.required.length > 5);
    const said = 'I looked at all five pages beside their words and the artwork behind them.';
    assert.equal((await call(AGENT, `/${SPRING}/record`, 'POST', { check: 'copy', by: 'designer', status: 'pass', summary: said })).status, 200);
    assert.equal((await call(AGENT, `/${SPRING}/record`, 'POST', { check: 'copy', by: 'owner', status: 'pass' })).status, 403, 'the agent token cannot record as the owner');
    assert.equal((await call(TOKEN, `/${SPRING}/record`, 'POST', { check: 'copy', by: 'designer', status: 'pass', summary: said })).status, 403, 'the owner is not the designer');
    const owner = await call(TOKEN, `/${SPRING}/record`, 'POST', { check: 'brief', by: 'owner', status: 'pass' });
    assert.equal(owner.status, 200);
    assert.equal(owner.json.entry.by, 'owner');
    assert.equal((await call(AGENT, '/no-such-doc')).status, 404);
    const media = await call(AGENT, `/${SPRING}/media`, 'POST', {});
    assert.equal(media.status, 200);
    assert.equal(Array.isArray(media.json.pairs), true);
    assert.ok(media.json.images.length >= 1 && media.json.images[0].base64.length > 100, 'the pictures come with it');
    const packet = await call(AGENT, `/${SPRING}/packet`, 'POST', {});
    assert.equal(packet.status, 200);
    assert.ok(packet.json.markdown.includes('Reviewer packet') && packet.json.images.length >= 1);
  } finally { await app.close(); }
});

test('MCP tools: five tools with real descriptions, honest annotations, and readable results', async () => {
  const helpers = { P: { type: 'string' }, D: { type: 'string' }, READ: { readOnlyHint: true }, EDIT: { readOnlyHint: false, destructiveHint: false }, enc: encodeURIComponent };
  const calls = [];
  const client = {
    async post(path, body) {
      calls.push(['POST', path, body]);
      if (path.endsWith('/media')) return { doc: 'x', version: 2, pairs: [{ page: 'p1', media: 'a.jpg', words: 'Our X-ray room', shows: 'A steriliser', verdict: 'mismatch', note: 'trap' }], findings: [], skipped: [], images: [{ label: 'p1', mime: 'image/jpeg', base64: 'AAAA' }] };
      if (path.endsWith('/record')) return { entry: { check: 'copy', by: 'designer', status: 'pass', v: 2 }, gate: { verified: false, missing: ['brief (reviewer)'], failed: [], next: ['Reviewer: ...'] } };
      if (path.endsWith('/packet')) return { path: 'C:/p/x.packet.md', markdown: '# Reviewer packet', imagePaths: [{ path: 'C:/p/a.png', label: 'p1' }], images: [{ base64: 'BBBB', mime: 'image/jpeg' }], version: 2 };
      return { doc: { id: 'x' }, version: 2, ok: false, counts: { pass: 1, warn: 0, fail: 1, skipped: 0 }, packs: [{ name: 'AHPRA', version: '0.1.0', disclaimer: 'Not legal advice.' }], checks: [{ check: 'facts', status: 'fail', summary: '1 error', findings: [{ level: 'error', rule: 'unknown-phone', message: 'The caption has a phone number that is not in facts.json', fix: 'Use 03 5550 0142' }] }], gate: { verified: false, missing: ['copy (designer)'], failed: ['facts (auto)'], next: ['Run again'] } };
    },
    async get(path) {
      calls.push(['GET', path]);
      return path.endsWith('/checks') ? { docs: [{ id: 'x', verified: false, missing: ['a'], failed: [] }] } : { gate: { v: 2, verified: false, missing: ['a (auto)'], failed: [], next: [], entries: [{ check: 'copy', by: 'auto', status: 'pass', summary: 'fine' }] } };
    },
  };
  const tools = verifyTools(client, helpers);
  assert.deepEqual(tools.map((t) => t.name), ['nordle_verify_post', 'nordle_verify_media', 'nordle_record_check', 'nordle_review_packet', 'nordle_finish']);
  for (const t of tools) {
    assert.ok(t.description.length > 40);
    assert.equal(t.inputSchema.type, 'object');
    if (!t.annotations.readOnlyHint) assert.equal(t.annotations.destructiveHint, false);
  }
  const verify = await tools[0].handler({ project: 'p', doc: 'x' });
  assert.match(verify.text, /FAIL facts/);
  assert.match(verify.text, /fix: Use 03 5550 0142/);
  assert.match(verify.text, /not legal advice/i);
  assert.match(verify.text, /NOT VERIFIED/);
  const media = await tools[1].handler({ project: 'p', doc: 'x' });
  assert.match(media.text, /script verdict: MISMATCH/);
  assert.equal(media.images.length, 1);
  const rec = await tools[2].handler({ project: 'p', doc: 'x', check: 'copy', by: 'designer', status: 'pass', summary: 'looked at it carefully' });
  assert.match(rec.text, /RECORDED copy by designer/);
  const pack = await tools[3].handler({ project: 'p', doc: 'x' });
  assert.match(pack.text, /DIFFERENT Claude|fresh Claude/i);
  assert.equal(pack.images.length, 1);
  assert.match((await tools[4].handler({ project: 'p' })).text, /0 of 1 posts verified/);
  assert.match((await tools[4].handler({ project: 'p', doc: 'x' })).text, /missing: a \(auto\)/);
  const failing = { ...client, async post() { throw new Error('A reviewer works from the packet'); } };
  const refused = await verifyTools(failing, helpers)[2].handler({ project: 'p', doc: 'x', check: 'brief', by: 'reviewer', status: 'pass', summary: 'ok ok ok ok ok ok' });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /NOT RECORDED/);
});

