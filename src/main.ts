/**
 * Application controller.
 *
 * Owns the page state machine, wires every `data-*` hook from index.html and
 * orchestrates: intake → engine call → result viewer → export / batch.
 * All heavy pixel work happens in the engine (workers); this file only
 * coordinates, renders and keeps the UI responsive.
 */

import './style.css';
import { CompareSlider } from './ui/compareSlider';
import { collectDom, domEngineId, setDisabled, type AppDom } from './ui/dom';
import {
  DEFAULT_AI_MODEL,
  EngineUnavailableError,
  describeProgress,
  loadEngine,
  type AiProgress,
  type RemovalOptions,
} from './ui/engineAdapter';
import { createModelSelect, type ModelSelect } from './ui/modelSelect';
import { setupCrossOriginIsolation } from './ui/isolation';
import { initI18n, t } from './ui/i18n';
import {
  MAX_BATCH,
  MAX_BYTES,
  collectFilesFromTransfer,
  createDemoImage,
  intakeFiles,
  type IntakeItem,
} from './ui/intake';
import { toastError, toastInfo, toastSuccess, toastWarning } from './ui/toast';
import { zipBlobs, uniqueName } from './ui/zip';
import {
  canvasToBlob,
  clamp,
  closeBitmap,
  decodeImage,
  downloadBlob,
  drawableSize,
  formatBytes,
  formatDims,
  formatMegapixels,
  formatPercent,
  formatSeconds,
  hexToRgb,
  isEditableTarget,
  rafThrottle,
  setAttr,
  setText,
  slugify,
  splitFileName,
  toggleClass,
  writeImageToClipboard,
} from './ui/utils';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type JobStatus = 'queued' | 'processing' | 'done' | 'error';

interface BatchItem {
  id: string;
  name: string;
  input: Blob;
  width: number;
  height: number;
  status: JobStatus;
  result: Blob | null;
  resultUrl: string | null;
  error: string | null;
  ms: number;
  row: HTMLLIElement | null;
  thumbUrl: string | null;
}

interface CurrentResult {
  blob: Blob;
  url: string;
  width: number;
  height: number;
  ms: number;
}

/** What `decodeImage` can hand back: a bitmap (modern browsers) or <img>. */
type DecodedImage = ImageBitmap | HTMLImageElement;

const ZOOM_MIN = 0.25;
const ENGINE_SWITCH_DEBOUNCE_MS = 250;
const ZOOM_MAX = 4;

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

class App {
  private readonly dom: AppDom = collectDom();
  /** Comparison slider instance (kept so the handle stays in sync). */
  private readonly compare: CompareSlider | null;
  private readonly fastOpts: Required<Omit<RemovalOptions, 'maxDimension'>> = {
    tolerance: 0.6,
    feather: 0.25,
    despeckle: 0.5,
  };

  /* current selection */
  private items: BatchItem[] = [];
  private activeId: string | null = null;
  private current: CurrentResult | null = null;
  private originalUrl: string | null = null;

  /* reprocessing bookkeeping */
  private fastTimer = 0;
  private engineTimer = 0;
  private fastToken = 0;
  private aiToken = 0;
  private busy = false;
  private modelSelect: ModelSelect | null = null;

  /* viewer */
  private zoom = 1;
  private fitZoom = 1;
  private viewNatural = { width: 1, height: 1 };

  constructor() {
    initI18n();

    this.compare =
      this.dom.compare && this.dom.compareHandle
        ? new CompareSlider({
            wrapper: this.dom.compare,
            handle: this.dom.compareHandle,
            range: this.dom.compareRange,
            beforeLabel: this.dom.compare.querySelector<HTMLElement>('.compare-tag-before'),
            afterLabel: this.dom.compare.querySelector<HTMLElement>('.compare-tag-after'),
            onChange: (value) => {
              setAttr(this.dom.compareRange, 'aria-valuetext', `${value}%`);
            },
          })
        : null;

    // Expose for debugging; also keeps the instance referenced in every build.
    (window as unknown as Record<string, unknown>).__compareSlider = this.compare;
    this.restoreFastOpts();
    this.wireUpload();
    this.wireWorkspace();
    this.wireEngine();
    this.wireExport();
    this.wireBatch();
    this.wireWindowGuards();
    this.syncSliderOutputs();
    this.updateZoomAfterResize();
  }

  /* ---------------------------------------------------------------- */
  /* Wiring: upload                                                   */
  /* ---------------------------------------------------------------- */

  private wireUpload(): void {
    const { dropzone, fileInput, browseBtn, demoBtn } = this.dom;

    browseBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput?.click();
    });

    dropzone?.addEventListener('click', (event) => {
      // Clicks on nested buttons are handled on their own.
      if ((event.target as HTMLElement).closest('button')) return;
      fileInput?.click();
    });

    dropzone?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        // Let nested buttons handle their own activation.
        if ((event.target as HTMLElement).closest('button')) return;
        event.preventDefault();
        fileInput?.click();
      }
    });

    fileInput?.addEventListener('change', async () => {
      const files = Array.from(fileInput.files ?? []);
      fileInput.value = ''; // allow re-selecting the same file
      if (files.length) await this.handleFiles(files);
    });

    demoBtn?.addEventListener('click', async (event) => {
      event.stopPropagation();
      try {
        const demo = await createDemoImage();
        await this.handleFiles([demo], { demo: true });
      } catch (error) {
        toastError(t('toast.errorGeneric'));
        console.error(error);
      }
    });

    // Window-wide drag guard: never let the browser navigate away.
    const hasFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');

    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
      document.documentElement.classList.add('is-dragging-files');
    };

    let dragDepth = 0;
    window.addEventListener('dragenter', (event) => {
      if (!hasFiles(event)) return;
      dragDepth += 1;
      document.documentElement.classList.add('is-dragging-files');
      toggleClass(dropzone, 'is-dragover', true);
    });
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', (event) => {
      if (!hasFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        document.documentElement.classList.remove('is-dragging-files');
        toggleClass(dropzone, 'is-dragover', false);
      }
    });
    window.addEventListener('drop', (event) => {
      event.preventDefault(); // stop navigation for stray drops
      dragDepth = 0;
      document.documentElement.classList.remove('is-dragging-files');
      toggleClass(dropzone, 'is-dragover', false);
      const files = collectFilesFromTransfer(event.dataTransfer);
      if (files.length) void this.handleFiles(files);
    });

    // Clipboard paste anywhere on the page.
    window.addEventListener('paste', (event) => {
      if (isEditableTarget(event.target)) return;
      const files = collectFilesFromTransfer(event.clipboardData);
      if (files.length === 0) {
        // Images copied from some apps arrive as HTML/plain text references.
        const text = event.clipboardData?.getData('text/plain')?.trim() ?? '';
        if (/^data:image\//i.test(text)) {
          void this.handleDataUrlPaste(text);
        }
        return;
      }
      event.preventDefault();
      void this.handleFiles(files);
    });
  }

  private async handleDataUrlPaste(dataUrl: string): Promise<void> {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const ext = (blob.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
      await this.handleFiles([new File([blob], `clipboard.${ext}`, { type: blob.type })]);
    } catch {
      toastError(t('toast.noFiles'));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Intake                                                           */
  /* ---------------------------------------------------------------- */

  private async handleFiles(files: (File | Blob)[], opts: { demo?: boolean } = {}): Promise<void> {
    if (!files.length) return;
    const { accepted, rejected, overflow } = await intakeFiles(files, { maxItems: MAX_BATCH });

    for (const item of rejected) {
      if (item.reason === 'unsupported') toastError(t('toast.unsupported', { name: item.name }));
      else if (item.reason === 'tooBig')
        toastError(
          t('toast.tooBig', {
            name: item.name,
            size: item.detail,
            max: Math.round(MAX_BYTES / (1024 * 1024)),
          }),
        );
      else toastError(t('toast.tooManyPixels', { name: item.name, mp: item.detail, max_mp: 40 }));
    }
    if (overflow > 0) toastWarning(t('toast.passedMax', { n: MAX_BATCH }));
    if (accepted.length === 0) return;

    const wasEmpty = this.items.length === 0;
    const newItems: BatchItem[] = accepted.map((item) => this.createBatchItem(item));
    this.items.push(...newItems);
    this.renderBatch();

    // Open the first image right away (or the first of a newly added batch).
    const first = newItems[0];
    this.selectItem(first.id, { focus: !wasEmpty });

    if (newItems.length > 1) {
      void this.runQueue(newItems);
    } else {
      void this.processItem(first, { fromQueue: false });
    }

    if (opts.demo) toastInfo(t('dropzone.demoHint'));
  }

  private createBatchItem(item: IntakeItem): BatchItem {
    return {
      id: `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      name: item.name,
      input: item.file,
      width: item.width,
      height: item.height,
      status: 'queued',
      result: null,
      resultUrl: null,
      error: null,
      ms: 0,
      row: null,
      thumbUrl: null,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Workspace                                                        */
  /* ---------------------------------------------------------------- */

  private wireWorkspace(): void {
    const { resetBtn, zoomIn, zoomOut, zoomFit, zoomReset, viewer } = this.dom;

    resetBtn?.addEventListener('click', () => {
      this.resetSelection();
    });
    zoomIn?.addEventListener('click', () => this.setZoom(this.zoom * 1.25));
    zoomOut?.addEventListener('click', () => this.setZoom(this.zoom / 1.25));
    zoomFit?.addEventListener('click', () => this.setZoom(this.fitZoom));
    zoomReset?.addEventListener('click', () => this.setZoom(1));

    // Ctrl/⌘ + wheel zoom inside the viewer.
    viewer?.addEventListener(
      'wheel',
      (event) => {
        if (!(event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        this.setZoom(this.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
      },
      { passive: false },
    );

    window.addEventListener(
      'resize',
      rafThrottle(() => {
        this.updateZoomAfterResize();
      }),
    );
  }

  private selectItem(id: string, { focus = false } = {}): void {
    this.activeId = id;
    const item = this.items.find((i) => i.id === id);
    if (!item) return;

    this.renderBatch();
    this.showWorkspace(true);

    // Original (before) image: revoke the previous URL.
    if (this.originalUrl) URL.revokeObjectURL(this.originalUrl);
    this.originalUrl = URL.createObjectURL(item.input);
    this.setImageSrc(this.dom.compareBefore, this.originalUrl);
    this.viewNatural = {
      width: item.width || 1,
      height: item.height || 1,
    };
    this.setFrameRatio(this.viewNatural.width, this.viewNatural.height);

    if (item.result && item.resultUrl) {
      this.applyResult(item.resultUrl, item.result, item.width, item.height, item.ms);
    } else {
      this.clearResultView();
      if (item.status === 'error' && item.error) {
        this.setProcessing(true, item.error, false);
      }
    }
    this.updateMeta();

    if (focus) this.focusWorkspace();
  }

  private focusWorkspace(): void {
    const target = this.dom.compareHandle ?? this.dom.compare ?? this.dom.workspace;
    if (!target) return;
    if (!target.hasAttribute('tabindex') && target !== this.dom.compareHandle) {
      target.setAttribute('tabindex', '-1');
    }
    if (!this.dom.workspace?.hidden) {
      target.focus({ preventScroll: true });
      this.dom.workspace?.scrollIntoView({
        behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
        block: 'start',
      });
    }
  }

  private showWorkspace(show: boolean): void {
    if (!this.dom.workspace) return;
    if (this.dom.workspace.hidden === !show) return;
    if (show) {
      this.dom.workspace.hidden = false;
      // Collapse the big dropzone to a compact bar so the result gets the
      // viewport; the window-wide drop guard still accepts files anywhere.
      document.documentElement.classList.add('has-image');
      this.dom.workspace.classList.add('is-revealing');
      window.setTimeout(() => this.dom.workspace?.classList.remove('is-revealing'), 320);
      // Prevent layout shift while the viewer sizes itself.
      this.setImageSrc(this.dom.compareBefore, this.originalUrl);
    } else {
      this.dom.workspace.hidden = true;
      document.documentElement.classList.remove('has-image');
    }
  }

  private setImageSrc(img: HTMLImageElement | null, url: string | null): void {
    if (!img) return;
    if (url) {
      if (img.getAttribute('src') !== url) img.src = url;
    } else if (img.hasAttribute('src')) {
      img.removeAttribute('src');
    }
  }

  private clearResultView(): void {
    this.setImageSrc(this.dom.compareAfter, null);
    toggleClass(this.dom.viewer, 'is-empty', true);
  }

  private applyResult(url: string, blob: Blob, width: number, height: number, ms: number): void {
    this.current = { blob, url, width, height, ms };
    this.setImageSrc(this.dom.compareAfter, url);
    toggleClass(this.dom.viewer, 'is-empty', false);
    this.viewNatural = { width: width || 1, height: height || 1 };
    this.setFrameRatio(this.viewNatural.width, this.viewNatural.height);
    this.updateZoomAfterResize();
    this.updateMeta();
  }

  /** Give the compare frame the image's aspect ratio so there is no jump. */
  private setFrameRatio(width: number, height: number): void {
    const ratio = height > 0 ? width / height : 1.5;
    this.dom.viewer?.style.setProperty('--frame-ratio', String(Number(ratio.toFixed(4))));
  }

  private updateMeta(): void {
    const item = this.activeItem;
    const width = this.current?.width ?? item?.width ?? 0;
    const height = this.current?.height ?? item?.height ?? 0;
    const parts: string[] = [];
    if (width && height) {
      parts.push(formatDims(width, height), formatMegapixels(width, height));
    }
    if (this.current) parts.push(formatBytes(this.current.blob.size));
    setText(this.dom.metaDims, parts.length ? parts.join(' · ') : '—');
    setText(
      this.dom.metaSize,
      this.current ? `Xử lý trong ${formatSeconds(this.current.ms / 1000)}` : '—',
    );
  }

  /* ---------------------------------------------------------------- */
  /* Processing                                                       */
  /* ---------------------------------------------------------------- */

  private get activeItem(): BatchItem | null {
    return this.items.find((i) => i.id === this.activeId) ?? null;
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    document.documentElement.classList.toggle('is-busy', busy);
    setDisabled(
      [
        this.dom.exportPng,
        this.dom.exportJpg,
        this.dom.exportWebp,
        this.dom.downloadBtn,
        this.dom.copyBtn,
        this.dom.browseBtn,
        this.dom.demoBtn,
        this.dom.batchZip,
        this.dom.resetBtn,
      ],
      busy,
    );
  }

  private setProcessing(active: boolean, message: string, indeterminate: boolean): void {
    const { processingOverlay, processingText } = this.dom;
    if (!processingOverlay) return;
    processingOverlay.hidden = !active;
    processingOverlay.classList.toggle('is-indeterminate', indeterminate);
    if (active) {
      setText(processingText, message);
      const bar = processingOverlay.querySelector<HTMLElement>('[role="progressbar"]');
      setAttr(bar, 'aria-valuenow', indeterminate ? null : '0');
      setAttr(bar, 'aria-valuetext', message);
    }
    setAttr(this.dom.viewer, 'aria-busy', active ? 'true' : 'false');
  }

  /**
   * Model-download progress. index.html carries [data-ai-bar] twice: once in
   * the AI control panel (persistent read-out) and once inside the processing
   * overlay. Both live inside their own [data-ai-progress] wrapper, so we
   * scope the bar/text updates to the wrapper that actually contains the bar.
   */
  private setAiProgress(ratio: number | null, label: string, detail: string): void {
    const { aiProgress, aiBar } = this.dom;
    const percent = ratio === null ? '' : formatPercent(ratio);
    const text = [label, percent, detail ? `(${detail})` : ''].filter(Boolean).join(' · ');
    const active = ratio !== null || Boolean(label);

    if (aiProgress) {
      aiProgress.hidden = !active;
      setText(aiProgress.querySelector('[data-ai-progress-text]'), text);
      const bar = aiProgress.querySelector<HTMLElement>('[data-ai-bar]');
      if (bar) bar.style.width = `${Math.round((ratio ?? 0) * 100)}%`;
      const progressEl = aiProgress.querySelector<HTMLElement>('[role="progressbar"]');
      setAttr(progressEl, 'aria-valuenow', ratio === null ? null : Math.round((ratio ?? 0) * 100));
      setAttr(progressEl, 'aria-valuetext', text || null);
    }

    // Mirror into the processing overlay (its progressbar is separate).
    const overlay = this.dom.processingOverlay;
    if (overlay && aiBar) {
      const scopedBar = overlay.contains(aiBar) ? aiBar : overlay.querySelector<HTMLElement>('[data-ai-bar]');
      if (scopedBar) scopedBar.style.width = `${Math.round((ratio ?? 0) * 100)}%`;
      const scopedText = overlay.querySelector<HTMLElement>('[data-ai-progress-text]');
      setText(scopedText, ratio === null ? '' : detail ? `${percent} · ${detail}` : percent);
    }
  }

  /** Process one item (fast or AI) and reflect the result in the UI. */
  private async processItem(item: BatchItem, opts: { fromQueue: boolean }): Promise<void> {
    const engineId = domEngineId(this.dom);
    const isActive = item.id === this.activeId;

    if (item.status === 'processing') return;
    item.status = 'processing';
    item.error = null;
    this.renderBatch();
    if (isActive) this.setProcessing(true, t(engineId === 'ai' ? 'status.aiRun' : 'status.fast'), engineId !== 'ai');

    const started = performance.now();
    const token = engineId === 'ai' ? ++this.aiToken : ++this.fastToken;
    if (!opts.fromQueue) this.setBusy(true);

    try {
      const engine = await loadEngine();
      let result: Blob;
      if (engineId === 'ai') {
        result = await engine.removeBackgroundAi(
          item.input,
          (p: AiProgress) => this.onAiProgress(p, item),
          this.modelSelect?.value() ?? DEFAULT_AI_MODEL,
        );
      } else {
        const preview = await this.decodePreview(item);
        try {
          result = await engine.removeBackgroundFast(preview as ImageBitmap, {
            tolerance: this.fastOpts.tolerance,
            feather: this.fastOpts.feather,
            despeckle: this.fastOpts.despeckle,
            maxDimension: 2048,
          });
        } finally {
          closeBitmap(preview);
        }
      }

      const ms = performance.now() - started;
      // A newer run superseded this one (user moved a slider / switched engine).
      const stillCurrent = (engineId === 'ai' ? this.aiToken : this.fastToken) === token;

      this.setItemResult(item, result, ms);
      if (isActive && stillCurrent) {
        this.applyResult(item.resultUrl!, result, item.width, item.height, ms);
        this.setProcessing(false, '', false);
      }
      if (engineId === 'fast') this.saveFastOpts();
    } catch (error) {
      const message = this.describeError(error);
      item.status = 'error';
      item.error = message;
      this.renderBatch();
      if (isActive) {
        this.setProcessing(false, '', false);
        this.showErrorBanner(message);
      }
      toastError(message, {
        action: { label: t('batch.retry'), run: () => void this.processItem(item, { fromQueue: false }) },
      });
    } finally {
      if (!opts.fromQueue) this.setBusy(false);
      this.updateBatchButtons();
    }
  }

  private setItemResult(item: BatchItem, result: Blob, ms: number): void {
    if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
    item.resultUrl = URL.createObjectURL(result);
    item.result = result;
    item.status = 'done';
    item.ms = ms;
    item.error = null;
    // Keep the very first item as the "current" image being viewed.
    this.renderBatch();
  }

  private async decodePreview(item: BatchItem): Promise<DecodedImage> {
    const decoded = await decodeImage(item.input);
    const { width, height } = drawableSize(decoded);
    if (!item.width || !item.height) {
      item.width = width;
      item.height = height;
      this.setFrameRatio(width, height);
    }
    return decoded;
  }

  private onAiProgress(p: AiProgress, item: BatchItem): void {
    if (item.id !== this.activeId) return;
    const { label, detail } = describeProgress(p);
    this.setAiProgress(clamp(p.ratio || 0, 0, 1), label, detail);
    this.setProcessing(true, label, false);
  }

  private describeError(error: unknown): string {
    if (error instanceof EngineUnavailableError) return t('toast.engineUnavailable');
    const msg = error instanceof Error ? error.message : String(error ?? '');
    if (/memory|allocation|out of memory|OOM|too large/i.test(msg)) {
      return t('error.tooLarge');
    }
    if (/network|fetch|load|import|model/i.test(msg)) {
      return t('error.model');
    }
    return msg ? `${t('toast.errorGeneric')} (${msg})` : t('toast.errorGeneric');
  }

  private showErrorBanner(message: string | null): void {
    const banner = this.dom.errorBanner;
    if (!banner) return;
    if (!message) {
      banner.hidden = true;
      setText(banner, '');
      return;
    }
    banner.hidden = false;
    setText(banner, message);
  }

  /** Sequential batch runner with per-item status. */
  private async runQueue(items: BatchItem[]): Promise<void> {
    this.setBusy(true);
    let doneCount = 0;
    try {
      for (const item of items) {
        if (item.status === 'done') continue;
        this.setAiProgress(item.id === this.activeId ? 0 : null, t('batch.processing'), '');
        await this.processItem(item, { fromQueue: true });
        doneCount += 1;
      }
    } finally {
      this.setBusy(false);
      this.updateBatchButtons();
      this.renderBatch();
    }
    if (doneCount > 1) toastSuccess(t('toast.batchDone', { n: doneCount }));
    this.setAiProgress(null, '', '');
  }

  /* ---------------------------------------------------------------- */
  /* Engine switch + sliders                                          */
  /* ---------------------------------------------------------------- */

  private wireEngine(): void {
    for (const input of this.dom.engineInputs) {
      input.addEventListener('change', () => {
        if (!input.checked) return;
        this.applyEngineVisibility();
        // Re-run the active image on the new engine (debounced ~250ms so rapid
        // radio toggling via arrow keys doesn't queue several runs).
        this.scheduleEngineReapply();
      });
    }

    for (const key of ['tolerance', 'feather', 'despeckle'] as const) {
      const ref = this.dom.sliders[key];
      if (!ref) continue;
      const commit = () => {
        this.fastOpts[key] = clamp(Number(ref.input.value) / 100, 0, 1);
        this.syncSliderOutputs();
        this.scheduleFastReapply();
      };
      ref.input.addEventListener('input', commit);
      ref.input.addEventListener('change', commit);
      setAttr(ref.input, 'aria-valuetext', `${ref.input.value}%`);
    }

    this.applyEngineVisibility();
  }

  /** Engine switch → re-process the current image after a short debounce. */
  private scheduleEngineReapply(): void {
    window.clearTimeout(this.engineTimer);
    this.engineTimer = window.setTimeout(() => {
      // If a run is in flight, retry shortly: the user's choice wins.
      if (this.busy) {
        this.scheduleEngineReapply();
        return;
      }
      const item = this.activeItem;
      if (!item) return;
      item.status = 'queued';
      void this.processItem(item, { fromQueue: false });
    }, ENGINE_SWITCH_DEBOUNCE_MS);
  }

  /** Fast sliders are only meaningful in Fast mode — disable them in AI mode. */
  private setFastSlidersEnabled(enabled: boolean): void {
    for (const key of ['tolerance', 'feather', 'despeckle'] as const) {
      const ref = this.dom.sliders[key];
      if (ref) ref.input.disabled = !enabled;
    }
  }

  private ensureModelSelect(): void {
    if (this.modelSelect) return;
    this.modelSelect = createModelSelect(this.dom.aiPanel);
  }

  private applyEngineVisibility(): void {
    this.ensureModelSelect();
    const engineId = domEngineId(this.dom);
    const isAi = engineId === 'ai';
    if (this.dom.aiPanel) this.dom.aiPanel.hidden = !isAi;
    if (this.dom.fastPanel) this.dom.fastPanel.hidden = isAi;
    if (this.dom.modeHint) this.dom.modeHint.hidden = !isAi;
    this.setFastSlidersEnabled(!isAi);
    document.documentElement.dataset.engine = engineId;
    // Keep the last known download state, but don't show a stale 100% bar.
    this.setAiProgress(null, '', '');
  }

  private syncSliderOutputs(): void {
    for (const key of ['tolerance', 'feather', 'despeckle'] as const) {
      const ref = this.dom.sliders[key];
      if (!ref) continue;
      const value = Number(ref.input.value);
      if (!Number.isFinite(value)) continue;
      this.fastOpts[key] = clamp(value / 100, 0, 1);
      setText(ref.output, `${Math.round(value)}%`);
      setAttr(ref.input, 'aria-valuetext', `${Math.round(value)}%`);
      // Paint the filled part of the track.
      ref.input.style.setProperty('--fill', `${Math.round(value)}%`);
    }
  }

  private scheduleFastReapply(): void {
    if (domEngineId(this.dom) !== 'fast') return;
    window.clearTimeout(this.fastTimer);
    this.fastTimer = window.setTimeout(() => {
      const item = this.activeItem;
      if (!item || this.busy) return;
      void this.processItem(item, { fromQueue: false });
    }, 220);
  }

  private restoreFastOpts(): void {
    try {
      const raw = localStorage.getItem('xnanh:fast-opts');
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<typeof this.fastOpts>;
        for (const key of ['tolerance', 'feather', 'despeckle'] as const) {
          if (typeof parsed[key] === 'number') this.fastOpts[key] = clamp(parsed[key]!, 0, 1);
          const ref = this.dom.sliders[key];
          if (ref) ref.input.value = String(Math.round(this.fastOpts[key] * 100));
        }
      }
    } catch {
      /* storage unavailable — defaults are fine */
    }
  }

  private saveFastOpts(): void {
    try {
      localStorage.setItem('xnanh:fast-opts', JSON.stringify(this.fastOpts));
    } catch {
      /* ignore quota/privacy-mode errors */
    }
  }

  /* ---------------------------------------------------------------- */
  /* Export                                                           */
  /* ---------------------------------------------------------------- */

  private wireExport(): void {
    const { exportPng, exportJpg, exportWebp, downloadBtn, copyBtn, exportBg, bgSwatches } = this.dom;

    const guard = (fn: () => Promise<void>) => () => {
      if (!this.current) {
        toastWarning(t('error.noExport'));
        return;
      }
      fn().catch((error: unknown) => {
        console.error(error);
        toastError(error instanceof Error ? error.message : t('toast.errorGeneric'));
      });
    };

    downloadBtn?.addEventListener('click', guard(() => this.exportImage('png', true)));
    exportPng?.addEventListener('click', guard(() => this.exportImage('png', false)));
    exportJpg?.addEventListener('click', guard(() => this.exportImage('jpeg', false)));
    exportWebp?.addEventListener('click', guard(() => this.exportImage('webp', false)));

    copyBtn?.addEventListener(
      'click',
      guard(async () => {
        const result = this.current;
        if (!result) return;
        try {
          const mode = await writeImageToClipboard(result.blob);
          toastSuccess(mode === 'image' ? t('toast.copied') : t('toast.copiedHtml'));
        } catch (error) {
          toastError(
            t('toast.copyFailed', { msg: error instanceof Error ? error.message : String(error) }),
          );
        }
      }),
    );

    exportBg?.addEventListener('input', () => this.syncSwatchState());
    for (const swatch of bgSwatches) {
      swatch.addEventListener('click', () => {
        const color = swatch.getAttribute('data-bg-swatch') ?? '#ffffff';
        if (exportBg) exportBg.value = color;
        this.syncSwatchState();
      });
    }
    this.syncSwatchState();
  }

  private syncSwatchState(): void {
    const value = (this.dom.exportBg?.value ?? '#ffffff').toLowerCase();
    for (const swatch of this.dom.bgSwatches) {
      const color = (swatch.getAttribute('data-bg-swatch') ?? '').toLowerCase();
      swatch.classList.toggle('is-active', color === value);
      swatch.setAttribute('aria-pressed', String(color === value));
    }
  }

  private exportName(format: 'png' | 'jpg' | 'webp'): string {
    const item = this.activeItem;
    const base = slugify(splitFileName(item?.name ?? 'anh').base) || 'anh';
    return `${base}-no-bg.${format}`;
  }

  private async exportImage(format: 'png' | 'jpeg' | 'webp', transparent: boolean): Promise<void> {
    const result = this.current;
    if (!result) return;
    const ext = format === 'jpeg' ? 'jpg' : format;
    const name = this.exportName(ext);

    if (transparent && format === 'png') {
      downloadBlob(result.blob, name);
      toastSuccess(t('toast.downloaded', { name }));
      return;
    }

    // Rasterise with a chosen background colour (JPG cannot carry alpha).
    const bmp = await decodeImage(result.blob);
    const { width, height } = drawableSize(bmp);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      closeBitmap(bmp);
      throw new Error(t('error.canvas'));
    }
    if (transparent) {
      // PNG with transparency requested through a non-transparent path.
      ctx.clearRect(0, 0, width, height);
    } else {
      const [r, g, b] = hexToRgb(this.dom.exportBg?.value ?? '#ffffff');
      ctx.fillStyle = `rgb(${r} ${g} ${b})`;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(bmp, 0, 0);
    closeBitmap(bmp);

    const mime = `image/${format}`;
    let blob: Blob;
    try {
      blob = await canvasToBlob(canvas, mime, format === 'jpeg' ? 0.92 : 0.95);
    } catch {
      if (format === 'webp') {
        toastWarning(t('export.webpFallback'));
        blob = await canvasToBlob(canvas, 'image/png');
        downloadBlob(blob, this.exportName('png'));
        return;
      }
      throw new Error(t('error.encoding'));
    }
    if (format === 'webp' && blob.type !== 'image/webp') {
      toastWarning(t('export.webpFallback'));
      downloadBlob(await canvasToBlob(canvas, 'image/png'), this.exportName('png'));
      return;
    }

    downloadBlob(blob, name);
    toastSuccess(t('toast.downloaded', { name }));
  }

  /* ---------------------------------------------------------------- */
  /* Batch                                                            */
  /* ---------------------------------------------------------------- */

  private wireBatch(): void {
    this.dom.batchZip?.addEventListener('click', () => {
      void this.downloadZip();
    });
    this.dom.batchClear?.addEventListener('click', () => {
      this.resetSelection();
    });
    this.renderBatch();
  }

  private renderBatch(): void {
    const list = this.dom.batchList;
    setText(this.dom.batchCount, String(this.items.length));
    this.updateBatchButtons();
    if (!list) return;

    const hasItems = this.items.length > 0;
    if (this.dom.batchEmpty) this.dom.batchEmpty.hidden = hasItems;
    // The batch card is only useful with more than one file.
    const card = list.closest('.batch');
    if (card instanceof HTMLElement) card.hidden = this.items.length < 2;

    // Build rows once, then only patch status changes (no flicker/scroll jump).
    for (const item of this.items) {
      if (!item.row) {
        item.row = this.createRow(item);
        list.appendChild(item.row);
      }
      this.updateRow(item);
    }
    // Drop rows for removed items.
    for (const row of Array.from(list.children)) {
      if (!this.items.some((item) => item.row === row)) row.remove();
    }
  }

  private createRow(item: BatchItem): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'batch-item';
    li.dataset.id = item.id;
    li.innerHTML = `
      <button type="button" class="batch-thumb" tabindex="-1" aria-hidden="true"></button>
      <div class="batch-info">
        <span class="batch-name"></span>
        <span class="batch-meta"></span>
      </div>
      <span class="batch-status" role="status"></span>
      <button type="button" class="batch-open btn btn-ghost btn-sm"></button>
      <button type="button" class="batch-download btn btn-ghost btn-sm" hidden></button>
      <button type="button" class="batch-remove icon-btn icon-btn-sm">✕</button>`;

    const nameEl = li.querySelector('.batch-name');
    if (nameEl) nameEl.textContent = item.name;
    setText(li.querySelector('.batch-open'), t('batch.view'));
    setText(li.querySelector('.batch-download'), t('batch.download'));
    setAttr(li.querySelector('.batch-remove'), 'aria-label', t('batch.remove'));
    const thumb = li.querySelector<HTMLElement>('.batch-thumb');
    if (thumb) {
      item.thumbUrl = URL.createObjectURL(item.input);
      thumb.style.backgroundImage = `url("${item.thumbUrl}")`;
    }
    const open = li.querySelector<HTMLButtonElement>('.batch-open');
    open?.addEventListener('click', () => this.selectItem(item.id, { focus: true }));
    // Clicking the row itself also opens the image.
    li.addEventListener('click', (event) => {
      if ((event.target as HTMLElement).closest('button') && event.target !== open) return;
      this.selectItem(item.id, { focus: true });
    });
    const dl = li.querySelector<HTMLButtonElement>('.batch-download');
    dl?.addEventListener('click', () => {
      if (!item.result) return;
      const name = `${slugify(splitFileName(item.name).base) || 'anh'}-no-bg.png`;
      downloadBlob(item.result, name);
      toastSuccess(t('toast.downloaded', { name }));
    });
    const remove = li.querySelector<HTMLButtonElement>('.batch-remove');
    remove?.addEventListener('click', () => this.removeItem(item.id));
    return li;
  }

  private updateRow(item: BatchItem): void {
    const row = item.row;
    if (!row) return;
    row.classList.toggle('is-active', item.id === this.activeId);
    row.dataset.status = item.status;
    setAttr(row.querySelector('.batch-open'), 'aria-current', item.id === this.activeId ? 'true' : null);

    const status = row.querySelector('.batch-status');
    const meta = row.querySelector('.batch-meta');
    const dl = row.querySelector<HTMLButtonElement>('.batch-download');
    const open = row.querySelector<HTMLButtonElement>('.batch-open');

    const dims = item.width && item.height ? formatDims(item.width, item.height) : '';
    let metaText = dims;
    let statusText = '';
    switch (item.status) {
      case 'queued':
        statusText = t('batch.queued');
        break;
      case 'processing':
        statusText = t('batch.processing');
        break;
      case 'done':
        statusText = formatSeconds(item.ms / 1000);
        metaText = [dims, item.result ? formatBytes(item.result.size) : ''].filter(Boolean).join(' · ');
        break;
      case 'error':
        statusText = 'Lỗi';
        break;
    }
    if (meta) meta.textContent = metaText;
    if (status) status.textContent = statusText;
    setAttr(status, 'title', item.error ?? '');
    if (dl) dl.hidden = item.status !== 'done';
    if (open) open.hidden = item.status !== 'done';
  }

  private removeItem(id: string): void {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return;
    const [removed] = this.items.splice(index, 1);
    removed.row?.remove();
    if (removed.resultUrl) URL.revokeObjectURL(removed.resultUrl);
    if (removed.thumbUrl) URL.revokeObjectURL(removed.thumbUrl);
    removed.row = null;

    if (this.activeId === id) {
      const next = this.items[index] ?? this.items[index - 1] ?? null;
      this.activeId = null;
      if (next) this.selectItem(next.id);
      else this.resetSelection();
    }
    this.renderBatch();
  }

  private updateBatchButtons(): void {
    const doneCount = this.items.filter((item) => item.status === 'done' && item.result).length;
    if (this.dom.batchZip) {
      this.dom.batchZip.disabled = doneCount === 0 || this.busy;
      this.dom.batchZip.setAttribute('aria-disabled', String(this.dom.batchZip.disabled));
      this.dom.batchZip.title = doneCount ? t('zip.buttonTitle', { n: doneCount }) : t('toast.zipEmpty');
    }
    if (this.dom.batchClear) this.dom.batchClear.disabled = this.items.length === 0;
  }

  private async downloadZip(): Promise<void> {
    const ready = this.items.filter((item): item is BatchItem & { result: Blob } => !!item.result);
    if (ready.length === 0) {
      toastWarning(t('toast.zipEmpty'));
      return;
    }
    const label = this.dom.batchZip;
    const previous = label?.textContent ?? '';
    if (label) {
      label.disabled = true;
      label.textContent = t('zip.busy');
    }
    try {
      const taken = new Set<string>();
      const files = ready.map((item) => {
        const base = slugify(splitFileName(item.name).base) || 'anh';
        return { name: uniqueName(`${base}-no-bg.png`, taken), blob: item.result };
      });
      const zip = await zipBlobs(files);
      downloadBlob(zip, `xoa-nen-anh-${ready.length}-anh.zip`);
      toastSuccess(t('zip.done', { n: ready.length }));
    } catch (error) {
      console.error(error);
      toastError(t('zip.fail'));
    } finally {
      if (label) {
        label.disabled = false;
        label.textContent = previous;
      }
      this.updateBatchButtons();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Reset                                                            */
  /* ---------------------------------------------------------------- */

  private resetSelection(): void {
    window.clearTimeout(this.fastTimer);
    window.clearTimeout(this.engineTimer);
    this.fastToken += 1;
    this.aiToken += 1;

    for (const item of this.items) {
      if (item.resultUrl) URL.revokeObjectURL(item.resultUrl);
      if (item.thumbUrl) URL.revokeObjectURL(item.thumbUrl);
      item.resultUrl = null;
      item.thumbUrl = null;
      item.row?.remove();
      item.row = null;
    }
    this.items = [];
    this.activeId = null;
    this.current = null;

    if (this.originalUrl) URL.revokeObjectURL(this.originalUrl);
    this.originalUrl = null;

    this.setImageSrc(this.dom.compareBefore, null);
    this.setImageSrc(this.dom.compareAfter, null);
    this.setProcessing(false, '', false);
    this.showErrorBanner(null);
    this.showWorkspace(false);
    this.setAiProgress(null, '', '');
    window.clearTimeout(this.engineTimer);
    this.renderBatch();

    const focusTarget = this.dom.browseBtn ?? document.getElementById('app');
    focusTarget?.focus({ preventScroll: true });
  }

  /* ---------------------------------------------------------------- */
  /* Zoom                                                             */
  /* ---------------------------------------------------------------- */

  private setZoom(zoom: number): void {
    const next = clamp(zoom, ZOOM_MIN, ZOOM_MAX);
    this.zoom = next;
    this.applyZoom();
  }

  private updateZoomAfterResize(): void {
    const stage = this.dom.viewer;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const pad = 24;
    const availableW = Math.max(80, rect.width - pad);
    const availableH = Math.max(80, Math.max(240, window.innerHeight * 0.62) - pad);
    const w = this.viewNatural.width;
    const h = this.viewNatural.height;
    this.fitZoom = clamp(Math.min(availableW / w, availableH / h), ZOOM_MIN, ZOOM_MAX);
    this.applyZoom();
  }

  private applyZoom(): void {
    const stage = this.dom.viewer;
    if (!stage) return;
    stage.style.setProperty('--zoom', String(this.zoom));
    stage.classList.toggle('is-zoomed', this.zoom > 1.01);
    setText(this.dom.zoomLabel, `${Math.round(this.zoom * 100)}%`);
    setAttr(this.dom.zoomLabel, 'aria-live', 'polite');
    const disabledOut = this.zoom <= ZOOM_MIN + 1e-4;
    const disabledIn = this.zoom >= ZOOM_MAX - 1e-4;
    if (this.dom.zoomOut) this.dom.zoomOut.disabled = disabledOut;
    if (this.dom.zoomIn) this.dom.zoomIn.disabled = disabledIn;
    if (this.dom.zoomFit) this.dom.zoomFit.setAttribute('aria-pressed', String(Math.abs(this.zoom - this.fitZoom) < 0.01));
  }

  /* ---------------------------------------------------------------- */
  /* Global guards                                                    */
  /* ---------------------------------------------------------------- */

  private wireWindowGuards(): void {
    // Keep Ctrl/⌘+V bubbling even when focus is on a button.
    window.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
        // Native paste event will fire; nothing to do, but make sure our
        // handler is not shadowed by a focused custom widget.
        document.documentElement.classList.add('paste-ready');
      }
      if (event.key === 'Escape' && this.activeItem) {
        this.dom.compareHandle?.focus({ preventScroll: true });
      }
    });

    // Warn before losing unsaved results (only while processing).
    window.addEventListener('beforeunload', (event) => {
      if (!this.busy) return;
      event.preventDefault();
      event.returnValue = '';
    });

    // Free decoded resources when the tab is hidden for a long time.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        this.updateZoomAfterResize();
      }
    });
  }
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function boot(): void {
  try {
    new App();
  } catch (error) {
    console.error('[xoa-nen-anh] boot failed', error);
    toastError(t('toast.engineUnavailable'));
  }
  // Performance-only: enables WASM multi-threading for the AI engine.
  // Deliberately not awaited — it may trigger a one-time reload.
  void setupCrossOriginIsolation();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}

export {};
