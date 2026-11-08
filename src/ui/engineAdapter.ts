/**
 * Thin, type-safe adapter between the UI and `src/engine`.
 *
 * The engine is owned by another module but is statically importable (Vite
 * bundles it, and it internally dynamic-imports @imgly/background-removal so
 * the AI library never lands in the main chunk). This file only re-exports
 * the public engine surface so the UI imports from one place, and adds small
 * UI-facing helpers such as human-readable labels for progress events.
 */
import type {
  AiModelId,
  AiProgress,
  EngineId,
  FastRemoveOptions,
  RemovalOptions,
} from '../engine';
// Value import from the dependency-free `engine/types` keeps the engine bundle
// lazily loaded (a re-export from `../engine` would make it eager).
import { DEFAULT_AI_MODEL } from '../engine/types';

export type { AiModelId, AiProgress, EngineId, FastRemoveOptions, RemovalOptions };
export { DEFAULT_AI_MODEL };

export interface EngineApi {
  /** Fast engine: `RemovalOptions` plus `maxDimension` (matte compute size). */
  removeBackgroundFast: (input: ImageBitmap | Blob, opts?: FastRemoveOptions) => Promise<Blob>;
  removeBackgroundAi: (
    input: Blob,
    onProgress?: (p: AiProgress) => void,
    model?: AiModelId,
  ) => Promise<Blob>;
  /** Best-effort model warm-up (download ahead of time); failures swallowed. */
  preloadAiModel: (model?: AiModelId) => Promise<void>;
  disposeAiModel: () => Promise<void>;
}

let cached: Promise<EngineApi> | null = null;

/**
 * Lazily load the engine module.
 *
 * Importing lazily keeps first paint snappy and means a transient engine
 * failure surfaces as a friendly, catchable error in the UI instead of a
 * blank page. The engine module itself is bundled by Vite (static graph), so
 * this is a client-side module promise, not an extra network chunk beyond
 * Vite's own code-splitting.
 */
export function loadEngine(): Promise<EngineApi> {
  if (!cached) {
    cached = import('../engine').then(
      (mod) => mod as unknown as EngineApi,
      (error: unknown) => {
        cached = null; // allow a retry after a transient failure
        throw new EngineUnavailableError(error);
      },
    );
  }
  return cached;
}

export class EngineUnavailableError extends Error {
  constructor(readonly cause?: unknown) {
    super('Không tải được bộ xử lý ảnh. Vui lòng tải lại trang.');
    this.name = 'EngineUnavailableError';
  }
}

export const AI_MODELS: { id: AiModelId; label: string; mb: number }[] = [
  { id: 'isnet_fp16', label: 'Chất lượng cao', mb: 88.2 },
  { id: 'isnet_quint8', label: 'Nhẹ (tải nhanh)', mb: 44.3 },
];

export const ENGINE_LABELS: Record<EngineId, string> = {
  ai: 'AI (chất lượng cao)',
  fast: 'Nhanh (nền đơn sắc)',
};

/**
 * Turn an engine progress payload into a Vietnamese label + MB read-out.
 *
 * The engine reports raw library keys (`fetch:/models/isnet_quint8`,
 * `compute:inference`, …) as `label`, but a *listening* progress reporter may
 * also forward already-humanised Vietnamese text. Both shapes are handled.
 *
 * A `total` of 0 (or the 1/1 "done" sentinel the engine emits on completion)
 * means "no byte information" — showing "0.0 / 0.0 MB" there was a bug.
 */
export function describeProgress(p: AiProgress): { label: string; detail: string } {
  const key = (p.label ?? '').toLowerCase();
  const hasBytes = p.total > 1024;
  const loadedMb = p.loaded / (1024 * 1024);
  const totalMb = p.total / (1024 * 1024);
  const detail = hasBytes
    ? `${loadedMb.toFixed(1)} / ${totalMb.toFixed(1)} MB`
    : p.loaded > 1024
      ? `${loadedMb.toFixed(1)} MB`
      : '';

  if (p.ratio >= 1 && (/hoàn tất|done/i.test(p.label ?? '') || !hasBytes)) {
    return { label: 'Hoàn tất', detail: '' };
  }
  if (key.includes('inference') || key.includes('compute') || key.includes('chuẩn bị') || key.includes('xử lý')) {
    return { label: 'Đang tách nền bằng AI…', detail: '' };
  }
  if (key.includes('onnx')) {
    return { label: 'Đang tải bộ máy tính toán (ONNX Runtime)', detail };
  }
  if (key.startsWith('fetch') || key.includes('model') || key.includes('mô hình')) {
    return { label: 'Đang tải mô hình AI', detail };
  }
  if (key.startsWith('compute') || key.includes('wasm')) {
    return { label: 'Đang tải bộ máy tính toán', detail };
  }
  return { label: 'Đang chuẩn bị…', detail };
}
