// Loads the recommended model in headless Chromium (WASM/CPU here: the adapter is SwiftShader) and measures tokens/s.
// Usage: node scripts/bench-model.mjs [modelId]
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const modelId = process.argv[2] ?? 'lfm2.5-1.2b-instruct';
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
// Optional local mirror of the HF repo layout (HF_MIRROR=/path/to/dir containing <org>/<model>/resolve/main/...).
let mirrorUrl = null;
if (process.env.HF_MIRROR) {
  const mirror = http.createServer((req, res) => {
    const f = join(process.env.HF_MIRROR, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!existsSync(f) || statSync(f).isDirectory()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Length', statSync(f).size); res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    createReadStream(f).pipe(res);
  }).listen(Number(process.env.HF_MIRROR_PORT ?? 48211), '127.0.0.1');
  mirrorUrl = `http://127.0.0.1:${process.env.HF_MIRROR_PORT ?? 48211}/`;
  console.log('serving HF mirror at', mirrorUrl);
}
const server = await createServer({ configFile: 'vite.config.js', server: { port: Number(process.env.PORT ?? 4173), strictPort: true, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0];
const userDataDir = process.env.PROFILE_DIR ?? new URL('../.bench-profile', import.meta.url).pathname; // persistent: keeps the 850 MB weight cache between runs
const context = await chromium.launchPersistentContext(userDataDir, { executablePath: CHROME, headless: true, proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined, args: ['--enable-unsafe-webgpu', '--js-flags=--max-old-space-size=8192'], env: { ...process.env, LANG: 'C.UTF-8' } });
const browser = context;
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error' || process.env.VERBOSE) console.log('CONSOLE', m.type(), m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.goto(url);
await page.waitForFunction(() => window.__sift?.store.get().env);
const env = await page.evaluate(() => { const e = window.__sift.store.get().env; return { outcome: e.outcome, adapter: e.adapter, coi: e.crossOriginIsolated, threads: e.hardwareConcurrency }; });
console.log('environment:', JSON.stringify(env));

const t0 = Date.now();
let last = '';
const timer = setInterval(async () => {
  try {
    const p = await page.evaluate(() => window.__sift.store.get().model);
    const s = `${p.status} ${p.progress?.text ?? ''} ${p.progress?.file ?? ''}`;
    if (s !== last) { last = s; console.log(`  [${((Date.now() - t0) / 1000).toFixed(0)}s] ${s}`); }
  } catch {}
}, 2000);
const loaded = await page.evaluate(async ({ id, mirror, dtype }) => {
  const { getRuntime } = await import('/src/runtime/index.js');
  const rt = getRuntime();
  if (mirror) rt.remoteHost = mirror;
  if (dtype) { const st = window.__sift.store; st.set({ settings: { ...st.get().settings, dtype: { [id]: dtype } } }); }
  await new Promise((r) => { const s = window.__sift.store; if (s.get().env) r(); else { const u = s.subscribe((st) => { if (st.env) { u(); r(); } }); } });
  try { await rt.load(id); return { ok: true, info: rt.adapter.loadInfo, backend: rt.backend }; } catch (e) { return { ok: false, error: e.message }; }
}, { id: modelId, mirror: mirrorUrl, dtype: process.env.DTYPE ?? null });
clearInterval(timer);
console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(0)}s:`, JSON.stringify(loaded));
if (!loaded.ok) { await browser.close(); await server.close(); process.exit(1); }

const runs = [
  { name: 'bench (thinking off, greedy)', thinking: false, prompt: 'List ten short, distinct English nouns as a comma-separated line, then stop.', max: 48 },
  { name: 'rename suggestion (thinking off)', thinking: false, prompt: 'Suggest a short, tidy filename for a PDF whose first line is "Quarterly Report Q3 2024 — Finance". Reply with the filename only.', max: 40 },
  { name: 'rename suggestion (thinking on)', thinking: true, prompt: 'Suggest a short, tidy filename for a PDF whose first line is "Quarterly Report Q3 2024 — Finance". Reply with the filename only.', max: 160 },
];
for (const r of runs) {
  const tw = Date.now();
  const res = await page.evaluate(async (r) => {
    const { getRuntime } = await import('/src/runtime/index.js');
    const rt = getRuntime();
    const out = await rt.adapter.complete({ messages: [{ role: 'user', content: r.prompt }], thinking: r.thinking, maxNewTokens: r.max, sampling: { temperature: 0 } });
    return { content: out.content, thinking: out.thinking.slice(0, 300), stats: out.stats, prefill: out.prefill };
  }, r);
  console.log(`\n== ${r.name} (${((Date.now() - tw) / 1000).toFixed(1)}s wall)`);
  console.log(`   prompt ${res.stats.promptTokens} tok, prefill ${res.stats.prefillMs} ms (${(res.stats.promptTokens / (res.stats.prefillMs / 1000)).toFixed(1)} tok/s), decode ${res.stats.generated} tok at ${res.stats.tps.toFixed(2)} tok/s`);
  if (res.thinking) console.log(`   thinking: ${JSON.stringify(res.thinking)}`);
  console.log(`   content: ${JSON.stringify(res.content.slice(0, 300))}`);
}
await browser.close();
await server.close();
process.exit(0);
