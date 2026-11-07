/**
 * Cross-Origin Isolation bootstrap.
 *
 * ONNX Runtime Web only uses WASM multi-threading when the document is
 * `crossOriginIsolated` (COOP: same-origin + COEP: require-corp). For the
 * imgly ISNet model that is the difference between ~15 s and ~5 s per image —
 * a huge win, so it is worth one extra reload on the very first visit.
 *
 * GitHub Pages cannot send response headers, so `public/coi-serviceworker.js`
 * re-issues same-origin responses with them attached. This module registers
 * that worker.
 *
 * Reload-loop protection: the worker only takes effect for documents *after*
 * it is activated. We set a sessionStorage flag before reloading, so a browser
 * that cannot be isolated (e.g. private mode blocking service workers, or
 * WebKit) reloads at most once and then runs without isolation.
 */
const RELOAD_FLAG = 'xnb:coi-reloaded';
const WORKER_URL = `${import.meta.env.BASE_URL}coi-serviceworker.js`;

export function isCrossOriginIsolated(): boolean {
  return typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
}

export async function setupCrossOriginIsolation(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (isCrossOriginIsolated()) return;
  // A worker cannot claim a page it did not serve: skip when embedded.
  if (window.top !== window.self) return;

  let alreadyTried = false;
  try {
    alreadyTried = sessionStorage.getItem(RELOAD_FLAG) === '1';
  } catch {
    /* storage blocked — just proceed */
  }

  try {
    const registration = await navigator.serviceWorker.register(WORKER_URL, {
      scope: import.meta.env.BASE_URL,
    });
    await navigator.serviceWorker.ready;

    const reloadOnce = (): void => {
      if (alreadyTried) return;
      try {
        sessionStorage.setItem(RELOAD_FLAG, '1');
      } catch {
        /* ignore */
      }
      location.reload();
    };

    // A freshly-installed worker did not serve this navigation: reload so the
    // next document response carries the isolation headers.
    if (!navigator.serviceWorker.controller || registration.installing) {
      reloadOnce();
      return;
    }
    // An existing controller: the current document was already served by it.
    // If isolation is still missing (e.g. the worker was just updated), reload.
    reloadOnce();
  } catch {
    /* Isolation is a performance optimisation; never block the app on it. */
  }
}
