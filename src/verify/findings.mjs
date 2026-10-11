// What every check returns: a list of findings, each in plain English with the exact fix, and a status derived from them.

import { readProjectSettings } from './paths.mjs';

/** @typedef {{level:'error'|'warn'|'info', rule:string, message:string, fix?:string, page?:string, layer?:string, media?:string, time?:number, evidence?:string}} Finding */

export const finding = (level, rule, message, extra = {}) => ({ level, rule, message, ...extra });
export const error = (rule, message, extra) => finding('error', rule, message, extra);
export const warn = (rule, message, extra) => finding('warn', rule, message, extra);
export const info = (rule, message, extra) => finding('info', rule, message, extra);

export const statusOf = (findings) => (findings.some((f) => f.level === 'error') ? 'fail' : findings.some((f) => f.level === 'warn') ? 'warn' : 'pass');

export const counts = (findings) => ({ error: findings.filter((f) => f.level === 'error').length, warn: findings.filter((f) => f.level === 'warn').length, info: findings.filter((f) => f.level === 'info').length });

/** Findings as they are stored in the checks record (only the fields the schema allows). */
export function entryFindings(findings, cap = 60) {
  const order = { error: 0, warn: 1, info: 2 };
  return [...findings].sort((a, b) => order[a.level] - order[b.level]).slice(0, cap).map((f) => ({
    level: f.level, ...(f.rule ? { rule: f.rule } : {}), ...(f.page ? { page: f.page } : {}), ...(f.layer ? { layer: f.layer } : {}),
    ...(f.media ? { media: f.media } : {}), ...(Number.isFinite(f.time) ? { time: Math.round(f.time * 1000) / 1000 } : {}), message: f.message, ...(f.fix ? { fix: f.fix } : {}),
  }));
}

/** One line for a result: "2 errors, 1 warning" or "nothing found". */
export function summarise(findings, what = '') {
  const c = counts(findings);
  const bits = [];
  if (c.error) bits.push(`${c.error} error${c.error === 1 ? '' : 's'}`);
  if (c.warn) bits.push(`${c.warn} warning${c.warn === 1 ? '' : 's'}`);
  return bits.length ? bits.join(', ') + (what ? ` ${what}` : '') : (what ? `${what}: nothing found` : 'nothing found');
}

/**
 * The owner can allow a wording or a repeat on purpose, with a reason, in nordle.project.json:
 *   "allow": [{ "rule": "ahpra-dental/free-offer", "text": "free consultation", "why": "Approved offer, terms are in the caption." }]
 * A finding that matches (same rule; and the text, if given, is in what was found) is kept but turned into an info note.
 */
export function applyAllowances(findings, projectDir, settings = readProjectSettings(projectDir)) {
  const allow = (settings.allow ?? []).filter((a) => a && typeof a.why === 'string' && a.why.trim() && (a.rule || a.text));
  if (!allow.length) return findings;
  return findings.map((f) => {
    if (f.level === 'info') return f;
    const hit = allow.find((a) => {
      if (a.rule && !(f.rule === a.rule || f.rule?.endsWith(`/${a.rule}`))) return false;
      if (a.text && !`${f.evidence ?? ''} ${f.message}`.toLowerCase().includes(String(a.text).toLowerCase())) return false;
      return true;
    });
    return hit ? { ...f, level: 'info', message: `(Allowed by the owner: ${hit.why.trim()}) ${f.message}` } : f;
  });
}
