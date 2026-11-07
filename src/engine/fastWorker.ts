/**
 * Module Worker that runs the fast (non-AI) background remover off the main
 * thread. All heavy buffers move in both directions as transferables, so no
 * pixel data is ever copied or structured-cloned.
 *
 * Protocol (see `fast.ts` for the client side):
 *   in : { id, data: ArrayBuffer (RGBA), width, height, options }
 *   out: { id, ok: true,  data: ArrayBuffer (RGBA), width, height, confidence }
 *      | { id, ok: false, error: string }
 */
import { removeBackgroundFastCore, type FastOptions } from './fastCore';

interface FastRequest {
  id: number;
  data: ArrayBuffer;
  width: number;
  height: number;
  options: Partial<FastOptions>;
}

interface FastResponse {
  id: number;
  ok: boolean;
  data?: ArrayBuffer;
  width?: number;
  height?: number;
  confidence?: number;
  error?: string;
}

// `self` is a DedicatedWorkerGlobalScope here; cast keeps this file compiling
// under a DOM lib too (the project uses lib DOM + WebWorker together).
const ctx = self as unknown as {
  onmessage: ((evt: MessageEvent<FastRequest>) => void) | null;
  postMessage: (msg: FastResponse, transfer?: Transferable[]) => void;
};

ctx.onmessage = (evt: MessageEvent<FastRequest>) => {
  const { id, data, width, height, options } = evt.data;
  try {
    const result = removeBackgroundFastCore(
      { data: new Uint8ClampedArray(data), width, height },
      options,
    );
    const out = result.data.buffer as ArrayBuffer;
    ctx.postMessage(
      {
        id,
        ok: true,
        data: out,
        width: result.width,
        height: result.height,
        confidence: result.confidence,
      },
      [out],
    );
  } catch (error) {
    ctx.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
