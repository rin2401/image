import { defineConfig } from 'vite';

/**
 * GitHub Pages project site → https://rin2401.github.io/image/
 * Override with GH_PAGES_BASE=/ for a user site or custom domain.
 *
 * AI runtime assets (ONNX model chunks + onnxruntime wasm) are vendored into
 * public/imgly/ by `node scripts/fetch-model-assets.mjs` (run automatically by
 * `npm run build`), so they are served same-origin from Pages.
 */
export default defineConfig({
  base: process.env.GH_PAGES_BASE ?? '/image/',
  build: {
    target: 'es2022',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1500,
  },
  worker: { format: 'es' },
  server: { host: true },
  preview: { host: true },
});
