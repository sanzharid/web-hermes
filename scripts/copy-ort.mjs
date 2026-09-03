// Copy onnxruntime-web's WASM runtime into public/ort so the app never loads it from a CDN.
import { mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const src = resolve('node_modules/onnxruntime-web/dist');
const dst = resolve('public/ort');
mkdirSync(dst, { recursive: true });
// plain = CPU-only build (full CPU kernel set incl. GatherBlockQuantized); asyncify = build with the WebGPU EP.
for (const f of ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
  if (existsSync(resolve(src, f))) copyFileSync(resolve(src, f), resolve(dst, f));
}
console.log('ort runtime copied to public/ort');
