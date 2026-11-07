#!/usr/bin/env node
/**
 * Vendors the @imgly/background-removal runtime assets (ONNX model chunks +
 * onnxruntime-web wasm) into ./public/imgly/ so the browser loads them
 * same-origin from GitHub Pages instead of a third-party CDN.
 *
 * Usage:
 *   node scripts/fetch-model-assets.mjs            # quantized model (44MB, default)
 *   node scripts/fetch-model-assets.mjs --fp16     # + fp16 model (+88MB, default)
 *   node scripts/fetch-model-assets.mjs --full     # + full fp32 model (+176MB)
 *   node scripts/fetch-model-assets.mjs --force    # re-download
 *
 * The script is idempotent: files that already exist (and are referenced by
 * resources.json) are skipped, so repeat builds stay cheap.
 */
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_DIR = join(ROOT, 'node_modules/@imgly/background-removal');
const PKG_VERSION = JSON.parse(readFileSync(join(PKG_DIR, 'package.json'), 'utf8')).version;
const REMOTE = `https://staticimgly.com/@imgly/background-removal-data/${PKG_VERSION}/dist/`;
const OUT = join(ROOT, 'public/imgly');
const FORCE = process.argv.includes('--force');

const MODELS = ['isnet_quint8'];
if (!process.argv.includes('--no-fp16')) MODELS.push('isnet_fp16');
if (process.argv.includes('--full')) MODELS.push('isnet');

const CONCURRENCY = 4;

async function download(url, dest, attempt = 1) {
  if (!FORCE && existsSync(dest)) return 0;
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    mkdirSync(dirname(dest), { recursive: true });
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    return Number(res.headers.get('content-length') ?? 0);
  } catch (err) {
    if (attempt < 3) return download(url, dest, attempt + 1);
    throw err;
  }
}

async function pool(items, limit, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function main() {
  console.log(`→ @imgly/background-removal@${PKG_VERSION} runtime assets`);
  mkdirSync(OUT, { recursive: true });

  const resourcesRes = await fetch(new URL('resources.json', REMOTE));
  if (!resourcesRes.ok) throw new Error(`resources.json: HTTP ${resourcesRes.status}`);
  const resources = await resourcesRes.json();
  writeFileSync(join(OUT, 'resources.json'), JSON.stringify(resources));

  // Only keep entries we actually vendor, so the engine's "is it local?" check
  // is authoritative and never points at a missing chunk.
  const wanted = Object.keys(resources).filter(
    (k) =>
      k.startsWith('/onnxruntime-web/') ||
      MODELS.some((m) => k === `/models/${m}`),
  );
  const chunks = new Map();
  for (const key of wanted) {
    for (const chunk of resources[key].chunks) chunks.set(chunk.name, true);
  }

  let downloaded = 0;
  await pool([...chunks.keys()], CONCURRENCY, async (name) => {
    downloaded += await download(new URL(name, REMOTE), join(OUT, name));
  });

  // Prune model entries we did not vendor from the local resources.json so the
  // library fails fast with a clear error instead of a 404 mid-download.
  const localResources = Object.fromEntries(
    Object.entries(resources).filter(([k]) => wanted.includes(k)),
  );
  writeFileSync(join(OUT, 'resources.json'), JSON.stringify(localResources));

  const totalBytes = Object.values(localResources).reduce((sum, e) => sum + e.size, 0);
  for (const key of wanted) console.log(`  ✓ ${key}`);
  console.log(
    `Done. ${(downloaded / 1e6).toFixed(1)} MB downloaded · ${(totalBytes / 1e6).toFixed(1)} MB vendored in public/imgly/`,
  );
}

main().catch((err) => {
  console.error('fetch-model-assets failed:', err.message);
  console.warn('The site will still work — the AI engine falls back to the imgly CDN.');
  // Never break a build because a CDN hiccuped: the runtime falls back to CDN.
  process.exit(0);
});
