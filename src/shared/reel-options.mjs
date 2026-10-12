// What a reel is made of, chosen per calendar item: its style, what it uses and how long it runs. Pure data and checks, shared by the calendar service, the
// Studio (Create page and the idea editor), the MCP tools and the build prompt, so they all say the same things.
//
//   item.reel = { style: 'footage' | 'motion' | 'voiceover', uses: ['footage', 'photos', ...], seconds: 30 }
//
//   auto       Claude decides (the default for a reel the owner leaves alone): footage if the project has footage that fits, motion graphics when it has none or the idea
//              is better told that way, a voice-over reel only when there is a recording with word timings.
//   footage    Cut from the owner's own footage and photos (the default).
//   motion     Motion graphics only: animated type, brand patterns and graphics, no footage at all.
//   voiceover  Motion graphics timed to a voice-over: the owner's recording is the spine, every scene change and word lands on what is said.

export const REEL_STYLES = [
  { id: 'auto', label: 'Auto', hint: 'Claude picks the best way to make it from what you have' },
  { id: 'footage', label: 'Cut from footage', hint: 'Your own clips and photos, cut to a story' },
  { id: 'motion', label: 'Motion graphics only', hint: 'Animated type and graphics, no footage' },
  { id: 'voiceover', label: 'Motion graphics with a voice-over', hint: 'The graphics follow your voice-over word for word' },
];

export const REEL_USES = [
  { id: 'footage', label: 'Your footage', hint: 'Clips from the footage you have added' },
  { id: 'photos', label: 'Your photos', hint: 'Photos with a slow push' },
  { id: 'stock', label: 'Stock footage', hint: 'Real filmed stock from your libraries' },
  { id: 'voiceover', label: 'A voice-over', hint: 'Your own recording; the picture follows it' },
  { id: 'music', label: 'Music', hint: 'From your own music library, quiet under speech' },
  { id: 'sfx', label: 'Sound effects', hint: 'Small whooshes on cuts and word snaps' },
  { id: 'captions', label: 'Captions', hint: 'Word-timed captions for what is said' },
  { id: 'logo', label: 'Your logo', hint: 'The right logo for the colour behind it' },
  { id: 'endcard', label: 'A closing card', hint: 'How to book, call or visit' },
];

export const REEL_LENGTHS = [15, 20, 30, 45, 60];

const DEFAULT_USES = {
  auto: ['footage', 'photos', 'music', 'captions', 'endcard'],
  footage: ['footage', 'photos', 'music', 'captions', 'endcard'],
  motion: ['music', 'sfx', 'logo', 'endcard'],
  voiceover: ['voiceover', 'captions', 'music', 'logo', 'endcard'],
};
const NEEDS_NOT = { motion: ['footage', 'photos', 'stock', 'voiceover', 'captions'], voiceover: ['footage', 'photos', 'stock'] };

const STYLE_IDS = REEL_STYLES.map((s) => s.id);
const USE_IDS = REEL_USES.map((u) => u.id);

/** What a reel of this style uses unless the owner changes it. */
export const defaultUses = (style) => [...(DEFAULT_USES[style] ?? DEFAULT_USES.footage)];

/**
 * Check what a person (or Claude) sent for `reel`. Returns { value, errors:[{path,message}] }; value is null when it is empty (which clears it).
 * A style that cannot use something (a motion-graphics reel has no footage) silently drops it from `uses`: the style wins.
 */
export function cleanReel(input) {
  const errors = [];
  if (input === null || input === undefined) return { value: null, errors };
  if (typeof input !== 'object' || Array.isArray(input)) return { value: null, errors: [{ path: '/reel', message: 'reel must be an object like { style, uses, seconds }' }] };
  for (const k of Object.keys(input)) if (!['style', 'uses', 'seconds'].includes(k)) errors.push({ path: `/reel/${k}`, message: `unknown reel option "${k}". Options: style, uses, seconds` });
  const out = {};
  if (input.style !== undefined && input.style !== null && input.style !== '') {
    if (!STYLE_IDS.includes(input.style)) errors.push({ path: '/reel/style', message: `reel style must be one of ${STYLE_IDS.join(', ')}` });
    else out.style = input.style;
  }
  if (input.uses !== undefined && input.uses !== null) {
    if (!Array.isArray(input.uses) || input.uses.some((u) => typeof u !== 'string')) errors.push({ path: '/reel/uses', message: 'uses must be a list of words' });
    else {
      const bad = input.uses.filter((u) => !USE_IDS.includes(u));
      if (bad.length) errors.push({ path: '/reel/uses', message: `unknown: ${bad.join(', ')}. A reel can use: ${USE_IDS.join(', ')}` });
      else out.uses = [...new Set(input.uses)].filter((u) => !(NEEDS_NOT[out.style ?? 'footage'] ?? []).includes(u));
    }
  }
  if (input.seconds !== undefined && input.seconds !== null && input.seconds !== '') {
    const n = Number(input.seconds);
    if (!Number.isFinite(n) || n < 5 || n > 90) errors.push({ path: '/reel/seconds', message: 'seconds must be a number from 5 to 90' });
    else out.seconds = Math.round(n);
  }
  if (out.style === 'voiceover' && out.uses && !out.uses.includes('voiceover')) out.uses.unshift('voiceover');
  return { value: errors.length || !Object.keys(out).length ? null : out, errors };
}

/** The style of an item, with the default filled in. Only reels have one. */
export const reelStyleOf = (item) => (item?.format === 'reel' ? (item.reel?.style ?? 'auto') : null);

/** A short phrase for lists and cards: "Motion graphics only, about 30 s". Null for the plain default. */
export function reelSummary(reel) {
  if (!reel) return null;
  const bits = [];
  if (reel.style && reel.style !== 'footage' && reel.style !== 'auto') bits.push(REEL_STYLES.find((s) => s.id === reel.style)?.label);
  if (reel.seconds) bits.push(`about ${reel.seconds} s`);
  if (reel.uses?.length) bits.push(`uses ${reel.uses.map((u) => REEL_USES.find((x) => x.id === u)?.label.toLowerCase() ?? u).join(', ')}`);
  return bits.filter(Boolean).join(', ') || null;
}

/**
 * The lines the build prompt adds for a reel's chosen style. `[]` for anything that is not a reel or has no choices.
 * Each line is an instruction to Claude, not a suggestion.
 */
export function reelPromptLines(item) {
  if (item?.format !== 'reel' || !item.reel) return [];
  const r = item.reel;
  const style = r.style ?? 'auto';
  const uses = r.uses ?? defaultUses(style);
  const out = [];
  if (style === 'auto') {
    out.push('- Reel style: AUTO. The owner left the way it is made to you. Look at what the project really has (`sources/catalog.json`, `assets/catalog.json`) and at the idea, then choose ONE: cut from footage when there is footage that fits what the idea says; motion graphics only when there is none or the idea is a list, a number, a tip or a myth that animated type tells better; motion graphics with a voice-over ONLY when there is a recording with word timings that covers it. Say which you chose and why in one line at the start of your notes. Never invent footage or a voice.');
  } else if (style === 'motion') {
    out.push('- Reel style: MOTION GRAPHICS ONLY. The owner asked for a reel made entirely of animated graphics: no footage, no photos, no stock. Build it from `card` and `end` scenes plus hand-made `layers` that have a `time` and `animate` (kinetic brand type, lists and numbers building in, wipes and panels, soft scrims and thin rules). Use only the brand\'s colours and fonts. Vary the structure from scene to scene and keep type big enough to read on a phone in two seconds. Never draw clip-art illustrations, cartoon icons or diagrams with shapes. Do not look for footage and do not fail the build for having none.');
  } else if (style === 'voiceover') {
    out.push('- Reel style: MOTION GRAPHICS WITH A VOICE-OVER. The owner\'s own voice-over is the spine of the reel and the graphics must match it. Find the recording in `sources/catalog.json` (an audio source that has a words file) or in the media plan; if there is no recording or no word timings, do NOT invent a voice: say exactly what is missing with `nordle_calendar_update` notes and stop. Add `voiceover: { source }` to the reel spec and give each scene a `say` (the words it covers, copied from the transcript) so its graphics start just before those words and change exactly when the next idea is spoken. Time extra layers with `time: { say: "..." }`. Build the scenes from `card`/`end` and hand-made animated `layers`, no footage. Show the key word or number of each sentence big; do not just repeat the whole sentence (captions can do that). Read docs/VIDEO.md "Voice-over reels" first.');
  } else if (uses.length) {
    out.push('- Reel style: cut from the owner\'s own footage and photos.');
  }
  const label = (id) => REEL_USES.find((u) => u.id === id)?.label.toLowerCase() ?? id;
  const wanted = uses.filter((u) => USE_IDS.includes(u));
  const left = USE_IDS.filter((u) => !wanted.includes(u) && !(NEEDS_NOT[style] ?? []).includes(u));
  if (r.uses) {
    out.push(`- This reel uses: ${wanted.map(label).join(', ') || 'nothing extra'}.${left.length ? ` It does NOT use: ${left.map(label).join(', ')}. Leave those out.` : ''}`);
  }
  if (r.seconds) out.push(`- Length: about ${r.seconds} seconds (stay within 3 seconds of that${style === 'voiceover' ? '; the voice-over decides the real length, so choose and trim what is said to fit' : ''}).`);
  return out;
}
