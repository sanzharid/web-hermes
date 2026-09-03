// Service worker for Sift. Generated into dist/sw.js by scripts/build-sw.mjs.
//
// 1. Precache the app shell (every built file, including the ORT WASM runtime) so the app opens offline.
// 2. Add COOP/COEP headers to every same-origin response, which makes the page cross-origin isolated
//    on hosts that cannot set headers (GitHub Pages). That enables SharedArrayBuffer -> multi-threaded WASM.
// Model weights are cached separately by Transformers.js in the Cache API ("transformers-cache").

const VERSION = '__VERSION__';
const PRECACHE = __PRECACHE__;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // Add one by one so a single failure (e.g. a font) does not abort the install.
    await Promise.all(PRECACHE.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('sift-') && k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

function withIsolation(res) {
  if (!res || res.status === 0) return res;
  const headers = new Headers(res.headers);
  headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // model downloads go straight to the network / transformers-cache
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const isNav = req.mode === 'navigate';
    const key = isNav ? './index.html' : req;
    const cached = await cache.match(key, { ignoreSearch: true }) ?? (isNav ? await cache.match('./') : null);
    if (cached) return withIsolation(cached);
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone()).catch(() => {});
      return withIsolation(res);
    } catch (e) {
      if (isNav) { const fallback = await cache.match('./index.html'); if (fallback) return withIsolation(fallback); }
      throw e;
    }
  })());
});
