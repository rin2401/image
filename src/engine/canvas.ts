/**
 * Canvas / ImageBitmap plumbing shared by the fast engine (`fast.ts`) and the AI
 * engine (`ai.ts`).
 *
 * Everything here is defensive on purpose: the app must work in Chrome, Safari
 * and Firefox latest, including older Safari builds without `OffscreenCanvas`
 * and without `createImageBitmap(blob)` support for every MIME type.
 */

/** True when the current context exposes `OffscreenCanvas` (Chrome/FF, Safari 16.4+). */
export function hasOffscreenCanvas(): boolean {
  return typeof OffscreenCanvas !== 'undefined';
}

/** True when `canvas.convertToBlob` exists (needed for the worker path). */
export function canConvertToBlob(): boolean {
  return (
    typeof OffscreenCanvas !== 'undefined' &&
    typeof (OffscreenCanvas.prototype as unknown as { convertToBlob?: unknown }).convertToBlob ===
      'function'
  );
}

/** Maximum area we're willing to rasterise (guards against absurd inputs). */
export const MAX_PIXELS = 64_000_000; // 64 MP

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;

function createCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function context2d(canvas: AnyCanvas): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D {
  const ctx = (canvas as HTMLCanvasElement).getContext('2d', {
    willReadFrequently: true,
    alpha: true,
  }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('Trình duyệt không hỗ trợ canvas 2D.');
  return ctx;
}

/** Result of decoding any user input into raw RGBA pixels. */
export interface DecodedImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Normalise `ImageBitmap | Blob | ImageData` into `{data,width,height}`.
 *
 * `ImageBitmap` is drawn and immediately closed (it holds GPU memory).
 */
export async function decodeToImageData(
  input: ImageBitmap | Blob | ImageData,
): Promise<DecodedImage> {
  if (typeof ImageData !== 'undefined' && input instanceof ImageData) {
    return {
      data: new Uint8ClampedArray(input.data),
      width: input.width,
      height: input.height,
    };
  }

  let source: ImageBitmap | Blob | ImageData = input;
  let bitmap: ImageBitmap | null = null;

  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    bitmap = await createBitmapFromBlob(input);
    source = bitmap;
  }

  const width = (source as ImageBitmap).width;
  const height = (source as ImageBitmap).height;
  if (!width || !height) throw new Error('Ảnh không hợp lệ hoặc bị hỏng.');
  if (width * height > MAX_PIXELS) throw new Error('Ảnh quá lớn (giới hạn 64 megapixel).');

  const canvas = createCanvas(width, height);
  const ctx = context2d(canvas);
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(source as CanvasImageSource, 0, 0);

  if (bitmap) bitmap.close();

  const imageData = ctx.getImageData(0, 0, width, height);
  return { data: imageData.data, width, height };
}

/**
 * Decode a Blob to an ImageBitmap with graceful fallbacks.
 *
 * Safari < 17 fails `createImageBitmap(blob)` for some formats, and older
 * browsers lack `createImageBitmap` for Blobs entirely; in those cases we fall
 * back to `<img>` + object URL.
 */
export async function createBitmapFromBlob(blob: Blob): Promise<ImageBitmap> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      // fall through to the <img> path
    }
  }

  if (typeof document === 'undefined') {
    throw new Error('Không thể giải mã ảnh trong môi trường này.');
  }

  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Không đọc được dữ liệu ảnh.'));
      img.src = url;
    });
    if (typeof createImageBitmap === 'function') {
      try {
        return await createImageBitmap(img);
      } catch {
        /* fall through */
      }
    }
    // Last resort: draw through a canvas and rebuild a bitmap from the canvas.
    const canvas = createCanvas(img.naturalWidth || img.width, img.naturalHeight || img.height);
    context2d(canvas).drawImage(img, 0, 0);
    if (typeof createImageBitmap === 'function') {
      return await createImageBitmap(canvas as CanvasImageSource);
    }
    throw new Error('Trình duyệt không hỗ trợ xử lý ảnh (createImageBitmap).');
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Put raw RGBA pixels onto a canvas (avoids `putImageData` type juggling). */
export function drawImageData(canvas: AnyCanvas, image: DecodedImage): void {
  const ctx = context2d(canvas);
  const data = new ImageData(new Uint8ClampedArray(image.data), image.width, image.height);
  ctx.putImageData(data, 0, 0);
}

/** Encode an RGBA buffer as PNG. Uses OffscreenCanvas when available. */
export async function encodePng(image: DecodedImage): Promise<Blob> {
  if (canConvertToBlob()) {
    const canvas = new OffscreenCanvas(image.width, image.height);
    drawImageData(canvas, image);
    return canvas.convertToBlob({ type: 'image/png' });
  }

  if (typeof document === 'undefined') {
    throw new Error('Không thể xuất ảnh trong môi trường này.');
  }
  const canvas = createCanvas(image.width, image.height);
  drawImageData(canvas, image);
  return new Promise<Blob>((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Không thể tạo tệp PNG.'));
    }, 'image/png');
  });
}

/**
 * Downscale RGBA pixels to fit `maxDimension` (longest side).
 * Returns the original object untouched when no downscale is needed.
 *
 * Uses `drawImage` (browser-accelerated, high quality) when a canvas is
 * available, otherwise a box filter — the box filter keeps the preview path
 * working even in environments without canvas.
 */
export async function fitWithin(
  image: DecodedImage,
  maxDimension: number,
): Promise<DecodedImage> {
  const { width, height } = image;
  const longest = Math.max(width, height);
  if (!Number.isFinite(maxDimension) || maxDimension <= 0 || longest <= maxDimension) return image;

  const scale = maxDimension / longest;
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));

  if (typeof OffscreenCanvas !== 'undefined' || typeof document !== 'undefined') {
    const canvas = createCanvas(width, height);
    drawImageData(canvas, image);
    const small = createCanvas(w, h);
    const ctx = context2d(small);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(canvas as CanvasImageSource, 0, 0, w, h);
    const out = ctx.getImageData(0, 0, w, h);
    return { data: out.data, width: w, height: h };
  }

  return boxDownscale(image, w, h);
}

/** Area-average downscale (pure, no DOM). */
export function boxDownscale(image: DecodedImage, w: number, h: number): DecodedImage {
  const { data, width, height } = image;
  const out = new Uint8ClampedArray(w * h * 4);
  const scaleX = width / w;
  const scaleY = height / h;

  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * scaleY);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor((y + 1) * scaleY)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * scaleX);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor((x + 1) * scaleX)));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy++) {
        let o = (sy * width + x0) * 4;
        for (let sx = x0; sx < x1; sx++, o += 4) {
          r += data[o];
          g += data[o + 1];
          b += data[o + 2];
          a += data[o + 3];
          count++;
        }
      }
      const inv = 1 / Math.max(1, count);
      const o = (y * w + x) * 4;
      out[o] = r * inv;
      out[o + 1] = g * inv;
      out[o + 2] = b * inv;
      out[o + 3] = a * inv;
    }
  }

  return { data: out, width: w, height: h };
}
