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

/** The shape of the picture. Vertical is a Reel, Short or TikTok; landscape is YouTube and websites. Each maps to a size in data/platforms.json. */
export const REEL_SHAPES = [
  { id: 'vertical', label: 'Vertical 9:16', hint: 'Reels, TikTok, Shorts and Stories', size: 'ig-reel-9x16' },
  { id: 'portrait', label: 'Portrait 4:5', hint: 'Instagram and Facebook feed', size: 'ig-feed-4x5' },
  { id: 'square', label: 'Square 1:1', hint: 'Feed posts that fit anywhere', size: 'ig-feed-1x1' },
  { id: 'landscape', label: 'Landscape 16:9', hint: 'YouTube, websites, TV and presentations', size: 'yt-landscape-16x9' },
];
export const sizeForShape = (shape) => REEL_SHAPES.find((s) => s.id === shape)?.size ?? 'ig-reel-9x16';
/** The size a reel item is made in (vertical unless the owner chose another shape). Stories are always vertical. */
export const reelSizeOf = (item) => (item?.format === 'story' ? 'ig-story-9x16' : sizeForShape(item?.reel?.shape));

const DEFAULT_USES = {
  auto: ['footage', 'photos', 'music', 'captions', 'endcard'],
  footage: ['footage', 'photos', 'music', 'captions', 'endcard'],
  motion: ['music', 'sfx', 'logo', 'endcard'],
  voiceover: ['voiceover', 'captions', 'music', 'logo', 'endcard'],
};
const NEEDS_NOT = { motion: ['footage', 'photos', 'stock', 'voiceover', 'captions'], voiceover: ['footage', 'photos', 'stock'] };

const STYLE_IDS = REEL_STYLES.map((s) => s.id);
const SHAPE_IDS = REEL_SHAPES.map((s) => s.id);
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
  for (const k of Object.keys(input)) if (!['style', 'uses', 'seconds', 'shape'].includes(k)) errors.push({ path: `/reel/${k}`, message: `unknown reel option "${k}". Options: style, uses, seconds, shape` });
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
  if (input.shape !== undefined && input.shape !== null && input.shape !== '') {
    if (!SHAPE_IDS.includes(input.shape)) errors.push({ path: '/reel/shape', message: `shape must be one of ${SHAPE_IDS.join(', ')}` });
    else out.shape = input.shape;
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
  if (reel.shape && reel.shape !== 'vertical') bits.push(REEL_SHAPES.find((s) => s.id === reel.shape)?.label);
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
    out.push('- Reel style: MOTION GRAPHICS ONLY. The owner asked for a reel made entirely of animated graphics: no footage, no photos, no stock, so do not look for any and do not fail the build for having none. Build it with `motion` scenes (src/shared/motion-kit.mjs; docs/VIDEO.md "The motion kit"): recipes kinetic, number, list, quote, bars, ticker, reveal and logo, on backgrounds aurora, glow, bold or paper, with counters that count up, rings and underlines that draw themselves, blur, tracking and spin entrances, floating specks and a `sweep` between scenes. Go all out and make it look like a motion designer made it: open with a hook scene in the first 2 seconds, change recipe AND background from scene to scene, build a rhythm (quick beat, then a held one), turn any real figure from facts.json into a number or bars scene (never invent a figure), and end on the logo scene. Add your own animated `layers` (keyframes, radial gradients, blur, `blend: "screen"`, drawn `path` shapes) for anything the recipes do not cover. Keep each beat to a few words in big type that reads on a phone in two seconds. Look at the contact sheet and stills yourself: if anything is flat, crowded or cut off, redo it before you finish. Never draw clip-art, cartoon icons or illustrations; the motion, type and colour carry it.');
  } else if (style === 'voiceover') {
    out.push('- Reel style: MOTION GRAPHICS WITH A VOICE-OVER. The owner\'s own voice-over is the spine of the reel and the graphics must match it. Find the recording in `sources/catalog.json` (an audio source that has a words file) or in the media plan; if there is no recording or no word timings, do NOT invent a voice: say exactly what is missing with `nordle_calendar_update` notes and stop. Add `voiceover: { source }` to the reel spec and give every scene a `say` (the words it covers, copied from the transcript) so its graphics start just before those words and change exactly when the next idea is spoken; time extra layers with `time: { say: "..." }`. Show the key word or number of each sentence big instead of repeating the sentence (captions can do that). Read docs/VIDEO.md "Voice-over reels" first. Build it with `motion` scenes (src/shared/motion-kit.mjs; docs/VIDEO.md "The motion kit"): recipes kinetic, number, list, quote, bars, ticker, reveal and logo, on backgrounds aurora, glow, bold or paper, with counters that count up, rings and underlines that draw themselves, blur, tracking and spin entrances, floating specks and a `sweep` between scenes. Go all out and make it look like a motion designer made it: open with a hook scene in the first 2 seconds, change recipe AND background from scene to scene, build a rhythm (quick beat, then a held one), turn any real figure from facts.json into a number or bars scene (never invent a figure), and end on the logo scene. Add your own animated `layers` (keyframes, radial gradients, blur, `blend: "screen"`, drawn `path` shapes) for anything the recipes do not cover. Keep each beat to a few words in big type that reads on a phone in two seconds. Look at the contact sheet and stills yourself: if anything is flat, crowded or cut off, redo it before you finish. Never draw clip-art, cartoon icons or illustrations; the motion, type and colour carry it.');
  } else if (uses.length) {
    out.push('- Reel style: cut from the owner\'s own footage and photos.');
  }
  const label = (id) => REEL_USES.find((u) => u.id === id)?.label.toLowerCase() ?? id;
  const wanted = uses.filter((u) => USE_IDS.includes(u));
  const left = USE_IDS.filter((u) => !wanted.includes(u) && !(NEEDS_NOT[style] ?? []).includes(u));
  if (r.uses) {
    out.push(`- This reel uses: ${wanted.map(label).join(', ') || 'nothing extra'}.${left.length ? ` It does NOT use: ${left.map(label).join(', ')}. Leave those out.` : ''}`);
  }
  if (r.shape && r.shape !== 'vertical') {
    const sh = REEL_SHAPES.find((s) => s.id === r.shape);
    out.push(`- Shape: ${sh.label} (size \`${sh.size}\`): put "sizes": ["${sh.size}"] in the reel spec and design for that shape from the start${r.shape === 'landscape' ? ' (wide frame: put type and subjects in the left and right thirds as well as the centre, use side-by-side layouts, keep captions in the lower third)' : ''}. Do not reuse a vertical layout and crop it.`);
  }
  if (r.seconds) out.push(`- Length: about ${r.seconds} seconds (stay within 3 seconds of that${style === 'voiceover' ? '; the voice-over decides the real length, so choose and trim what is said to fit' : ''}).`);
  return out;
}
