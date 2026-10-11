// Proxies (small copies of footage a browser can play and scrub) and waveforms (peaks for the timeline's sound lanes):
// the files, the freshness rule, the limits, the path rules, and the routes that serve them. Synthetic media only.
//   node --test tests/video-proxy.test.mjs        (needs ffmpeg on the PATH)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../tools/validate.mjs';
import { createNordleServer } from '../src/server/http.mjs';
import { binary, ffmpegVersion, run } from '../src/video/ffmpeg.mjs';
import { MountError } from '../src/video/mounts.mjs';
import { probeMedia } from '../src/video/probe.mjs';
import { makeProxy, proxyFor, proxyStats, proxyArgs, PROXY_DIR } from '../src/video/proxy.mjs';
import { cacheStep, peakReducer, poolPeaks, speechRanges, waveformFor } from '../src/video/waveform.mjs';
import { decodeFrames, makeMedia, retryReset } from './video-fixtures.mjs';

const work = mkdtempSync(join(tmpdir(), 'nordle-proxytest-'));
const footage = join(work, 'footage');
const projectsDir = join(work, 'projects');
const proj = join(projectsDir, 'little-gannet');
const proxies = join(proj, PROXY_DIR);
const M = (name) => `mount:footage/${name}`;

const keyframes = async (file) => {
  const { stdout } = await run(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', file], { bin: binary('ffprobe'), capture: 'text' });
  return stdout.split(/\r?\n/).filter((l) => /,K/.test(l)).map((l) => Number(l.split(',')[0]));
};
/** the top-level boxes of an mp4, in order: ['ftyp','moov','mdat'] for a file that starts playing before it has all arrived */
function boxes(file) {
  const fd = openSync(file, 'r');
  try {
    const out = [];
    const size = statSync(file).size;
    let pos = 0;
    const head = Buffer.alloc(16);
    while (pos + 8 <= size) {
      readSync(fd, head, 0, 16, pos);
      let len = head.readUInt32BE(0);
      out.push(head.toString('latin1', 4, 8));
      if (len === 1) len = Number(head.readBigUInt64BE(8));
      if (len < 8) break;
      pos += len;
    }
    return out;
  } finally { closeSync(fd); }
}

before(async () => {
  mkdirSync(proj, { recursive: true });
  cpSync(join(ROOT, 'samples', 'little-gannet', 'brand.json'), join(proj, 'brand.json'));
  mkdirSync(join(proj, 'assets'), { recursive: true });
  await makeMedia(footage);
  cpSync(join(footage, 'photo.jpg'), join(proj, 'assets', 'photo.jpg'));
  const lav = (spec) => ['-f', 'lavfi', '-i', spec];
  const v = ffmpegVersion();
  const vfrFlag = v.major > 5 || (v.major === 5 && v.minor >= 1) ? ['-fps_mode', 'vfr'] : ['-vsync', 'vfr'];
  await Promise.all([
    // 1 s of 440 Hz, 2 s of silence, 1 s of 440 Hz (the silent middle)
    run([...lav("aevalsrc='0.5*sin(2*PI*440*t)*(lt(t,1)+gte(t,3))':s=44100:d=4"), '-c:a', 'pcm_s16le', join(footage, 'tone.wav')]),
    // 250 s of tone at a low sample rate: long enough that 0.01 s per peak would be more than 20000 peaks
    run([...lav('sine=frequency=300:sample_rate=8000:duration=250'), '-c:a', 'pcm_s16le', join(footage, 'long.wav')]),
    // a phone-style portrait clip: landscape pixels with a rotation of 90 degrees
    // (-display_rotation is ffmpeg 6 and later: without it there is no phone clip and that part of the test is skipped)
    run([...lav('testsrc=size=1920x1080:rate=30:duration=2'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(work, 'land.mp4')]).then(() => run(['-display_rotation', '90', '-i', join(work, 'land.mp4'), '-c', 'copy', join(footage, 'phone.mp4')])).catch(() => {}),
  ]);
  await Promise.all([
    // variable frame rate: three of every ten frames are missing
    run([...lav('testsrc=size=640x360:rate=30:duration=4'), '-vf', "select='lt(mod(n,10),7)'", ...vfrFlag, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', join(footage, 'vfr.mp4')]),
    // a clip that starts half a second into its own clock (what cutting without re-timing leaves behind)
    run(['-itsoffset', '0.5', '-i', join(footage, 'talk.mp4'), '-c', 'copy', join(footage, 'offset.mp4')]),
    // two sound tracks: a silent mono one first, then a stereo one with a tone (the stereo one is the sound)
    run([...lav('color=c=red:s=640x360:r=25:d=2'), ...lav('anullsrc=r=44100:cl=mono:d=2'), ...lav('sine=frequency=440:sample_rate=44100:duration=2'),
      '-filter_complex', '[2:a]pan=stereo|c0=c0|c1=c0[s]', '-map', '0:v', '-map', '1:a', '-map', '[s]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', join(footage, 'multi.mp4')]),
  ]);
  writeFileSync(join(footage, 'bad.mp4'), 'this is not a video');
  writeFileSync(join(proj, 'nordle.local.json'), JSON.stringify({ mounts: { footage } }));
});
after(() => { rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); });

// ------------------------------------------------------------------------------------------------ proxies

test('a proxy is small, keeps the source timing, has a keyframe at least every half second, and starts playing early', { timeout: 90000 }, async () => {
  assert.equal(proxyFor(proj, M('talk.mp4')), null, 'nothing yet');
  const seen = [];
  const made = await makeProxy(proj, M('talk.mp4'), { onProgress: (p) => seen.push(p.percent) });
  assert.equal(made.cached, false);
  assert.match(made.file, new RegExp(`\\.proxies[\\\\/][0-9a-f]{40}\\.mp4$`));
  assert.equal(made.file, join(proxies, `${made.key}.mp4`));
  assert.equal(proxyFor(proj, M('talk.mp4')), made.file);
  assert.equal(seen.at(-1), 100); assert.ok(seen.every((v, i) => i === 0 || v >= seen[i - 1]));
  assert.deepEqual(readdirSync(proxies).sort(), [`${made.key}.json`, `${made.key}.mp4`], 'no .part left, a note of what it was made from');

  const src = await probeMedia(join(footage, 'talk.mp4'));
  const px = await probeMedia(made.file);
  assert.deepEqual([px.video.width, px.video.height], [960, 540], '1280x720 comes down to 540 on the short side');
  assert.equal(px.video.codec, 'h264'); assert.equal(px.video.pixFmt, 'yuv420p');
  assert.equal(px.video.fps, src.video.fps, 'the frame rate is the source\'s own');
  assert.ok(Math.abs(px.duration - src.duration) <= 1 / src.video.fps, `duration ${px.duration} against ${src.duration}`);
  assert.equal(px.audio[0].codec, 'aac');
  assert.ok(px.size < src.size, 'smaller than the source');
  // a time in the proxy is a time in the source: the same frames, the same colour on the same frame number
  const a = await decodeFrames(join(footage, 'talk.mp4'), 4, 4), b = await decodeFrames(made.file, 4, 4);
  assert.equal(b.length, a.length);
  for (let i = 0; i < a.length; i += 9) assert.ok(Math.abs(a[i].r - b[i].r) < 30 && Math.abs(a[i].g - b[i].g) < 30 && Math.abs(a[i].b - b[i].b) < 30, `frame ${i}`);
  const firstGreen = (frames) => frames.findIndex((f) => f.g > 200 && f.r < 80);
  assert.equal(firstGreen(b), firstGreen(a)); assert.equal(firstGreen(a), 25);
  // keyframes
  const keys = await keyframes(made.file);
  assert.ok(keys.length >= 24, `${keys.length} keyframes in 12 s`);
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i] - keys[i - 1] <= 0.5 + 1e-6, `keyframes ${keys[i - 1]} and ${keys[i]}`);
  // moov before mdat: playable before it has all arrived
  const order = boxes(made.file);
  assert.ok(order.indexOf('moov') < order.indexOf('mdat'), order.join(','));
  // asked again: the same file, nothing redone
  const mtime = statSync(made.file).mtimeMs;
  const again = await makeProxy(proj, M('talk.mp4'));
  assert.equal(again.cached, true); assert.equal(again.file, made.file); assert.equal(statSync(made.file).mtimeMs, mtime);
});

test('footage with no sound gets a proxy with no sound, and a phone clip with a rotation tag comes out the right way up', { timeout: 90000 }, async () => {
  const broll = await makeProxy(proj, M('broll.mp4'));
  const p = await probeMedia(broll.file);
  assert.deepEqual([p.video.width, p.video.height], [960, 540]);
  assert.equal(p.hasAudio, false);
  assert.equal(Math.round(p.video.fps), 30);
  assert.ok(Math.abs(p.duration - 6) <= 1 / 30);
  assert.ok((await keyframes(broll.file)).every((t, i, k) => i === 0 || t - k[i - 1] <= 0.5 + 1e-6));
  if (existsSync(join(footage, 'phone.mp4'))) {
    const phone = await makeProxy(proj, M('phone.mp4'));
    const q = await probeMedia(phone.file);
    assert.deepEqual([q.video.width, q.video.height, q.video.rotation], [540, 960, 0], 'portrait on display, turned for real in the copy');
  }
  // a clip already smaller than 540 on the short side is not enlarged
  assert.deepEqual(proxyArgs({ kind: 'video', video: { displayWidth: 640, displayHeight: 360, fps: 25 }, audio: [], hasAudio: false }, 'x.mp4', 'y').filter((a) => /^scale=/.test(a)), ['scale=640:360:flags=bicubic,format=yuv420p']);
});

test('timing is kept exactly: every frame keeps its time, for steady and uneven frame rates and for a clip that starts late', { timeout: 90000 }, async () => {
  const pts = async (file) => {
    const { stdout } = await run(['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', file], { bin: binary('ffprobe'), capture: 'text' });
    const list = stdout.split(/\r?\n/).filter(Boolean).map(Number).sort((a, b) => a - b);
    return list.map((t) => t - list[0]); // from the first frame, which is what a seek to 0 means
  };
  for (const name of ['talk.mp4', 'vfr.mp4', 'offset.mp4']) {
    const made = await makeProxy(proj, M(name));
    const a = await pts(join(footage, name)), b = await pts(made.file);
    assert.equal(b.length, a.length, `${name}: the same number of frames (${a.length})`);
    for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 0.0011, `${name}: frame ${i} is at ${a[i]} s in the source and ${b[i]} s in the proxy`);
  }
  // the uneven one really is uneven (so the check above means something), and it did not turn into a steady 30 fps
  const vfr = await pts(join(footage, 'vfr.mp4'));
  assert.ok(vfr.length < 100 && vfr.some((t, i) => i > 0 && t - vfr[i - 1] > 0.05), 'gaps in the source');
});

test('with several sound tracks the proxy and the waveform use the one with the most channels, like the render', { timeout: 90000 }, async () => {
  const src = await probeMedia(join(footage, 'multi.mp4'));
  assert.deepEqual(src.audio.map((a) => a.channels), [1, 2]);
  const fromOriginal = await waveformFor(proj, M('multi.mp4'), { per: 0.1 });
  assert.ok(fromOriginal.peaks.slice(1, 18).every((v) => v > 0.1 && v < 0.14), 'the tone of the stereo track, not the silent mono one');
  const made = await makeProxy(proj, M('multi.mp4'));
  const p = await probeMedia(made.file);
  assert.deepEqual(p.audio.map((a) => a.channels), [2], 'one sound track, the stereo one');
  // the waveform of a source that has a proxy is read from the proxy: same shape
  rmSync(join(proxies, `${made.key}.peaks.json`));
  const fromProxy = await waveformFor(proj, M('multi.mp4'), { per: 0.1 });
  assert.equal(fromProxy.peaks.length, fromOriginal.peaks.length);
  assert.ok(Math.abs(fromProxy.duration - fromOriginal.duration) < 0.03);
  assert.ok(fromProxy.peaks.slice(2, 17).every((v) => v > 0.1 && v < 0.15));
});

test('music or a recording with only sound gets a small sound-only proxy; a picture gets none', { timeout: 60000 }, async () => {
  const m = await makeProxy(proj, M('music.wav'));
  const p = await probeMedia(m.file);
  assert.equal(p.kind, 'audio'); assert.equal(p.audio[0].codec, 'aac'); assert.ok(Math.abs(p.duration - 12) < 0.1);
  await assert.rejects(makeProxy(proj, 'assets/photo.jpg'), /is a picture.*no proxy/);
  assert.deepEqual(readdirSync(proxies).filter((n) => n.endsWith('.part')), []);
});

test('a stale proxy is not used and is rebuilt when the file changes; the old one is deleted', { timeout: 90000 }, async () => {
  const file = join(footage, 'changing.mp4');
  copyFileSync(join(footage, 'talk.mp4'), file);
  const first = await makeProxy(proj, M('changing.mp4'));
  assert.equal(proxyFor(proj, M('changing.mp4')), first.file);
  // only the modification time changes: still stale
  const later = new Date(Date.now() + 60000);
  utimesSync(file, later, later);
  assert.equal(proxyFor(proj, M('changing.mp4')), null, 'a changed time means a stale proxy');
  const second = await makeProxy(proj, M('changing.mp4'));
  assert.notEqual(second.key, first.key);
  assert.equal(second.cached, false);
  assert.equal(proxyFor(proj, M('changing.mp4')), second.file);
  assert.equal(existsSync(first.file), false, 'the proxy of the old version is gone');
  assert.equal(existsSync(join(proxies, `${first.key}.json`)), false);
  // the contents change (a different video of a different size)
  copyFileSync(join(footage, 'bands.mp4'), file);
  assert.equal(proxyFor(proj, M('changing.mp4')), null);
  const third = await makeProxy(proj, M('changing.mp4'));
  assert.ok(existsSync(third.file) && !existsSync(second.file));
  assert.ok(Math.abs((await probeMedia(third.file)).duration - 4) <= 1 / 25);
  // a file that is gone has no proxy to hand out
  rmSync(file);
  assert.equal(proxyFor(proj, M('changing.mp4')), null);
});

test('at most two proxies are made at once, the rest wait their turn, and they all finish', { timeout: 120000 }, async () => {
  const names = ['talk.mp4', 'broll.mp4', 'bands.mp4', 'stripes.mp4', 'sync.mp4'];
  const waiting = [];
  const results = await Promise.all(names.map((n) => makeProxy(proj, M(n), { force: true, onProgress: (p) => { if (p.stage === 'waiting') waiting.push(n); } })));
  assert.equal(results.length, 5);
  for (const r of results) assert.ok(existsSync(r.file));
  const stats = proxyStats();
  assert.equal(stats.peak, 2, `never more than two at once (peak ${stats.peak})`);
  assert.deepEqual([stats.active, stats.waiting], [0, 0]);
  assert.equal(waiting.length, 3, 'three of the five had to wait');
});

test('a proxy being made is cancelled cleanly, and a second ask shares the first one\'s work', { timeout: 60000 }, async () => {
  const ac = new AbortController();
  const one = makeProxy(proj, M('sync.mp4'), { force: true, signal: ac.signal });
  const two = makeProxy(proj, M('sync.mp4'), { force: true });
  assert.strictEqual(one, two, 'the same piece of work');
  ac.abort();
  await assert.rejects(one, /Cancelled/);
  assert.deepEqual(readdirSync(proxies).filter((n) => n.endsWith('.part')), [], 'no half-made file is left');
});

test('paths that leave the project or the mount are refused, a missing file is said plainly', { timeout: 60000 }, async () => {
  for (const bad of ['mount:footage/../secret.mp4', 'mount:footage/a/../../x.mp4', 'mount:footage//etc/x.mp4', 'mount:footage/C:/Windows/x.mp4', 'mount:footage/a\\b.mp4', 'mount:ghost/x.mp4', '../outside.mp4', 'assets/../../x.mp4', 'C:/Windows/x.mp4', '/etc/passwd', '\\\\server\\share\\x.mp4', '', undefined]) {
    assert.throws(() => proxyFor(proj, bad), MountError, `proxyFor ${bad}`);
    await assert.rejects(Promise.resolve().then(() => makeProxy(proj, bad)), MountError, `makeProxy ${bad}`);
  }
  assert.equal(proxyFor(proj, M('not-there.mp4')), null);
  await assert.rejects(Promise.resolve().then(() => makeProxy(proj, M('not-there.mp4'))), /There is no file at mount:footage\/not-there\.mp4/);
  // a link inside the mount that leads outside it
  mkdirSync(join(work, 'outside'), { recursive: true });
  writeFileSync(join(work, 'outside', 'secret.mp4'), 'x');
  try {
    symlinkSync(join(work, 'outside'), join(footage, 'linkout'), 'junction');
    assert.throws(() => proxyFor(proj, M('linkout/secret.mp4')), (e) => e instanceof MountError && e.code === 'mount-escape');
    await assert.rejects(Promise.resolve().then(() => makeProxy(proj, M('linkout/secret.mp4'))), MountError);
  } catch (e) { if (e instanceof assert.AssertionError) throw e; /* links are not allowed on this machine: the checks above still held */ }
  assert.equal(readdirSync(proxies).filter((n) => !/^[0-9a-f]{40}\.(mp4|json|peaks\.json)$/.test(n)).length, 0, 'nothing but proxies, notes and waveforms in the folder');
});

// ------------------------------------------------------------------------------------------------ waveforms

test('peaks: a tone with a silent middle shows as loud, silent, loud, in the right places', { timeout: 60000 }, async () => {
  const w = await waveformFor(proj, M('tone.wav'), { per: 0.05 });
  assert.equal(w.per, 0.05);
  assert.ok(Math.abs(w.duration - 4) < 0.02, `duration ${w.duration}`);
  assert.equal(w.peaks.length, 80);
  assert.ok(w.peaks.every((v) => v >= 0 && v <= 1 && Math.round(v * 1000) / 1000 === v), '0 to 1, three decimals');
  const loud = (a, b) => w.peaks.slice(a, b).every((v) => v > 0.4 && v < 0.6);
  const quiet = (a, b) => w.peaks.slice(a, b).every((v) => v < 0.02);
  assert.ok(loud(0, 19), 'the first second is loud');
  assert.ok(quiet(22, 58), 'the silent middle is silent');
  assert.ok(loud(62, 79), 'and the last second is loud again');
  assert.equal(w.hasAudio, true);
  assert.equal(w.speech, undefined, 'no transcript, no speech');
  assert.ok(existsSync(join(proxies, `${readdirSync(proxies).find((n) => n.endsWith('.peaks.json'))}`)), 'kept next to the proxies');
  // other steps come from the same cache, exactly
  const coarse = await waveformFor(proj, M('tone.wav'), { per: 0.1 });
  assert.equal(coarse.peaks.length, 40);
  for (let i = 0; i < 40; i++) assert.equal(coarse.peaks[i], Math.max(w.peaks[2 * i], w.peaks[2 * i + 1]), `step ${i}`);
  const fine = await waveformFor(proj, M('tone.wav'), { per: 0.01 });
  assert.equal(fine.per, 0.01); assert.equal(fine.peaks.length, 400);
  // asked for something silly: a floor, and a default
  assert.equal((await waveformFor(proj, M('tone.wav'), { per: 0.0001 })).per, 0.01);
  assert.equal((await waveformFor(proj, M('tone.wav'), { per: 'x' })).per, 0.05);
});

test('peaks: never more than 20000, by making each peak cover more time', { timeout: 60000 }, async () => {
  assert.equal(cacheStep(200), 0.01); assert.equal(cacheStep(200.5), 0.05); assert.equal(cacheStep(3600), 0.5); assert.equal(cacheStep(7200), 0.5);
  const w = await waveformFor(proj, M('long.wav'), { per: 0.01 });
  assert.equal(w.per, 0.05, '250 s at 0.01 would be 25000 peaks');
  assert.equal(w.peaks.length, 5000);
  assert.ok(w.peaks.slice(10, 4990).every((v) => v > 0.11 && v < 0.14), 'a steady tone (ffmpeg\'s sine is at 1/8 of full scale) is steady all the way');
  assert.ok(w.peaks.length <= 20000);
  const ten = await waveformFor(proj, M('long.wav'), { per: 10 });
  assert.equal(ten.peaks.length, 25); assert.equal(ten.per, 10);
});

test('peaks are read as the sound streams in: pieces of any size, even a split sample, give the same answer', () => {
  const samples = new Int16Array(8000 * 3 + 123);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(20000 * Math.sin(i / 7) * (i > 9000 && i < 15000 ? 1 : 0.1));
  const bytes = Buffer.from(samples.buffer);
  const whole = peakReducer(0.05); whole.push(bytes);
  const expected = whole.end();
  assert.equal(expected.peaks.length, Math.ceil(samples.length / 400));
  for (const size of [1, 3, 7, 4097, 65536]) {
    const r = peakReducer(0.05);
    for (let i = 0; i < bytes.length; i += size) r.push(bytes.subarray(i, i + size));
    const got = r.end();
    assert.deepEqual(got.peaks, expected.peaks, `pieces of ${size} bytes`);
    assert.equal(got.seconds, samples.length / 8000);
  }
  let loudest = 0; for (let i = 0; i < 400; i++) loudest = Math.max(loudest, Math.abs(samples[i]));
  assert.equal(expected.peaks[0], Math.round((loudest / 32768) * 1000) / 1000);
  assert.deepEqual(poolPeaks([0.1, 0.5, 0.2, 0.9, 0.3], 0.01, 0.02, 0.05), [0.5, 0.9, 0.3]);
});

test('speech: the stretches covered by the words, with gaps under 0.35 s closed up', () => {
  assert.deepEqual(speechRanges([{ start: 2.5, end: 3 }, { start: 0, end: 1 }, { start: 1.2, end: 2 }]), [{ start: 0, end: 2 }, { start: 2.5, end: 3 }]);
  assert.deepEqual(speechRanges([{ start: 0, end: 1 }, { start: 1.35, end: 2 }]), [{ start: 0, end: 1 }, { start: 1.35, end: 2 }], 'a gap of exactly 0.35 s is a gap');
  assert.deepEqual(speechRanges([{ start: 0, end: 3 }, { start: 1, end: 2 }]), [{ start: 0, end: 3 }], 'a word inside another changes nothing');
  assert.deepEqual(speechRanges([]), []);
});

test('a changed source gets a new waveform and the old one is deleted', { timeout: 60000 }, async () => {
  const file = join(footage, 'wavechange.wav');
  copyFileSync(join(footage, 'tone.wav'), file);
  const a = await waveformFor(proj, M('wavechange.wav'), { per: 0.1 });
  const before = readdirSync(proxies).filter((n) => n.endsWith('.peaks.json'));
  copyFileSync(join(footage, 'music.wav'), file);
  const b = await waveformFor(proj, M('wavechange.wav'), { per: 0.1 });
  assert.notEqual(a.peaks.length, b.peaks.length, '4 s then 12 s');
  assert.ok(Math.abs(b.duration - 12) < 0.05);
  const after = readdirSync(proxies).filter((n) => n.endsWith('.peaks.json'));
  assert.equal(after.length, before.length, 'one waveform per source file, the old one was replaced');
  const none = await waveformFor(proj, M('broll.mp4'), { per: 0.05 });
  assert.deepEqual([none.hasAudio, none.peaks.length], [false, 0]);
  await assert.rejects(waveformFor(proj, 'assets/photo.jpg'), /picture/);
});

// ------------------------------------------------------------------------------------------------ the server

test('server: proxy and waveform routes, and the proxy is served in ranges and nothing else of .proxies is', { timeout: 180000 }, async () => {
  const doc = {
    schema: 'nordle.doc/0.1', id: 'prox', title: 'prox', kind: 'video', brand: 'little-gannet', sizes: [{ id: 'tiny', w: 360, h: 640 }],
    sources: [
      { id: 'talk', type: 'video', path: M('talk.mp4'), duration: 12, transcript: M('talk.words.json') },
      { id: 'stripes', type: 'video', path: M('stripes.mp4'), duration: 4 },
      { id: 'tone', type: 'audio', path: M('tone.wav'), duration: 4 },
      { id: 'photo', type: 'image', path: 'assets/photo.jpg' },
      { id: 'broken', type: 'video', path: M('bad.mp4') },
    ],
    timeline: { fps: 30, duration: 3, tracks: [{ id: 'v1', type: 'video', clips: [{ id: 'a', source: 'talk', in: 0, out: 3, at: 0 }] }] },
  };
  mkdirSync(join(proj, 'docs'), { recursive: true });
  writeFileSync(join(proj, 'docs', 'prox.json'), JSON.stringify(doc));
  const TOKEN = 'proxy-test-token-0123456789abcdef012';
  const AGENT = 'proxy-test-agent-0123456789abcdef0123';
  const app = createNordleServer({ roots: [projectsDir], token: TOKEN, agentToken: AGENT });
  const port = await app.listen(0);
  const origin = `http://127.0.0.1:${port}`;
  const get = (u, init) => retryReset(() => fetch(u, init));
  const call = async (path, method = 'GET', body) => {
    const res = await get(`${origin}/api${path}`, { method, headers: { 'x-nordle-token': AGENT, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  };
  const id = 'little-gannet';
  const v = `/projects/${id}/video`;
  try {
    // (an earlier test made this proxy: take it away so that the first ask finds nothing)
    const had = proxyFor(proj, M('stripes.mp4'));
    if (had) rmSync(had);
    // not made yet: says so, without starting anything
    const before = await call(`${v}/proxy?doc=prox&source=stripes`);
    assert.equal(before.status, 200);
    assert.deepEqual([before.json.ready, before.json.progress, before.json.url], [false, 0, undefined]);
    // start it by source id and wait for the job
    const started = await call(`${v}/proxy`, 'POST', { doc: 'prox', source: 'stripes' });
    assert.ok(started.status === 202 || started.status === 200);
    let status = started.json;
    assert.equal(status.ready, false);
    assert.equal(status.job.kind, 'proxy');
    const again = await call(`${v}/proxy`, 'POST', { doc: 'prox', source: 'stripes' });
    if (again.status === 202) assert.equal(again.json.job.id, status.job.id, 'asking twice does not start two jobs');
    let job = status.job;
    for (let i = 0; i < 12 && job.status === 'running'; i++) job = (await call(`${v}/jobs/${job.id}?wait=10`)).json.job;
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.percent, 100); assert.equal(job.result.ready, true);
    assert.deepEqual((await call(`${v}/jobs?kind=proxy`)).json.jobs.map((j) => j.id), [job.id]);
    assert.deepEqual((await call(`${v}/jobs?kind=render`)).json.jobs, []);
    status = (await call(`${v}/proxy?doc=prox&source=stripes`)).json;
    assert.equal(status.ready, true); assert.equal(status.progress, 100);
    assert.match(status.url, /^\/p\/little-gannet\/\.proxies\/[0-9a-f]{40}\.mp4$/);
    assert.equal(job.result.url, status.url);
    // ready already: answered straight away
    const ready = await call(`${v}/proxy`, 'POST', { doc: 'prox', source: 'stripes' });
    assert.equal(ready.status, 200); assert.equal(ready.json.url, status.url);
    // the same thing by path, without a document
    const byPath = await call(`${v}/proxy?source=${encodeURIComponent(M('stripes.mp4'))}`);
    assert.equal(byPath.json.url, status.url);

    // served in ranges
    const url = `${origin}${status.url}`;
    const file = proxyFor(proj, M('stripes.mp4'));
    const size = statSync(file).size;
    const whole = await get(url);
    assert.equal(whole.status, 200); assert.equal(whole.headers.get('content-type'), 'video/mp4'); assert.equal(whole.headers.get('accept-ranges'), 'bytes');
    assert.match(whole.headers.get('content-security-policy'), /sandbox/); assert.equal(whole.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await whole.arrayBuffer()).byteLength, size);
    const part = await get(url, { headers: { range: 'bytes=100-199' } });
    assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), `bytes 100-199/${size}`); assert.equal((await part.arrayBuffer()).byteLength, 100);
    const tail = await get(url, { headers: { range: 'bytes=-50' } });
    assert.equal(tail.status, 206); assert.equal((await tail.arrayBuffer()).byteLength, 50);
    assert.equal((await get(url, { headers: { range: `bytes=${size + 5}-` } })).status, 416);
    assert.equal((await get(url, { method: 'HEAD' })).status, 200);
    // nothing else of the folder is reachable
    const key = status.url.split('/').at(-1).slice(0, 40);
    const hidden = [
      `/p/${id}/.proxies/${key}.json`, `/p/${id}/.proxies/${key}.mp4.part`, `/p/${id}/.proxies/${key}.peaks.json`, `/p/${id}/.proxies/`, `/p/${id}/.proxies`,
      `/p/${id}/.proxies/${'0'.repeat(40)}.mp4`, `/p/${id}/.proxies/stripes.mp4`, `/p/${id}/.proxies/${key}.MP4.txt`,
      `/p/${id}/.proxies/../../package.json`, `/p/${id}/.proxies/%2e%2e/%2e%2e/package.json`, `/p/${id}/.proxies/..%5cbrand.json`, `/p/${id}/.proxies/%2e%2e%5cbrand.json`, `/p/${id}/.proxies%5c${key}.mp4`, `/p/${id}/%2eproxies/${key}.mp4%2f..%2f..%2fbrand.json`,
      `/p/${id}/.proxies/sub/${key}.mp4`, `/p/${id}/.proxies//${key}.mp4`, `/p/${id}/.nordle/runtime.json`, `/p/${id}/.hidden`,
    ];
    // sent exactly as written: fetch() would tidy a %2e%2e into a real .. before it left (and so ask for a different file)
    const raw = (path) => retryReset(() => new Promise((resolve, reject) => { http.get({ host: '127.0.0.1', port, path }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', reject); }));
    for (const path of hidden) assert.equal(await raw(path), 404, path);
    assert.equal(await raw(`/p/${id}/.proxies/${key}.mp4`), 200, 'the proxy itself, asked for the same way');
    assert.equal((await get(`${origin}/p/${id}/brand.json`)).status, 200, 'ordinary project files are still served');
    assert.equal((await get(`${origin}/p/${id}/history/prox.jsonl`)).status, 404);
    assert.equal((await get(`${origin}/p/${id}/review/prox.json`)).status, 404);

    // waveform: by source id, with the speech from the transcript
    const w = await call(`${v}/waveform?doc=prox&source=talk&per=0.05`);
    assert.equal(w.status, 200);
    assert.equal(w.json.per, 0.05); assert.equal(w.json.peaks.length, 240); assert.ok(Math.abs(w.json.duration - 12) < 0.02);
    assert.ok(w.json.peaks[11] > 0.4 && w.json.peaks[5] < 0.05, 'silence, then the first word at 0.5 s');
    assert.deepEqual(w.json.speech, [{ start: 0.5, end: 8.85 }], 'seventeen words 0.15 s apart read as one stretch');
    const tone = await call(`${v}/waveform?doc=prox&source=tone`);
    assert.equal(tone.json.peaks.length, 80); assert.equal(tone.json.speech, undefined);
    const byPathWave = await call(`${v}/waveform?source=${encodeURIComponent(M('tone.wav'))}&per=0.1`);
    assert.equal(byPathWave.json.peaks.length, 40);
    assert.equal((await call(`${v}/waveform?doc=prox&source=talk&per=abc`)).status, 400);
    assert.equal((await call(`${v}/waveform?doc=prox&source=talk&per=0`)).status, 400);

    // refusals
    assert.equal((await call(`${v}/proxy`, 'POST', { source: 'talk' })).status, 400, 'an id needs its document');
    const noSource = await call(`${v}/proxy`, 'POST', { doc: 'prox', source: 'nope' });
    assert.equal(noSource.status, 404); assert.match(noSource.json.errors[0].message, /no source "nope" in "prox"/);
    assert.equal((await call(`${v}/proxy`, 'POST', { doc: 'nodoc', source: 'talk' })).status, 404);
    assert.equal((await call(`${v}/proxy`, 'POST', {})).status, 400);
    for (const bad of ['mount:footage/../secret.mp4', '../x.mp4', 'C:/Windows/x.mp4', '/etc/passwd', 'mount:ghost/x.mp4', 'mount:footage/nothing.mp4']) {
      assert.equal((await call(`${v}/proxy`, 'POST', { source: bad })).status, 422, `POST ${bad}`);
      assert.equal((await call(`${v}/proxy?source=${encodeURIComponent(bad)}`)).status, 422, `GET ${bad}`);
      assert.equal((await call(`${v}/waveform?source=${encodeURIComponent(bad)}`)).status, 422, `waveform ${bad}`);
    }
    const pic = await call(`${v}/proxy`, 'POST', { doc: 'prox', source: 'photo' });
    assert.equal(pic.status, 422); assert.match(pic.json.errors[0].message, /picture/);
    assert.equal((await call(`${v}/waveform?doc=prox&source=photo`)).status, 422);
    // the token is needed, and the writes must be JSON
    const noToken = await get(`${origin}/api${v}/proxy?doc=prox&source=talk`);
    assert.equal(noToken.status, 401);
    assert.equal((await get(`${origin}/api${v}/waveform?doc=prox&source=talk`)).status, 401);
    const notJson = await get(`${origin}/api${v}/proxy`, { method: 'POST', headers: { 'x-nordle-token': AGENT, 'content-type': 'text/plain' }, body: '{"doc":"prox","source":"talk"}' });
    assert.equal(notJson.status, 415);

    // a file that cannot be read: the job fails and the status says why
    const bad = await call(`${v}/proxy`, 'POST', { doc: 'prox', source: 'broken' });
    assert.equal(bad.status, 202);
    let badJob = bad.json.job;
    for (let i = 0; i < 12 && badJob.status === 'running'; i++) badJob = (await call(`${v}/jobs/${badJob.id}?wait=10`)).json.job;
    assert.equal(badJob.status, 'failed');
    const badStatus = (await call(`${v}/proxy?doc=prox&source=broken`)).json;
    assert.equal(badStatus.ready, false); assert.ok(badStatus.error);
    assert.equal(readdirSync(proxies).filter((n) => n.endsWith('.part')).length, 0);
  } finally { await app.close(); }
});

test('CLI: video proxy makes the proxies of a document\'s footage, and says which one could not be made', { timeout: 150000 }, () => {
  const file = join(proj, 'docs', 'prox.json');
  const cli = (...args) => spawnSync(process.execPath, [join(ROOT, 'nordle.mjs'), 'video', ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 140000 });
  const one = cli('proxy', file, '--source', 'stripes');
  assert.equal(one.status, 0, one.stdout + one.stderr);
  assert.match(one.stdout, /OK\s+stripes: (already made|made)\s+960x540/);
  const all = cli('proxy', file);
  assert.equal(all.status, 1, 'one of the sources is not a video');
  assert.match(all.stdout, /OK\s+talk:/); assert.match(all.stdout, /OK\s+tone:/); assert.match(all.stdout, /FAIL\s+broken:/);
  assert.doesNotMatch(all.stdout, /photo/, 'a picture needs no proxy');
  const picture = cli('proxy', file, '--source', 'photo');
  assert.equal(picture.status, 2);
  assert.match(picture.stderr, /no video or audio source "photo"/);
});
