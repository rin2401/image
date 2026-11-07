import { defineConfig, type Plugin } from 'vite';
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Drop ONNX Runtime's bundled `.wasm` from the build output.
 *
 * Vite emits it because `onnxruntime-web` it's imported dynamically, but
 * `@imgly/background-removal` unconditionally overrides `ort.env.wasm.wasmPaths`
 * with blob URLs built from our `publicPath` (see its `createOnnxSession`). The
 * emitted file is therefore never fetched — it only bloats the Pages artifact by
 * ~24 MB. Verified by serving a build with the file removed: inference works.
 */
function dropUnusedOrtWasm(): Plugin {
  let outDir = 'dist';
  return {
    name: 'drop-unused-ort-wasm',
    apply: 'build',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    closeBundle() {
      const assets = join(outDir, 'assets');
      let removed = 0;
      try {
        for (const file of readdirSync(assets)) {
          if (!/^ort-wasm-.*\.wasm$/.test(file)) continue;
          const path = join(assets, file);
          removed += statSync(path).size;
          rmSync(path, { force: true });
        }
      } catch {
        /* no assets dir — nothing to do */
      }
      if (removed > 0) {
        this.info?.(`removed ${(removed / 1e6).toFixed(1)} MB of unreachable ort wasm`);
      }
    },
  };
}

/**
 * GitHub Pages project site → https://rin2401.github.io/image/
 * Override with GH_PAGES_BASE=/ for a user site or custom domain.
 *
 * AI runtime assets (ONNX model chunks + onnxruntime wasm) are vendored into
 * public/imgly/ by `node scripts/fetch-model-assets.mjs` (run by `npm run build`)
 * so they are served same-origin from Pages.
 */
export default defineConfig({
  base: process.env.GH_PAGES_BASE ?? '/image/',
  plugins: [dropUnusedOrtWasm()],
  build: {
    target: 'es2022',
    assetsInlineLimit: 4096,
    chunkSizeWarningLimit: 1500,
  },
  worker: { format: 'es' },
  server: { host: true },
  preview: { host: true },
});
