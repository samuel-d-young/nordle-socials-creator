// A small project of invented footage for the video editor tests: synthetic sources (see video-fixtures.mjs), a reel with two
// speaking clips, a cutaway, a photo, music, scenes, captions and a title; and a second copy whose transcript has filler words.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../tools/validate.mjs';
import { makeMedia, SCRIPT, wordEnd, wordStart } from './video-fixtures.mjs';

export const P = 'little-gannet';
const M = (name) => `mount:footage/${name}`;

export const sources = () => [
  { id: 'talk', type: 'video', path: M('talk.mp4'), duration: 12, transcript: M('talk.words.json') },
  { id: 'broll', type: 'video', path: M('broll.mp4'), duration: 6 },
  { id: 'music', type: 'audio', path: M('music.wav'), duration: 12 },
  { id: 'photo', type: 'image', path: 'assets/photo.jpg' },
];

/**
 * Words 0 to 15 are kept (0.5 to 8.4 s of the recording), word 16 ("days.") is cut off, and there is a 1 second gap on the picture
 * track from 7.9 to 9 s: so the check finds a gap, and (cutting before the end of a sentence) a warning too.
 */
export const reelDoc = (id = 'reel-edit', extra = {}) => ({
  schema: 'nordle.doc/0.1', id, title: 'Editor test reel', kind: 'video', brand: P, sizes: ['ig-reel-9x16', 'tiktok-9x16'],
  sources: sources(),
  timeline: {
    fps: 30, duration: 10,
    tracks: [
      { id: 'v1', type: 'video', name: 'Picture', clips: [
        { id: 'c1', source: 'talk', in: 0.5, out: 3.4, at: 0 },
        { id: 'c2', source: 'talk', in: 3.4, out: 8.4, at: 2.9 },
        { id: 'pic', source: 'photo', in: 0, out: 1, at: 9 },
      ] },
      { id: 'v2', type: 'video', name: 'Cutaway', clips: [{ id: 'cutaway', source: 'broll', in: 0, out: 2, at: 3, mute: true }] },
      { id: 'music', type: 'audio', name: 'Music', clips: [{ id: 'bed', source: 'music', in: 0, out: 7, at: 0, gainDb: -10, duck: { under: 'v1', amountDb: -12, attack: 0.1, release: 0.4 } }] },
    ],
    scenes: [{ id: 'hook', title: 'Hook', start: 0, end: 3 }, { id: 'rest', title: 'Rest', start: 3, end: 10 }],
    captions: { source: 'talk', highlight: 'word', maxWordsPerLine: 3, position: 'bottom-third' },
  },
  layers: [{ id: 'title', type: 'text', text: 'Hello there', time: { start: 0.4, end: 2.6 }, layout: { anchor: 'top-left', x: 8, y: 20, w: 70 }, style: { font: '$brand.fonts.display', size: 96, weight: 700, color: '$brand.colors.paper' }, animate: [{ preset: 'rise-in', at: 0, duration: 0.4 }] }],
  ...extra,
});

/** Build the project folder once: brand, assets, the mount, the footage, and the documents. */
export async function buildEditorProject(root) {
  // the invented footage is the same every time and takes a while to make, so one copy is kept between runs (nothing in it is a person's)
  const footage = process.env.NORDLE_EDITOR_FOOTAGE ?? join(tmpdir(), 'nordle-editor-test-footage');
  const projectsDir = join(root, 'projects');
  const proj = join(projectsDir, P);
  mkdirSync(join(proj, 'assets'), { recursive: true });
  mkdirSync(join(proj, 'docs'), { recursive: true });
  cpSync(join(ROOT, 'samples', P, 'brand.json'), join(proj, 'brand.json'));
  const marker = join(footage, '.ready-1');
  if (!existsSync(marker)) { await makeMedia(footage); writeFileSync(marker, 'ok'); }
  cpSync(join(footage, 'photo.jpg'), join(proj, 'assets', 'photo.jpg'));
  writeFileSync(join(proj, 'nordle.local.json'), JSON.stringify({ mounts: { footage } }));
  // a transcript with fillers in it: "we" -> um, "and" -> uh, "make" -> like
  const fill = SCRIPT.map((text, i) => ({ text: { 2: 'um', 7: 'uh', 14: 'like' }[i] ?? text, start: wordStart(i), end: wordEnd(i) }));
  writeFileSync(join(footage, 'talk.fill.words.json'), JSON.stringify({ schema: 'nordle.words/0.1', synthetic: true, words: fill }));
  writeDoc(proj, reelDoc());
  const fillers = reelDoc('reel-fillers');
  fillers.sources[0].transcript = M('talk.fill.words.json');
  writeDoc(proj, fillers);
  return { root, footage, projectsDir, proj };
}

export function writeDoc(proj, doc) {
  mkdirSync(join(proj, 'docs'), { recursive: true });
  writeFileSync(join(proj, 'docs', `${doc.id}.json`), `${JSON.stringify(doc, null, 2)}\n`);
}
