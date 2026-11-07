/**
 * Synthetic-image harness for `src/engine/fastCore.ts`, plus a tiny hand-rolled
 * PNG encoder so the script can dump visual results without any dependency.
 *
 * The test script (`scripts/test-engine.mjs`) imports from here; the file
 * itself is not part of the bundle.
 */
import { deflateSync } from 'node:zlib';

/** Deterministic PRNG (xorshift32). */
export function rng(seed = 1) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** Approximate gaussian noise via Box–Muller. */
function gauss(rnd) {
  const u = Math.max(1e-9, rnd());
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function createImage(width, height, fill = [255, 255, 255, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = fill[3];
  }
  return { data, width, height };
}

function setPx(img, x, y, r, g, b, a = 255, blend = false) {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  const o = (y * img.width + x) * 4;
  if (!blend) {
    img.data[o] = r;
    img.data[o + 1] = g;
    img.data[o + 2] = b;
    img.data[o + 3] = a;
    return;
  }
  const t = a / 255;
  img.data[o] = img.data[o] * (1 - t) + r * t;
  img.data[o + 1] = img.data[o + 1] * (1 - t) + g * t;
  img.data[o + 2] = img.data[o + 2] * (1 - t) + b * t;
}

export function getAlpha(img, x, y) {
  return img.data[(y * img.width + x) * 4 + 3];
}

export function getPixel(img, x, y) {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
}

/**
 * Case 1 — solid light-grey studio background + red anti-aliased circle.
 * The classic "product photo on white" case.
 */
export function solidBgWithCircle(width = 320, height = 240, bg = [238, 238, 240]) {
  const img = createImage(width, height, [...bg, 255]);
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) * 0.3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      // 1.5 px anti-aliased edge
      const cov = Math.max(0, Math.min(1, r + 0.75 - d));
      if (cov > 0) {
        const o = (y * width + x) * 4;
        img.data[o] = img.data[o] * (1 - cov) + 210 * cov;
        img.data[o + 1] = img.data[o + 1] * (1 - cov) + 30 * cov;
        img.data[o + 2] = img.data[o + 2] * (1 - cov) + 40 * cov;
      }
    }
  }
  return img;
}

/**
 * Case 2 — vertical gradient background (top dark blue → bottom light blue)
 * + skin-tone ellipse (portrait-ish).
 */
export function gradientBgWithEllipse(width = 320, height = 240, noise = 0) {
  const img = createImage(width, height);
  const rnd = rng(7);
  for (let y = 0; y < height; y++) {
    const t = y / (height - 1);
    const r = Math.round(30 + (120 - 30) * t);
    const g = Math.round(60 + (190 - 60) * t);
    const b = Math.round(140 + (230 - 140) * t);
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const n = noise ? gauss(rnd) * noise : 0;
      img.data[o] = r + n;
      img.data[o + 1] = g + n;
      img.data[o + 2] = b + n;
      img.data[o + 3] = 255;
    }
  }
  const cx = width / 2;
  const cy = height / 2;
  const rx = width * 0.22;
  const ry = height * 0.36;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = (x + 0.5 - cx) / rx;
      const ny = (y + 0.5 - cy) / ry;
      const d = Math.sqrt(nx * nx + ny * ny);
      const cov = Math.max(0, Math.min(1, (1 - d) * Math.min(rx, ry) + 0.5));
      if (cov > 0) {
        const o = (y * width + x) * 4;
        img.data[o] = img.data[o] * (1 - cov) + 232 * cov;
        img.data[o + 1] = img.data[o + 1] * (1 - cov) + 186 * cov;
        img.data[o + 2] = img.data[o + 2] * (1 - cov) + 156 * cov;
      }
    }
  }
  return img;
}

/**
 * Case 3 — noisy "JPEG-ish" background: blocky 8×8 DCT-like noise with
 * strong per-block bias + mild multiplicative grain (mimics compression
 * artefacts around a subject).
 */
export function noisyBgWithCircle(width = 320, height = 240, sigma = 9) {
  const img = createImage(width, height);
  const rnd = rng(12345);
  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      const blockBias = (rnd() - 0.5) * sigma * 1.6;
      for (let y = by; y < Math.min(height, by + 8); y++) {
        for (let x = bx; x < Math.min(width, bx + 8); x++) {
          const o = (y * width + x) * 4;
          // low-frequency wobble + grain
          const wobble = Math.sin(x * 0.02) * 3 + Math.cos(y * 0.017) * 3;
          const n = gauss(rnd) * sigma;
          img.data[o] = 205 + wobble + blockBias + n;
          img.data[o + 1] = 206 + wobble + blockBias + n;
          img.data[o + 2] = 210 + wobble + blockBias + n;
          img.data[o + 3] = 255;
        }
      }
    }
  }
  const cx = width / 2;
  const cy = height / 2;
  const r = Math.min(width, height) * 0.3;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cov = Math.max(0, Math.min(1, r + 0.75 - d));
      if (cov > 0) {
        const o = (y * width + x) * 4;
        img.data[o] = img.data[o] * (1 - cov) + 200 * cov;
        img.data[o + 1] = img.data[o + 1] * (1 - cov) + 40 * cov;
        img.data[o + 2] = img.data[o + 2] * (1 - cov) + 60 * cov;
      }
    }
  }
  return img;
}

/**
 * Case 4 — subject with an ENCLOSED background hole (a "donut" / mug handle).
 * Documented behaviour: a hole whose colour matches the background model and
 * whose area ≥ 0.15% of the image IS made transparent; smaller or colour-drifted
 * holes stay opaque.
 */
export function enclosedHole(width = 320, height = 240, holeRadius = 30) {
  const img = solidBgWithCircle(width, height);
  const cx = width / 2;
  const cy = height / 2;
  // punch a hole (background colour) back into the circle
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d < holeRadius) {
        const o = (y * width + x) * 4;
        img.data[o] = 238;
        img.data[o + 1] = 238;
        img.data[o + 2] = 240;
      }
    }
  }
  return img;
}

/** Case 5 — foreground touches the border (subject cropped by the frame). */
export function subjectTouchingBorder(width = 320, height = 240) {
  const img = createImage(width, height, [244, 244, 246, 255]);
  // a large rect that runs off the bottom edge
  for (let y = Math.floor(height * 0.45); y < height; y++) {
    for (let x = Math.floor(width * 0.25); x < Math.floor(width * 0.75); x++) {
      const o = (y * width + x) * 4;
      img.data[o] = 40;
      img.data[o + 1] = 60;
      img.data[o + 2] = 120;
    }
  }
  return img;
}

/** JPEG-like tint: multiply-blend a warm-ish cast over the whole image. */
export function warmCast(img) {
  const out = { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  for (let o = 0; o < out.data.length; o += 4) {
    out.data[o] = out.data[o] * 1.02;
    out.data[o + 1] = out.data[o + 1] * 0.995;
    out.data[o + 2] = out.data[o + 2] * 0.97;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Minimal PNG encoder (RGBA8)                                                */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** Encode an RGBA image buffer (or plain {data,width,height}) as PNG bytes. */
export function encodePng({ data, width, height }) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(data.buffer, data.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Composite an RGBA image over a checkerboard so alpha is visible. */
export function checkerboard(img, cell = 8) {
  const out = { data: new Uint8ClampedArray(img.data.length), width: img.width, height: img.height };
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const o = (y * img.width + x) * 4;
      const dark = ((x / cell) | 0) % 2 === ((y / cell) | 0) % 2;
      const bg = dark ? 200 : 235;
      const a = img.data[o + 3] / 255;
      out.data[o] = img.data[o] * a + bg * (1 - a);
      out.data[o + 1] = img.data[o + 1] * a + bg * (1 - a);
      out.data[o + 2] = img.data[o + 2] * a + bg * (1 - a);
      out.data[o + 3] = 255;
    }
  }
  return out;
}
