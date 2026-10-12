// Reading a written style guide (a .md, .txt, .css, .html or .json file) for what it plainly says: colours, fonts, tone of voice, phrases to avoid.
// Deliberately literal: it picks up hex colours, "font-family", and lines such as "Tone of voice: warm, plain" or "Never say: cheap". Nothing is guessed.
// PDFs and Word files are not read (there is no honest way to do it without a heavy dependency); the caller says so and keeps the file.

import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';

export const TEXT_EXT = new Set(['.md', '.markdown', '.txt', '.css', '.html', '.htm', '.json']);
export const UNREADABLE_DOC_EXT = new Set(['.pdf', '.doc', '.docx', '.pages', '.key', '.pptx']);
const MAX_TEXT = 300_000;
const GENERIC = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'inherit', 'initial', 'unset', 'arial', 'helvetica', 'times new roman', 'georgia', 'verdana', 'tahoma', 'segoe ui', 'roboto', 'tbd', 'none', 'n/a']);
const STRONG_COLOUR = /primary|brand|accent|main|secondary|heading|button|logo|highlight|headline|cta|background|text|ink|paper/i;

const clean = (s) => String(s ?? '').replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim();
const words = (s) => clean(s).split(/[,;/]|\band\b|\s[-–—]\s/i).map((x) => x.trim().replace(/^["'“”‘’]+|["'“”‘’.]+$/g, '')).filter((x) => x && x.length <= 40);
const fontName = (s) => {
  const f = clean(s).replace(/["'“”‘’]/g, '').split(/[,(;]|\s[-–—]\s|\.\s/)[0].replace(/\b(bold|regular|light|medium|italic|semibold|weight|size|\d+\s?(pt|px))\b.*$/i, '').trim();
  return f && f.length >= 3 && f.length <= 40 && /^[A-Za-z0-9][A-Za-z0-9 ]*$/.test(f) && !GENERIC.has(f.toLowerCase()) ? f : null;
};
const stripLead = (line) => line.replace(/^[\s>*\-+]+/, '');

/**
 * @param {string} text
 * @returns {{ colours: Map<string, number>, fonts: { display: string|null, body: string|null, other: string[] }, tone: string[], banned: string[] }}
 */
export function readGuideText(text) {
  const out = { colours: new Map(), fonts: { display: null, body: null, other: [] }, tone: [], banned: [] };
  const lines = String(text ?? '').slice(0, MAX_TEXT).split(/\r?\n/);
  const addColour = (hex, w) => { let h = hex.replace('#', '').toUpperCase(); if (h.length === 3) h = [...h].map((c) => c + c).join(''); const k = `#${h}`; out.colours.set(k, (out.colours.get(k) ?? 0) + w); };
  for (const raw of lines) {
    const line = stripLead(raw);
    for (const m of line.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) addColour(m[0], STRONG_COLOUR.test(line) ? 12 : 2);
    const ff = /font-family\s*:\s*([^;}\n]+)/i.exec(line);
    if (ff) { const f = fontName(ff[1].split(',')[0]); if (f) out.fonts.other.push(f); continue; }
    const named = line.length < 160 ? /\b(headings?|headlines?|titles?|display|body|paragraph|text|copy|typeface|typography|fonts?)\b[^:\n]{0,24}:\s*(.+)$/i.exec(line) : null;
    if (named) {
      const f = fontName(named[2]);
      if (f) {
        const kind = named[1].toLowerCase();
        if (/head|title|display/.test(kind) && !out.fonts.display) out.fonts.display = f;
        else if (/body|paragraph|text|copy/.test(kind) && !out.fonts.body) out.fonts.body = f;
        else out.fonts.other.push(f);
      }
    }
    const tone = /\b(tone(?: of voice)?|voice|personality|brand voice)\b[^:\n]{0,16}:\s*(.+)$/i.exec(line);
    if (tone) for (const w of words(tone[2])) if (out.tone.length < 8 && !out.tone.includes(w.toLowerCase())) out.tone.push(w.toLowerCase());
    const avoid = /\b(never say|do not say|don'?t say|avoid|do not use|don'?t use|banned|words to avoid|phrases to avoid)\b[^:\n]{0,16}:\s*(.+)$/i.exec(line);
    if (avoid) for (const w of words(avoid[2])) if (out.banned.length < 12 && !out.banned.includes(w.toLowerCase())) out.banned.push(w.toLowerCase());
  }
  return out;
}

/** Read one file from disk as a style guide; null when it is not a plain text file or is too big. */
export function readGuideFile(file) {
  const ext = extname(file).toLowerCase();
  if (!TEXT_EXT.has(ext)) return null;
  try { if (statSync(file).size > MAX_TEXT * 2) return null; const text = readFileSync(file, 'utf8'); return { name: basename(file), snippet: ext === '.json' || ext === '.css' ? '' : text.slice(0, 6000), ...readGuideText(text) }; } catch { return null; }
}
