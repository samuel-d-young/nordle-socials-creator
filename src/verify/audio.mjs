// Sound checks for a video: loudness and peak of the finished file (target -14 LUFS, no clipping), and that music gives way to speech.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { decodeAudio, ffmpegPath, levelDb, run } from './ff.mjs';
import { error, info, warn } from './findings.mjs';
import { buildTimeline } from './timeline.mjs';

export const TARGET_LUFS = -14;
export const LUFS_TOLERANCE = 1.5;
export const PEAK_WARN = -1.0; // dBTP
export const PEAK_CLIP = -0.1;

/** The newest rendered video for a document: out/<id>.mp4, out/<id>/<id>.mp4 or any mp4 in out/<id>/. */
export function renderedVideo(projectDir, docId) {
  const cands = [join(projectDir, 'out', `${docId}.mp4`), join(projectDir, 'out', docId, `${docId}.mp4`)];
  const dir = join(projectDir, 'out', docId);
  if (existsSync(dir)) for (const f of readdirSync(dir)) if (/\.(mp4|mov)$/i.test(f)) cands.push(join(dir, f));
  const have = cands.filter((f) => existsSync(f));
  return have.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] ?? null;
}

/** Integrated loudness (LUFS), loudness range (LU) and true peak (dBTP) of a file's audio. null if it cannot be measured. */
export function measureLoudness(file) {
  const ff = ffmpegPath();
  if (!ff || !file || !existsSync(file)) return null;
  const r = run(ff, ['-nostdin', '-hide_banner', '-i', file, '-vn', '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { encoding: 'utf8', timeout: 300000 });
  const text = `${r.stderr ?? ''}`;
  const tail = text.slice(text.lastIndexOf('Summary:'));
  const num = (re) => { const m = re.exec(tail); return m ? Number(m[1]) : null; };
  const integrated = num(/I:\s+(-?[\d.]+|-inf)\s+LUFS/);
  if (integrated === null || r.error) return null;
  const peakM = /Peak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(tail);
  return { integrated, lra: num(/LRA:\s+([\d.]+)\s+LU/), truePeak: peakM && peakM[1] !== '-inf' ? Number(peakM[1]) : -120 };
}

/** Level of the finished mix while someone speaks and while only music plays, in dB (relative). */
export function speechVersusMusic(file, timeline) {
  if (!timeline) return null;
  const audio = decodeAudio(file, { sampleRate: 16000 });
  if (!audio) return null;
  const speech = timeline.clips.filter((c) => c.audible && c.words.length).flatMap((c) => c.words.map((w) => [w.tlStart, w.tlEnd]));
  const music = timeline.clips.filter((c) => c.trackType === 'audio' && c.audible);
  if (!speech.length || !music.length) return null;
  const spoken = (a, b) => speech.some(([s, e]) => e > a && s < b);
  const near = (a, b) => speech.some(([s, e]) => e > a - 0.25 && s < b + 0.25);
  const playing = (a, b) => music.some((c) => c.tlEnd > a && c.tlStart < b);
  const inSpeech = [];
  const inGap = [];
  const step = 0.2;
  for (let t = 0; t + 0.4 <= timeline.duration; t += step) {
    if (!playing(t, t + 0.4)) continue;
    const l = levelDb(audio, t, t + 0.4);
    if (l === null || l < -90) continue;
    if (spoken(t, t + 0.4)) inSpeech.push(l);
    else if (!near(t, t + 0.4)) inGap.push(l);
  }
  const mean = (a) => (a.length ? 10 * Math.log10(a.reduce((s, x) => s + 10 ** (x / 10), 0) / a.length) : null);
  if (inSpeech.length < 3 || inGap.length < 3) return null;
  return { speechDb: mean(inSpeech), gapDb: mean(inGap), speechWindows: inSpeech.length, gapWindows: inGap.length };
}

/**
 * @returns {{findings:object[], measured:object|null, skipped?:string}}
 */
export function checkAudio(doc, { projectDir, file = renderedVideo(projectDir, doc.id), timeline = buildTimeline(doc, projectDir, { transcripts: true }) } = {}) {
  const findings = [];
  if (doc.kind !== 'video' || !timeline) return { findings, measured: null, skipped: 'This is not a video.' };

  // in the timeline: music that plays over speech must duck under it
  const speakers = timeline.clips.filter((c) => c.audible && c.words.length);
  for (const m of timeline.clips.filter((c) => c.trackType === 'audio' && c.audible)) {
    const over = speakers.filter((s) => s.words.some((w) => w.tlEnd > m.tlStart && w.tlStart < m.tlEnd));
    if (!over.length) continue;
    const gain = m.gainDb ?? 0;
    const duck = m.duck?.amountDb ?? 0;
    const under = gain + duck;
    if (!m.duck && gain > -20) {
      findings.push(error('music-not-ducked', `The music "${m.id}" plays over speech at ${gain} dB and does not duck under it, so the voice will be hard to hear.`, {
        time: m.tlStart, fix: `Add "duck": { "under": "${over[0].trackId}", "amountDb": -12, "attack": 0.1, "release": 0.4 } to clip "${m.id}", or lower its gainDb to -26 or below.`,
      }));
    } else if (m.duck && duck > -6 && gain > -20) {
      findings.push(warn('music-duck-shallow', `The music "${m.id}" ducks only ${Math.abs(duck)} dB under speech (to ${under} dB). Voice-over usually needs 9 to 15 dB.`, { time: m.tlStart, fix: `Set duck.amountDb to -12 on clip "${m.id}".` }));
    } else if (m.duck && !timeline.tracks.some((t) => t.id === m.duck.under && t.clips.some((c) => over.some((s) => s.id === c.id)))) {
      findings.push(warn('music-ducks-wrong-track', `The music "${m.id}" ducks under track "${m.duck.under}", but the speech is on ${[...new Set(over.map((s) => `"${s.trackId}"`))].join(', ')}, so it will not duck when someone talks.`, { time: m.tlStart, fix: `Set duck.under to "${over[0].trackId}".` }));
    }
  }
  const hasSpeech = speakers.length > 0;

  if (!file) {
    return { findings, measured: null, skipped: `There is no rendered video yet (looked for out/${doc.id}.mp4), so loudness and peaks could not be measured.` };
  }
  const loud = measureLoudness(file);
  if (!loud) {
    findings.push(warn('audio-unmeasured', `The sound of ${file} could not be measured (is ffmpeg installed, and does the file have sound?).`, { fix: 'Install ffmpeg or render the video again.' }));
    return { findings, measured: null };
  }
  const measured = { file, ...loud };
  const off = loud.integrated - TARGET_LUFS;
  if (loud.integrated < -60) findings.push(error('audio-silent', 'The rendered video is silent.', { fix: 'Check that the clips and music are not muted, then render again.' }));
  else if (Math.abs(off) > LUFS_TOLERANCE) {
    findings.push(error('loudness-off-target', `The video measures ${loud.integrated.toFixed(1)} LUFS; the target is ${TARGET_LUFS} LUFS \u00B1${LUFS_TOLERANCE}. It will play ${off < 0 ? 'quieter' : 'louder'} than other posts.`, {
      fix: `${off < 0 ? 'Raise' : 'Lower'} the master level by ${Math.abs(off).toFixed(1)} dB (or normalise the mix to ${TARGET_LUFS} LUFS) and render again.`,
    }));
  }
  if (loud.truePeak > PEAK_CLIP) findings.push(error('clipping', `The loudest moment reaches ${loud.truePeak.toFixed(1)} dBTP, which is clipping.`, { fix: 'Lower the master level or the loudest clip until the peak is -1 dBTP or lower, then render again.' }));
  else if (loud.truePeak > PEAK_WARN) findings.push(warn('peak-hot', `The loudest moment reaches ${loud.truePeak.toFixed(1)} dBTP, close to clipping (the ceiling is ${PEAK_WARN} dBTP).`, { fix: 'Lower the master level by 1 dB.' }));
  if (hasSpeech) {
    const sv = speechVersusMusic(file, timeline);
    if (sv) {
      measured.speechDb = Math.round(sv.speechDb * 10) / 10;
      measured.gapDb = Math.round(sv.gapDb * 10) / 10;
      if (sv.speechDb - sv.gapDb < 1) {
        findings.push(warn('music-masks-speech', `While someone speaks the mix is ${sv.speechDb.toFixed(1)} dB and in the pauses with only music it is ${sv.gapDb.toFixed(1)} dB, so the music is about as loud as the voice.`, { fix: 'Lower the music (gainDb) or deepen its duck so the voice is clearly above it.' }));
      } else findings.push(info('ducking-ok', `The voice sits ${(sv.speechDb - sv.gapDb).toFixed(1)} dB above the music-only pauses.`));
    }
  }
  findings.push(info('loudness', `Measured ${loud.integrated.toFixed(1)} LUFS, loudness range ${loud.lra ?? '?'} LU, true peak ${loud.truePeak.toFixed(1)} dBTP.`));
  return { findings, measured };
}
