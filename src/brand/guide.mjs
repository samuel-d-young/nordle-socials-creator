// A brand's SIMPLE style guide: the few things a person would tweak (name, colours, the two fonts, how it sounds, the handle and website),
// read from and saved into the project's brand.json. Everything else in brand.json (house style, colourways, logos, motion) is left exactly as
// it is. Every change is checked against the brand schema before it is written, and the file is replaced atomically.

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { cleanIndustry } from './industry.mjs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { validators } from '../../tools/validate.mjs';

export class GuideError extends Error {
  constructor(status, message, errors) { super(message); this.status = status; this.errors = errors ?? [{ path: '/', message }]; }
}

/** The colours a person is asked about first, with what each is for. Others a brand has are shown after these. */
export const CORE_COLORS = [
  ['ink', 'Main text and dark areas'],
  ['paper', 'Background'],
  ['accent', 'Accent'],
  ['accentDark', 'Accent for text (darker)'],
  ['muted', 'Quiet text'],
];
const HEX = /^#[0-9a-fA-F]{6}$/;
const KEY = /^[A-Za-z0-9_-]{1,40}$/;
export const FONT_SOURCES = ['google', 'system', 'file'];

export const brandFile = (projectDir) => join(projectDir, 'brand.json');

export function readBrand(projectDir) {
  return JSON.parse(readFileSync(brandFile(projectDir), 'utf8'));
}

const list = (v) => (Array.isArray(v) ? v : []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());

/** What the Studio shows and edits. */
export function toGuide(brand) {
  const f = (k) => ({ family: brand.fonts?.[k]?.family ?? '', source: brand.fonts?.[k]?.source ?? 'google' });
  const colors = brand.colors ?? {};
  const core = CORE_COLORS.map(([key, label]) => ({ key, label, value: colors[key] ?? '' }));
  const coreKeys = new Set(CORE_COLORS.map(([k]) => k));
  const more = Object.entries(colors).filter(([k]) => !coreKeys.has(k)).map(([key, value]) => ({ key, label: key, value }));
  return {
    id: brand.id, name: brand.name ?? '', note: brand.note ?? '',
    industry: { id: brand.industry?.id ?? '', label: brand.industry?.label ?? '', regulated: brand.industry?.regulated ?? null, rules: brand.industry?.rules ?? '' },
    colors: { core, more },
    fonts: { display: f('display'), body: f('body'), others: Object.keys(brand.fonts ?? {}).filter((k) => !['display', 'body'].includes(k)) },
    voice: { audience: brand.voice?.audience ?? '', tone: list(brand.voice?.tone), do: list(brand.voice?.do), dont: list(brand.voice?.dont), bannedPhrases: list(brand.voice?.bannedPhrases) },
    links: { handle: brand.links?.handle ?? '', website: brand.links?.website ?? '' },
    logos: Object.keys(brand.logos ?? {}),
  };
}

const bad = (path, message) => { throw new GuideError(400, message, [{ path, message }]); };

function cleanColors(input) {
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!KEY.test(k)) bad(`/colors/${k}`, `"${k}" is not a usable colour name (letters, numbers, - and _ only).`);
    const hex = String(v ?? '').trim();
    const full = /^#[0-9a-fA-F]{3}$/.test(hex) ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex;
    if (!HEX.test(full)) bad(`/colors/${k}`, `${k}: "${hex}" is not a colour. Use six digits like #1F3A3C.`);
    out[k] = full.toUpperCase();
  }
  return out;
}

function cleanFont(current, input, role) {
  const family = String(input?.family ?? '').trim();
  if (!family) bad(`/fonts/${role}`, `Give the ${role} font a name.`);
  if (family.length > 80 || /[<>{};"]/.test(family)) bad(`/fonts/${role}`, `"${family}" is not a font name.`);
  const source = FONT_SOURCES.includes(input?.source) ? input.source : (current?.source ?? 'google');
  // a font backed by files keeps them while its name stays; renaming it (or changing where it comes from) drops them: the files belonged to the old one
  if (source === 'file' && current?.source === 'file' && current.family === family) return current;
  const weights = current?.weights?.length ? current.weights : role === 'display' ? [600, 700] : [400, 600];
  return { family, weights, source: source === 'file' ? 'google' : source };
}

function cleanList(v, what, max = 40, len = 240) {
  const items = list(v);
  if (items.length > max) bad(`/voice/${what}`, `${what}: at most ${max} lines.`);
  for (const s of items) if (s.length > len) bad(`/voice/${what}`, `${what}: a line is over ${len} characters.`);
  return items;
}

/** Apply a patch of the guide's fields to a brand object (not saved). Throws GuideError with a plain reason. */
export function applyGuide(brand, patch) {
  const next = structuredClone(brand);
  if (patch.name !== undefined) {
    const name = String(patch.name).trim();
    if (!name || name.length > 80) bad('/name', 'Give the brand a name (up to 80 characters).');
    next.name = name;
  }
  if (patch.industry !== undefined) {
    const ind = cleanIndustry(patch.industry === null ? null : patch.industry);
    if (ind) next.industry = ind; else delete next.industry;
  }
  if (patch.note !== undefined) { const note = String(patch.note).trim(); if (note) next.note = note.slice(0, 600); else delete next.note; }
  if (patch.colors !== undefined) {
    if (!patch.colors || typeof patch.colors !== 'object' || Array.isArray(patch.colors)) bad('/colors', 'Colours must be a list of names and values.');
    const merged = { ...next.colors, ...cleanColors(patch.colors) };
    for (const k of patch.removeColors ?? []) if (!CORE_COLORS.some(([c]) => c === k)) delete merged[k];
    if (Object.keys(merged).length < 2) bad('/colors', 'A brand needs at least two colours.');
    next.colors = merged;
  }
  if (patch.fonts !== undefined) {
    next.fonts = { ...next.fonts };
    for (const role of ['display', 'body']) if (patch.fonts[role] !== undefined) next.fonts[role] = cleanFont(next.fonts[role], patch.fonts[role], role);
  }
  if (patch.voice !== undefined) {
    const v = { ...(next.voice ?? {}) };
    if (patch.voice.audience !== undefined) { const a = String(patch.voice.audience).trim(); if (a) v.audience = a.slice(0, 1500); else delete v.audience; }
    for (const k of ['tone', 'do', 'dont', 'bannedPhrases']) if (patch.voice[k] !== undefined) { const items = cleanList(patch.voice[k], k); if (items.length || k === 'tone' || k === 'bannedPhrases') v[k] = items; else delete v[k]; }
    next.voice = v;
  }
  if (patch.links !== undefined) {
    const links = { ...(next.links ?? {}) };
    if (patch.links.handle !== undefined) { const h = String(patch.links.handle).trim(); if (h) links.handle = h.slice(0, 80); else delete links.handle; }
    if (patch.links.website !== undefined) {
      let w = String(patch.links.website).trim();
      if (w && !/^https?:\/\//i.test(w)) w = `https://${w}`;
      if (w) { try { new URL(w); } catch { bad('/links/website', `"${patch.links.website}" is not a web address.`); } links.website = w; } else delete links.website;
    }
    if (Object.keys(links).length) next.links = links; else delete next.links;
  }
  const validate = validators().brand;
  if (!validate(next)) {
    const e = validate.errors.find((x) => x.keyword !== 'if') ?? validate.errors[0];
    throw new GuideError(422, `That does not fit the brand file: ${e.instancePath || '/'} ${e.message}`, validate.errors.map((x) => ({ path: x.instancePath || '/', message: x.message })));
  }
  return next;
}

function writeAtomic(file, text) {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** Save a patch into the project's brand.json and return the guide as saved. */
export function saveGuide(projectDir, patch) {
  if (!existsSync(brandFile(projectDir))) throw new GuideError(404, 'This project has no brand file.');
  const next = applyGuide(readBrand(projectDir), patch ?? {});
  writeAtomic(brandFile(projectDir), `${JSON.stringify(next, null, 2)}\n`);
  return toGuide(next);
}

/** A new brand object from a (partly filled) guide, with sensible defaults for anything missing. */
export function newBrand(id, guide = {}) {
  const base = {
    $schema: '../../schemas/brand.schema.json', schema: 'nordle.brand/0.1', id, name: String(guide.name ?? id).trim() || id,
    colors: { ink: '#1F2933', paper: '#FAF7F2', accent: '#C2410C', accentDark: '#9A3412', muted: '#6B7280' },
    fonts: { display: { family: 'Fraunces', weights: [600, 700], source: 'google' }, body: { family: 'Inter', weights: [400, 600], source: 'google' } },
    voice: { tone: [], bannedPhrases: [] },
    motion: { personality: 'calm', ease: 'out-cubic' },
  };
  return applyGuide(base, { colors: guide.colors, fonts: guide.fonts, voice: guide.voice, links: guide.links, note: guide.note, ...(guide.industry ? { industry: guide.industry } : {}) });
}

