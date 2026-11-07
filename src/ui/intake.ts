/**
 * File intake: validation, clipboard paste extraction and the built-in demo
 * image (drawn on a canvas — no downloaded/copyrighted asset).
 */
import { formatBytes, formatMegapixels, slugify, splitFileName } from './utils';

export const MAX_BYTES = 20 * 1024 * 1024; // 20 MB
export const MAX_PIXELS = 40_000_000; // 40 MP
export const MAX_BATCH = 20;

export interface IntakeItem {
  file: Blob;
  /** Original file name (used for export naming). */
  name: string;
  /** Estimated pixel dimensions (decoded lazily, 0 when unknown). */
  width: number;
  height: number;
}

export interface IntakeResult {
  accepted: IntakeItem[];
  /** Human-readable rejection reasons (already localised by caller keys). */
  rejected: { name: string; reason: 'unsupported' | 'tooBig' | 'tooManyPixels'; detail: string }[];
  /** Extra files above MAX_BATCH that were dropped. */
  overflow: number;
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
  bmp: 'image/bmp',
  heic: 'image/heic',
  heif: 'image/heif',
};

const ACCEPTED_TYPES = new Set(Object.values(EXT_MIME));

/** Sniff the real type from magic bytes; browsers report "" for pasted/odd files. */
async function sniffType(blob: Blob): Promise<string | null> {
  const head = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const s = (from: number, to: number) => String.fromCharCode(...head.slice(from, to));
  if (head[0] === 0x89 && s(1, 4) === 'PNG') return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8) return 'image/jpeg';
  if (s(0, 4) === 'RIFF' && s(8, 12) === 'WEBP') return 'image/webp';
  if (s(0, 3) === 'GIF') return 'image/gif';
  if (s(0, 2) === 'BM') return 'image/bmp';
  if (s(4, 8) === 'ftyp') {
    const brand = s(8, 12);
    if (/^avi[fs]$/.test(brand)) return 'image/avif';
    if (/^he[icxs]|^mif1|^msf1/.test(brand)) return 'image/heic';
  }
  // SVG is text-based.
  const text = new TextDecoder().decode(head).trimStart().toLowerCase();
  if (text.startsWith('<svg') || text.startsWith('<?xml')) return 'image/svg+xml';
  return null;
}

function extOf(name: string, type: string): string {
  const { ext } = splitFileName(name);
  if (ext && EXT_MIME[ext]) return ext;
  const byMime = Object.keys(EXT_MIME).find((k) => EXT_MIME[k] === type);
  return byMime ?? 'png';
}

/** Read pixel dimensions asynchronously via a one-off <img> decode. */
function readDims(blob: Blob): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    const finish = (w: number, h: number) => {
      URL.revokeObjectURL(url);
      resolve({ width: w, height: h });
    };
    img.onload = () => finish(img.naturalWidth, img.naturalHeight);
    img.onerror = () => finish(0, 0);
    img.src = url;
  });
}

/**
 * Validate a list of raw files/blobs. Dimensions are read lazily only when the
 * file size is plausible, to avoid decoding huge images twice.
 */
export async function intakeFiles(
  files: (File | Blob)[],
  opts: { maxItems?: number } = {},
): Promise<IntakeResult> {
  const maxItems = opts.maxItems ?? MAX_BATCH;
  const accepted: IntakeItem[] = [];
  const rejected: IntakeResult['rejected'] = [];
  let overflow = 0;

  for (const file of files) {
    if (accepted.length >= maxItems) {
      overflow += 1;
      continue;
    }
    const name = (file as File).name || `anh-${Date.now()}.png`;
    let type = file.type;
    if (!ACCEPTED_TYPES.has(type)) {
      type = (await sniffType(file)) ?? '';
    }
    if (!ACCEPTED_TYPES.has(type)) {
      rejected.push({ name, reason: 'unsupported', detail: formatBytes(file.size) });
      continue;
    }
    if (file.size > MAX_BYTES) {
      rejected.push({ name, reason: 'tooBig', detail: formatBytes(file.size) });
      continue;
    }

    const dims = await readDims(file);
    if (dims.width * dims.height > MAX_PIXELS) {
      rejected.push({
        name,
        reason: 'tooManyPixels',
        detail: formatMegapixels(dims.width, dims.height),
      });
      continue;
    }

    // Normalise the file name + MIME so the engine and exports agree.
    const ext = extOf(name, type);
    const finalName = /\.[a-z0-9]{2,5}$/i.test(name) ? name : `${name}.${ext}`;
    const normalised =
      file.type === type ? file : new File([file], finalName, { type, lastModified: Date.now() });

    accepted.push({ file: normalised, name: finalName, width: dims.width, height: dims.height });
  }

  return { accepted, rejected, overflow };
}

/** Extract image blobs from a paste / drop DataTransfer. */
export function collectFilesFromTransfer(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  if (data.items && data.items.length > 0) {
    for (const item of Array.from(data.items)) {
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length === 0 && data.files) {
    for (const file of Array.from(data.files)) files.push(file);
  }
  return files;
}

/* ------------------------------------------------------------------ */
/* Demo image                                                          */
/* ------------------------------------------------------------------ */

/**
 * Generate a pleasant demo portrait-ish scene: soft gradient "studio"
 * background, ground shadow and a simple flat character silhouette.
 * Drawn at 900×900 and encoded as PNG.
 */
export async function createDemoImage(): Promise<File> {
  const size = 900;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas không khả dụng.');

  // Background: vertical gradient + radial vignette (a very typical "studio" look).
  const bg = ctx.createLinearGradient(0, 0, 0, size);
  bg.addColorStop(0, '#dfe7f7');
  bg.addColorStop(0.55, '#c7d4ee');
  bg.addColorStop(1, '#aebfe0');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, size, size);

  const glow = ctx.createRadialGradient(size * 0.5, size * 0.36, size * 0.05, size * 0.5, size * 0.42, size * 0.62);
  glow.addColorStop(0, 'rgba(255,255,255,0.85)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, size, size);

  // Soft ground shadow ellipses under the character.
  ctx.save();
  ctx.filter = 'blur(26px)';
  ctx.fillStyle = 'rgba(41, 52, 84, 0.28)';
  ctx.beginPath();
  ctx.ellipse(size * 0.5, size * 0.88, size * 0.26, size * 0.055, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Character: shoulders/bust shape.
  const cx = size * 0.5;
  const shoulderY = size * 0.66;
  const body = ctx.createLinearGradient(0, shoulderY, 0, size);
  body.addColorStop(0, '#3f51b5');
  body.addColorStop(1, '#283593');
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.29, size);
  ctx.bezierCurveTo(cx - size * 0.28, shoulderY + size * 0.02, cx - size * 0.15, shoulderY - size * 0.03, cx, shoulderY - size * 0.03);
  ctx.bezierCurveTo(cx + size * 0.15, shoulderY - size * 0.03, cx + size * 0.28, shoulderY + size * 0.02, cx + size * 0.29, size);
  ctx.closePath();
  ctx.fill();

  // Neck.
  ctx.fillStyle = '#e7b48f';
  ctx.beginPath();
  ctx.roundRect(cx - size * 0.07, size * 0.55, size * 0.14, size * 0.14, size * 0.05);
  ctx.fill();

  // Hair back.
  ctx.fillStyle = '#2b2118';
  ctx.beginPath();
  ctx.ellipse(cx, size * 0.36, size * 0.155, size * 0.185, 0, 0, Math.PI * 2);
  ctx.fill();

  // Face.
  ctx.fillStyle = '#f3c6a4';
  ctx.beginPath();
  ctx.ellipse(cx, size * 0.375, size * 0.128, size * 0.158, 0, 0, Math.PI * 2);
  ctx.fill();

  // Hair fringe.
  ctx.fillStyle = '#332720';
  ctx.beginPath();
  ctx.ellipse(cx, size * 0.285, size * 0.132, size * 0.085, 0, 0, Math.PI);
  ctx.fill();

  // Eyes + smile.
  ctx.fillStyle = '#2a2119';
  for (const dx of [-0.05, 0.05]) {
    ctx.beginPath();
    ctx.ellipse(cx + size * dx, size * 0.372, size * 0.012, size * 0.016, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = '#b8644f';
  ctx.lineWidth = size * 0.008;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, size * 0.41, size * 0.045, 0.18 * Math.PI, 0.82 * Math.PI);
  ctx.stroke();

  // Shoulder hint of a shirt collar.
  ctx.fillStyle = '#e8eaf6';
  ctx.beginPath();
  ctx.moveTo(cx - size * 0.058, shoulderY - size * 0.025);
  ctx.lineTo(cx, shoulderY + size * 0.075);
  ctx.lineTo(cx + size * 0.058, shoulderY - size * 0.025);
  ctx.closePath();
  ctx.fill();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), 'image/png'),
  );
  if (!blob) throw new Error('Không tạo được ảnh mẫu.');
  return new File([blob], `anh-mau-${slugify(String(size))}.png`, {
    type: 'image/png',
    lastModified: Date.now(),
  });
}

/** Validate a single pasted/dropped blob quickly (used by paste handler). */
export function looksLikeImageFile(file: File): boolean {
  return ACCEPTED_TYPES.has(file.type) || /\.(png|jpe?g|webp|avif|gif|bmp|heic|heif)$/i.test(file.name);
}
