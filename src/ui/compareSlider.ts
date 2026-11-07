/**
 * Before/after comparison slider.
 *
 * - The visual handle is a <button role="slider"> (pointer + keyboard).
 * - An optional overlay <input type="range"> ([data-compare-range]) provides
 *   native keyboard + screen-reader support; both stay in sync.
 * - Pointer events (mouse/pen/touch) all run through Pointer Events, so touch
 *   dragging works without extra touch handlers.
 */

const KEY_STEP = 2;
const KEY_STEP_LARGE = 10;

export interface CompareSliderOptions {
  wrapper: HTMLElement;
  handle: HTMLElement;
  range?: HTMLInputElement | null;
  beforeLabel?: HTMLElement | null;
  afterLabel?: HTMLElement | null;
  /** Fired while the user drags (for "hide labels" etc.). */
  onChange?: (value: number) => void;
}

export class CompareSlider {
  private value = 50;
  private dragging = false;
  private frame = 0;

  constructor(private readonly opts: CompareSliderOptions) {
    const { wrapper, handle, range } = opts;

    handle.addEventListener('pointerdown', this.onPointerDown);
    handle.addEventListener('keydown', this.onKeyDown);
    wrapper.addEventListener('pointerdown', this.onTrackPointerDown);

    if (range) {
      range.min = '0';
      range.max = '100';
      range.step = '1';
      range.value = String(this.value);
      range.addEventListener('input', () => {
        this.set(Number(range.value), false);
      });
      // Stop pointer events on the hidden range from starting a drag too.
      range.addEventListener('pointerdown', (e) => {
        if (!this.dragging) return;
        e.stopPropagation();
      });
    }

    this.apply();
  }

  get current(): number {
    return this.value;
  }

  set(value: number, notify = true): void {
    const next = Math.min(100, Math.max(0, Math.round(value)));
    if (next === this.value) return;
    this.value = next;
    this.apply();
    if (notify) this.opts.onChange?.(this.value);
  }

  reset(): void {
    this.set(50);
  }

  private apply(): void {
    const { wrapper, handle, range, beforeLabel, afterLabel } = this.opts;
    wrapper.style.setProperty('--compare', `${this.value}%`);
    handle.setAttribute('aria-valuenow', String(this.value));
    handle.setAttribute('aria-valuetext', `Ảnh gốc ${this.value}%, đã xóa nền ${100 - this.value}%`);
    if (range && range.value !== String(this.value)) range.value = String(this.value);
    // Fade the side labels as the divider approaches them.
    if (beforeLabel) {
      beforeLabel.style.opacity = this.value < 14 ? '0' : '';
    }
    if (afterLabel) {
      afterLabel.style.opacity = this.value > 86 ? '0' : '';
    }
  }

  private positionFromEvent(clientX: number): number {
    const rect = this.opts.wrapper.getBoundingClientRect();
    if (rect.width <= 0) return this.value;
    return ((clientX - rect.left) / rect.width) * 100;
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.beginDrag(event.pointerId);
  };

  private onTrackPointerDown = (event: PointerEvent): void => {
    if (event.button !== undefined && event.button !== 0) return;
    if ((event.target as HTMLElement).closest('[data-compare-range]')) return;
    event.preventDefault();
    this.set(this.positionFromEvent(event.clientX));
    this.beginDrag(event.pointerId);
  };

  private beginDrag(pointerId: number): void {
    const { handle, wrapper } = this.opts;
    this.dragging = true;
    wrapper.classList.add('is-dragging');
    try {
      handle.setPointerCapture(pointerId);
    } catch {
      /* pointer already released */
    }
    handle.addEventListener('pointermove', this.onPointerMove);
    handle.addEventListener('pointerup', this.onPointerUp);
    handle.addEventListener('pointercancel', this.onPointerUp);
    handle.focus({ preventScroll: true });
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.dragging) return;
    const x = event.clientX;
    // rAF-coalesce: pointermove can fire faster than the display refreshes.
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.dragging) this.set(this.positionFromEvent(x));
    });
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    const { handle, wrapper } = this.opts;
    wrapper.classList.remove('is-dragging');
    handle.removeEventListener('pointermove', this.onPointerMove);
    handle.removeEventListener('pointerup', this.onPointerUp);
    handle.removeEventListener('pointercancel', this.onPointerUp);
    try {
      handle.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
  };

  private onKeyDown = (event: KeyboardEvent): void => {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let handled = true;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown':
        this.set(this.value - step);
        break;
      case 'ArrowRight':
      case 'ArrowUp':
        this.set(this.value + step);
        break;
      case 'Home':
        this.set(0);
        break;
      case 'End':
        this.set(100);
        break;
      case 'PageDown':
        this.set(this.value - KEY_STEP_LARGE * 2);
        break;
      case 'PageUp':
        this.set(this.value + KEY_STEP_LARGE * 2);
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  };
}
