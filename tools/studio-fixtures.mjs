// Builds a fictional workspace for the Studio: three made-up brands, a calendar of posts for each, documents, check records,
// review files and picture files, so the Studio (and its tests) have something real-looking to show.
// Everything is invented: no real business, no real people. Used by tests/studio.test.mjs and tools/studio-demo.mjs.

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { requiredChecks } from '../src/verify/store.mjs';

export const BRANDS = [
  {
    id: 'little-gannet', name: 'Little Gannet Coffee', handle: '@littlegannet', timezone: 'Australia/Melbourne',
    colors: { ink: '#1F2A2E', paper: '#F5EEE3', accent: '#D4752B', accentDark: '#A8520F', sea: '#3F6C7A', muted: '#6F7F83' },
    pillars: [{ id: 'menu', name: 'Menu', share: 0.3 }, { id: 'people', name: 'People', share: 0.2 }, { id: 'place', name: 'Place', share: 0.2 }, { id: 'craft', name: 'Craft', share: 0.3 }],
    audience: 'locals and day-trippers in a small harbour town',
    reels: ['Pouring the honey lavender latte', 'Cold brew tonic in twenty seconds', 'Listening for the first crack', 'The morning rush by the harbour', 'Latte art, slowed down', 'Setting up the grinder before opening', 'Meet the cardamom cortado', 'Behind the roast', 'How we steam oat milk', 'A walk along the bar', 'From bean to cup', 'The tamp, up close', 'Friday pastry delivery', 'Rainy day regulars', 'Cleaning the group head', 'Single origin of the week', 'Two ways to brew filter', 'Putting the sign out', 'The hot chocolate station', 'The Sunday queue', 'Tasting notes, explained', 'Closing up the bar', 'Saturday cupping', 'New cups arrive'],
    others: ['Spring menu at a glance', 'Five drinks for a cold morning', 'How to order a flat white', 'Milk guide: oat, soy or dairy', 'Find us by the harbour', 'Why we roast small batches', 'A guide to our beans', 'Cold brew, explained', 'What is a cortado?', 'Our summer iced menu', 'Meet the team behind the bar', 'Coffee and a walk: three routes', 'Reusable cups, made easy', 'Gift a bag of beans', 'Thank you for a busy season'],
  },
  {
    id: 'harbour-bakery', name: 'Harbour Street Bakery', handle: '@harbourstreetbakery', timezone: 'Australia/Melbourne',
    colors: { ink: '#2B2118', paper: '#FBF4E8', accent: '#2F7F79', accentDark: '#1F5E59', sea: '#C7863A', muted: '#7A6E62' },
    pillars: [{ id: 'bakes', name: 'Bakes', share: 0.35 }, { id: 'oven', name: 'Behind the oven', share: 0.25 }, { id: 'local', name: 'Local', share: 0.2 }, { id: 'season', name: 'Seasonal', share: 0.2 }],
    audience: 'neighbours who like fresh bread and a chat',
    reels: ['Scoring the sourdough', 'Laminating croissant dough', 'The 4am proof', 'Cinnamon scrolls, glazed', 'A loaf comes out of the oven', 'Shaping a baguette', 'Filling the pastry case', 'Hand-rolling pretzels', 'Saturday morning line', 'The starter has a name', 'Cutting a cardamom bun', 'Pie crust in thirty seconds', 'Slicing a fruit loaf', 'Dusting the doughnuts', 'Stacking the lunch rolls', 'Fresh focaccia, dimpled', 'Weighing the flour', 'The oven door opens', 'Tying up a bread bag', 'Brushing the egg wash', 'A tray of rye', 'Wrapping a gift box', 'Sweeping up at noon', 'Winter bakes arrive'],
    others: ['This week on the counter', 'Sourdough, step by step', 'Which loaf is for you?', 'Pastries that travel well', 'Meet the baker', 'How to keep bread fresh', 'A guide to our buns', 'Our flour, from the mill down the road', 'Order ahead for the weekend', 'Gluten-free options explained', 'The Saturday special', 'Bread and soup season', 'Holiday order cut-off dates', 'Thank you, neighbours', 'What we baked this year'],
  },
  {
    id: 'quiet-wren', name: 'Quiet Wren Yoga', handle: '@quietwrenyoga', timezone: 'Australia/Melbourne',
    colors: { ink: '#1E2433', paper: '#F1EFEA', accent: '#3A5BA0', accentDark: '#2B4680', sea: '#8CA3A0', muted: '#68707F' },
    pillars: [{ id: 'classes', name: 'Classes', share: 0.35 }, { id: 'practice', name: 'Practice tips', share: 0.3 }, { id: 'space', name: 'The studio', share: 0.2 }, { id: 'community', name: 'Community', share: 0.15 }],
    audience: 'busy people looking for a calm hour that fits their week',
    reels: ['A slow morning flow', 'Three stretches for desk days', 'Setting up the studio at dawn', 'Breathing before you begin', 'Hips, gently', 'A five minute wind-down', 'How to fold a blanket for support', 'Cat and cow, explained', 'Rolling out a mat', 'The studio in the rain', 'Standing balance, simplified', 'A teacher talks about pacing', 'Candle on, lights down', 'Neck release in thirty seconds', 'Stacking the blocks', 'A Sunday restore class', 'Child pose, three ways', 'The sound of the singing bowl', 'Sun salutation, slowly', 'Shoulders away from the ears', 'Wiping down the mats', 'Early class warm-up', 'Foam roller basics', 'Closing the studio door'],
    others: ['This week’s timetable', 'Your first class: what to expect', 'Props, explained', 'Five poses for better sleep', 'Meet our teachers', 'Beginner questions, answered', 'What to bring to class', 'A guide to class levels', 'Why we keep classes small', 'Morning or evening practice?', 'The month ahead', 'Gentle ways to start again', 'Community class, open to all', 'A note on listening to your body', 'Thank you for practising with us'],
  },
];

// ---- tiny deterministic random + painting ----------------------------------------------------------------------------------------

function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** A simple abstract poster (no text): a ground colour, a big shape and a bar, laid out differently for each variant. */
export function paintPoster({ w, h, ground, shape, ink, variant = 0, seed = 1 }) {
  const png = new PNG({ width: w, height: h });
  const [gr, gg, gb] = hex(ground), [sr, sg, sb] = hex(shape), [ir, ig, ib] = hex(ink);
  const rand = rng(seed * 7919 + variant);
  const cx = w * (0.25 + rand() * 0.5), cy = h * (0.3 + rand() * 0.4), rad = Math.min(w, h) * (0.22 + rand() * 0.18);
  const barY = Math.floor(h * (0.62 + rand() * 0.2)), barH = Math.max(3, Math.floor(h * 0.035));
  const mode = variant % 4;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      let c = [gr, gg, gb];
      if (mode === 0 && (x - cx) ** 2 + (y - cy) ** 2 < rad ** 2) c = [sr, sg, sb];
      else if (mode === 1 && x > w * 0.5 + (y / h) * 20 - 10) c = [sr, sg, sb];
      else if (mode === 2 && ((y > h * 0.55) || ((x - cx) ** 2 + (y - cy) ** 2 < (rad * 0.6) ** 2))) c = [sr, sg, sb];
      else if (mode === 3 && Math.abs(x - y * (w / h)) < w * 0.16) c = [sr, sg, sb];
      if (y >= barY && y < barY + barH && x > w * 0.08 && x < w * 0.08 + w * (0.3 + rand() * 0.001 + (seed % 5) * 0.08)) c = [ir, ig, ib];
      png.data[i] = c[0]; png.data[i + 1] = c[1]; png.data[i + 2] = c[2]; png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png, { deflateLevel: 2 });
}

const MONTHS = { '01': 'jan', '02': 'feb', '03': 'mar', '04': 'apr', '05': 'may', '06': 'jun', '07': 'jul', '08': 'aug', '09': 'sep', '10': 'oct', '11': 'nov', '12': 'dec' };
const pad2 = (n) => String(n).padStart(2, '0');

/** Thirteen working-day slots in a month (8 reels, 3 carousels, 2 posts), nudged per brand so the lanes interleave. */
function slotsFor(month, brandIndex) {
  const [y, m] = month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const base = [1, 3, 5, 8, 10, 12, 15, 17, 19, 22, 24, 26, 29];
  return base.map((d, i) => {
    let day = Math.min(days, d + ((brandIndex + i) % 3 === 0 ? brandIndex : 0));
    const dow = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
    if (dow === 0) day = Math.min(days, day + 1);
    if (dow === 6) day = Math.max(1, day - 1);
    return `${month}-${pad2(day)}`;
  });
}
const FORMATS = ['reel', 'carousel', 'reel', 'reel', 'post', 'reel', 'carousel', 'reel', 'reel', 'carousel', 'reel', 'post', 'reel'];

const LINES = ['Made fresh, every morning.', 'Come and say hello.', 'Save this for later.', 'Ask us anything.', 'Small batches, big care.', 'See you this weekend.'];
const PASS_NOTES = {
  uniqueness: 'No photo or hook is repeated in the same month.',
  technical: 'Every page renders at every size. No text is cut off or too small.',
  compliance: 'No claims, offers or wording that the health-advertising rules rule out.',
  facts: 'Every name, number and place in the words is in the brand facts or the brief.',
  copy: 'The caption opens with the hook, has one call to action and the alt text describes each picture.',
  'media-match': 'Each claim in the words is true of the picture it sits on.',
  brief: 'It does what the idea asked and says one thing.',
  design: 'Clear hierarchy, comfortable margins, brand colours and fonts.',
  'speech-cuts': 'No one is cut off mid-sentence.',
  broll: 'The cutaways match what is being said.',
  audio: 'Music sits under the voice; levels are even.',
};

const requiredFor = (kind) => requiredChecks({ kind }).map((r) => [r.check, r.by]);

function checksFor(docId, kind, profile, title, at, rand) {
  const entries = [];
  for (const [check, bys] of requiredFor(kind)) {
    for (const by of bys) {
      if (profile === 'missing-reviewer' && by === 'reviewer') continue;
      const e = { check, by, status: 'pass', v: 0, at, summary: PASS_NOTES[check] };
      if (check === 'design') { e.score = 90 + Math.floor(rand() * 8); e.summary = `Design score ${e.score}. ${PASS_NOTES.design}`; }
      if (profile === 'fail-media' && check === 'media-match' && by === 'designer') {
        e.status = 'fail';
        e.summary = 'The caption says the pour is slow, but the clip is a quick cut.';
        e.findings = [{ level: 'error', page: kind === 'video' ? undefined : 'cover', message: `The words on "${title}" make a claim the picture does not show.`, fix: 'Reword the line, or swap in the right photo.' }];
      }
      if (profile === 'warn' && check === 'copy') { e.status = 'warn'; e.summary = 'The caption is a little long; the hook is clear but the call to action comes late.'; }
      if (check === 'media-match') {
        e.pairs = (kind === 'video' ? [{ media: 'clip-1', words: title, shows: 'A steady shot of the subject, in focus, for four seconds.', verdict: 'match' }, { media: 'clip-2', words: 'Come and see for yourself', shows: 'A wide shot of the room with the door in frame.', verdict: profile === 'fail-media' ? 'mismatch' : 'match' }]
          : [{ page: 'cover', media: 'assets/hero-cup.svg', words: title, shows: 'A cup on a saucer with steam rising.', verdict: 'match' }, { page: 'p2', media: 'assets/beans.svg', words: 'Made fresh each morning', shows: 'Scattered roasted beans.', verdict: profile === 'fail-media' ? 'mismatch' : 'match', note: profile === 'fail-media' ? 'Beans do not show anything being made.' : undefined }]);
      }
      entries.push(e);
    }
  }
  return { schema: 'nordle.checks/0.1', doc: docId, entries };
}

let _mp4;
/** One small test video (made once with ffmpeg if it is installed). */
export function sampleVideo(dir) {
  if (_mp4 !== undefined) return _mp4;
  const out = join(dir, '.sample.mp4');
  mkdirSync(dir, { recursive: true });
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=270x480:rate=15:duration=6', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '15', '-an', out], { windowsHide: true, encoding: 'utf8' });
  _mp4 = r.status === 0 && existsSync(out) ? out : null;
  return _mp4;
}

/**
 * @param {string} root  an empty folder; projects go in <root>/projects
 * @param {{today?:string, months?:string[], brands?:number, perMonth?:number, paint?:Function, video?:boolean, size?:'small'|'real', statuses?:'morning'|'mixed'}} opts
 */
export async function buildWorkspace(root, opts = {}) {
  const today = opts.today ?? '2026-10-05';
  const months = opts.months ?? ['2026-10', '2026-11', '2026-12'];
  const brandCount = Math.min(opts.brands ?? 3, BRANDS.length);
  const perMonth = Math.min(opts.perMonth ?? 13, 13);
  const w = opts.size === 'real' ? 1080 : 270, h = opts.size === 'real' ? 1350 : 338;
  const paint = opts.paint ?? ((p) => paintPoster(p));
  const projectsDir = join(root, 'projects');
  const made = [];
  const now = new Date(`${today}T08:00:00Z`).toISOString();
  const video = opts.video === false ? null : sampleVideo(join(root, '.cache'));

  for (const [bi, brand] of BRANDS.slice(0, brandCount).entries()) {
    const dir = join(projectsDir, brand.id);
    for (const sub of ['docs', 'out', 'checks', 'review', 'assets']) mkdirSync(join(dir, sub), { recursive: true });
    writeFileSync(join(dir, 'brand.json'), `${JSON.stringify({
      $schema: '../../schemas/brand.schema.json', schema: 'nordle.brand/0.1', id: brand.id, name: brand.name, note: 'Fictional brand made for Nordle tests and demos.',
      colors: brand.colors,
      fonts: { display: { family: 'Fraunces', weights: [600, 700], source: 'google' }, body: { family: 'Inter', weights: [400, 600], source: 'google' } },
      voice: { audience: brand.audience, tone: ['warm', 'plain-spoken'], bannedPhrases: ['world’s best', 'guaranteed'] },
      motion: { personality: 'calm', ease: 'out-cubic' }, links: { handle: brand.handle },
    }, null, 2)}\n`);

    const items = [];
    let reelN = 0, otherN = 0;
    for (const [mi, month] of months.entries()) {
      const slots = slotsFor(month, bi).slice(0, perMonth);
      for (const [si, date] of slots.entries()) {
        const n = mi * 13 + si;
        const format = FORMATS[si] === 'reel' ? 'reel' : FORMATS[si];
        const title = format === 'reel' ? brand.reels[reelN++ % brand.reels.length] : brand.others[otherN++ % brand.others.length];
        const pillar = brand.pillars[(n + bi) % brand.pillars.length];
        let id = `${MONTHS[month.slice(5)]}-${pad2(Number(date.slice(8)))}-${format === 'reel' ? 'r' : format === 'carousel' ? 'c' : 'p'}`;
        for (let n = 2; items.some((i) => i.id === id); n++) id = `${id.replace(/-\d+$/, '')}-${n}`;
        let status = 'built';
        let profile = 'clean';
        const k = n + bi * 5;
        if (k % 9 === 4) status = 'signed-off';
        if (k % 17 === 6) status = 'changes';
        if (k % 29 === 12) status = 'idea';
        if (k % 31 === 20) status = 'rejected';
        if (k % 37 === 22) status = 'approved';
        if (k % 41 === 30) status = 'building';
        if (opts.statuses === 'mixed') { if (mi === 1 && k % 3 === 0) status = 'approved'; if (mi === 2 && k % 2 === 0) status = 'idea'; }
        if (['built', 'signed-off', 'changes'].includes(status)) {
          if (k % 13 === 3) profile = 'fail-media';
          else if (k % 11 === 5) profile = 'missing-reviewer';
          else if (k % 7 === 2) profile = 'warn';
        }
        const hasDoc = ['built', 'signed-off', 'changes', 'rejected'].includes(status);
        const docId = hasDoc ? `post-${id}` : null;
        const hook = format === 'reel' ? `Watch: ${title.toLowerCase()}.` : `${title}.`;
        const item = {
          id, date, time: '17:30', format, title, pillar: pillar.id, hook,
          idea: `${title}: a short, honest look aimed at ${brand.audience}. It shows one real moment and ends with one clear next step.`,
          audience: brand.audience, status, origin: 'claude',
          ...(docId ? { doc: docId } : {}), updated: now,
        };
        if (si === 3) item.occasion = 'Melbourne Cup week';
        if (si === 5) item.mediaPlan = 'Two clips from the morning and one photo of the counter.';
        items.push(item);

        if (hasDoc) {
          const kind = format === 'reel' ? 'video' : format === 'post' ? 'graphic' : 'carousel';
          const pageIds = kind === 'carousel' ? ['cover', 'p2', 'p3'] : kind === 'graphic' ? ['main'] : [];
          const size = kind === 'video' ? 'ig-reel-9x16' : 'ig-feed-4x5';
          const caption = `${hook}\n\n${brand.audience.charAt(0).toUpperCase()}${brand.audience.slice(1)} will recognise this one. We keep it simple and true, and you can see it for yourself.\n\nSave this for later, or send it to someone who would love it.`;
          const copy = { caption, cta: 'Save this for later.', hashtags: [`#${brand.id.replace(/-/g, '')}`, '#local', `#${pillar.id}`], alt: Object.fromEntries((kind === 'video' ? ['video'] : pageIds).map((p) => [p, `${title}: ${p === 'cover' || p === 'video' || p === 'main' ? 'the first picture' : 'another picture from the post'}.`])) };
          const doc = kind === 'video'
            ? { schema: 'nordle.doc/0.1', id: docId, title, kind, brand: brand.id, sizes: [size], copy, brief: { goal: 'Make someone stop scrolling and keep watching.', audience: brand.audience, message: title, tone: 'warm, plain-spoken', mustInclude: ['one real moment'], mustAvoid: ['superlatives'], calendarItem: id, postDate: date }, timeline: { fps: 30, duration: 15, tracks: [] } }
            : { schema: 'nordle.doc/0.1', id: docId, title, kind, brand: brand.id, sizes: [size], copy, brief: { goal: 'Be saved and shared.', audience: brand.audience, message: title, tone: 'warm, plain-spoken', calendarItem: id, postDate: date }, pages: pageIds.map((pid, pi) => ({ id: pid, title: pi === 0 ? 'Cover' : `Page ${pi + 1}`, background: '$brand.colors.paper', layers: [{ id: 'headline', type: 'text', text: pi === 0 ? title : 'One more thing', layout: { anchor: 'top-left', x: 8, y: 12, w: 84 }, style: { font: '$brand.fonts.display', size: 96, weight: 700, color: '$brand.colors.ink' } }] })) };
          writeFileSync(join(dir, 'docs', `${docId}.json`), `${JSON.stringify(doc, null, 2)}\n`);
          writeFileSync(join(dir, 'checks', `${docId}.json`), `${JSON.stringify(checksFor(docId, kind, profile, title, now, rng(k + 1)), null, 2)}\n`);
          const review = { schema: 'nordle.review/0.1', doc: docId, comments: [], versions: [], approvals: [] };
          if (status === 'changes') review.comments.push({ id: `c-seed${n}`, page: pageIds[0] ?? 'video', x: 0.5, y: 0.5, text: 'The second line feels long. Try a shorter one that ends on the verb.', author: 'human', created: now, status: 'open', docV: 0 });
          writeFileSync(join(dir, 'review', `${docId}.json`), `${JSON.stringify(review, null, 2)}\n`);
          const outDir = join(dir, 'out', docId);
          mkdirSync(outDir, { recursive: true });
          const colors = [brand.colors.paper, brand.colors.ink, brand.colors.accent, brand.colors.sea];
          if (kind === 'video') {
            const ph = Math.round((w * 16) / 9);
            writeFileSync(join(outDir, `${docId}-cover.png`), await paint({ w, h: ph, ground: colors[1], shape: colors[2], ink: colors[0], variant: k, seed: k, title, text: title, brand, kind: 'reel', page: 0, pages: 1 }));
            if (video) copyFileSync(video, join(outDir, `${docId}.mp4`));
          } else {
            for (const [pi, pid] of pageIds.entries()) {
              const v = k + pi;
              writeFileSync(join(outDir, `${docId}_${size}_${pad2(pi + 1)}-${pid}.png`), await paint({ w, h, ground: colors[pi === 1 ? 1 : 0], shape: colors[2 + (pi % 2)], ink: colors[pi === 1 ? 0 : 1], variant: v, seed: k + pi, title, text: pi === 0 ? title : LINES[(k + pi) % LINES.length], brand, kind, page: pi, pages: pageIds.length }));
            }
          }
        }
      }
    }
    const calendar = {
      schema: 'nordle.calendar/0.1', brand: brand.id, timezone: brand.timezone,
      settings: { leadDays: 14, perMonth: { reel: 8, carousel: 3, post: 2 }, pillars: brand.pillars.map((p) => ({ id: p.id, name: p.name, share: p.share })) },
      items,
    };
    writeFileSync(join(dir, 'calendar.json'), `${JSON.stringify(calendar, null, 2)}\n`);
    made.push({ id: brand.id, name: brand.name, items: items.length, docs: items.filter((i) => i.doc).length });
  }
  return { root, projectsDir, today, projects: made, video: !!video };
}
