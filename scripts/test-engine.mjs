#!/usr/bin/env node
/**
 * Engine test suite — plain Node, no test framework, no browser.
 *
 *   node --experimental-strip-types scripts/test-engine.mjs
 *
 * Node 22 strips the TypeScript types on the fly, which is why the algorithm
 * lives in the DOM-free `src/engine/fastCore.ts`: the exact same code that ships
 * to the browser is what runs here.
 *
 * The suite asserts *behaviour* (what a user would call correct), not internal
 * implementation details, so the algorithm can be retuned without rewriting the
 * tests:
 *
 *   1. solid background + anti-aliased red circle   → corners transparent, centre opaque
 *   2. vertical gradient background + ellipse       → same, plus clean edge band
 *   3. JPEG-like noisy background + circle          → corners still ~0 (noise tolerance)
 *   4. enclosed background hole (donut)             → hole transparent, ring opaque
 *   5. subject touching the frame border            → documented limitation, asserted as-is
 *   6. option sweep: tolerance / feather / despeckle behave monotonically
 *   7. real photograph if present (OM.png)          → sane alpha histogram
 *   8. performance budget on a 12 MP image
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  DEFAULT_FAST_OPTIONS,
  normalizeFastOptions,
  removeBackgroundFastCore,
} from '../src/engine/fastCore.ts';
import {
  gradientBgWithEllipse,
  enclosedHole,
  getAlpha,
  getPixel,
  noisyBgWithCircle,
  solidBgWithCircle,
  subjectTouchingBorder,
} from './synthetic.mjs';
import { decodePng } from './png.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

/* -------------------------------------------------------------------------- */
/* Tiny assertion harness                                                     */
/* -------------------------------------------------------------------------- */

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    process.stdout.write(`  \u001b[32m✓\u001b[0m ${name}${detail ? ` \u001b[90m(${detail})\u001b[0m` : ''}\n`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    process.stdout.write(`  \u001b[31m✗ ${name}\u001b[0m${detail ? ` \u001b[90m(${detail})\u001b[0m` : ''}\n`);
  }
}

function near(actual, expected, tol, label) {
  return Math.abs(actual - expected) <= tol ? '' : `${label}=${actual.toFixed(4)} expected ${expected}±${tol}`;
}

function section(title) {
  process.stdout.write(`\n\u001b[1m${title}\u001b[0m\n`);
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/** Alpha at the four corners (averaged over a small inset box, avoiding AA). */
function cornerAlphas(img, result, inset = 4) {
  const { width, height } = img;
  const box = (x0, y0) => {
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y0 + inset; y++) {
      for (let x = x0; x < x0 + inset; x++) {
        sum += getAlpha(result, x, y);
        n++;
      }
    }
    return sum / n;
  };
  return [
    box(0, 0),
    box(width - inset, 0),
    box(0, height - inset),
    box(width - inset, height - inset),
  ];
}

function alphaAt(img, result, fx, fy) {
  return getAlpha(result, Math.round(img.width * fx), Math.round(img.height * fy));
}

/** Fraction of pixels whose alpha is fully transparent / opaque / partial. */
function alphaHistogram(result) {
  const n = result.width * result.height;
  let clear = 0;
  let solid = 0;
  let partial = 0;
  for (let p = 0; p < n; p++) {
    const a = result.data[p * 4 + 3];
    if (a <= 2) clear++;
    else if (a >= 253) solid++;
    else partial++;
  }
  return { clear: clear / n, solid: solid / n, partial: partial / n };
}

/**
 * Intersection-over-union of the predicted matte against a ground-truth
 * predicate, thresholded at alpha > 127.
 */
function iou(result, truth) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (let y = 0; y < result.height; y++) {
    for (let x = 0; x < result.width; x++) {
      const want = truth(x, y);
      const got = result.data[(y * result.width + x) * 4 + 3] > 127;
      if (want && got) tp++;
      else if (!want && got) fp++;
      else if (want && !got) fn++;
    }
  }
  return { iou: tp / (tp + fp + fn), fp, fn };
}

const circleTruth = (img) => (x, y) => {
  const r = Math.min(img.width, img.height) * 0.3;
  return Math.hypot(x + 0.5 - img.width / 2, y + 0.5 - img.height / 2) <= r;
};

/* -------------------------------------------------------------------------- */
/* 0. Option normalisation                                                    */
/* -------------------------------------------------------------------------- */

section('0. Option normalisation');
{
  const d = normalizeFastOptions();
  check('defaults tolerance', d.tolerance === DEFAULT_FAST_OPTIONS.tolerance, String(d.tolerance));
  check('defaults feather', d.feather === DEFAULT_FAST_OPTIONS.feather, String(d.feather));
  check('defaults despeckle', d.despeckle === DEFAULT_FAST_OPTIONS.despeckle, String(d.despeckle));

  const clamped = normalizeFastOptions({ tolerance: 5, feather: -3, despeckle: Number.NaN });
  check('tolerance clamps to 1', clamped.tolerance === 1, String(clamped.tolerance));
  check('feather clamps to 0', clamped.feather === 0, String(clamped.feather));
  check('NaN despeckle falls back to default', clamped.despeckle === DEFAULT_FAST_OPTIONS.despeckle);

  check(
    'DEFAULT_FAST_OPTIONS is frozen',
    Object.isFrozen(DEFAULT_FAST_OPTIONS),
    'guards against accidental mutation by callers',
  );
}

/* -------------------------------------------------------------------------- */
/* 1. Solid background + anti-aliased circle                                  */
/* -------------------------------------------------------------------------- */

section('1. Solid background + red circle');
let solidStats;
{
  const img = solidBgWithCircle();
  const t0 = performance.now();
  const result = removeBackgroundFastCore(img);
  const ms = performance.now() - t0;
  solidStats = { img, result, ms };

  const corners = cornerAlphas(img, result);
  check(
    'all four corners fully transparent',
    corners.every((a) => a <= 2),
    corners.map((a) => a.toFixed(1)).join('/'),
  );
  const centre = alphaAt(img, result, 0.5, 0.5);
  check('centre fully opaque', centre >= 253, `alpha=${centre}`);

  // Foreground colour must survive untouched (no global darkening / tinting).
  const px = getPixel(result, Math.round(img.width / 2), Math.round(img.height / 2));
  check(
    'foreground colour preserved',
    Math.abs(px[0] - 210) <= 2 && Math.abs(px[1] - 30) <= 2 && Math.abs(px[2] - 40) <= 2,
    `rgb(${px[0]},${px[1]},${px[2]}) vs (210,30,40)`,
  );

  const { iou: score, fp, fn } = iou(result, circleTruth(img));
  check('matte IoU ≥ 0.98 vs ground truth', score >= 0.98, `IoU=${score.toFixed(4)} fp=${fp} fn=${fn}`);

  // A 1.5 px anti-aliased outline on a 320x240 frame is ~0.6% of pixels; the
  // algorithm is allowed slack for the threshold cutting a sub-pixel off the
  // true edge, but the band must stay thin — a mushy/blurred matte scatters
  // alpha over 3-4 px and would blow well past this.
  const hist = alphaHistogram(result);
  check(
    'edge band is thin (≤2.5% partial-alpha pixels)',
    hist.partial <= 0.025,
    `${(hist.partial * 100).toFixed(2)}% partial`,
  );

  // The matte must track the true anti-aliased coverage, not just "be soft":
  // comparing against the generator's own coverage ramp pins the sub-pixel
  // position of the edge.
  let err = 0;
  let counted = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const d = Math.hypot(x + 0.5 - img.width / 2, y + 0.5 - img.height / 2);
      const ideal = Math.max(0, Math.min(1, Math.min(img.width, img.height) * 0.3 + 0.75 - d));
      if (ideal <= 0.05 || ideal >= 0.95) continue; // only the transition band
      err += Math.abs(getAlpha(result, x, y) / 255 - ideal);
      counted++;
    }
  }
  // A blank/aliased matte (all 0 or all 255 in the band) would score ~0.5.
  const meanErr = counted ? err / counted : 1;
  check(
    'matte tracks true anti-aliased coverage (mean |Δα| ≤ 0.25 in the band)',
    meanErr <= 0.25,
    `mean |Δα| = ${meanErr.toFixed(3)} over ${counted} band pixels`,
  );

  // Fully transparent pixels must carry no colour, otherwise PNG viewers that
  // ignore alpha (or naive compositing) show a coloured fringe.
  let tinted = 0;
  for (let p = 0; p < result.width * result.height; p++) {
    const o = p * 4;
    if (result.data[o + 3] === 0 && (result.data[o] || result.data[o + 1] || result.data[o + 2])) {
      tinted++;
    }
  }
  check('transparent pixels have zeroed RGB', tinted === 0, `${tinted} pixels carry colour`);
  check('confidence high on a solid background', result.confidence >= 0.8, result.confidence.toFixed(3));
}

/* -------------------------------------------------------------------------- */
/* 2. Gradient background                                                     */
/* -------------------------------------------------------------------------- */

section('2. Vertical gradient background + ellipse');
{
  const img = gradientBgWithEllipse(320, 240, 0);
  const result = removeBackgroundFastCore(img);

  const top = alphaAt(img, result, 0.5, 0.06);
  const bottom = alphaAt(img, result, 0.5, 0.94);
  check('corner top transparent', top <= 4, `alpha=${top}`);
  check('corner bottom transparent (gradient end)', bottom <= 4, `alpha=${bottom}`);
  const centre = alphaAt(img, result, 0.5, 0.5);
  check('centre opaque', centre >= 253, `alpha=${centre}`);

  // A background *gradient* must not be mistaken for a subject: the whole border
  // has to go, even though the two ends differ in colour a lot.
  const hist = alphaHistogram(result);
  check('≥70% of the frame removed', hist.clear >= 0.7, `${(hist.clear * 100).toFixed(1)}% clear`);
  check('confidence high on a gradient', result.confidence >= 0.8, result.confidence.toFixed(3));
}

section('2b. Noisy gradient background (JPEG-like artefacts)');
{
  const img = gradientBgWithEllipse(320, 240, 6);
  const result = removeBackgroundFastCore(img);
  const corners = cornerAlphas(img, result);
  check(
    'noisy gradient corners transparent',
    corners.every((a) => a <= 8),
    corners.map((a) => a.toFixed(1)).join('/'),
  );
  const centre = alphaAt(img, result, 0.5, 0.5);
  check('noisy gradient centre opaque', centre >= 253, `alpha=${centre}`);
}

/* -------------------------------------------------------------------------- */
/* 3. Noisy background                                                        */
/* -------------------------------------------------------------------------- */

section('3. Noisy (JPEG-like) background + circle');
{
  const img = noisyBgWithCircle();
  const result = removeBackgroundFastCore(img);

  const corners = cornerAlphas(img, result);
  check(
    'noisy corners transparent despite grain',
    corners.every((a) => a <= 8),
    corners.map((a) => a.toFixed(1)).join('/'),
  );
  const centre = alphaAt(img, result, 0.5, 0.5);
  check('noisy centre opaque', centre >= 253, `alpha=${centre}`);

  const { iou: score } = iou(result, circleTruth(img));
  check('noisy matte IoU ≥ 0.95', score >= 0.95, `IoU=${score.toFixed(4)}`);

  // Grain must not leak through as salt-and-pepper holes inside the subject.
  let holesInside = 0;
  const truth = circleTruth(img);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (!truth(x, y)) continue;
      // ignore a 3 px rim (legitimately anti-aliased)
      if (Math.hypot(x + 0.5 - img.width / 2, y + 0.5 - img.height / 2) > Math.min(img.width, img.height) * 0.3 - 3) continue;
      if (getAlpha(result, x, y) < 200) holesInside++;
    }
  }
  check('no speckle holes inside the subject', holesInside === 0, `${holesInside} eroded pixels`);
}

/* -------------------------------------------------------------------------- */
/* 4. Enclosed background hole                                                */
/* -------------------------------------------------------------------------- */

section('4. Enclosed background hole (donut)');
{
  const img = enclosedHole();
  const result = removeBackgroundFastCore(img);

  const corners = cornerAlphas(img, result);
  check(
    'outside transparent',
    corners.every((a) => a <= 2),
    corners.map((a) => a.toFixed(1)).join('/'),
  );

  const holeAlpha = alphaAt(img, result, 0.5, 0.5);
  // DOCUMENTED BEHAVIOUR: an enclosed region whose colour matches the background
  // model is treated as background and becomes transparent (true alpha matting,
  // which is what you want for a handle/hole). A *subject-coloured* enclosed
  // region stays opaque — asserted in case 4b below.
  check('enclosed hole is cut out (transparent)', holeAlpha <= 2, `alpha=${holeAlpha}`);

  const ringAlpha = getAlpha(result, Math.round(img.width / 2), Math.round(img.height * 0.22));
  check('ring stays opaque', ringAlpha >= 253, `alpha=${ringAlpha}`);
}
{
  // 4b — an enclosed *subject-coloured* island must survive.
  const img = solidBgWithCircle();
  const cx = img.width / 2;
  const cy = img.height / 2;
  // carve a background ring so the centre disc is fully enclosed
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      if (d > 34 && d < 46) {
        const o = (y * img.width + x) * 4;
        img.data[o] = 238;
        img.data[o + 1] = 238;
        img.data[o + 2] = 240;
      }
    }
  }
  const result = removeBackgroundFastCore(img);
  const inner = alphaAt(img, result, 0.5, 0.5);
  check('enclosed subject-coloured island stays opaque', inner >= 253, `alpha=${inner}`);
}

/* -------------------------------------------------------------------------- */
/* 5. Subject touching the frame border (documented limitation)                */
/* -------------------------------------------------------------------------- */

section('5. Subject touching the frame border');
{
  const img = subjectTouchingBorder();
  const result = removeBackgroundFastCore(img);
  const centre = alphaAt(img, result, 0.5, 0.6);
  check('cropped subject stays opaque', centre >= 253, `alpha=${centre}`);

  // DOCUMENTED LIMITATION: the algorithm models the background from the border
  // ring. When the subject itself touches the border the model is polluted and
  // `confidence` drops, which is the UI's signal to suggest the AI engine.
  check(
    'confidence drops below the solid-background case',
    result.confidence < solidStats.result.confidence,
    `${result.confidence.toFixed(2)} < ${solidStats.result.confidence.toFixed(2)}`,
  );
}

/* -------------------------------------------------------------------------- */
/* 6. Option behaviour                                                        */
/* -------------------------------------------------------------------------- */

section('6. Options: tolerance / feather / despeckle');
{
  const img = solidBgWithCircle();

  const low = removeBackgroundFastCore(img, { tolerance: 0.2 });
  const high = removeBackgroundFastCore(img, { tolerance: 0.95 });
  const areaOf = (r) => alphaHistogram(r).solid;
  check(
    'higher tolerance removes at least as much background',
    areaOf(high) <= areaOf(low) + 0.005,
    `t=0.2→${(areaOf(low) * 100).toFixed(1)}% solid, t=0.95→${(areaOf(high) * 100).toFixed(1)}% solid`,
  );
  check('both tolerance extremes still hold the centre', alphaAt(img, high, 0.5, 0.5) >= 253);
  check('both tolerance extremes still clear the corners', alphaAt(img, low, 0.02, 0.02) <= 2);

  const soft = removeBackgroundFastCore(img, { feather: 1 });
  const hard = removeBackgroundFastCore(img, { feather: 0 });
  const softPartial = alphaHistogram(soft).partial;
  const hardPartial = alphaHistogram(hard).partial;
  check(
    'feather=1 produces a softer edge than feather=0',
    softPartial > hardPartial,
    `soft=${(softPartial * 100).toFixed(2)}% hard=${(hardPartial * 100).toFixed(2)}% partial`,
  );

  // Despeckle must not eat the subject at its maximum setting.
  const heavy = removeBackgroundFastCore(img, { despeckle: 1 });
  check(
    'despeckle=1 keeps the subject intact',
    alphaAt(img, heavy, 0.5, 0.5) >= 253 && areaOf(heavy) >= areaOf(low) - 0.02,
    `${(areaOf(heavy) * 100).toFixed(1)}% solid`,
  );

  // Determinism: the same input and options must give byte-identical output.
  const a = removeBackgroundFastCore(img, { tolerance: 0.6 });
  const b = removeBackgroundFastCore(img, { tolerance: 0.6 });
  let identical = a.data.length === b.data.length;
  for (let i = 0; identical && i < a.data.length; i++) if (a.data[i] !== b.data[i]) identical = false;
  check('output is deterministic', identical);
}

/* -------------------------------------------------------------------------- */
/* 7. Real photograph                                                         */
/* -------------------------------------------------------------------------- */

section('7. Real image (OM.png)');
{
  let img = null;
  for (const candidate of ['OM.png', 'OM-transparent.png']) {
    try {
      const decoded = decodePng(readFileSync(join(ROOT, candidate)));
      // Skip already-transparent sources: they test nothing about matting.
      let opaque = 0;
      for (let p = 3; p < decoded.data.length; p += 4) if (decoded.data[p] > 200) opaque++;
      if (opaque > decoded.width * decoded.height * 0.5) {
        img = decoded;
        break;
      }
    } catch {
      /* try the next candidate */
    }
  }

  if (!img) {
    process.stdout.write('  \u001b[90m(skipped — no opaque sample image found)\u001b[0m\n');
  } else {
    const result = removeBackgroundFastCore(img);
    const hist = alphaHistogram(result);
    check(
      'background removed but subject retained',
      hist.clear > 0.1 && hist.solid > 0.05,
      `${(hist.clear * 100).toFixed(1)}% clear, ${(hist.solid * 100).toFixed(1)}% solid`,
    );
    check('corners clear on the real image', cornerAlphas(img, result).every((a) => a <= 8));

    // The counter of the "O" is an enclosed background region and should be cut.
    const counter = getAlpha(result, Math.round(img.width * 0.56), Math.round(img.height * 0.47));
    check('enclosed counter of the glyph is cut out', counter <= 8, `alpha=${counter}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 8. Performance                                                             */
/* -------------------------------------------------------------------------- */

section('8. Performance');
{
  const img = gradientBgWithEllipse(4000, 3000, 2); // 12 MP
  // Warm up the JIT so we measure the steady state, not the interpreter.
  removeBackgroundFastCore(solidBgWithCircle(64, 64));
  removeBackgroundFastCore(solidBgWithCircle(512, 512));

  const t0 = performance.now();
  removeBackgroundFastCore(img);
  const ms = performance.now() - t0;
  const budget = 20000; // generous: CI machines and the Node interpreter vary wildly
  check(`12 MP under ${budget} ms`, ms < budget, `${ms.toFixed(0)} ms`);
  process.stdout.write(`    \u001b[90m(full-resolution 12 MP run takes ${ms.toFixed(0)} ms here; the UI caps the fast engine at 2048 px, which is ~30× cheaper)\u001b[0m\n`);
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                    */
/* -------------------------------------------------------------------------- */

process.stdout.write('\n');
if (failed === 0) {
  process.stdout.write(`\u001b[32m\u001b[1mAll ${passed} checks passed.\u001b[0m\n`);
  process.exit(0);
} else {
  process.stdout.write(`\u001b[31m\u001b[1m${failed} check(s) failed\u001b[0m (${passed} passed):\n`);
  for (const f of failures) process.stdout.write(`  \u001b[31m•\u001b[0m ${f}\n`);
  process.exit(1);
}
