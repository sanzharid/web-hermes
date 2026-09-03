// Generate dist/sw.js with a precache list of every built asset. Run after `vite build`.
import { readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const dist = 'dist';

// The ONNX Runtime WASM binaries are 13-24 MB each and only one of them is ever used, decided by the
// backend at runtime. Precaching them would force every install to download ~36 MB, most of it dead.
// They are fetched on the first model load (which requires the network anyway, for the weights) and the
// service worker's fetch handler caches them then, so offline still works once a model has been loaded.
// The small .mjs loaders stay precached. dist/assets also carries an unused duplicate of the asyncify
// binary: onnxruntime-web's built-in fallback URL, which the app always overrides to ./ort/.
const SKIP_PRECACHE = /\.wasm$/;

const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (!/sw\.js$/.test(p) && !SKIP_PRECACHE.test(p)) files.push('./' + relative(dist, p).split('\\').join('/'));
  }
})(dist);
const template = readFileSync('src/sw.template.js', 'utf8');
const version = `sift-${Date.now().toString(36)}`;
const out = template.replace('__PRECACHE__', JSON.stringify(files, null, 1)).replace('__VERSION__', version);
writeFileSync(join(dist, 'sw.js'), out);
console.log(`sw.js: ${files.length} files precached, version ${version} (WASM binaries excluded, cached on first model load)`);
