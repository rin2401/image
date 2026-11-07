/**
 * Thin, type-safe adapter between the UI and `src/engine`.
 *
 * The engine is owned by another module but is statically importable (Vite
 * bundles it, and it internally dynamic-imports @imgly/background-removal so
 * the AI library never lands in the main chunk). This file only re-exports
 * the public engine surface so the UI imports from one place, and adds small
 * UI-facing helpers such as human-readable labels for progress events.
 */
import type { AiModelId, AiProgress, EngineId, RemovalOptions } from '../engine';

export type { AiModelId, AiProgress, EngineId, RemovalOptions };

export interface EngineApi {
  removeBackgroundFast: (
    input: ImageBitmap | Blob,
    opts?: RemovalOptions,
  ) => Promise<Blob>;
  removeBackgroundAi: (
    input: Blob,
    onProgress?: (p: AiProgress) => void,
    model?: AiModelId,
  ) => Promise<Blob>;
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

/**
 * Default AI model. Measured download sizes (vendored in public/imgly/):
 *   isnet_quint8 = 44.3 MB (default, best size/quality trade-off)
 *   isnet_fp16   = 88.2 MB (higher quality, opt-in)
 *   isnet        = 176 MB (not vendored — never use as default)
 */
export const DEFAULT_AI_MODEL: AiModelId = 'isnet_quint8';

export const AI_MODELS: { id: AiModelId; label: string; mb: number }[] = [
  { id: 'isnet_quint8', label: 'Nhanh gọn', mb: 44.3 },
  { id: 'isnet_fp16', label: 'Chất lượng cao', mb: 88.2 },
];

export const ENGINE_LABELS: Record<EngineId, string> = {
  ai: 'AI (chất lượng cao)',
  fast: 'Nhanh (nền đơn sắc)',
};

/**
 * Turn an engine progress payload into a Vietnamese label + MB read-out.
 * Engine keys look like `fetch:/image/imgly/models/isnet_fp16` or
 * `compute:inference`.
 */
export function describeProgress(p: AiProgress): { label: string; detail: string } {
  const key = (p.label ?? '').toLowerCase();
  const loadedMb = p.loaded / (1024 * 1024);
  const totalMb = p.total / (1024 * 1024);
  const detail =
    p.total > 0 ? `${loadedMb.toFixed(1)} / ${totalMb.toFixed(1)} MB` : `${loadedMb.toFixed(1)} MB`;

  if (key.includes('inference') || key.includes('compute') || key.includes('process')) {
    return { label: 'Đang tách nền bằng AI…', detail: '' };
  }
  if (key.startsWith('fetch') || key.includes('model') || key.includes('onnx') || key.includes('wasm')) {
    return { label: 'Đang tải mô hình AI', detail };
  }
  return { label: 'Đang chuẩn bị…', detail };
}
