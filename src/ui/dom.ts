/**
 * DOM hook layer.
 *
 * index.html is owned by the Lead and exposes `data-*` hooks. We query them
 * once here (typed, cached) so the rest of the app never touches raw selectors
 * and stays resilient if an element is temporarily missing (it is simply null
 * and every helper no-ops).
 */

import { $, $$ } from './utils';
import type { EngineId } from './engineAdapter';

export interface SliderRefs {
  input: HTMLInputElement;
  output: HTMLOutputElement | HTMLSpanElement | null;
}

export interface AppDom {
  /* Drop / upload */
  dropzone: HTMLElement | null;
  fileInput: HTMLInputElement | null;
  browseBtn: HTMLButtonElement | null;
  demoBtn: HTMLButtonElement | null;
  pasteTarget: HTMLElement | null;

  /* Notifications */
  toasts: HTMLElement | null;
  errorBanner: HTMLElement | null;

  /* Workspace */
  workspace: HTMLElement | null;
  viewer: HTMLElement | null;
  compare: HTMLElement | null;
  compareBefore: HTMLImageElement | null;
  compareAfter: HTMLImageElement | null;
  compareHandle: HTMLElement | null;
  compareRange: HTMLInputElement | null;
  processingOverlay: HTMLElement | null;
  processingText: HTMLElement | null;
  resetBtn: HTMLButtonElement | null;

  /* Meta + zoom */
  metaDims: HTMLElement | null;
  metaSize: HTMLElement | null;
  zoomIn: HTMLButtonElement | null;
  zoomOut: HTMLButtonElement | null;
  zoomFit: HTMLButtonElement | null;
  zoomReset: HTMLButtonElement | null;
  zoomLabel: HTMLElement | null;

  /* Engine */
  engineInputs: HTMLInputElement[];
  aiPanel: HTMLElement | null;
  fastPanel: HTMLElement | null;
  modeHint: HTMLElement | null;
  aiProgress: HTMLElement | null;
  aiBar: HTMLElement | null;
  aiProgressText: HTMLElement | null;
  sliders: Record<'tolerance' | 'feather' | 'despeckle', SliderRefs | null>;

  /* Export */
  exportBg: HTMLInputElement | null;
  bgSwatches: HTMLButtonElement[];
  exportPng: HTMLButtonElement | null;
  exportJpg: HTMLButtonElement | null;
  exportWebp: HTMLButtonElement | null;
  downloadBtn: HTMLButtonElement | null;
  copyBtn: HTMLButtonElement | null;

  /* Batch */
  batchList: HTMLElement | null;
  batchEmpty: HTMLElement | null;
  batchZip: HTMLButtonElement | null;
  batchClear: HTMLButtonElement | null;
  batchCount: HTMLElement | null;
}

const SLIDER_KEYS = ['tolerance', 'feather', 'despeckle'] as const;

function querySliders(): AppDom['sliders'] {
  const out: AppDom['sliders'] = { tolerance: null, feather: null, despeckle: null };
  for (const key of SLIDER_KEYS) {
    const input = $<HTMLInputElement>(`[data-slider="${key}"]`);
    if (!input) continue;
    const output =
      $(`[data-slider-out="${key}"]`) ??
      input.closest('label')?.querySelector<HTMLOutputElement>('output') ??
      null;
    out[key] = { input, output };
  }
  return out;
}

export function collectDom(): AppDom {
  return {
    dropzone: $('[data-dropzone]'),
    fileInput: $<HTMLInputElement>('[data-file-input]'),
    browseBtn: $<HTMLButtonElement>('[data-browse-btn]'),
    demoBtn: $<HTMLButtonElement>('[data-demo-btn]'),
    pasteTarget: $('[data-paste-target]'),

    toasts: $('[data-toasts]'),
    errorBanner: $('[data-error-banner]'),

    workspace: $('[data-workspace]'),
    viewer: $('[data-viewer]'),
    compare: $('[data-compare]'),
    compareBefore: $<HTMLImageElement>('[data-compare-before]'),
    compareAfter: $<HTMLImageElement>('[data-compare-after]'),
    compareHandle: $('[data-compare-handle]'),
    compareRange: $<HTMLInputElement>('[data-compare-range]'),
    processingOverlay: $('[data-processing-overlay]'),
    processingText: $('[data-processing-text]'),
    resetBtn: $<HTMLButtonElement>('[data-reset-btn]'),

    metaDims: $('[data-meta-dims]'),
    metaSize: $('[data-meta-size]'),
    zoomIn: $<HTMLButtonElement>('[data-zoom-in]'),
    zoomOut: $<HTMLButtonElement>('[data-zoom-out]'),
    zoomFit: $<HTMLButtonElement>('[data-zoom-fit]'),
    zoomReset: $<HTMLButtonElement>('[data-zoom-reset]'),
    zoomLabel: $('[data-zoom-label]'),

    engineInputs: $$<HTMLInputElement>('[data-engine]'),
    aiPanel: $('[data-ai-panel]'),
    fastPanel: $('[data-fast-panel]'),
    modeHint: $('[data-mode-hint]'),
    aiProgress: $('[data-ai-progress]'),
    aiBar: $('[data-ai-bar]'),
    aiProgressText: $('[data-ai-progress-text]'),
    sliders: querySliders(),

    exportBg: $<HTMLInputElement>('[data-export-bg]'),
    bgSwatches: $$<HTMLButtonElement>('[data-bg-swatch]'),
    exportPng: $<HTMLButtonElement>('[data-export-png]'),
    exportJpg: $<HTMLButtonElement>('[data-export-jpg]'),
    exportWebp: $<HTMLButtonElement>('[data-export-webp]'),
    downloadBtn: $<HTMLButtonElement>('[data-download-btn]'),
    copyBtn: $<HTMLButtonElement>('[data-copy-btn]'),

    batchList: $('[data-batch-list]'),
    batchEmpty: $('[data-batch-empty]'),
    batchZip: $<HTMLButtonElement>('[data-batch-zip]'),
    batchClear: $<HTMLButtonElement>('[data-batch-clear]'),
    batchCount: $('[data-batch-count]'),
  };
}

export function domEngineId(dom: AppDom): EngineId {
  const checked = dom.engineInputs.find((input) => input.checked);
  return checked?.value === 'fast' ? 'fast' : 'ai';
}

/** Enable/disable a list of buttons at once (busy states). */
export function setDisabled(nodes: (HTMLButtonElement | HTMLInputElement | null)[], on: boolean): void {
  for (const node of nodes) {
    if (!node) continue;
    node.disabled = on;
    node.setAttribute('aria-disabled', String(on));
  }
}
