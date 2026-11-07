/**
 * Fast (algorithmic) background removal — public entry point.
 *
 * Runs `fastCore` inside a module Worker when the environment supports it, and
 * transparently falls back to running on the main thread otherwise (older
 * Safari, `file://` pages, CSP-blocked workers, …). The caller never has to care
 * which path was taken.
 *
 * Preview support: pass `maxDimension` to compute the matte at a reduced
 * resolution and get the *mask* back at source resolution, ready to be applied
 * over the full-resolution image. This keeps interactive slider tweaking snappy
 * on multi-megapixel photos.
 */
import { decodeToImageData, encodePng, fitWithin, type DecodedImage } from './canvas';
import {
  DEFAULT_FAST_OPTIONS,
  applyAlphaMask,
  fitBackgroundModel,
  normalizeFastOptions,
  removeBackgroundFastCore,
  resampleMask,
  type FastOptions,
} from './fastCore';

export type FastOptionsPublic = FastOptions;

/** Options accepted by `removeBackgroundFast`. */
export interface FastRemoveOptions extends Partial<FastOptions> {
  /**
   * Compute the matte at most this many pixels on the longest side, then
   * upscale it to the source resolution. `undefined` = full resolution.
   * Typical preview value: 768–1536.
   */
  maxDimension?: number;
}

export interface FastRemoveResult {
  /** PNG with alpha (full source resolution). */
  blob: Blob;
  /** 0..1 — how background-like the image border was; low means "use AI". */
  confidence: number;
  /** Time spent in the algorithm, ms. */
  durationMs: number;
  /** True when the work happened off the main thread. */
  usedWorker: boolean;
}

interface WorkerResponse {
  id: number;
  ok: boolean;
  data?: ArrayBuffer;
  width?: number;
  height?: number;
  confidence?: number;
  error?: string;
}

let workerRef: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const pending = new Map<
  number,
  {
    resolve: (v: WorkerResponse) => void;
    reject: (e: Error) => void;
  }
>();

/**
 * Lazily create the module Worker.
 *
 * `new Worker(new URL('./fastWorker.ts', import.meta.url), { type: 'module' })`
 * is the Vite-native form: it emits a separate chunk, works in dev and in the
 * production build, and respects the configured `base` (important for GitHub
 * Pages project sites served from `/<repo>/`).
 */
function getWorker(): Worker | null {
  if (workerBroken) return null;
  if (workerRef) return workerRef;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') return null;

  try {
    const worker = new Worker(new URL('./fastWorker.ts', import.meta.url), {
      type: 'module',
      name: 'fast-bg-removal',
    });
    worker.onmessage = (evt: MessageEvent<WorkerResponse>) => {
      const entry = pending.get(evt.data.id);
      if (!entry) return;
      pending.delete(evt.data.id);
      entry.resolve(evt.data);
    };
    worker.onerror = () => {
      // A worker-level failure (e.g. CSP, unsupported module workers) is fatal
      // for this session: reject in-flight requests and stop using it so the
      // next call goes down the main-thread path instead of hanging.
      workerBroken = true;
      workerRef = null;
      for (const [, entry] of pending) entry.reject(new Error('Worker xử lý ảnh gặp lỗi.'));
      pending.clear();
      try {
        worker.terminate();
      } catch {
        /* ignore */
      }
    };
    workerRef = worker;
    return worker;
  } catch {
    workerBroken = true;
    return null;
  }
}

async function runInWorker(
  image: DecodedImage,
  options: FastOptions,
): Promise<{ data: Uint8ClampedArray; confidence: number } | null> {
  const worker = getWorker();
  if (!worker) return null;

  // Copy, because transferring detaches the buffer the caller may still need
  // (the preview path keeps the source pixels for the full-res apply step).
  const buffer = image.data.slice().buffer as ArrayBuffer;
  const id = nextId++;

  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: (res) => {
        if (!res.ok || !res.data) {
          reject(new Error(res.error ?? 'Worker xử lý ảnh gặp lỗi.'));
          return;
        }
        resolve({
          data: new Uint8ClampedArray(res.data),
          confidence: res.confidence ?? 1,
        });
      },
      reject,
    });
    try {
      worker.postMessage(
        { id, data: buffer, width: image.width, height: image.height, options },
        [buffer],
      );
    } catch (error) {
      pending.delete(id);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/**
 * Remove the background using the fast algorithm.
 *
 * @param input  `ImageBitmap` or `Blob` of the photo.
 * @param opts   `tolerance` / `feather` / `despeckle` (0..1) plus optional
 *               `maxDimension` for the preview path.
 * @returns PNG Blob with alpha at the input's resolution.
 */
export async function removeBackgroundFast(
  input: ImageBitmap | Blob,
  opts?: FastRemoveOptions,
): Promise<Blob> {
  const result = await removeBackgroundFastDetailed(input, opts);
  return result.blob;
}

/**
 * Same as `removeBackgroundFast` but returns metadata alongside the blob
 * (confidence, timing, whether a Worker was used). The UI uses `confidence` to
 * suggest switching to the AI engine on busy backgrounds.
 */
export async function removeBackgroundFastDetailed(
  input: ImageBitmap | Blob,
  opts?: FastRemoveOptions,
): Promise<FastRemoveResult> {
  const options = normalizeFastOptions(opts);
  const started = typeof performance !== 'undefined' ? performance.now() : Date.now();

  const source = await decodeToImageData(input);

  const limit = opts?.maxDimension;
  const work = limit && limit > 0 ? await fitWithin(source, limit) : source;
  const scaled = work.width !== source.width || work.height !== source.height;

  let data: Uint8ClampedArray;
  let confidence: number;
  let usedWorker = false;

  const workerResult = await runInWorker(work, options).catch(() => null);
  if (workerResult) {
    usedWorker = true;
    if (scaled) {
      // Worker computed the matte at preview size: lift it back up and apply it
      // to the *full-resolution* pixels so the caller gets a usable full image.
      const mask = resampleMaskFromRgba(workerResult.data, work.width, work.height, source.width, source.height);
      const model = fitBackgroundModel(source);
      data = applyAlphaMask(source.data, source.width, source.height, mask, model);
    } else {
      data = workerResult.data;
    }
    confidence = workerResult.confidence;
  } else {
    // Main-thread fallback. Kept synchronous-ish so a single tick can't be
    // preempted mid-algorithm; it simply blocks while it runs.
    const core = removeBackgroundFastCore(work, options);
    confidence = core.confidence;
    if (scaled) {
      const mask = resampleMaskFromRgba(core.data, work.width, work.height, source.width, source.height);
      const model = fitBackgroundModel(source);
      data = applyAlphaMask(source.data, source.width, source.height, mask, model);
    } else {
      data = core.data;
    }
  }

  const blob = await encodePng({ data, width: source.width, height: source.height });
  const ended = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { blob, confidence, durationMs: ended - started, usedWorker };
}

/** Extract the alpha channel of an RGBA buffer and resample it to `dstW×dstH`. */
function resampleMaskFromRgba(
  rgba: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Float32Array {
  const n = srcW * srcH;
  const mask = new Uint8ClampedArray(n);
  for (let p = 0, o = 3; p < n; p++, o += 4) mask[p] = rgba[o];
  return resampleMask(mask, srcW, srcH, dstW, dstH);
}

/**
 * Preview helper: compute the matte at `maxDimension` and return it as a data
 * URL, without touching the source-resolution pixels.
 *
 * The UI shows this while the user drags the sliders; once they stop, call
 * `removeBackgroundFast` at full resolution.
 */
export async function renderFastPreview(
  input: ImageBitmap | Blob,
  maxDimension = 1024,
  opts?: FastOptionsPublic,
): Promise<{ dataUrl: string; confidence: number }> {
  const options = normalizeFastOptions(opts);
  const source = await decodeToImageData(input);
  const work = await fitWithin(source, maxDimension);

  let rgba: Uint8ClampedArray;
  let confidence: number;
  const workerResult = await runInWorker(work, options).catch(() => null);
  if (workerResult) {
    rgba = workerResult.data;
    confidence = workerResult.confidence;
  } else {
    const core = removeBackgroundFastCore(work, options);
    rgba = core.data;
    confidence = core.confidence;
  }

  const blob = await encodePng({ data: rgba, width: work.width, height: work.height });
  const dataUrl = await blobToDataUrl(blob);
  return { dataUrl, confidence };
}

/** Read a Blob as a data URL (FileReader-based for maximum compatibility). */
export function blobToDataUrl(blob: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Không đọc được dữ liệu ảnh.'));
      reader.readAsDataURL(blob);
    });
  }
  return blob.arrayBuffer().then((buf) => {
    let binary = '';
    const bytes = new Uint8Array(buf);
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return `data:image/png;base64,${btoa(binary)}`;
  });
}

/** Terminate the worker (called on page unload / when the engine is disposed). */
export function disposeFastEngine(): void {
  if (workerRef) {
    try {
      workerRef.terminate();
    } catch {
      /* ignore */
    }
    workerRef = null;
  }
  for (const [, entry] of pending) entry.reject(new Error('Đã huỷ xử lý ảnh.'));
  pending.clear();
}

export { DEFAULT_FAST_OPTIONS };
