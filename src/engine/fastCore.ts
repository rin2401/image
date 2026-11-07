/**
 * Pure, dependency-free core of the "fast" (non-AI) background remover.
 *
 * This module deliberately references **no** DOM / Worker / Canvas API so it can
 * be unit-tested in Node (`node --experimental-strip-types scripts/test-engine.mjs`)
 * and reused verbatim inside a module Worker.
 *
 * Pipeline
 * --------
 *  1. `fitBackgroundModel`  – sample the image border, learn a robust background
 *                             model: weighted mean colour (median-based, so an
 *                             object touching the border cannot drag it) plus a
 *                             low-order least-squares colour ramp so smooth
 *                             studio gradients are modelled, not just flats.
 *  2. `growBackground`      – BFS / scanline flood-fill from the border uses the
 *                             model (OkLab ΔE, locally adaptive) with hysteresis
 *                             so anti-aliased edges are cut crisply instead of
 *                             leaving halo rings.
 *  3. `fillEnclosedBackground` – holes fully enclosed by the subject (e.g. the
 *                             gap inside a mug handle) are classified as
 *                             background too, but only when confidently close to
 *                             the background model.
 *  4. `despeckleAlpha`      – removes/absorbs isolated islands (counts, dust,
 *                             JPEG noise) sized relative to the image.
 *  5. `featherAlpha`        – anti-aliases the alpha edge (box blur ≈ gaussian),
 *                             keeping interior 255 and exterior 0.
 *  6. `decontaminateEdge`   – un-premultiplies near-transparent edge pixels
 *                             toward their foreground colour so the classic
 *                             "white halo" of matting is gone.
 *
 * Everything works on RGBA `Uint8ClampedArray` buffers and plain numbers, i.e.
 * no allocation-heavy objects in the hot loops.
 */

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

/** Tuning knobs of the fast algorithm. All values are normalised to 0..1. */
export interface FastOptions {
  /** How different a pixel may look from the background model and still be
   *  removed. 0 = only exact colour match, 1 = very permissive. Default 0.6. */
  tolerance: number;
  /** Width of the anti-aliasing / edge-softening pass. 0 = hard edge,
   *  1 = very soft. Default 0.25. */
  feather: number;
  /** Strength of the isolated-island clean-up. 0 = keep every speck,
   *  1 = aggressively absorb small blobs into their surroundings. Default 0.5. */
  despeckle: number;
}

export const DEFAULT_FAST_OPTIONS: FastOptions = Object.freeze({
  tolerance: 0.6,
  feather: 0.25,
  despeckle: 0.5,
});

/** RGBA image, row-major, 4 bytes per pixel. */
export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Result of `removeBackgroundFastCore`. */
export interface FastResult {
  /** Premultiplied-safe RGBA pixels with the background made transparent. */
  data: Uint8ClampedArray;
  width: number;
  height: number;
  /** 0..1 confidence that a usable flat/gradient background model was found.
   *  Low values mean "the border is busy" — callers should prefer AI. */
  confidence: number;
}

/* -------------------------------------------------------------------------- */
/* Colour spaces                                                              */
/* -------------------------------------------------------------------------- */

/** sRGB 0..255 → linear 0..1 lookup table (exact for 8-bit inputs). */
const SRGB_TO_LINEAR = (() => {
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    lut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  return lut;
})();

/**
 * Convert one sRGB triple to OkLab. OkLab is perceptually uniform, which makes
 * a single ΔE threshold behave the same on dark, mid and bright backgrounds.
 * Writes into `out` to avoid allocating in hot loops.
 */
function rgbToOklab(r: number, g: number, b: number, out: Float32Array): void {
  const lr = SRGB_TO_LINEAR[r & 255];
  const lg = SRGB_TO_LINEAR[g & 255];
  const lb = SRGB_TO_LINEAR[b & 255];

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  out[0] = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  out[1] = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  out[2] = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
}

/* -------------------------------------------------------------------------- */
/* Small numeric helpers                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Clamp to 0..1, treating anything non-finite as "not provided".
 *
 * NaN must not survive: the UI reads slider values from `localStorage`, so a
 * corrupted entry (`"abc"` → `NaN`) would otherwise turn every threshold NaN and
 * silently blank the image instead of failing loudly.
 */
function clamp01(v: number): number {
  if (!Number.isFinite(v)) return Number.NaN;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** Seeded xorshift32 PRNG so results are deterministic between runs/threads. */
function makeRng(seed: number): () => number {
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

/** k-th smallest element of `values[0..n)` using quickselect (in place). */
function quickselect(values: Float32Array | Float64Array, n: number, k: number): number {
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const pivot = values[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (values[i] < pivot) i++;
      while (values[j] > pivot) j--;
      if (i <= j) {
        const t = values[i];
        values[i] = values[j];
        values[j] = t;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else break;
  }
  return values[k];
}

/* -------------------------------------------------------------------------- */
/* 1. Background model                                                        */
/* -------------------------------------------------------------------------- */

/** Weighted least-squares colour ramp over the image. */
export interface BackgroundModel {
  width: number;
  height: number;
  /** Mean background colour, sRGB 0..255 (fallback / flat model). */
  mean: [number, number, number];
  /** OkLab coordinates of `mean`. */
  meanLab: [number, number, number];
  /** Linear ramp coefficients in normalised (-1..1) image coordinates.
   *  Spatially varying: R = a + b*x + c*y in sRGB space. */
  ramp: {
    r: [number, number, number];
    g: [number, number, number];
    b: [number, number, number];
  } | null;
  /** Residual noise scale in OkLab units (how "clean" the border is). */
  noise: number;
  /** How much of the border actually matched the model (0..1). */
  confidence: number;
  /** Border coverage: fraction of the perimeter ring that is background-like. */
  coverage: number;
}

const BORDER_RING = 3;

/**
 * Sample the image border and fit a background colour model.
 *
 * Robustness: samples are taken from a `BORDER_RING`-px frame. A first median
 * pass rejects outliers (a subject touching the frame), then a weighted
 * least-squares plane fit captures gradients (studio backdrops, vignettes).
 */
export function fitBackgroundModel(image: RgbaImage): BackgroundModel {
  const { data, width, height } = image;
  const ring = Math.max(1, Math.min(BORDER_RING, Math.floor(Math.min(width, height) / 8) || 1));

  // ---- collect border samples (stride-limited for big images) -------------
  const maxSamples = 8192;
  const perim = 2 * (width + height) * ring;
  const stride = Math.max(1, Math.ceil(perim / maxSamples));
  const cap = Math.ceil(perim / stride) + 4;
  const sx = new Float32Array(cap);
  const sy = new Float32Array(cap);
  const sr = new Float32Array(cap);
  const sg = new Float32Array(cap);
  const sb = new Float32Array(cap);
  let count = 0;

  const pushSample = (x: number, y: number): void => {
    const o = (y * width + x) * 4;
    if (data[o + 3] === 0) return; // already-transparent pixels carry no info
    sx[count] = x;
    sy[count] = y;
    sr[count] = data[o];
    sg[count] = data[o + 1];
    sb[count] = data[o + 2];
    count++;
  };

  let k = 0;
  // top + bottom bands
  for (let y = 0; y < ring && y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (k++ % stride === 0) pushSample(x, y);
      if (k++ % stride === 0) pushSample(x, height - 1 - y);
    }
  }
  // left + right bands (skip the corners already visited)
  for (let x = 0; x < ring && x < width; x++) {
    for (let y = ring; y < height - ring; y++) {
      if (k++ % stride === 0) pushSample(x, y);
      if (k++ % stride === 0) pushSample(width - 1 - x, y);
    }
  }

  if (count === 0) {
    return {
      width,
      height,
      mean: [255, 255, 255],
      meanLab: [1, 0, 0],
      ramp: null,
      noise: 0.02,
      confidence: 0,
      coverage: 0,
    };
  }

  // ---- robust centre: median per channel ---------------------------------
  // Quickselect mutates, so each channel gets its own scratch copy.
  const n = count;
  const medR = quickselect(Float32Array.from(sr.subarray(0, n)), n, n >> 1);
  const medG = quickselect(Float32Array.from(sg.subarray(0, n)), n, n >> 1);
  const medB = quickselect(Float32Array.from(sb.subarray(0, n)), n, n >> 1);

  // Robust spread of the border (MAD) drives the inlier radius and noise floor.
  const dev = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const dr = sr[i] - medR;
    const dg = sg[i] - medG;
    const db = sb[i] - medB;
    dev[i] = Math.sqrt(dr * dr + dg * dg + db * db);
  }
  const mad = quickselect(dev, n, n >> 1);
  const inlierRadius = Math.max(10, 4 * mad + 8);

  // ---- weighted least squares plane fit on inliers ------------------------
  // fx, fy ∈ [-1, 1]; weights = Tukey-like taper so outlier corners (subject
  // poking into the frame) barely influence the gradient.
  let wsum = 0;
  let swx = 0;
  let swy = 0;
  let swxx = 0;
  let swxy = 0;
  let swyy = 0;
  const swc = [0, 0, 0];
  const swxc = [0, 0, 0];
  const swyc = [0, 0, 0];
  let inliers = 0;

  for (let i = 0; i < n; i++) {
    const d = dev[i];
    if (d > inlierRadius) continue;
    const w = 1 - (d / inlierRadius) * (d / inlierRadius);
    const fx = (sx[i] / (width - 1 || 1)) * 2 - 1;
    const fy = (sy[i] / (height - 1 || 1)) * 2 - 1;
    const cols = [sr[i], sg[i], sb[i]];
    wsum += w;
    swx += w * fx;
    swy += w * fy;
    swxx += w * fx * fx;
    swxy += w * fx * fy;
    swyy += w * fy * fy;
    for (let c = 0; c < 3; c++) {
      swc[c] += w * cols[c];
      swxc[c] += w * fx * cols[c];
      swyc[c] += w * fy * cols[c];
    }
    inliers++;
  }

  let mean: [number, number, number] = [medR, medG, medB];
  let ramp: BackgroundModel['ramp'] = null;

  if (wsum > 8) {
    // Solve for [a, b, c] in  a = A⁻¹ * rhs, shared 3x3 matrix for all channels.
    const m = [
      [wsum, swx, swy],
      [swx, swxx, swxy],
      [swy, swxy, swyy],
    ];
    const inv = invert3(m);
    const yVecs = [swc, swxc, swyc];
    if (inv) {
      const coefR: number[] = [];
      const coefG: number[] = [];
      const coefB: number[] = [];
      const coefs = [coefR, coefG, coefB];
      for (let c = 0; c < 3; c++) {
        for (let r = 0; r < 3; r++) {
          coefs[c][r] = inv[r][0] * yVecs[0][c] + inv[r][1] * yVecs[1][c] + inv[r][2] * yVecs[2][c];
        }
      }
      // Reject numerically-flat fits: float dust from a perfectly uniform
      // border would otherwise be "detected" as a gradient.
      const flat = (c: number[]): boolean => Math.abs(c[1]) < 1e-3 && Math.abs(c[2]) < 1e-3;
      if (!(flat(coefR) && flat(coefG) && flat(coefB))) {
        ramp = {
          r: [coefR[0], coefR[1], coefR[2]],
          g: [coefG[0], coefG[1], coefG[2]],
          b: [coefB[0], coefB[1], coefB[2]],
        };
      }
      mean = [coefR[0], coefG[0], coefB[0]];
    }
  }

  const meanLabArr = new Float32Array(3);
  rgbToOklab(
    Math.round(Math.min(255, Math.max(0, mean[0]))),
    Math.round(Math.min(255, Math.max(0, mean[1]))),
    Math.round(Math.min(255, Math.max(0, mean[2]))),
    meanLabArr,
  );

  // ---- residual noise + confidence --------------------------------------
  const lab = new Float32Array(3);
  const tmpLab = new Float32Array(3);
  const devs = new Float32Array(n);
  const rangeX = width - 1 || 1;
  const rangeY = height - 1 || 1;
  for (let i = 0; i < n; i++) {
    rgbToOklab(sr[i] | 0, sg[i] | 0, sb[i] | 0, lab);
    let ml = meanLabArr[0];
    let ma = meanLabArr[1];
    let mb = meanLabArr[2];
    if (ramp) {
      const fx = (sx[i] / rangeX) * 2 - 1;
      const fy = (sy[i] / rangeY) * 2 - 1;
      rgbToOklab(
        Math.round(Math.min(255, Math.max(0, ramp.r[0] + ramp.r[1] * fx + ramp.r[2] * fy))),
        Math.round(Math.min(255, Math.max(0, ramp.g[0] + ramp.g[1] * fx + ramp.g[2] * fy))),
        Math.round(Math.min(255, Math.max(0, ramp.b[0] + ramp.b[1] * fx + ramp.b[2] * fy))),
        tmpLab,
      );
      ml = tmpLab[0];
      ma = tmpLab[1];
      mb = tmpLab[2];
    }
    const dl = lab[0] - ml;
    const da = lab[1] - ma;
    const db = lab[2] - mb;
    devs[i] = Math.sqrt(dl * dl + da * da + db * db);
  }
  const noise = Math.max(0.004, quickselect(devs, n, Math.floor(n * 0.6)));
  let inlierFrac = 0;
  const inlierCut = Math.max(0.03, 3.2 * noise);
  for (let i = 0; i < n; i++) if (devs[i] <= inlierCut) inlierFrac++;
  const coverage = inlierFrac / n;

  // Confidence: a clean flat/gradient border scores ~1, a busy photo border
  // (foliage, pavement, crowd) scores low.
  const confidence = clamp01(coverage * 1.15) * (noise < 0.09 ? 1 : Math.max(0.15, 0.09 / noise));

  return {
    width,
    height,
    mean: [
      Math.min(255, Math.max(0, mean[0])),
      Math.min(255, Math.max(0, mean[1])),
      Math.min(255, Math.max(0, mean[2])),
    ],
    meanLab: [meanLabArr[0], meanLabArr[1], meanLabArr[2]],
    ramp,
    noise,
    confidence,
    coverage,
  };
}

function invert3(m: number[][]): number[][] | null {
  const [a, b, c] = m[0];
  const [d, e, f] = m[1];
  const [g, h, i] = m[2];
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-6) return null;
  const invDet = 1 / det;
  return [
    [A * invDet, (c * h - b * i) * invDet, (b * f - c * e) * invDet],
    [B * invDet, (a * i - c * g) * invDet, (c * d - a * f) * invDet],
    [C * invDet, (b * g - a * h) * invDet, (a * e - b * d) * invDet],
  ];
}

/**
 * Squared OkLab ΔE from the background model for every pixel.
 *
 * Squared (not rooted) because both consumers only compare against thresholds,
 * which removes a `sqrt` per pixel — measurable at 12 MP.
 *
 * The ramp case is evaluated **incrementally**: the model is affine in
 * normalised coordinates, so we walk x with a constant per-pixel step instead of
 * evaluating the plane (and its Lab conversion) per pixel. Both loops are
 * written out in full rather than using a callback, because an indirect call
 * per pixel prevents V8 from inlining the colour transform.
 */
function computeDistances(image: RgbaImage, model: BackgroundModel): Float32Array {
  const { data, width, height } = image;
  const n = width * height;
  const dist = new Float32Array(n);
  const lut = SRGB_TO_LINEAR;
  const ramp = model.ramp;

  if (ramp) {
    // The background model varies *smoothly*, so its Lab colour is tabulated on
    // a grid at most QUANT cells per axis and bilinearly interpolated. That is
    // visually identical (the model is already an affine plane, i.e. linear) but
    // removes the per-pixel plane evaluation + Lab conversion.
    const QUANT = 48;
    const gw = Math.min(QUANT, width);
    const gh = Math.min(QUANT, height);
    const grid = new Float32Array(gw * gh * 3);
    const rx = width - 1 || 1;
    const ry = height - 1 || 1;
    const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);
    for (let gy = 0; gy < gh; gy++) {
      const fy = (gy / (gh - 1 || 1)) * 2 - 1;
      for (let gx = 0; gx < gw; gx++) {
        const fx = (gx / (gw - 1 || 1)) * 2 - 1;
        const sr = clamp255(ramp.r[0] + ramp.r[1] * fx + ramp.r[2] * fy);
        const sg = clamp255(ramp.g[0] + ramp.g[1] * fx + ramp.g[2] * fy);
        const sb = clamp255(ramp.b[0] + ramp.b[1] * fx + ramp.b[2] * fy);
        const lr = lut[sr | 0];
        const lg = lut[sg | 0];
        const lb = lut[sb | 0];
        const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
        const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
        const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
        const g3 = (gy * gw + gx) * 3;
        grid[g3] = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
        grid[g3 + 1] = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
        grid[g3 + 2] = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
      }
    }
    const sx = (gw - 1 || 1) / rx;
    const sy = (gh - 1 || 1) / ry;
    let p = 0;
    for (let y = 0; y < height; y++) {
      const gyf = y * sy;
      const y0 = gyf | 0;
      const y1 = y0 < gh - 1 ? y0 + 1 : y0;
      const wy = gyf - y0;
      const row0 = y0 * gw * 3;
      const row1 = y1 * gw * 3;
      for (let x = 0; x < width; x++, p++) {
        const gxf = x * sx;
        const x0 = gxf | 0;
        const x1 = x0 < gw - 1 ? x0 + 1 : x0;
        const wx = gxf - x0;
        const i00 = row0 + x0 * 3;
        const i01 = row0 + x1 * 3;
        const i10 = row1 + x0 * 3;
        const i11 = row1 + x1 * 3;
        const w00 = (1 - wx) * (1 - wy);
        const w01 = wx * (1 - wy);
        const w10 = (1 - wx) * wy;
        const w11 = wx * wy;
        const mdl = grid[i00] * w00 + grid[i01] * w01 + grid[i10] * w10 + grid[i11] * w11;
        const mda = grid[i00 + 1] * w00 + grid[i01 + 1] * w01 + grid[i10 + 1] * w10 + grid[i11 + 1] * w11;
        const mdb = grid[i00 + 2] * w00 + grid[i01 + 2] * w01 + grid[i10 + 2] * w10 + grid[i11 + 2] * w11;

        const o = p * 4;
        const lr = lut[data[o]];
        const lg = lut[data[o + 1]];
        const lb = lut[data[o + 2]];
        const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
        const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
        const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
        const dl = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_ - mdl;
        const da = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_ - mda;
        const db = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_ - mdb;
        dist[p] = dl * dl + da * da + db * db;
      }
    }
    return dist;
  }

  const ml = model.meanLab[0];
  const ma = model.meanLab[1];
  const mb = model.meanLab[2];
  for (let p = 0, o = 0; p < n; p++, o += 4) {
    const lr = lut[data[o]];
    const lg = lut[data[o + 1]];
    const lb = lut[data[o + 2]];
    const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
    const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
    const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
    const dl = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_ - ml;
    const da = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_ - ma;
    const db = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_ - mb;
    dist[p] = dl * dl + da * da + db * db;
  }
  return dist;
}

/** Label values used by the flood fill. */
const BG = 1;
const FG = 0;

/**
 * Thresholds for the hysteresis flood fill, derived from `tolerance` and the
 * measured border noise.
 *
 *  - `growTol`  : a pixel closer than this *extends* the region (loose).
 *  - `seedTol`  : a pixel must be closer than this to *seed* the region (tight).
 * The pair forms a hysteresis band, so anti-aliased edge pixels (partially
 * mixed with the background) are absorbed instead of leaving a halo ring,
 * while genuinely different colours stop the fill dead.
 */
export function thresholdsFor(model: BackgroundModel, tolerance: number): { growTol: number; seedTol: number } {
  // ΔE 0..0.5 maps to tolerance 0..1 — 0.5 is already an obvious colour jump.
  const base = 0.006 + 0.085 * clamp01(tolerance);
  const noiseFloor = model.noise * 1.15;
  const seedTol = Math.max(base, noiseFloor + 0.004);
  // The loose band must still be clearly below "different colour": 0.11 ΔE is
  // roughly a 25-level sRGB step on a mid grey — visible, but still an obvious
  // colour family.
  const growTol = Math.min(0.115, seedTol * 1.7 + 0.014);
  return { growTol, seedTol };
}

/**
 * Flood fill the background starting from every border pixel.
 *
 * Implementation notes:
 *  - Uses an explicit Int32Array stack (no recursion, no array-of-arrays), so
 *    12 MP images fit comfortably in memory and run in linear time.
 *  - 4-connectivity: keeps thin foreground structures (hair, cables) connected
 *    instead of leaking through diagonal gaps.
 *  - Hysteresis: a pixel joins the region when it is within `seedTol` of the
 *    model *and* touches the growing region.
 */
export function growBackground(
  dist: Float32Array,
  width: number,
  height: number,
  growTol: number,
  seedTol: number,
): Uint8Array {
  const n = width * height;
  // 0 = never queued, 1 = background. A pixel is marked at *push* time so it
  // can never enter the stack twice (a duplicated push would re-expand the same
  // neighbourhood and, worse, make the LIFO order revisit already-processed
  // regions — the classic source of stray holes inside the subject).
  const label = new Uint8Array(n);
  const stack = new Int32Array(n);
  let sp = 0;

  // Hysteresis: pixels close to the model *seed* the region, then the region
  // *expands* through the looser threshold. This keeps thin, confident
  // connections (a gradient's mid-tones) from fragmenting the fill while still
  // stopping at a real colour boundary.
  // `dist` holds SQUARED OkLab ΔE; thresholds are compared squared.
  const seedLimit = seedTol * seedTol;
  const growLimit = growTol * growTol;
  const push = (p: number, limit: number): void => {
    if (label[p] !== 0) return; // already queued / visited
    if (dist[p] > limit) return;
    label[p] = BG;
    stack[sp++] = p;
  };

  for (let x = 0; x < width; x++) {
    push(x, seedLimit);
    push((height - 1) * width + x, seedLimit);
  }
  for (let y = 0; y < height; y++) {
    push(y * width, seedLimit);
    push(y * width + width - 1, seedLimit);
  }

  while (sp > 0) {
    const p = stack[--sp];
    const x = p % width;
    const y = (p - x) / width;

    if (x > 0) push(p - 1, growLimit);
    if (x < width - 1) push(p + 1, growLimit);
    if (y > 0) push(p - width, growLimit);
    if (y < height - 1) push(p + width, growLimit);
  }

  return label;
}

/* -------------------------------------------------------------------------- */
/* 3. Enclosed background holes                                               */
/* -------------------------------------------------------------------------- */

/**
 * Mark background-coloured regions that do **not** touch the border as
 * background too ("hole" handling, e.g. the inside of a mug handle).
 *
 * A hole is only opened when its area is meaningful (≥ 0.15% of the image) and
 * its colours are confidently background — otherwise a dark button on a shirt
 * that happens to resemble the blue backdrop would get punched out.
 *
 * Documented behaviour: holes ≤ `minArea` px and holes whose mean ΔE > 0.5×
 * `growTol` are KEPT opaque on purpose (conservative matting).
 */
export function fillEnclosedBackground(
  label: Uint8Array,
  dist: Float32Array,
  width: number,
  height: number,
  growTol: number,
): number {
  const n = width * height;
  const minArea = Math.max(24, Math.floor(n * 0.0015));
  // Confidently-background holes only: half the loose fill tolerance.
  const maxHoleDist = growTol * 0.5;
  const maxHoleDistSq = maxHoleDist * maxHoleDist;
  const meanCutSq = (maxHoleDist * 0.85) ** 2;
  const visited = new Uint8Array(n);
  const stack = new Int32Array(n);
  const members = new Int32Array(n);
  let filled = 0;

  for (let start = 0; start < n; start++) {
    if (label[start] !== FG || visited[start]) continue;
    if (dist[start] > maxHoleDistSq) continue;

    let sp = 0;
    let m = 0;
    let touchesBorder = false;
    let sumDistSq = 0;

    stack[sp++] = start;
    visited[start] = 1;

    while (sp > 0) {
      const p = stack[--sp];
      members[m++] = p;
      sumDistSq += dist[p];
      const x = p % width;
      const y = (p - x) / width;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBorder = true;

      if (x > 0) {
        const q = p - 1;
        if (!visited[q] && label[q] === FG && dist[q] <= maxHoleDistSq) {
          visited[q] = 1;
          stack[sp++] = q;
        }
      }
      if (x < width - 1) {
        const q = p + 1;
        if (!visited[q] && label[q] === FG && dist[q] <= maxHoleDistSq) {
          visited[q] = 1;
          stack[sp++] = q;
        }
      }
      if (y > 0) {
        const q = p - width;
        if (!visited[q] && label[q] === FG && dist[q] <= maxHoleDistSq) {
          visited[q] = 1;
          stack[sp++] = q;
        }
      }
      if (y < height - 1) {
        const q = p + width;
        if (!visited[q] && label[q] === FG && dist[q] <= maxHoleDistSq) {
          visited[q] = 1;
          stack[sp++] = q;
        }
      }
    }

    if (touchesBorder) continue;
    if (m < minArea) continue; // too small → probably a highlight/detail
    if (sumDistSq / m > meanCutSq) continue; // not confidently background
    for (let i = 0; i < m; i++) label[members[i]] = BG;
    filled += m;
  }

  return filled;
}

/* -------------------------------------------------------------------------- */
/* 4. Despeckle                                                               */
/* -------------------------------------------------------------------------- */

/**
 * One connected-component-labelling + filtering pass over the *foreground*.
 *
 * Optimisations that matter at 12 MP:
 *  - The dominant component (the subject) is usually >95 % of the foreground.
 *    We still visit it completely (so its pixels are correctly marked), but we
 *    skip the perimeter bookkeeping and the member buffer once the component is
 *    known to be far larger than `maxArea`.
 *  - Neighbour visits are unrolled, no array allocation in the hot loop.
 */
function despecklePass(label: Uint8Array, width: number, height: number, maxArea: number): number {
  const n = width * height;
  const visited = new Uint8Array(n);
  const stack = new Int32Array(n);
  // Only components that can possibly be removed get their members recorded.
  const members = new Int32Array(maxArea + 1);
  let changed = 0;

  for (let start = 0; start < n; start++) {
    if (label[start] !== FG || visited[start]) continue;
    let sp = 0;
    let m = 0;
    let perimeter = 0;
    let record = true;
    stack[sp++] = start;
    visited[start] = 1;

    while (sp > 0) {
      const p = stack[--sp];
      if (record) members[m] = p;
      m++;
      if (m > maxArea) record = false; // too big to be a speck; stop recording
      const x = p % width;
      const y = (p - x) / width;

      // 4-connectivity matches the flood fill so thin diagonal structures are
      // not artificially split.
      let open = 0;
      let q: number;
      if (x > 0) {
        q = p - 1;
        if (label[q] === BG) open++;
        else if (!visited[q]) {
          visited[q] = 1;
          stack[sp++] = q;
        }
      } else open++;
      if (x < width - 1) {
        q = p + 1;
        if (label[q] === BG) open++;
        else if (!visited[q]) {
          visited[q] = 1;
          stack[sp++] = q;
        }
      } else open++;
      if (y > 0) {
        q = p - width;
        if (label[q] === BG) open++;
        else if (!visited[q]) {
          visited[q] = 1;
          stack[sp++] = q;
        }
      } else open++;
      if (y < height - 1) {
        q = p + width;
        if (label[q] === BG) open++;
        else if (!visited[q]) {
          visited[q] = 1;
          stack[sp++] = q;
        }
      } else open++;
      if (record) perimeter += open;
    }

    if (m > maxArea) continue;
    // A blob is "noise" when it is small and either compact (a dust speck) or
    // very thin (a 1–2 px remnant of the anti-aliased outline). Elongated
    // structures with real thickness (hair strand, wire) survive.
    const compactness = (perimeter * perimeter) / Math.max(1, m);
    const isSpeck = compactness <= 32;
    const isHairline = m <= maxArea * 0.25 && perimeter >= m;
    if (isSpeck || isHairline) {
      for (let i = 0; i < m; i++) label[members[i]] = BG;
      changed += m;
    }
  }

  return changed;
}

/**
 * Remove isolated foreground specks and absorb tiny background crumbs inside
 * the subject. `strength` 0..1 scales the speck area budget.
 */
export function despeckleAlpha(label: Uint8Array, width: number, height: number, strength: number): number {
  const s = clamp01(strength);
  if (s <= 0) return 0;
  const n = width * height;
  // Up to ~0.35% of the image per speck at max strength.
  const maxArea = Math.max(8, Math.floor(n * 0.0035 * s * s + 6 * s));
  let total = 0;
  // Two passes: the first normalises the label set, the second catches pieces
  // that became isolated after the first one removed their neighbours.
  for (let pass = 0; pass < 2; pass++) {
    const c = despecklePass(label, width, height, maxArea);
    total += c;
    if (c === 0) break;
  }

  return total;
}

/* -------------------------------------------------------------------------- */
/* 5. Alpha rasterisation + anti-aliasing                                     */
/* -------------------------------------------------------------------------- */

/**
 * Box blur along one axis with a running sum: O(n) regardless of radius.
 * Edge pixels are handled by *clamping* the window (the border value is
 * repeated), which keeps the background borderfully transparent and the
 * subject borderfully opaque — no dark/light vignette at the frame edge.
 */
function boxBlur1D(
  src: Float32Array,
  dst: Float32Array,
  width: number,
  height: number,
  radius: number,
  horizontal: boolean,
): void {
  const len = horizontal ? width : height;
  const lines = horizontal ? height : width;
  if (radius <= 0) {
    dst.set(src);
    return;
  }
  const step = horizontal ? 1 : width;
  const inv = 1 / (radius * 2 + 1);

  for (let line = 0; line < lines; line++) {
    const base = horizontal ? line * width : line;
    const at = (i: number): number => src[base + (i < 0 ? 0 : i >= len ? len - 1 : i) * step];

    let sum = 0;
    for (let i = -radius; i <= radius; i++) sum += at(i);

    for (let i = 0; i < len; i++) {
      dst[base + i * step] = sum * inv;
      sum += at(i + radius + 1) - at(i - radius);
    }
  }
}

/**
 * Convert the binary label map into an anti-aliased float alpha channel.
 *
 * Anti-aliasing is *edge-limited*: only pixels within `aaRadius` of a label
 * boundary are modified, everything else keeps alpha 0 or 1 exactly. A plain
 * box blur would erode thin foreground structures (hair, handles) and lift
 * background alpha near the frame edge; this pass instead reconstructs a
 * signed-distance-like coverage from the label neighbourhood, which yields
 * sub-pixel accurate edges without eating geometry.
 *
 * `feather` then applies an optional wider softening blur on top (0 = crisp).
 */
export function rasterizeAlpha(
  label: Uint8Array,
  width: number,
  height: number,
  feather: number,
  source?: Uint8ClampedArray,
  model?: BackgroundModel,
): Float32Array {
  const n = width * height;
  const alpha = new Float32Array(n);
  for (let p = 0; p < n; p++) alpha[p] = label[p] === BG ? 0 : 1;

  // ---- pass 1: anti-aliased coverage on the 1px boundary band ------------
  // The label map is *binary* and derived from a colour-distance threshold, so
  // its edge is aliased and sits at an arbitrary sub-pixel position inside the
  // 1–2 px transition. Deriving alpha from the binary map alone gives a matte
  // that is "mushy" by ±2 px and shifts with the tolerance slider.
  //
  // When the source pixels are available we instead invert the blend that the
  // browser/JPEG applied to produce the edge:
  //     C = α·F + (1-α)·B     ⇒     α = (C-B)·(F-B) / |F-B|²
  // where `F` is the local interior foreground colour and `B` the background
  // model colour at this pixel. That recovers the true coverage and is immune to
  // where the threshold landed.
  //
  // Without source pixels (unit tests of the label stage) we fall back to a 3×3
  // coverage kernel, which is aliased but never wrong in the ±0.5 px sense.
  const fgMask = (p: number): number => (label[p] === BG ? 0 : 255);
  const edge = new Uint8Array(n);
  let hasEdge = false;
  for (let y = 0; y < height; y++) {
    const yUp = y > 0;
    const yDn = y < height - 1;
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const self = fgMask(p);
      let isEdge = false;
      if ((x > 0 && fgMask(p - 1) !== self) || (x < width - 1 && fgMask(p + 1) !== self)) {
        isEdge = true;
      } else if ((yUp && fgMask(p - width) !== self) || (yDn && fgMask(p + width) !== self)) {
        isEdge = true;
      }
      if (isEdge) {
        edge[p] = 1;
        hasEdge = true;
      }
    }
  }

  if (hasEdge) {
    const canUnmix = !!source && !!model;
    const bgR = model ? model.mean[0] : 0;
    const bgG = model ? model.mean[1] : 0;
    const bgB = model ? model.mean[2] : 0;

    // Degenerate contrast guard: if the local foreground is (nearly) the same
    // colour as the background, unmixing is ill-conditioned — keep the binary
    // value instead of amplifying noise.
    const MIN_DEN = 24;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const p = y * width + x;
        if (!edge[p]) continue;

        if (!canUnmix) {
          // Coverage-kernel fallback on the binary map.
          const l = x > 0 ? fgMask(p - 1) : fgMask(p);
          const r = x < width - 1 ? fgMask(p + 1) : fgMask(p);
          const u = y > 0 ? fgMask(p - width) : fgMask(p);
          const d = y < height - 1 ? fgMask(p + width) : fgMask(p);
          const covX = (l + fgMask(p) + r) / 3 / 255;
          const covY = (u + fgMask(p) + d) / 3 / 255;
          alpha[p] = 0.5 * (covX + covY);
          continue;
        }

        // Local interior foreground colour: mean of non-edge foreground pixels
        // in a 5×5 window. Local (not global) so a multi-coloured subject does
        // not bleed one region's colour into another's edge.
        let fr = 0;
        let fg_ = 0;
        let fb = 0;
        let count = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            const q = yy * width + xx;
            if (label[q] === BG || edge[q]) continue;
            const o = q * 4;
            fr += source![o];
            fg_ += source![o + 1];
            fb += source![o + 2];
            count++;
          }
        }
        if (count === 0) continue;
        const inv = 1 / count;
        const mr = fr * inv;
        const mg = fg_ * inv;
        const mb = fb * inv;

        const o = p * 4;
        const dr = mr - bgR;
        const dg = mg - bgG;
        const db = mb - bgB;
        const den = dr * dr + dg * dg + db * db;
        if (den < MIN_DEN) continue; // no usable contrast — keep binary value

        const estimate =
          ((source![o] - bgR) * dr + (source![o + 1] - bgG) * dg + (source![o + 2] - bgB) * db) / den;
        alpha[p] = estimate < 0 ? 0 : estimate > 1 ? 1 : estimate;
      }
    }
  }

  // ---- pass 2: optional feather (soft matte) -----------------------------
  const f = clamp01(feather);
  const radius = Math.round(f * Math.max(2, Math.min(width, height) * 0.012));
  if (radius > 0) {
    const tmp = new Float32Array(n);
    boxBlur1D(alpha, tmp, width, height, radius, true);
    const blurred = new Float32Array(n);
    boxBlur1D(tmp, blurred, width, height, radius, false);
    // Blend proportionally to the requested feather so small values stay crisp
    // while 1.0 gives a genuinely soft matte.
    const t = clamp01(f * 1.4);
    for (let p = 0; p < n; p++) alpha[p] = alpha[p] * (1 - t) + blurred[p] * t;
  }

  return alpha;
}

/* -------------------------------------------------------------------------- */
/* 6. Edge colour decontamination                                             */
/* -------------------------------------------------------------------------- */

/**
 * Un-premultiply edge colours: a semi-transparent pixel is a mix of true
 * foreground colour F and background colour B, C = aF + (1-a)B. We know B (the
 * local model) and a, so we can recover F = (C - (1-a)B) / a. Without this the
 * matte keeps a light halo on white backdrops — the single most visible
 * artefact of naive background removal.
 */
export function decontaminateEdge(
  data: Uint8ClampedArray,
  alpha: Float32Array,
  model: BackgroundModel,
  width: number,
  height: number,
): void {
  const n = width * height;
  const [br, bg, bb] = model.mean;
  const ramp = model.ramp;
  let any = false;
  for (let p = 0; p < n; p++) {
    const a = alpha[p];
    if (a <= 0.02 || a >= 0.98) continue;
    any = true;
    break;
  }
  if (!any) return;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      const a = alpha[p];
      if (a <= 0.02 || a >= 0.98) continue;
      const o = p * 4;
      let Br = br;
      let Bg = bg;
      let Bb = bb;
      if (ramp) {
        const fx = (x / (width - 1 || 1)) * 2 - 1;
        const fy = (y / (height - 1 || 1)) * 2 - 1;
        Br = ramp.r[0] + ramp.r[1] * fx + ramp.r[2] * fy;
        Bg = ramp.g[0] + ramp.g[1] * fx + ramp.g[2] * fy;
        Bb = ramp.b[0] + ramp.b[1] * fx + ramp.b[2] * fy;
      }
      const invA = 1 / a;
      const oneMinusA = 1 - a;
      const fr = (data[o] - oneMinusA * Br) * invA;
      const fg = (data[o + 1] - oneMinusA * Bg) * invA;
      const fb = (data[o + 2] - oneMinusA * Bb) * invA;
      // Clamp instead of wrapping: Uint8ClampedArray already clamps, but the
      // explicit clamp keeps the intent obvious and avoids double rounding.
      data[o] = fr < 0 ? 0 : fr > 255 ? 255 : fr;
      data[o + 1] = fg < 0 ? 0 : fg > 255 ? 255 : fg;
      data[o + 2] = fb < 0 ? 0 : fb > 255 ? 255 : fb;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Public core entry point                                                    */
/* -------------------------------------------------------------------------- */

/** Normalise partial options into a complete `FastOptions`. */
export function normalizeFastOptions(opts?: Partial<FastOptions> | null): FastOptions {
  const pick = (value: number | undefined, fallback: number): number => {
    if (value === undefined || value === null) return fallback;
    const clamped = clamp01(value);
    return Number.isNaN(clamped) ? fallback : clamped;
  };
  return {
    tolerance: pick(opts?.tolerance, DEFAULT_FAST_OPTIONS.tolerance),
    feather: pick(opts?.feather, DEFAULT_FAST_OPTIONS.feather),
    despeckle: pick(opts?.despeckle, DEFAULT_FAST_OPTIONS.despeckle),
  };
}

/**
 * Run the whole fast pipeline on an RGBA buffer.
 *
 * Pure function: never mutates `image`, allocates its own output buffer.
 */
export function removeBackgroundFastCore(image: RgbaImage, options?: Partial<FastOptions>): FastResult {
  const { data, width, height } = image;
  const opts = normalizeFastOptions(options);
  const n = width * height;
  if (n === 0) {
    return { data: new Uint8ClampedArray(0), width, height, confidence: 0 };
  }

  const model = fitBackgroundModel(image);
  const { growTol, seedTol } = thresholdsFor(model, opts.tolerance);
  const dist = computeDistances(image, model);
  const label = growBackground(dist, width, height, growTol, seedTol);
  fillEnclosedBackground(label, dist, width, height, growTol);
  despeckleAlpha(label, width, height, opts.despeckle);
  const alpha = rasterizeAlpha(label, width, height, opts.feather, data, model);

  const out = new Uint8ClampedArray(n * 4);
  out.set(data);
  decontaminateEdge(out, alpha, model, width, height);
  for (let p = 0, o = 3; p < n; p++, o += 4) {
    out[o] = Math.round(alpha[p] * 255);
  }
  // Fully transparent pixels: zero the RGB so exports don't carry hidden
  // background colour (avoids dark fringes in some viewers/print).
  for (let o = 0; o < n * 4; o += 4) {
    if (out[o + 3] === 0) {
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
    }
  }

  return { data: out, width, height, confidence: model.confidence };
}

/**
 * Downscale/upscale an alpha mask between resolutions (bilinear, SIMD-free).
 * Used by the preview path: compute at a small size, then resample back to the
 * source resolution so the caller always gets a mask matching the input.
 */
export function resampleMask(
  mask: Float32Array | Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Float32Array {
  const maxV = mask instanceof Uint8ClampedArray ? 255 : 1;
  if (srcW === dstW && srcH === dstH) {
    const copy = new Float32Array(mask.length);
    for (let i = 0; i < mask.length; i++) copy[i] = mask[i] / maxV;
    return copy;
  }
  const out = new Float32Array(dstW * dstH);
  const sx = srcW / dstW;
  const sy = srcH / dstH;
  for (let y = 0; y < dstH; y++) {
    const fy = Math.min(srcH - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(srcH - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < dstW; x++) {
      const fx = Math.min(srcW - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(srcW - 1, x0 + 1);
      const wx = fx - x0;
      const a = mask[y0 * srcW + x0] / maxV;
      const b = mask[y0 * srcW + x1] / maxV;
      const c = mask[y1 * srcW + x0] / maxV;
      const d = mask[y1 * srcW + x1] / maxV;
      out[y * dstW + x] = (a * (1 - wx) + b * wx) * (1 - wy) + (c * (1 - wx) + d * wx) * wy;
    }
  }
  return out;
}

/**
 * Apply an alpha mask (0..1 floats) to an RGBA buffer, returning a new buffer.
 * Used by the preview path where the mask was computed at a lower resolution.
 */
export function applyAlphaMask(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  alpha: Float32Array,
  model?: BackgroundModel,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(data.length);
  out.set(data);
  const n = width * height;
  if (model) decontaminateEdge(out, alpha, model, width, height);
  for (let p = 0, o = 3; p < n; p++, o += 4) {
    const a = alpha[p];
    const v = Math.round(a * 255);
    out[o] = v;
    if (v === 0) {
      out[o - 3] = 0;
      out[o - 2] = 0;
      out[o - 1] = 0;
    }
  }
  return out;
}

/** Deterministic PRNG exported for the test-suite (synthetic noise). */
export { makeRng };

