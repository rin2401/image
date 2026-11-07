/**
 * Public surface of the background-removal engine.
 *
 * The UI imports **only from this module** (`src/engine`):
 *
 * ```ts
 * import {
 *   removeBackgroundFast,
 *   removeBackgroundAi,
 *   disposeAiModel,
 *   type EngineId,
 *   type RemovalOptions,
 *   type AiProgress,
 *   type AiModelId,
 * } from '../engine';
 * ```
 *
 * Two engines:
 *  - `'fast'` — pure algorithm (flood fill on a background model). Runs in a
 *    Worker, ~30–300 ms, no download. Great for solid/studio/gradient
 *    backgrounds, and the default for instant feedback.
 *  - `'ai'`   — ISNet via ONNX Runtime Web. Tens of MB download, seconds per
 *    image, but handles hair, fur and busy backgrounds.
 */

export type { EngineId } from './types';

export {
  removeBackgroundFast,
  removeBackgroundFastDetailed,
  renderFastPreview,
  disposeFastEngine,
  blobToDataUrl,
  DEFAULT_FAST_OPTIONS,
  type FastRemoveOptions,
  type FastRemoveResult,
} from './fast';

export {
  removeBackgroundAi,
  preloadAiModel,
  disposeAiModel,
  DEFAULT_AI_MODEL,
  type AiModelId,
  type AiProgress,
  type AiRemoveOptions,
} from './ai';

export type { RemovalOptions } from './types';
