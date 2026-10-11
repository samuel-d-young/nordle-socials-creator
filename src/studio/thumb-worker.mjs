// Runs in a worker thread: decodes a PNG and averages it down to a small width, so the server's main thread never does it.
import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { PNG } from 'pngjs';

/** Area-weighted (box) downscale of an RGBA bitmap to a new width, keeping the aspect ratio. */
export function shrink(src, width) {
  const w = Math.max(1, Math.min(width, src.width));
  const h = Math.max(1, Math.round((src.height * w) / src.width));
  const out = new PNG({ width: w, height: h });
  const kx = src.width / w, ky = src.height / h;
  const sd = src.data, od = out.data;
  for (let y = 0; y < h; y++) {
    const y0 = y * ky, y1 = Math.min(src.height, (y + 1) * ky);
    for (let x = 0; x < w; x++) {
      const x0 = x * kx, x1 = Math.min(src.width, (x + 1) * kx);
      let r = 0, g = 0, b = 0, a = 0, wsum = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const wt = wy * (Math.min(sx + 1, x1) - Math.max(sx, x0));
          const i = (sy * src.width + sx) * 4;
          const al = sd[i + 3] * wt;
          r += sd[i] * al; g += sd[i + 1] * al; b += sd[i + 2] * al; a += al; wsum += wt;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) { od[o] = Math.round(r / a); od[o + 1] = Math.round(g / a); od[o + 2] = Math.round(b / a); od[o + 3] = Math.round(a / wsum); }
    }
  }
  return out;
}

if (parentPort) {
  parentPort.on('message', ({ id, file, w }) => {
    try {
      const png = shrink(PNG.sync.read(readFileSync(file)), w);
      const buf = PNG.sync.write(png, { deflateLevel: 4 });
      parentPort.postMessage({ id, bytes: new Uint8Array(buf) });
    } catch (e) {
      parentPort.postMessage({ id, error: String(e?.message ?? e) });
    }
  });
}
