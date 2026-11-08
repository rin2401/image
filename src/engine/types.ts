/**
 * Shared public types for the engine layer.
 *
 * Kept in its own module so `fast.ts`, `ai.ts` and the UI can all import them
 * without pulling in a DOM- or Worker-dependent implementation.
 */

/** Which background-removal engine to use. */
export type EngineId = 'ai' | 'fast';

/** Which ISNet model variant the AI engine should use. */
export type AiModelId = 'isnet_quint8' | 'isnet' | 'isnet_fp16';

/**
 * Default AI model — the single source of truth shared by the engine and UI.
 *
 * `isnet_fp16` (~88 MB) is the quality plateau: it matches the 176 MB fp32
 * model at half the download, while `isnet_quint8` (~44 MB) visibly degrades
 * on soft-edged subjects (speckle holes, hair contamination). Defined here —
 * not in `ai.ts` — so the UI can import the constant without pulling the
 * heavy engine bundle into the first-paint chunk.
 */
export const DEFAULT_AI_MODEL: AiModelId = 'isnet_fp16';

/**
 * Tuning knobs exposed in the UI, all normalised to `0..1`.
 *
 * The UI renders three sliders bound to these fields; every engine accepts the
 * same object so switching engines keeps the user's settings.
 */
export interface RemovalOptions {
  /**
   * How different a pixel may be from the detected background and still be
   * removed. Higher = removes more (more aggressive).
   * @default 0.6
   */
  tolerance?: number;
  /**
   * Softness of the matte edge, in "pixels of blend" scaled by image size.
   * Higher = softer edge.
   * @default 0.25
   */
  feather?: number;
  /**
   * How aggressively to clean up isolated specks and stray outlines.
   * Higher = cleaner but may nibble fine details.
   * @default 0.5
   */
  despeckle?: number;
}
