/**
 * Small, dependency-free helpers shared by the UI modules.
 *
 * Everything here is UI-layer only: it must never import the engine or any
 * third-party package so the main bundle stays lean.
 */

export const $ = <T extends Element = HTMLElement>(
  sel: string,
  root: ParentNode = document,
): T | null => root.querySelector<T>(sel);

export const $$ = <T extends Element = HTMLElement>(
  sel: string,
  root: ParentNode = document,
): T[] => Array.from(root.querySelectorAll<T>(sel));

/** Set text only when it changed (avoids needless layout / a11y chatter). */
export function setText(node: Element | null, value: string): void {
  if (node && node.textContent !== value) node.textContent = value;
}

export function setAttr(node: Element | null, name: string, value: string | number | null): void {
  if (!node) return;
  if (value === null) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
    return;
  }
  const str = String(value);
  if (node.getAttribute(name) !== str) node.setAttribute(name, str);
}

export function toggleClass(node: Element | null, name: string, on: boolean): void {
  if (node) node.classList.toggle(name, on);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** requestAnimationFrame-coalesced callback (drag/resize work on a hot path). */
export function rafThrottle<T extends unknown[]>(fn: (...args: T) => void): (...args: T) => void {
  let queued = false;
  let last: T;
  return (...args: T) => {
    last = args;
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fn(...last);
    });
  };
}

export function debounce<T extends unknown[]>(fn: (...args: T) => void, ms: number): (...args: T) => void {
  let timer = 0;
  return (...args: T) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  };
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

const MIB = 1024 * 1024;

export function formatBytes(bytes: number, digits = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < MIB) return `${(bytes / 1024).toFixed(digits)} KB`;
  if (bytes < 1024 * MIB) return `${(bytes / MIB).toFixed(digits)} MB`;
  return `${(bytes / (1024 * MIB)).toFixed(digits)} GB`;
}

export function formatPercent(ratio: number): string {
  return `${Math.round(clamp(ratio, 0, 1) * 100)}%`;
}

export function formatMegapixels(width: number, height: number): string {
  const mp = (width * height) / 1_000_000;
  return `${mp < 10 ? mp.toFixed(1) : Math.round(mp)} MP`;
}

export function formatDims(width: number, height: number): string {
  return `${width} × ${height} px`;
}

/** Decimal ratio for slider read-outs, Vietnamese number formatting. */
export function formatRatio(value: number): string {
  return new Intl.NumberFormat('vi-VN', {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  }).format(value);
}

export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 1) return `${seconds.toFixed(1).replace('.', ',')} giây`;
  if (seconds < 60) return `${Math.round(seconds)} giây`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m} phút ${s.toString().padStart(2, '0')} giây`;
}

/** Strip the extension from a file name (keeps dots inside the name). */
export function splitFileName(name: string): { base: string; ext: string } {
  const clean = name.replace(/\\/g, '/').split('/').pop() ?? name;
  const dot = clean.lastIndexOf('.');
  if (dot > 0) return { base: clean.slice(0, dot), ext: clean.slice(dot + 1).toLowerCase() };
  return { base: clean, ext: '' };
}

/** Make a file name safe across platforms; keeps Vietnamese diacritics. */
export function slugify(name: string): string {
  return name
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

/** Convert a colour written as #rrggbb / #rgb into RGB 0-255. */
export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) return [255, 255, 255];
  const n = parseInt(h.slice(0, 6), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Safety net when createImageBitmap is unavailable / rejects. */
function decodeWithImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Không đọc được ảnh.'));
    };
    img.src = url;
  });
}

/** Decode off the main thread when possible, honouring EXIF orientation. */
export async function decodeImage(blob: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch {
      // Fall through to <img> decoding (e.g. SVG in some browsers).
    }
  }
  return decodeWithImage(blob);
}

export function drawableSize(src: ImageBitmap | HTMLImageElement): { width: number; height: number } {
  if ('naturalWidth' in src) return { width: src.naturalWidth, height: src.naturalHeight };
  return { width: src.width, height: src.height };
}

export function closeBitmap(src: ImageBitmap | HTMLImageElement | null | undefined): void {
  if (src && 'close' in src && typeof src.close === 'function') {
    try {
      src.close();
    } catch {
      /* already closed */
    }
  }
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Không đọc được dữ liệu ảnh.'));
    reader.readAsDataURL(blob);
  });
}

/** Render a blob to a canvas-backed PNG blob (needed for clipboard). */
export async function toPngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === 'image/png') return blob;
  const bmp = await decodeImage(blob);
  const { width, height } = drawableSize(bmp);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    closeBitmap(bmp);
    throw new Error('Trình duyệt không hỗ trợ canvas.');
  }
  ctx.drawImage(bmp, 0, 0);
  closeBitmap(bmp);
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Không tạo được PNG.'))),
      'image/png',
    );
  });
}

/**
 * Copy an image to the clipboard.
 * Prefers a real `image/png` ClipboardItem; falls back to `text/html` with a
 * data-URL <img> (Safari / browsers that deny image writes).
 * Returns which strategy succeeded so the caller can word the toast.
 */
export async function writeImageToClipboard(blob: Blob): Promise<'image' | 'html'> {
  const clipboard = navigator.clipboard;
  const ItemCtor = (window as { ClipboardItem?: typeof ClipboardItem }).ClipboardItem;
  if (!clipboard?.write || typeof ItemCtor !== 'function') {
    throw new Error('Trình duyệt không hỗ trợ sao chép ảnh.');
  }

  const png = await toPngBlob(blob);
  try {
    await clipboard.write([new ItemCtor({ 'image/png': png })]);
    return 'image';
  } catch {
    /* try the HTML route below */
  }

  const dataUrl = await blobToDataUrl(png);
  const html = new Blob([`<img src="${dataUrl}" alt="Ảnh đã xóa nền">`], { type: 'text/html' });
  try {
    await clipboard.write([new ItemCtor({ 'text/html': html })]);
    return 'html';
  } catch {
    throw new Error('Trình duyệt chặn quyền ghi clipboard. Hãy dùng nút tải xuống.');
  }
}

/** Trigger a download for a blob without leaking object URLs. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Keep the URL alive long enough for Safari to actually start the download.
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
  );
}

export const prefersReducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Canvas → Blob promise. */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error('Không tạo được tệp ảnh.'))),
      type,
      quality,
    );
  });
}

/** Typed `nextFrame` promise, used to let the browser paint busy states. */
export const nextFrame = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => resolve()));
