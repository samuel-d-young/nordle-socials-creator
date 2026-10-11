// Drawing a waveform into a canvas: the peaks of the part of the source a clip plays, one column per pixel. Speech (the stretches
// the transcript covers) is drawn in the speaker tint, everything else in the plain one.

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{peaks:number[], per:number, speech?:{start:number,end:number}[]}} wave  what the waveform route answered
 * @param {{from:number, to:number, w:number, h:number, base?:boolean, colours:{wave:string, speech:string}}} o
 *   from/to: the source seconds the clip plays; w/h: the canvas size in pixels; base: bars grow from the bottom edge
 */
export function drawWave(canvas, wave, { from, to, w, h, base = false, colours }) {
  const width = Math.max(1, Math.min(24000, Math.round(w)));
  const height = Math.max(1, Math.round(h));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  const { peaks, per, speech = [] } = wave;
  if (!peaks?.length || !(to > from)) return;
  const span = to - from;
  let si = 0; // speech ranges are sorted: walk through them as x grows
  for (let x = 0; x < width; x++) {
    const t0 = from + (x / width) * span;
    const t1 = from + ((x + 1) / width) * span;
    const a = Math.max(0, Math.floor(t0 / per));
    const b = Math.min(peaks.length, Math.max(a + 1, Math.ceil(t1 / per)));
    let m = 0;
    for (let i = a; i < b; i++) if (peaks[i] > m) m = peaks[i];
    const mid = (t0 + t1) / 2;
    while (si < speech.length && speech[si].end < mid) si++;
    const talking = si < speech.length && speech[si].start <= mid;
    ctx.fillStyle = talking ? colours.speech : colours.wave;
    const bar = Math.max(1, Math.round(Math.sqrt(clamp01(m)) * height * (base ? 0.95 : 0.9)));
    if (base) ctx.fillRect(x, height - bar, 1, bar);
    else ctx.fillRect(x, Math.round((height - bar) / 2), 1, bar);
  }
}

/** The two tints, read from the page's colours so light and dark both work. */
export function waveColours(el) {
  const cs = getComputedStyle(el);
  const pick = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return { wave: pick('--vt-wave', '#7d8a96'), speech: pick('--vt-wave-speech', '#17674a') };
}
