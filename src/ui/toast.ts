/**
 * Accessible toast notifications (aria-live polite region).
 * Auto-dismisses, deduplicates identical messages and pauses on hover.
 */
import { $ } from './utils';

export type ToastKind = 'info' | 'success' | 'error' | 'warning';

interface ToastOptions {
  kind?: ToastKind;
  /** ms before auto-dismiss; 0 = sticky (must be closed by hand). */
  duration?: number;
  /** Optional action button, e.g. "Tải lại". */
  action?: { label: string; run: () => void };
}

const ICONS: Record<ToastKind, string> = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  success: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.4 2.4 4.6-5"/>',
  error:
    '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
  warning:
    '<path d="M12 3.6 21 19.5H3L12 3.6Z"/><path d="M12 9.5v4M12 16.5h.01"/>',
};

const MAX_VISIBLE = 4;
const recent = new Map<string, number>();

function resolveRegion(host?: Element | null): HTMLElement {
  const region =
    (host instanceof HTMLElement ? host : null) ??
    $('#toasts') ??
    (() => {
      const fallback = document.createElement('div');
      fallback.id = 'toasts';
      fallback.className = 'toasts';
      fallback.setAttribute('role', 'status');
      fallback.setAttribute('aria-live', 'polite');
      fallback.setAttribute('aria-relevant', 'additions');
      document.body.appendChild(fallback);
      return fallback;
    })();
  if (!region.hasAttribute('aria-live')) {
    region.setAttribute('role', 'status');
    region.setAttribute('aria-live', 'polite');
  }
  return region;
}

export function toast(message: string, opts: ToastOptions = {}): void {
  const { kind = 'info', duration = kind === 'error' ? 7000 : 3600, action } = opts;
  const now = Date.now();
  const key = `${kind}:${message}`;
  // Suppress identical spam within 3s (e.g. dropping 10 bad files at once).
  const last = recent.get(key);
  if (last && now - last < 3000) return;
  recent.set(key, now);

  const region = resolveRegion();
  while (region.querySelectorAll('.toast').length >= MAX_VISIBLE) {
    region.querySelector('.toast')?.remove();
  }

  const node = document.createElement('div');
  node.className = `toast toast--${kind}`;
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  node.innerHTML = `
    <svg class="toast__icon" viewBox="0 0 24 24" aria-hidden="true" fill="none"
      stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      ${ICONS[kind]}
    </svg>
    <p class="toast__msg"></p>
    ${action ? '<button type="button" class="toast__action"></button>' : ''}
    <button type="button" class="toast__close" aria-label="Đóng thông báo">
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor"
        stroke-width="1.8" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
    </button>`;

  const msg = node.querySelector<HTMLParagraphElement>('.toast__msg');
  if (msg) msg.textContent = message;

  const actionBtn = node.querySelector<HTMLButtonElement>('.toast__action');
  if (actionBtn && action) {
    actionBtn.textContent = action.label;
    actionBtn.addEventListener('click', () => {
      action.run();
      dismiss();
    });
  }

  let timer = 0;
  let remaining = duration;
  let startedAt = 0;

  const dismiss = () => {
    window.clearTimeout(timer);
    node.classList.add('toast--out');
    node.addEventListener('animationend', () => node.remove(), { once: true });
    // Safety net when animations are disabled.
    window.setTimeout(() => node.remove(), 400);
  };

  const start = () => {
    if (duration <= 0) return;
    startedAt = Date.now();
    timer = window.setTimeout(dismiss, remaining);
  };
  const pause = () => {
    if (duration <= 0) return;
    window.clearTimeout(timer);
    remaining = Math.max(600, remaining - (Date.now() - startedAt));
  };

  node.querySelector('.toast__close')?.addEventListener('click', dismiss);
  node.addEventListener('mouseenter', pause);
  node.addEventListener('mouseleave', start);
  node.addEventListener('focusin', pause);
  node.addEventListener('focusout', start);

  region.appendChild(node);
  // Force a frame so the enter animation plays on first paint.
  requestAnimationFrame(() => node.classList.add('toast--in'));
  start();
}

export const toastError = (message: string, opts?: Omit<ToastOptions, 'kind'>) =>
  toast(message, { ...opts, kind: 'error' });
export const toastSuccess = (message: string, opts?: Omit<ToastOptions, 'kind'>) =>
  toast(message, { ...opts, kind: 'success' });
export const toastInfo = (message: string, opts?: Omit<ToastOptions, 'kind'>) =>
  toast(message, { ...opts, kind: 'info' });
export const toastWarning = (message: string, opts?: Omit<ToastOptions, 'kind'>) =>
  toast(message, { ...opts, kind: 'warning' });
