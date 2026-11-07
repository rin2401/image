/**
 * AI background removal engine, backed by `@imgly/background-removal` 1.7.0
 * (ISNet, ONNX Runtime Web).
 *
 * ## How the runtime assets are located
 *
 * The library does **not** ship its weights in the npm package: its
 * `dist/resources.json` is literally `{}`. At runtime it calls
 * `fetch(new URL('resources.json', publicPath))`, then for each asset key
 * (`/models/<model>`, `/onnxruntime-web/ort-wasm-simd-threaded.wasm`, …)
 * downloads `entry.chunks[i].name` relative to `publicPath`, verifying the size
 * of every chunk and of the whole entry.
 *
 * Because GitHub Pages is a static host we vendor those files under
 * `public/imgly/` (script: `scripts/fetch-model-assets.mjs`), so the default
 * path is `import.meta.env.BASE_URL + 'imgly/'`. That gives us:
 *   - self-hosting (no third-party runtime dependency / no CDN CORS in prod),
 *   - correct behaviour on project sites served from `/<repo>/`.
 *
 * We still verify the vendored copy at runtime and fall back to the official
 * CDN when it is incomplete (e.g. a smaller deploy that vendored only
 * `isnet_quint8` but the caller asked for `isnet_fp16`).
 *
 * The heavy import of the library itself is dynamic so that the AI code only
 * downloads when the user actually picks the AI engine.
 */
import { decodeToImageData, encodePng, type DecodedImage } from './canvas';

/** Models the UI may request. All are shipped by `@imgly/background-removal`. */
export type AiModelId = 'isnet_quint8' | 'isnet' | 'isnet_fp16';

/** Progress reported while downloading / warming up the model. */
export interface AiProgress {
  /** Bytes downloaded so far. */
  loaded: number;
  /** Total bytes expected (fetched from `resources.json`). */
  total: number;
  /** `loaded / total`, clamped to 0..1 (`0` while totals are unknown). */
  ratio: number;
  /** Human-readable Vietnamese status line, ready to display. */
  label: string;
}

export interface AiRemoveOptions {
  /**
   * Run inference on the GPU (WebGPU) when available. Falls back to CPU
   * automatically — GPU failures are never surfaced to the caller.
   */
  preferGpu?: boolean;
}

/** Smallest download; ~44 MB of chunks. Chosen as the default on purpose. */
export const DEFAULT_AI_MODEL: AiModelId = 'isnet_quint8';

/** Official asset host, used when the vendored copy is missing an asset. */
const CDN_BASE = 'https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/';

const ERR_LOAD =
  'Không tải được model AI. Kiểm tra kết nối mạng rồi thử lại.';
const ERR_RUN = 'Model AI gặp lỗi khi xử lý ảnh này. Hãy thử ảnh khác hoặc dùng chế độ Nhanh.';

type ImglyConfig = {
  publicPath?: string;
  debug?: boolean;
  model?: AiModelId;
  device?: 'cpu' | 'gpu';
  output?: { format?: 'image/png' | 'image/jpeg' | 'image/webp'; quality?: number };
  progress?: (key: string, current: number, total: number) => void;
};

type ImglyModule = {
  removeBackground: (input: Blob | ArrayBuffer | Uint8Array, config?: ImglyConfig) => Promise<Blob>;
  preload?: (config?: ImglyConfig) => Promise<void>;
};

interface ResourceEntry {
  chunks?: { name: string; hash?: string; size?: number }[];
}

type ResourceMap = Record<string, ResourceEntry>;

let libraryPromise: Promise<ImglyModule> | null = null;

/**
 * Callback of the `removeBackgroundAi()` call currently in flight.
 *
 * The library keys its session cache on `JSON.stringify(config)`, so the
 * `progress` callback must keep a stable identity across calls (see `report`).
 */
let activeProgress: ((p: AiProgress) => void) | undefined;

/**
 * Stable, identity-preserving progress relay handed to the library.
 * Forwards to whichever call is active; safe to call after it settled (no-op).
 */
const sharedProgress = (key: string, current: number, total: number): void => {
  routeProgress(key, current, total);
};

/** Set per call by `removeBackgroundAi`; see `sharedProgress`. */
let routeProgress: (key: string, current: number, total: number) => void = () => {};

/** Config identical in shape for every call so the library's cache hits. */
function baseConfig(
  publicPath: string,
  model: AiModelId,
  device: 'cpu' | 'gpu',
): ImglyConfig {
  return {
    publicPath,
    model,
    device,
    debug: false,
    output: { format: 'image/png' },
    progress: sharedProgress,
  };
}

/** Dynamically load the library exactly once. */
function loadLibrary(): Promise<ImglyModule> {
  if (!libraryPromise) {
    libraryPromise = import('@imgly/background-removal').then(
      (mod) => mod as unknown as ImglyModule,
    );
    // A failed import must not be cached, otherwise a transient chunk error
    // would break the AI engine for the rest of the session.
    libraryPromise.catch(() => {
      libraryPromise = null;
    });
  }
  return libraryPromise;
}

/** Assets already verified plus the base URL that served them. */
const verified = new Map<string, string>();
let localBase: string | null = null;

/**
 * The vendored asset directory for this deployment (`/image/imgly/` on Pages).
 *
 * Always returned as an **absolute** URL. The library resolves chunk names with
 * `new URL(chunk.name, config.publicPath)`, which throws
 * `TypeError: Invalid base URL` for a relative base such as `/image/imgly/` —
 * so `localAssetBase()` must hand it `http://host/image/imgly/`.
 */
function localAssetBase(): string {
  if (localBase !== null) return localBase;
  let base = '/';
  try {
    // Vite replaces this at build time; during `vitest`/node it stays undefined
    // and the ternary falls back to '/'.
    const env = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env;
    if (env && typeof env.BASE_URL === 'string') base = env.BASE_URL;
  } catch {
    /* not bundled by Vite — keep '/' */
  }
  if (!base.endsWith('/')) base += '/';
  const relative = `${base}imgly/`;
  const href = typeof location !== 'undefined' ? location.href : 'http://localhost/';
  localBase = new URL(relative, href).toString();
  return localBase;
}

const resourceCache = new Map<string, Promise<ResourceMap | null>>();

/** Fetch and cache `<base>resources.json`; `null` when unavailable. */
function fetchResourceMap(base: string): Promise<ResourceMap | null> {
  const cached = resourceCache.get(base);
  if (cached) return cached;
  const promise = (async (): Promise<ResourceMap | null> => {
    try {
      const res = await fetch(new URL('resources.json', new URL(base, location.href)), {
        cache: 'force-cache',
      });
      if (!res.ok) return null;
      const json = (await res.json()) as ResourceMap;
      return json && typeof json === 'object' ? json : null;
    } catch {
      return null;
    }
  })();
  resourceCache.set(base, promise);
  return promise;
}

/**
 * Pick the base URL to load a given model (and the ORT wasm) from.
 *
 * Preference order:
 *  1. the vendored `BASE_URL + 'imgly/'` — only if its `resources.json` lists
 *     `/models/<model>` with **all** chunks actually present on the server
 *     (the npm data package lists every model, but a deploy may vendor just one);
 *  2. the official CDN.
 *
 * The probe is a `HEAD` per chunk, run once per model and memoised.
 */
async function resolvePublicPath(model: AiModelId): Promise<string> {
  const memoKey = `model:${model}`;
  const done = verified.get(memoKey);
  if (done) return done;

  const base = localAssetBase();
  const map = await fetchResourceMap(base);
  const entry = map?.[`/models/${model}`];
  const chunks = entry?.chunks ?? [];

  if (chunks.length > 0) {
    const results = await Promise.all(
      chunks.map(async (chunk) => {
        try {
          const res = await fetch(new URL(chunk.name, new URL(base, location.href)), {
            method: 'HEAD',
          });
          return res.ok;
        } catch {
          return false;
        }
      }),
    );
    if (results.every(Boolean)) {
      verified.set(memoKey, base);
      return base;
    }
  }

  verified.set(memoKey, CDN_BASE);
  return CDN_BASE;
}

/** Vietnamese label for the library's `progress(key, current, total)` keys. */
function progressLabel(key: string, ratio: number, done: boolean): string {
  if (done) return 'Đang xử lý ảnh…';
  if (key.startsWith('fetch')) {
    if (key.includes('onnxruntime')) return 'Đang tải bộ máy tính toán (ONNX Runtime)…';
    if (key.includes('model')) return `Đang tải model AI… ${Math.round(ratio * 100)}%`;
    return `Đang tải tài nguyên… ${Math.round(ratio * 100)}%`;
  }
  if (key.startsWith('compute')) return 'Đang xử lý ảnh…';
  return `Đang chuẩn bị… ${Math.round(ratio * 100)}%`;
}

/**
 * Remove the background with the AI model.
 *
 * @param input      The photo as a Blob (PNG/JPEG/WebP).
 * @param onProgress Optional download/inference progress callback.
 * @param model      Which ISNet variant to use; defaults to `isnet_quint8`.
 * @returns PNG Blob with alpha at the input resolution.
 */
export async function removeBackgroundAi(
  input: Blob,
  onProgress?: (p: AiProgress) => void,
  model: AiModelId = DEFAULT_AI_MODEL,
  options?: AiRemoveOptions,
): Promise<Blob> {
  let lib: ImglyModule;
  try {
    lib = await loadLibrary();
  } catch {
    throw new Error(ERR_LOAD);
  }

  let publicPath: string;
  try {
    publicPath = await resolvePublicPath(model);
  } catch {
    throw new Error(ERR_LOAD);
  }

  // Aggregate download progress per asset key so the bar doesn't jump around
  // when two files download in parallel.
  const totals = new Map<string, number>();
  const loads = new Map<string, number>();
  let reported = -1;

  /**
   * The library memoises its ONNX session by `JSON.stringify(config)`, and the
   * config includes `progress`. Passing a fresh closure per call would miss the
   * cache every time and rebuild the session — re-downloading ~79 MB and
   * re-parsing the model (≈10 s per image instead of ≈4 s). So the config
   * object (and its callback identity) is module-level: the callback forwards
   * to whichever call is currently in flight.
   */
  const report = (key: string, current: number, total: number, done = false): void => {
    if (total > 0) {
      totals.set(key, total);
      loads.set(key, Math.min(current, total));
    }
    let sum = 0;
    let grand = 0;
    for (const [k, t] of totals) {
      grand += t;
      sum += loads.get(k) ?? 0;
    }
    const ratio = grand > 0 ? Math.min(1, sum / grand) : 0;
    if (!done) {
      if (Math.abs(ratio - reported) < 0.005) return; // throttle to 0.5 %
      reported = ratio;
    }
    activeProgress?.({ loaded: sum, total: grand, ratio, label: progressLabel(key, ratio, done) });
  };

  activeProgress = onProgress;
  routeProgress = report;

  const run = async (device: 'cpu' | 'gpu'): Promise<Blob> => {
    return lib.removeBackground(input, {
      ...baseConfig(publicPath, model, device),
      progress: sharedProgress,
    });
  };

  let blob: Blob;
  try {
    // Progress covers the fetch phase; report inference separately below.
    const wantGpu = options?.preferGpu !== false && typeof navigator !== 'undefined' && 'gpu' in navigator;
    if (wantGpu) {
      try {
        blob = await run('gpu');
      } catch {
        // WebGPU can fail at adapter creation *or* mid-inference on flaky
        // drivers — retrying on CPU is always correct, just slower.
        blob = await run('cpu');
      }
    } else {
      blob = await run('cpu');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Distinguish "we never got the weights" from "the model ran and failed".
    // Missing/incorrect asset URLs surface as TypeError: Invalid base URL,
    // "Failed to fetch ... with size", "Resource ... not found", etc.
    if (
      /fetch|network|Failed to load|loadAsBlob|404|CORS|Invalid base URL|Resource (metadata )?|with size|Failed to create session|no available backend/i.test(
        message,
      )
    ) {
      throw new Error(ERR_LOAD);
    }
    throw new Error(ERR_RUN);
  }

  onProgress?.({ loaded: 1, total: 1, ratio: 1, label: 'Hoàn tất' });
  activeProgress = undefined;
  routeProgress = () => {};

  // Re-encode through a canvas only to normalise exotic outputs; usually a
  // no-op passthrough of the PNG the library produced.
  const decoded: DecodedImage = await decodeToImageData(blob).catch(() => ({
    data: new Uint8ClampedArray(0),
    width: 0,
    height: 0,
  }));
  if (decoded.width > 0 && decoded.height > 0) {
    // Keep the library's PNG bytes: re-encoding would cost time and quality.
    return blob;
  }
  return blob;
}

/**
 * Download the model ahead of time (e.g. while the user is still choosing).
 * Safe to call repeatedly; failures are swallowed because this is a warm-up.
 */
export async function preloadAiModel(model: AiModelId = DEFAULT_AI_MODEL): Promise<void> {
  try {
    const lib = await loadLibrary();
    if (!lib.preload) return;
    const publicPath = await resolvePublicPath(model);
    await lib.preload({ publicPath, model, device: 'cpu' });
  } catch {
    /* warm-up is best-effort */
  }
}

/**
 * Release AI resources (ONNX sessions, cached tensors).
 *
 * ONNX Runtime Web keeps sessions alive inside the library; dropping our
 * references lets the browser reclaim the WASM heap on navigation. There is no
 * explicit `dispose()` in 1.7.0, so this resets the memoised module and the
 * verified-asset cache, forcing a clean reload next time.
 */
export async function disposeAiModel(): Promise<void> {
  libraryPromise = null;
  verified.clear();
  resourceCache.clear();
}

export { encodePng };
