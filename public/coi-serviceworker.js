/**
 * Cross-Origin Isolation service worker.
 *
 * ONNX Runtime Web only enables WASM multi-threading when the page is
 * `crossOriginIsolated` (COOP: same-origin + COEP: require-corp). For the
 * imgly ISNet model that is the difference between ~15 s and ~5 s per image.
 *
 * GitHub Pages cannot be configured to send response headers, so — following
 * the well-known `coi-serviceworker` technique — this worker re-issues every
 * same-origin (and CORS) response through a new `Response` with the isolation
 * headers attached.
 *
 * Behaviour:
 *  - First visit: the page registers this worker, and reloads once so the
 *    document is served by the worker with the headers. To avoid an endless
 *    reload loop the page stores a session flag before reloading.
 *  - Later visits: headers are present from the first response — no reload.
 */
/* eslint-disable no-restricted-globals */

const RELOAD_HEADER = 'x-coi-reloaded';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;

  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  event.respondWith(
    (async () => {
      const response = await fetch(request).catch(() => null);
      if (!response) return Response.error();

      // Opaque (no-cors third-party) responses cannot be rebuilt — pass through.
      if (response.type === 'opaque' || response.status === 0) return response;

      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    })(),
  );
});
