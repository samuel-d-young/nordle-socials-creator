// Colours for ffmpeg: a document colour or brand token turned into #RRGGBB.

import { resolveToken } from '../shared/tokens.mjs';

const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** "#abc", "#aabbcc", "#aabbccdd", rgb(), rgba(), hsl(), hsla(), "transparent" or "$brand.colors.x" -> "#RRGGBB" (alpha is dropped), or null. */
export function toHex(value, brand, colourway) {
  if (typeof value !== 'string') return null;
  let v = value.trim();
  if (v.startsWith('$brand.')) { const r = brand ? resolveToken(v, brand, colourway) : undefined; if (typeof r !== 'string') return null; v = r.trim(); }
  if (v === 'transparent') return '#000000';
  let m = /^#([0-9a-f]{3,8})$/i.exec(v);
  if (m) {
    const h = m[1];
    if (h.length === 3 || h.length === 4) return `#${[...h].slice(0, 3).map((c) => c + c).join('')}`.toLowerCase();
    if (h.length === 6 || h.length === 8) return `#${h.slice(0, 6)}`.toLowerCase();
    return null;
  }
  m = /^rgba?\(([^)]*)\)$/i.exec(v);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).slice(0, 3).map((x) => (x.endsWith('%') ? (parseFloat(x) / 100) * 255 : parseFloat(x)));
    return p.length === 3 && p.every(Number.isFinite) ? `#${p.map(hex2).join('')}` : null;
  }
  m = /^hsla?\(([^)]*)\)$/i.exec(v);
  if (m) {
    const p = m[1].replace(/deg/i, '').split(/[\s,/]+/).filter(Boolean).slice(0, 3).map((x) => parseFloat(x));
    if (p.length !== 3 || !p.every(Number.isFinite)) return null;
    return `#${hslToRgb(((p[0] % 360) + 360) % 360, p[1] / 100, p[2] / 100).map(hex2).join('')}`;
  }
  return null;
}

/** A document `fill` (colour or linear gradient) -> { kind:'solid', hex } | { kind:'linear', angle, stops:[{at,hex}] } | null */
export function fillSpec(fill, brand, colourway) {
  if (fill === undefined || fill === null) return null;
  if (typeof fill === 'string') { const hex = toHex(fill, brand, colourway); return hex ? { kind: 'solid', hex } : null; }
  const stops = (fill.stops ?? []).map((s) => ({ at: s.at, hex: toHex(s.color, brand, colourway) })).filter((s) => s.hex);
  if (stops.length < 2) return stops[0] ? { kind: 'solid', hex: stops[0].hex } : null;
  return { kind: 'linear', angle: fill.angle ?? 180, stops };
}
