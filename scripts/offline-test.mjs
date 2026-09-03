// Offline audit: serve dist/ statically, install the service worker, cut the network, reload, and (if the
// bench profile has cached weights) load the model with the network still off.
import { chromium } from 'playwright-core';
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml' };
// Deliberately NO COOP/COEP headers from the server: the service worker must supply them (GitHub Pages case).
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = join('dist', p);
  if (!existsSync(f) || statSync(f).isDirectory()) { res.statusCode = 404; res.end('not found'); return; }
  res.setHeader('Content-Type', MIME[extname(f)] ?? 'application/octet-stream');
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(Number(process.env.PORT ?? 4173), '127.0.0.1', r)); // fixed port: Cache API storage is per origin, so the bench and offline runs must share it
const url = `http://127.0.0.1:${server.address().port}/`;
const userDataDir = process.env.PROFILE_DIR ?? new URL('../.bench-profile', import.meta.url).pathname;
const context = await chromium.launchPersistentContext(userDataDir, { executablePath: CHROME, headless: true, proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined, env: { ...process.env, LANG: 'C.UTF-8' } });
let failures = 0;
const check = (c, m) => { console.log(`${c ? 'ok' : 'FAIL'} - ${m}`); if (!c) failures++; };
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));

await page.goto(url);
// Start from a clean service-worker state (a stale worker from an earlier build would serve the old shell);
// the model weight cache ("transformers-cache") is kept.
await page.evaluate(async () => {
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  for (const k of await caches.keys()) if (k.startsWith('sift-')) await caches.delete(k);
});
// Land on the site as a first-time visitor. The server above sends no COOP/COEP, so this is the
// GitHub Pages case: the app must register the worker and reload itself once to become isolated.
await page.evaluate(() => { try { sessionStorage.clear(); } catch {} });
await page.reload();
await page.waitForFunction(() => window.__sift?.store.get().env);
try {
  await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 30000 });
} catch {
  // fall through to the assertions below, which report what actually happened
}
const second = await page.evaluate(() => ({
  coi: crossOriginIsolated,
  sw: !!navigator.serviceWorker.controller,
  sab: typeof SharedArrayBuffer !== 'undefined',
  reloads: (() => { try { return sessionStorage.getItem('sift.isolationReload'); } catch { return null; } })(),
}));
check(second.sw, 'service worker controls the page');
check(second.coi && second.sab, `app reloads itself once into cross-origin isolation with no server headers: crossOriginIsolated=${second.coi}, SharedArrayBuffer=${second.sab}`);

// A page that is already isolated must not reload again: prove it stays put.
const before = await page.evaluate(() => performance.now());
await new Promise((r) => setTimeout(r, 3000));
const stable = await page.evaluate(() => performance.now());
check(stable > before, 'no reload loop once isolated (page context survived 3s)');

await context.setOffline(true);
await page.reload();
try {
  await page.waitForFunction(() => window.__sift?.store.get().env, null, { timeout: 20000 });
  const off = await page.evaluate(() => ({ online: navigator.onLine, screen: window.__sift.store.get().screen, files: document.querySelectorAll('.connect').length }));
  check(off.screen === 'connect' && off.files === 1, `app shell loads with the network off (navigator.onLine=${off.online})`);
} catch (e) {
  check(false, `app shell offline: ${e.message}`);
}
const modelId = process.argv[2] ?? 'lfm2.5-1.2b-instruct';
const r = await page.evaluate(async ({ id, mirror }) => {
  const rt = window.__sift.runtime;
  if (!rt) return { skipped: 'runtime not exposed' };
  if (mirror) rt.remoteHost = mirror; // same URL the bench cached under, so Cache API keys match; the host is unreachable offline anyway
  const { getModel } = await rt.modelsModule();
  const m = getModel(id);
  if (!(await rt.isCached(m))) { const c = await caches.open('transformers-cache'); const keys = (await c.keys()).map((r) => r.url).filter((u) => u.includes('LiquidAI')); return { skipped: 'weights not cached in this profile', keys: keys.slice(0, 12), dtype: window.__sift.store.get().settings.dtype, backend: rt.backend, names: await caches.keys() }; }
  const t0 = performance.now();
  try {
    await rt.load(id);
    const out = await rt.adapter.complete({ messages: [{ role: 'user', content: 'Say the word ready.' }], thinking: false, maxNewTokens: 8, sampling: { temperature: 0 } });
    return { ok: true, ms: Math.round(performance.now() - t0), content: out.content, tps: out.stats.tps };
  } catch (e) { return { ok: false, error: e.message }; }
}, { id: modelId, mirror: process.env.HF_MIRROR ? `http://127.0.0.1:${process.env.HF_MIRROR_PORT ?? 48211}/` : null });
if (r.skipped) console.log(`skip - model offline load: ${r.skipped}`, JSON.stringify(r, null, 1));
else check(r.ok, `model loads and generates with the network off: ${JSON.stringify(r)}`);
await context.close();
server.close();
console.log(failures ? `\n${failures} FAILED` : '\nall offline checks passed');
process.exit(failures ? 1 : 0);
