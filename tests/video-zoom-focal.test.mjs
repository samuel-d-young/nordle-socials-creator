// A zoom must close in on the clip's focal point, not the middle of the window. A seated speaker filmed wide has their face
// in the top third; zooming about the centre pushed the head out of the top of a 9:16 reel (Nov 2026).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentArgs } from '../src/video/picture.mjs';

const plan = { width: 1080, height: 1920, fps: 30 };
const seg = (clip) => ({ kind: 'clip', s: 0, e: 30, ext: 0, fadeIn: 0, fadeOut: 0, srcStart: 0, clip });
const clip = (over) => ({
  src: { abs: 'x.mp4', probe: { video: { displayWidth: 3840, displayHeight: 2160 }, duration: 10 } },
  fit: 'cover', focal: { x: 0.5, y: 0.3 }, zoom: { from: 1.3, to: 1.34 }, speed: 1, startF: 0, endF: 30, isImage: false, fade: {}, ...over,
});
const zoompanOf = (c) => {
  const args = segmentArgs(plan, seg(c), 'out.mp4');
  const vf = args[args.indexOf('-vf') + 1];
  return vf.match(/zoompan=.*?:fps=30/)[0];   // its expressions contain commas, so it cannot be split on them
};

test('zoom centres on the focal height, kept inside the window', () => {
  const z = zoompanOf(clip());
  assert.match(z, /y='clip\(ih\*0\.3-ih\/zoom\/2,0,ih-ih\/zoom\)'/);
  assert.match(z, /x='clip\(iw\*0\.(5|49\d*)-iw\/zoom\/2,0,iw-iw\/zoom\)'/);   // the window lands on even pixels
});

test('a centred focal point zooms about the middle as before', () => {
  const z = zoompanOf(clip({ focal: { x: 0.5, y: 0.5 } }));
  assert.match(z, /y='clip\(ih\*0\.5-ih\/zoom\/2/);
});

test('the focal point is measured inside the cropped window, not the whole source', () => {
  // a 9:16 window on 16:9 footage is 1214 px wide; focal x 0.05 of 3840 = 192 px, too near the edge to centre the window,
  // so the window sits at x 0 and the point is 192/1214 (about 0.16) across it
  const z = zoompanOf(clip({ focal: { x: 0.05, y: 0.5 } }));
  const fx = Number(z.match(/x='clip\(iw\*([\d.]+)/)[1]);
  assert.ok(fx > 0.12 && fx < 0.2, `focal inside the window was ${fx}`);
});
