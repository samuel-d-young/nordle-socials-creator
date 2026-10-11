// Rule packs (schemas/pack.schema.json): wording rules a project opts into with nordle.project.json {"packs": [...]}.
// Every rule is read against EVERY text surface of a post (caption, hashtags, alt text, each text layer, a video's overlay text
// and what is said in it), not only the caption. Packs are data: a pack never runs code here.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, checkPack, validators } from '../../tools/validate.mjs';
import { error, finding, warn } from './findings.mjs';
import { isSafeRel, readProjectSettings } from './paths.mjs';
import { allText, textSurfaces } from './surfaces.mjs';
import { clip, escapeRegex, normalise } from './text.mjs';

/** A pattern for a phrase that tolerates spaces and hyphens being swapped ("pain-free" finds "pain free"). */
export function phraseRegex(phrase, { wholeWord = false, caseSensitive = false } = {}) {
  const p = normalise(phrase);
  const body = p.split(/[\s-]+/).filter(Boolean).map(escapeRegex).join('[\\s\\-]+');
  const pre = wholeWord && /^[\p{L}\p{N}]/u.test(p) ? '(?<![\\p{L}\\p{N}])' : '';
  const post = wholeWord && /[\p{L}\p{N}]$/u.test(p) ? '(?![\\p{L}\\p{N}])' : '';
  return new RegExp(`${pre}${body}${post}`, caseSensitive ? 'gu' : 'giu');
}

/** Where a pack named in nordle.project.json is on disk: next to the project, in the repo, in examples/ or in the mounted packs/. */
export function resolvePackRef(projectDir, ref) {
  if (!isSafeRel(ref)) return null;
  const bases = [projectDir, ROOT, join(ROOT, 'examples'), join(ROOT, 'examples', 'packs'), join(ROOT, 'packs')];
  for (const base of bases) {
    const p = resolve(base, ref);
    if (!p.startsWith(resolve(base))) continue;
    if (existsSync(p) && statSync(p).isFile()) return p;
    const inDir = join(p, 'pack.json');
    if (existsSync(inDir)) return inDir;
  }
  return null;
}

/** @returns {{packs:{ref:string,path:string,pack:object}[], problems:{ref:string,message:string}[]}} */
export function loadPacks(projectDir, settings = readProjectSettings(projectDir)) {
  const packs = [];
  const problems = [];
  for (const ref of settings.packs ?? []) {
    const path = resolvePackRef(projectDir, ref);
    if (!path) { problems.push({ ref, message: `The pack "${ref}" listed in nordle.project.json was not found (looked next to the project, in the Nordle folder and in examples/packs).` }); continue; }
    let pack;
    try { pack = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { problems.push({ ref, message: `The pack "${ref}" is not valid JSON: ${e.message}` }); continue; }
    const v = validators().pack;
    if (!v(pack)) { problems.push({ ref, message: `The pack "${ref}" does not follow the pack format: ${v.errors.slice(0, 2).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}` }); continue; }
    const bad = checkPack(pack).filter((i) => i.level === 'error');
    if (bad.length) { problems.push({ ref, message: `The pack "${ref}" has a broken rule: ${bad[0].message}` }); continue; }
    if (pack.runsCode) { problems.push({ ref, message: `The pack "${ref}" says it runs code, and Nordle does not run pack code in checks, so its rules were skipped.` }); continue; }
    packs.push({ ref, path, pack });
  }
  return { packs, problems };
}

function whenApplies(rule, doc, text) {
  const w = rule.when;
  if (w?.kind && !w.kind.includes(doc.kind)) return false;
  if (w?.tagsInclude) {
    const tags = new Set((doc.tags ?? []).map((t) => String(t).toLowerCase()));
    if (!w.tagsInclude.some((t) => tags.has(String(t).toLowerCase()))) return false;
  }
  if (rule.whenText?.length) {
    const hay = normalise(text).toLowerCase();
    if (!rule.whenText.some((p) => hay.includes(normalise(p).toLowerCase()))) return false;
  }
  return true;
}

function spans(text, re) {
  const out = [];
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === '') { re.lastIndex++; continue; }
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  }
  return out;
}

const around = (text, s) => {
  const a = Math.max(0, s.start - 28);
  const b = Math.min(text.length, s.end + 28);
  return `${a > 0 ? '…' : ''}${text.slice(a, b).replace(/\s*\n\s*/g, ' / ')}${b < text.length ? '…' : ''}`;
};

const cap1 = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Findings for one pack against a post. */
export function evaluatePack(pack, doc, surfaces) {
  const out = [];
  const all = allText(surfaces);
  for (const rule of pack.rules ?? []) {
    if (!whenApplies(rule, doc, all)) continue;
    const ruleId = `${pack.id}/${rule.id}`;
    const level = rule.severity;
    const inScope = (s) => !rule.scope || rule.scope.includes(s.scope);

    if (rule.type === 'phrase' || rule.type === 'regex') {
      let re;
      try {
        re = rule.type === 'phrase'
          ? new RegExp(rule.phrases.map((p) => phraseRegex(p, { wholeWord: rule.wholeWord, caseSensitive: rule.caseSensitive }).source).join('|'), rule.caseSensitive ? 'gu' : 'giu')
          : new RegExp(rule.pattern, `${(rule.flags ?? 'i').replace(/g/g, '')}g`);
      } catch { continue; }
      const exceptRes = (rule.except ?? []).map((p) => phraseRegex(p, { wholeWord: false }));
      for (const s of surfaces.filter(inScope)) {
        const text = normalise(s.text);
        const safe = exceptRes.flatMap((r) => spans(text, r));
        const seen = new Set();
        for (const hit of spans(text, re)) {
          if (safe.some((x) => hit.start >= x.start && hit.end <= x.end)) continue;
          const key = hit.text.toLowerCase();
          if (seen.has(key) || seen.size >= 3) continue;
          seen.add(key);
          out.push(finding(level, ruleId, `${cap1(s.label)} says "${around(text, hit)}". ${rule.message}`, {
            evidence: hit.text, ...(s.page ? { page: s.page } : {}), ...(s.layer ? { layer: s.layer } : {}), ...(s.time ? { time: s.time.start } : {}),
            fix: rule.fix ?? `Reword it without "${hit.text}".`,
          }));
        }
      }
    } else if (rule.type === 'limit') {
      const value = rule.field === 'copy.caption' ? (doc.copy?.caption ?? '').length : rule.field === 'copy.hashtags.count' ? (doc.copy?.hashtags ?? []).length : doc.timeline?.duration;
      if (value === undefined || value === null) continue;
      const unit = rule.field === 'copy.caption' ? 'characters' : rule.field === 'copy.hashtags.count' ? 'hashtags' : 'seconds';
      if (rule.max !== undefined && value > rule.max) out.push(finding(level, ruleId, `${rule.message} (${value} ${unit}; the most is ${rule.max}).`, { fix: rule.fix ?? `Bring it down to ${rule.max} ${unit} or fewer.` }));
      if (rule.min !== undefined && value < rule.min) out.push(finding(level, ruleId, `${rule.message} (${value} ${unit}; the least is ${rule.min}).`, { fix: rule.fix ?? `Bring it up to at least ${rule.min} ${unit}.` }));
    } else if (rule.type === 'requireText') {
      const wanted = [...(rule.text ? [rule.text] : []), ...(rule.phrases ?? [])];
      const hay = surfaces.filter(inScope).map((s) => normalise(s.text).toLowerCase()).join('\n');
      if (!wanted.some((p) => hay.includes(normalise(p).toLowerCase()))) {
        out.push(finding(level, ruleId, `${rule.message} It must say: ${wanted.map((w) => `"${clip(w, 100)}"`).join(' or ')}.`, { fix: rule.fix ?? `Add the wording to the ${(rule.scope ?? ['caption']).join(' or ').replace('copy.', '')}.` }));
      }
    }
  }
  return out;
}

/**
 * Wording check for a post: the project's packs, the brand's banned phrases and the facts file's banned claims, over every
 * place the post has words.
 */
export function checkCompliance(doc, { projectDir, brand, facts, surfaces = textSurfaces(doc, { projectDir }) } = {}) {
  const findings = [];
  const { packs, problems } = loadPacks(projectDir);
  for (const p of problems) findings.push(error('pack-missing', p.message, { fix: 'Fix the pack path or format in nordle.project.json, then run the check again.' }));
  if (!packs.length && !problems.length) {
    findings.push(warn('no-packs', 'This project lists no wording packs, so only the brand\'s banned phrases are checked. For a regulated business (health, finance, law) that is not enough.', { fix: 'Add a pack to nordle.project.json, for example {"packs": ["ahpra-dental/pack.json"]}.' }));
  }
  for (const { pack } of packs) findings.push(...evaluatePack(pack, doc, surfaces));

  const banned = [
    ...(brand?.voice?.bannedPhrases ?? []).map((p) => ({ p, rule: 'brand-banned', why: 'the brand\'s voice rules ban it' })),
    ...(facts?.bannedClaims ?? []).map((p) => ({ p, rule: 'facts-banned-claim', why: 'facts.json lists it as a claim this business must never make' })),
  ];
  for (const { p, rule, why } of banned) {
    const re = phraseRegex(p, { wholeWord: true });
    for (const s of surfaces) {
      const text = normalise(s.text);
      const m = spans(text, re)[0];
      if (m) findings.push(error(rule, `${cap1(s.label)} says "${around(text, m)}", and ${why}.`, { evidence: m.text, fix: `Reword it without "${p}".`, ...(s.page ? { page: s.page } : {}), ...(s.layer ? { layer: s.layer } : {}) }));
    }
  }
  return { findings, packs: packs.map(({ ref, pack }) => ({ ref, id: pack.id, name: pack.name, version: pack.version, disclaimer: pack.disclaimer ?? '', rules: pack.rules?.length ?? 0 })) };
}
