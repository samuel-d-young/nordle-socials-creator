// "Text-level facts that were invented": every phone number, web address, email, handle, price, address, opening hour, statistic,
// staff name and job title in a post's words is checked against <project>/facts.json (and the post's brief, and for on-screen
// text what is said in the footage). If it is not there, it does not go out.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validators } from '../../tools/validate.mjs';
import { error, info, warn } from './findings.mjs';
import { flatLayers, layerText, textSurfaces } from './surfaces.mjs';
import { keywords, normalise, stem, tokens } from './text.mjs';
import { numberWordsToDigits } from './transcript.mjs';

export const factsPath = (projectDir) => join(projectDir, 'facts.json');

/** @returns {{facts:object|null, problems:string[]}} */
export function loadFacts(projectDir) {
  const file = factsPath(projectDir);
  if (!existsSync(file)) return { facts: null, problems: [] };
  let facts;
  try { facts = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { return { facts: null, problems: [`facts.json is not valid JSON: ${e.message}`] }; }
  const v = validators().facts;
  if (!v(facts)) return { facts, problems: v.errors.slice(0, 4).map((e) => `facts.json ${e.instancePath || '/'} ${e.message}`) };
  return { facts, problems: [] };
}

// ---- pulling claims out of text --------------------------------------------------------------------------------------------

const TLD = 'com\\.au|net\\.au|org\\.au|gov\\.au|edu\\.au|id\\.au|com|net|org|au|co|io|nz|uk|app|dev|health|dental|me|ly|link|bio|shop|store|clinic|care';
const RE = {
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  url: new RegExp(`\\b(?:https?:\\/\\/)?(?:www\\.)?[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.(?:${TLD})\\b(?:\\/[^\\s)>,"']*)?`, 'gi'),
  handle: /(?<![\w.@])@[A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])/g,
  address: /\b\d{1,4}[A-Za-z]?(?:-\d{1,4})?\s+[A-Z][A-Za-z'-]+(?:\s+[A-Z][A-Za-z'-]+){0,2}\s+(?:Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Highway|Hwy|Place|Pl|Court|Ct|Lane|Ln|Parade|Pde|Boulevard|Blvd|Crescent|Cres|Terrace|Tce|Way|Close|Circuit|Cct|Esplanade|Esp)\b/g,
  postcode: /\b(?:VIC|NSW|QLD|SA|WA|TAS|NT|ACT)\s+\d{4}\b/g,
  phone: /(?<![\d$.\/-])(?:\+?61[\s-]?\(?0?\d\)?[\s-]?\d{4}[\s-]?\d{4}|\(?0[2-478]\)?[\s-]?\d{4}[\s-]?\d{4}|04\d{2}[\s-]?\d{3}[\s-]?\d{3}|1[38]00[\s-]?\d{3}[\s-]?\d{3}|13[\s-]?\d{2}[\s-]?\d{2}|\d{4}[\s-]\d{4})(?![\d])/g,
  price: /\$\s?\d[\d,]*(?:\.\d{1,2})?(?:\s?[kK])?/g,
  bareDecimal: /(?<![\d.$])\d{1,4}\.\d{2}(?![\d%])/g,
  percent: /\d+(?:\.\d+)?\s?%/g,
  ratio: /\b\d+\s*(?:in|out of|of every)\s*\d+\b/gi,
  time: /\b\d{1,2}(?::\d{2})?\s?(?:am|pm)\b/gi,
  year: /\b(?:19|20)\d{2}\b/g,
  since: /\b(?:since|established|est\.?|founded)\s+(?:in\s+)?((?:19|20)\d{2})\b/gi,
  count: /\b(\d[\d,]*)\+?\s+(?:happy\s+|local\s+|loyal\s+|new\s+)?(patients?|smiles?|clients?|customers?|families|procedures?|reviews?|people|dentists?|practices?|clinics?|locations?)\b/gi,
  years: /\b(\d{1,3})\+?\s+(?:years?|yrs?)\b/gi,
  unit: /\b\d+(?:\.\d+)?\s?(?:mins?|minutes?|hours?|hrs?|days?|weeks?|months?|mm|cm|kg|mg|ml|degrees)\b/gi,
};

const YEARISH = /^(?:19|20)\d{2}$/;
const digits = (s) => String(s).replace(/\D/g, '');
const phoneKey = (s) => { let d = digits(s); if (d.startsWith('61') && d.length >= 11) d = `0${d.slice(2)}`; return d.length >= 8 ? d.slice(-8) : d; };
const hostOf = (u) => String(u).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/[.,;:!]+$/, '');
const amountKey = (s) => { const n = Number(String(s).replace(/[$,\s]/g, '').replace(/k$/i, '')); return Number.isFinite(n) ? (/k$/i.test(s) ? n * 1000 : n).toFixed(2) : null; };
const timeKey = (s) => { const m = /(\d{1,2})(?::(\d{2}))?\s?(am|pm)/i.exec(s); return m ? `${Number(m[1])}:${m[2] ?? '00'}${m[3].toLowerCase()}` : null; };
const ABBR = { st: 'street', rd: 'road', ave: 'avenue', dr: 'drive', hwy: 'highway', pl: 'place', ct: 'court', ln: 'lane', pde: 'parade', blvd: 'boulevard', cres: 'crescent', tce: 'terrace', cct: 'circuit', esp: 'esplanade' };
const addressKey = (s) => tokens(s).map((t) => ABBR[t] ?? t).join(' ');
const nounStem = (n) => stem(n.toLowerCase()).replace(/^famil.*/, 'family');

/**
 * Every checkable claim in a text. Each: {type, key, text, index, severity}. severity says how serious it is when nothing
 * supports it: 'error' (a fact that must be right), 'warn' (an odd number to confirm).
 */
export function extractClaims(text) {
  const src = normalise(text);
  let work = src;
  const out = [];
  const take = (type, re, make) => {
    work = work.replace(re, (m, ...args) => {
      const index = args.at(-2);
      const claim = make(m, args, index);
      if (claim === 'skip') return m;
      if (claim) out.push({ type, text: m.trim(), index, ...claim });
      return ' '.repeat(m.length);
    });
  };
  take('email', RE.email, (m) => ({ key: m.toLowerCase(), severity: 'error' }));
  take('url', RE.url, (m) => ({ key: hostOf(m), severity: 'error' }));
  take('handle', RE.handle, (m) => ({ key: m.slice(1).replace(/\.+$/, '').toLowerCase(), severity: 'error' }));
  take('address', RE.address, (m) => ({ key: addressKey(m), severity: 'error' }));
  take('postcode', RE.postcode, (m) => ({ key: digits(m), severity: 'error' }));
  take('phone', RE.phone, (m) => {
    const d = digits(m);
    if (d.length === 8 && /^(?:19|20)\d{2}(?:19|20)\d{2}$/.test(d)) return 'skip';
    return { key: phoneKey(m), severity: 'error' };
  });
  take('price', RE.price, (m) => ({ key: `$${amountKey(m)}`, severity: 'error' }));
  take('percent', RE.percent, (m) => ({ key: `${Number.parseFloat(m)}%`, severity: 'error' }));
  take('ratio', RE.ratio, (m) => { const n = m.match(/\d+/g); return { key: `${n[0]} in ${n[1]}`, severity: 'error' }; });
  take('since', RE.since, (m, a) => ({ key: `since ${a[0]}`, severity: 'error' }));
  take('year', RE.year, (m) => { const y = Number(m); const now = new Date().getFullYear(); return y >= now - 1 && y <= now + 2 ? 'skip' : { key: String(y), severity: 'warn', note: 'a year' }; });
  take('time', RE.time, (m) => ({ key: timeKey(m), severity: 'warn', note: 'an opening or booking time' }));
  take('count', RE.count, (m, a) => ({ key: `${a[0].replace(/,/g, '')} ${nounStem(a[1])}`, severity: 'error' }));
  take('years', RE.years, (m, a, index) => {
    const around = work.slice(Math.max(0, index - 35), index + m.length + 40).toLowerCase();
    const claim = /experience|serving|in business|established|local|community|dentistry|practice|trusted|caring|years of|for over|more than|over \d/.test(around);
    return { key: `${Number(a[0])} years`, severity: claim ? 'error' : 'warn', note: claim ? 'a years-of-experience style claim' : 'a number of years' };
  });
  take('unit', RE.unit, (m) => ({ key: m.toLowerCase().replace(/\s+/g, ' '), severity: 'warn' }));
  take('price', RE.bareDecimal, (m) => ({ key: `$${Number(m).toFixed(2)}`, severity: 'warn', note: 'looks like a price' }));
  return out.sort((a, b) => a.index - b.index);
}

// ---- what is known ---------------------------------------------------------------------------------------------------------

function factText(facts) {
  const f = facts ?? {};
  const bits = [];
  for (const p of f.phones ?? []) bits.push(p.number);
  for (const e of f.emails ?? []) bits.push(e.address);
  for (const a of f.addresses ?? []) bits.push(a.text);
  for (const h of f.hours ?? []) bits.push(h.text);
  for (const w of f.websites ?? []) bits.push(w.url);
  for (const s of f.social ?? []) bits.push(`@${String(s.handle).replace(/^@/, '')}`);
  for (const p of f.prices ?? []) bits.push(p.text);
  for (const s of f.approvedStats ?? []) bits.push(s.text);
  for (const c of f.approvedCtas ?? []) bits.push(c);
  for (const s of f.staff ?? []) bits.push(s.name);
  return bits.filter(Boolean).join('\n');
}

const briefText = (doc) => {
  const b = doc.brief ?? {};
  return [b.goal, b.audience, b.message, b.tone, b.notes, ...(b.mustInclude ?? [])].filter(Boolean).join('\n');
};

const keysOf = (text) => new Set(extractClaims(text).map((c) => `${c.type}:${c.key}`));
// extractClaims gives a bare "7.50" a price key; a "$7.50" has the same key, so both meet.
const claimKey = (c) => `${c.type}:${c.key}`;

// ---- people ----------------------------------------------------------------------------------------------------------------

const TITLES = [
  'oral and maxillofacial surgeon', 'patient care coordinator', 'treatment coordinator', 'oral health therapist', 'principal dentist', 'associate dentist', 'senior dentist', 'head dentist',
  'lead dentist', 'general dentist', 'cosmetic dentist', 'paediatric dentist', 'pediatric dentist', 'dental hygienist', 'dental therapist', 'dental assistant', 'dental nurse', 'dental technician',
  'dental prosthetist', 'practice manager', 'practice owner', 'clinical director', 'maxillofacial surgeon', 'oral surgeon', 'prosthodontist', 'periodontist', 'endodontist', 'orthodontist',
  'paedodontist', 'receptionist', 'hygienist', 'therapist', 'dentist', 'founder', 'owner', 'director', 'manager', 'head chef', 'head roaster', 'barista', 'roaster',
].sort((a, b) => b.length - a.length);
const TITLE_RE = new RegExp(`\\b(?:${TITLES.map((t) => t.replace(/ /g, '\\s+')).join('|')})\\b`, 'gi');
const stripDental = (s) => lowerTitle(s).replace(/\b(?:dental|oral)\s+/g, '').trim();
const lowerTitle = (s) => normalise(s).toLowerCase().replace(/\s+/g, ' ');
const NAME_WORD = "[A-Z][\\p{L}'-]+";
const DR_RE = new RegExp(`\\b(?:Dr|Doctor|Prof|Professor)\\.?\\s+(${NAME_WORD}(?:\\s+${NAME_WORD})?)`, 'gu');
const NOT_NAMES = new Set(['The', 'Our', 'Your', 'A', 'An', 'We', 'Meet', 'With', 'And', 'Is', 'At', 'In', 'On', 'For', 'Dental', 'Team', 'Staff', 'This', 'That', 'Welcome', 'Hello', 'Hi', 'Today', 'Tomorrow', 'Now', 'Book', 'Call', 'Visit', 'New', 'Head', 'Principal', 'Senior', 'Associate', 'Practice', 'Say', 'Come',
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']);

function staffIndex(facts) {
  return (facts?.staff ?? []).map((s) => {
    const names = [s.name, ...(s.aliases ?? [])].map((n) => normalise(n));
    const bare = names.map((n) => n.replace(/^(?:dr|doctor|prof|professor)\.?\s+/i, ''));
    const parts = tokens(bare[0]);
    return { s, names, bare, first: parts[0], last: parts.length > 1 ? parts.at(-1) : null, nameTokens: new Set([...names, ...bare].flatMap((n) => tokens(n))), titles: [s.title, ...(s.titleAliases ?? [])].map(stripDental) };
  });
}

function mentions(text, staff) {
  const out = [];
  for (const st of staff) {
    const forms = new Set([...st.names, ...st.bare, ...(st.last ? [`Dr ${st.last}`] : []), ...(st.first ? [`Dr ${st.first}`] : [])]);
    for (const f of forms) {
      if (!f || f.length < 3) continue;
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
      for (let m = re.exec(text); m; m = re.exec(text)) out.push({ st, index: m.index, end: m.index + m[0].length });
    }
    // a first name on its own, when nobody else shares it
    if (st.first && st.first.length >= 3 && staff.filter((o) => o.first === st.first).length === 1) {
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${st.first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu');
      for (let m = re.exec(text); m; m = re.exec(text)) out.push({ st, index: m.index, end: m.index + m[0].length });
    }
  }
  return out;
}

function checkPeople(surface, staff, hasFacts, out, practiceNames) {
  const text = normalise(surface.text);
  const where = { ...(surface.page ? { page: surface.page } : {}), ...(surface.layer ? { layer: surface.layer } : {}), ...(surface.time ? { time: surface.time.start } : {}) };
  const spoken = surface.kind === 'speech';
  const level = spoken ? 'warn' : 'error';
  const mk = (rule, message, fix, evidence) => (level === 'error' ? error : warn)(rule, message, { fix, evidence, ...where });
  const label = surface.label;
  const known = mentions(text, staff);

  // "Dr Surname" that matches nobody
  const maskedPractice = practiceNames.reduce((t, n) => t.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), (m) => ' '.repeat(m.length)), text);
  for (let m = DR_RE.exec(maskedPractice); m; m = DR_RE.exec(maskedPractice)) {
    const cand = tokens(m[1]).filter((t) => !NOT_NAMES.has(t.charAt(0).toUpperCase() + t.slice(1)));
    if (!cand.length) continue;
    const ok = staff.some((st) => cand.every((c) => st.nameTokens.has(c)));
    if (!ok) out.push(mk('unknown-staff-name', `${label} names "${m[0]}", who is not in facts.json${hasFacts ? '' : ' (there is no facts.json)'}.`, hasFacts ? `Use a name from facts.json staff, or add this person to facts.json with their exact title and where it came from. Do not guess a name or title.` : 'Add a facts.json with the staff (name, title, source) from the practice\'s own page.', m[0]));
  }

  // titles: each one belongs to the nearest name, and must be that person's title
  TITLE_RE.lastIndex = 0;
  for (let m = TITLE_RE.exec(text); m; m = TITLE_RE.exec(text)) {
    const term = stripDental(m[0]);
    const t0 = m.index;
    const t1 = m.index + m[0].length;
    const sameChunk = (k) => !/[.!?]\s/.test(k.end <= t0 ? text.slice(k.end, t0) : text.slice(t1, k.index));
    const dist = (k) => (k.end <= t0 ? t0 - k.end : k.index >= t1 ? k.index - t1 : 0);
    const chunk = known.filter(sameChunk);
    // "NAME is our TITLE", "NAME, TITLE" (the name comes first); else "TITLE NAME", "TITLE: NAME"; else whoever is nearest
    const preName = chunk.filter((k) => k.end <= t0 && /^[\s,:–-]*(?:(?:is|as|are)\s+)?(?:(?:our|the|a|an|your)\s+)?$/i.test(text.slice(k.end, t0))).sort((a, b) => dist(a) - dist(b))[0];
    const postName = chunk.filter((k) => k.index >= t1 && /^[\s,:–-]*$/.test(text.slice(t1, k.index))).sort((a, b) => dist(a) - dist(b))[0];
    const near = preName ?? postName ?? chunk.map((k) => ({ ...k, d: dist(k) })).sort((a, b) => a.d - b.d)[0];
    if (near && dist(near) <= 60) {
      const ok = near.st.titles.some((t) => t === term || t.includes(term));
      if (!ok) out.push(mk('wrong-staff-title', `${label} calls ${near.st.s.name} "${m[0]}", but facts.json gives their title as "${near.st.s.title}".`, `Use "${near.st.s.title}" (or add a titleAliases entry in facts.json if both wordings are correct).`, m[0]));
      continue;
    }
    // a capitalised name right next to a title that is nobody in facts.json. Only where the wording says "this person is that":
    // "Jess, our hygienist", "Jess is the hygienist", "our hygienist Jess", "Hygienist: Jess". A Title Case headline is not read as a name.
    const lineStart = text.lastIndexOf('\n', t0) + 1;
    const lineEnd = text.indexOf('\n', t1) < 0 ? text.length : text.indexOf('\n', t1);
    const lineWords = text.slice(lineStart, lineEnd).split(/\s+/).filter(Boolean);
    if (lineWords.length >= 3 && lineWords.filter((w) => /^[A-Z]/.test(w)).length / lineWords.length >= 0.7) continue;
    const before = text.slice(Math.max(0, t0 - 45), t0);
    const after = text.slice(t1, t1 + 40);
    const preM = new RegExp(`(${NAME_WORD}(?:[ \\t]+${NAME_WORD})?)(\\s*[,:\\u2013\\n-]\\s*|\\s+(?:is|as)\\s+|\\s+)((?:our|the|a|an|your)\\s+)?$`, 'u').exec(before);
    const preOk = preM && (/[,:–\n-]|\b(?:is|as)\b/.test(preM[2]) || preM[3]);
    const postM = new RegExp(`^(\\s*[,:\\u2013-]\\s*|\\s+)(${NAME_WORD}(?:[ \\t]+${NAME_WORD})?)`, 'u').exec(after);
    const detBefore = /(?:^|\s)(?:our|the|your|a|an|meet)\s+$/i.test(before);
    const postOk = postM && (/[,:–-]/.test(postM[1]) || detBefore);
    for (const hit of [preOk ? [null, preM[1]] : null, postOk ? [null, postM[2]] : null]) {
      if (!hit) continue;
      const nm = hit[1].trim();
      const parts = nm.split(/\s+/).filter((w) => !NOT_NAMES.has(w));
      if (!parts.length || parts.length !== nm.split(/\s+/).length) continue;
      if (practiceNames.some((p) => p.toLowerCase().includes(nm.toLowerCase()))) continue;
      if (TITLES.includes(nm.toLowerCase())) continue;
      const isStaff = staff.some((st) => parts.every((p) => st.nameTokens.has(p.toLowerCase())));
      if (!isStaff) out.push(mk('unknown-staff-name', `${label} puts the name "${nm}" next to the title "${m[0]}", and "${nm}" is not in facts.json${hasFacts ? '' : ' (there is no facts.json)'}.`, 'Use a name and title from facts.json staff, or add the person there with where the title came from. Never guess a role.', `${nm} ${m[0]}`));
    }
  }
}

// ---- the check -------------------------------------------------------------------------------------------------------------

const TREATMENTS = ['implant', 'veneer', 'crown', 'bridge', 'denture', 'root canal', 'extraction', 'wisdom teeth', 'filling', 'whitening', 'invisalign', 'aligner', 'braces', 'orthodontic', 'sedation', 'check-up', 'checkup', 'mouthguard', 'sleep apnoea', 'tmj', 'periodontal', 'bonding', 'inlay', 'onlay', 'cerec', 'all-on-4', 'all-on-x', 'fluoride', 'scale and clean', 'teeth cleaning'];
const DEFAULT_RISK_TRIGGERS = ['implant', 'veneer', 'cosmetic', 'smile makeover', 'aligner', 'invisalign', 'whitening', 'all-on', 'braces'];

/**
 * Check the facts in a post.
 * @returns {{findings: object[], claims: object[]}}
 */
export function checkFacts(doc, { projectDir, facts, brand, surfaces = textSurfaces(doc, { projectDir }), transcriptText = '' } = {}) {
  const findings = [];
  const hasFacts = Boolean(facts);
  // the brand kit's own links (handle, website) are supplied by the owner, so they count as known
  const factKeys = keysOf(`${factText(facts)}\n${Object.values(brand?.links ?? {}).filter((x) => typeof x === 'string').join('\n')}`);
  const briefKeys = keysOf(briefText(doc));
  const speechKeys = keysOf(numberWordsToDigits(transcriptText));
  const staff = staffIndex(facts);
  const practiceNames = (facts?.names ?? []).filter(Boolean);
  const claims = [];

  for (const s of surfaces) {
    if (s.scope === 'copy.hashtags') continue;
    const spoken = s.kind === 'speech';
    const where = { ...(s.page ? { page: s.page } : {}), ...(s.layer ? { layer: s.layer } : {}), ...(s.time ? { time: s.time.start } : {}) };
    for (const c of extractClaims(spoken ? numberWordsToDigits(s.text) : s.text)) {
      const key = claimKey(c);
      claims.push({ ...c, surface: s.label });
      if (factKeys.has(key)) continue;
      // hours: a time is wrong if facts.json lists hours and this is not one of them
      if (c.type === 'time' && !(facts?.hours?.length)) {
        if (briefKeys.has(key) || (!spoken && speechKeys.has(key))) continue;
        findings.push(warn('hours-not-in-facts', `${s.label} says "${c.text}", and facts.json has no opening hours to check it against.`, { fix: 'Add the opening hours (with their source) to facts.json, or leave the time out.', evidence: c.text, ...where }));
        continue;
      }
      if (briefKeys.has(key)) { findings.push(info('claim-from-brief', `${s.label} says "${c.text}"; it is supported by the post's brief only, not by facts.json.`, { evidence: c.text, ...where })); continue; }
      if (!spoken && speechKeys.has(key)) { findings.push(info('claim-from-footage', `${s.label} says "${c.text}"; it is said in the footage.`, { evidence: c.text, ...where })); continue; }
      const level = spoken ? 'warn' : c.type === 'time' ? 'error' : c.severity;
      const what = {
        phone: 'a phone number', url: 'a web address', email: 'an email address', handle: 'a social handle', address: 'an address', postcode: 'a state and postcode', price: 'a price', percent: 'a percentage',
        ratio: 'a statistic', since: 'a founding year', count: 'a figure about patients or the practice', years: c.note ?? 'a number of years', time: 'an opening time', unit: 'a figure', year: 'a year',
      }[c.type] ?? 'a figure';
      const unit = c.type === 'time' ? `The opening hours in facts.json (${facts.hours.map((h) => h.text).join('; ')}) do not include that time.` : hasFacts ? 'It is not in facts.json or the brief.' : 'There is no facts.json for this project.';
      const fix = {
        phone: `Use one of the numbers in facts.json${facts?.phones?.length ? ` (${facts.phones.map((p) => `${p.label ? `${p.label}: ` : ''}${p.number}`).join('; ')})` : ''}, or leave the number out.`,
        url: `Use a web address from facts.json${facts?.websites?.length ? ` (${facts.websites.map((w) => w.url).join('; ')})` : ''}, or leave it out.`,
        email: 'Use an address from facts.json or leave it out.',
        handle: `Use a handle from facts.json${facts?.social?.length ? ` (${facts.social.map((w) => w.handle).join('; ')})` : ''}, or leave it out.`,
        address: 'Use the address exactly as in facts.json, or leave it out.',
        postcode: 'Use the address exactly as in facts.json.',
        price: 'Quote only prices listed in facts.json (with their source), or take the price out.',
      }[c.type] ?? 'Leave it out, or add it to facts.json (approvedStats, hours) with where it came from.';
      findings.push((level === 'error' ? error : warn)(`unknown-${c.type}`, `${s.label} has ${what}, "${c.text}". ${unit}${spoken ? ' It is said on camera, so confirm it is right.' : ''}`, { fix, evidence: c.text, ...where }));
    }
    checkPeople(s, staff, hasFacts, findings, practiceNames);
  }

  // lower-third pairs: a name layer with a role layer next to it
  const pairs = [];
  const scan = (layers, page) => {
    for (const g of layers ?? []) {
      if (g.type === 'group' && g.children?.length) {
        const kids = flatLayers(g.children).filter((l) => l.type === 'text');
        const name = kids.find((l) => /(^|[-_])name($|[-_])/i.test(l.id));
        const role = kids.find((l) => /(^|[-_])(role|title|job)($|[-_])/i.test(l.id));
        if (name && role) pairs.push({ name: normalise(layerText(name)), role: normalise(layerText(role)), page, layer: g.id });
        scan(g.children, page);
      }
    }
  };
  for (const p of doc.pages ?? []) scan(p.layers, p.id);
  scan(doc.layers, undefined);
  for (const p of pairs) {
    const hit = staff.find((st) => st.names.some((n) => n.toLowerCase() === p.name.toLowerCase() || st.bare.some((b) => b.toLowerCase() === p.name.toLowerCase())) || (st.first && st.first === p.name.toLowerCase()));
    const where = { ...(p.page ? { page: p.page } : {}), layer: p.layer };
    if (!hit) findings.push(error('unknown-staff-name', `The name card says "${p.name}" (${p.role}), and "${p.name}" is not in facts.json${hasFacts ? '' : ' (there is no facts.json)'}.`, { fix: 'Use a name and title from facts.json staff, or add the person there with where the title came from.', evidence: p.name, ...where }));
    else if (!hit.titles.some((t) => t === stripDental(p.role) || t.includes(stripDental(p.role)))) findings.push(error('wrong-staff-title', `The name card calls ${hit.s.name} "${p.role}", but facts.json gives their title as "${hit.s.title}".`, { fix: `Use "${hit.s.title}".`, evidence: p.role, ...where }));
  }

  // services
  const all = surfaces.filter((s) => s.scope !== 'copy.hashtags').map((s) => normalise(s.text)).join('\n').toLowerCase();
  if (facts?.services?.length) {
    const have = new Set();
    for (const s of facts.services) for (const n of typeof s === 'string' ? [s] : [s.name, ...(s.aliases ?? [])]) for (const k of keywords(n)) have.add(k);
    const mentioned = TREATMENTS.filter((t) => new RegExp(`(?<![\\p{L}])${t.replace(/[-\s]+/g, '[-\\s]?')}`, 'iu').test(all));
    for (const t of mentioned) {
      const ks = [...keywords(t)];
      if (!ks.some((k) => have.has(k))) findings.push(warn('service-not-in-facts', `The post mentions "${t}", and facts.json does not list it among the services this business offers.`, { fix: `Only mention treatments the business offers (${facts.services.map((s) => (typeof s === 'string' ? s : s.name)).slice(0, 8).join(', ')}${facts.services.length > 8 ? ', ...' : ''}), or add it to facts.json services if it is offered.`, evidence: t }));
    }
  }

  // approved calls to action
  if (facts?.approvedCtas?.length && doc.copy?.cta) {
    const norm = (s) => tokens(s).join(' ');
    const cta = norm(doc.copy.cta);
    if (!facts.approvedCtas.some((a) => { const n = norm(a); return n === cta || cta.includes(n) || n.includes(cta); })) {
      findings.push(warn('cta-not-approved', `The call to action "${doc.copy.cta}" is not one of the approved wordings in facts.json.`, { fix: `Use one of: ${facts.approvedCtas.map((a) => `"${a}"`).join(', ')}.`, evidence: doc.copy.cta }));
    }
  }

  // the practice's own risk statement on implant / cosmetic content
  if (facts?.riskStatement?.text) {
    const triggers = (facts.riskStatement.appliesTo?.length ? facts.riskStatement.appliesTo : DEFAULT_RISK_TRIGGERS).map((t) => t.toLowerCase());
    const hit = triggers.find((t) => all.includes(t));
    const caption = tokens(doc.copy?.caption ?? '').join(' ');
    const lead = tokens(facts.riskStatement.text).slice(0, 8).join(' ');
    if (hit && !caption.includes(lead)) {
      findings.push(error('risk-statement-missing', `The post is about "${hit}", and the caption does not carry the practice's risk statement from facts.json.`, { fix: `Add this to the caption, word for word: "${facts.riskStatement.text}"`, evidence: hit }));
    }
  }

  const unsourced = (facts?.staff ?? []).filter((s) => !s.source).length;
  if (unsourced) findings.push(warn('staff-without-source', `${unsourced} staff in facts.json have no source, so their titles cannot be trusted.`));
  // the same problem in several places is reported once, with where else it is
  const merged = [];
  const byKey = new Map();
  for (const f of findings) {
    const key = f.evidence ? `${f.rule}|${f.evidence}` : null;
    if (key && byKey.has(key)) { byKey.get(key).also.push(f); continue; }
    const g = { ...f, also: [] };
    if (key) byKey.set(key, g);
    merged.push(g);
  }
  const tidy = merged.map(({ also, ...f }) => (also.length ? { ...f, message: `${f.message} The same thing is also in ${also.slice(0, 4).map((x) => (x.page ? `page "${x.page}"${x.layer ? ` (${x.layer})` : ''}` : x.layer ?? 'another place')).join(', ')}${also.length > 4 ? `, and ${also.length - 4} more` : ''}.` } : f));
  return { findings: tidy, claims };
}
