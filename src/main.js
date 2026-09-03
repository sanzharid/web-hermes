import { createStore } from './ui/store.js';
import { h, clear, plural } from './ui/dom.js';
import { renderConnect } from './ui/connect.js';
import { renderWork } from './ui/work.js';
import { renderReview } from './ui/review.js';
import { renderResult } from './ui/result.js';
import { renderJournals } from './ui/journals.js';
import { renderEnv } from './ui/env.js';
import { renderModels } from './ui/models.js';
import { renderInterpret } from './ui/interpret.js';
import { loadSettings } from './settings.js';
import { runEnvironmentCheck } from './runtime/envcheck.js';
import { getRuntime } from './runtime/index.js';

const store = createStore({
  screen: 'connect',
  folder: null, // { id, handle, name }
  listing: [],
  recursive: false,
  selection: null, // Set<path> or null = all files
  rules: [],
  instruction: '',
  spec: '',
  plan: null, // { title, source, accepted, rejected, dropped, decisions }
  result: null,
  enrichment: new Map(),
  model: { status: 'none', id: null, progress: null, backend: null, error: null, tps: null },
  env: null,
  settings: loadSettings(),
  notice: null,
  pickerError: null, // set when showDirectoryPicker is refused, so Environment can report it
});

window.__sift = { store }; // for browser tests

const screens = {
  connect: renderConnect,
  work: renderWork,
  interpret: renderInterpret,
  review: renderReview,
  result: renderResult,
  journals: renderJournals,
  env: renderEnv,
  models: renderModels,
};

let cleanup = null;
const app = document.getElementById('app');

function render(state) {
  if (cleanup) { cleanup(); cleanup = null; }
  clear(app);
  app.append(topbar(state));
  const screen = h('div', { class: 'screen' });
  app.append(screen);
  const fn = screens[state.screen] ?? renderConnect;
  cleanup = fn(screen, store) ?? null;
}

function topbar(state) {
  const nav = (id, label) => h('a', {
    href: '#', class: state.screen === id ? 'active' : '',
    onclick: (e) => { e.preventDefault(); store.set({ screen: id }); },
  }, label);
  const files = state.listing.filter((f) => f.kind === 'file').length;
  const m = state.model;
  const pill = m.status === 'ready' ? `model: ${m.id} · ${m.backend}${m.tps ? ` · ${m.tps.toFixed(1)} tok/s` : ''}`
    : m.status === 'loading' ? `loading ${m.id}${m.progress ? ` · ${m.progress.text}` : ''}`
    : m.status === 'error' ? `model error` : 'no model';
  return h('div', { class: 'topbar' },
    h('span', { class: 'brand' }, 'Sift'),
    state.folder ? h('span', { class: 'crumb' }, h('b', null, state.folder.name), ` · ${plural(files, 'file')}${state.recursive ? ' (one level deep)' : ''}`) : h('span', { class: 'crumb' }, 'No folder connected'),
    h('span', { class: 'spacer' }),
    h('span', { class: `status-pill ${m.status}` }, pill),
    h('nav', null,
      nav('connect', 'Folder'),
      state.folder && nav('work', 'Files'),
      state.folder && nav('journals', 'Undo journals'),
      nav('models', 'Models'),
      nav('env', 'Environment'),
    ),
  );
}

store.subscribe(render);
render(store.get());

// Environment check runs at startup; the result gates the model picker's recommendation.
runEnvironmentCheck().then((env) => store.set({ env })).catch((e) => store.set({ env: { error: String(e) } }));

// Restore a previously loaded model's identity for the status pill (weights load lazily on demand).
const runtime = getRuntime();
runtime.attach(store);
runtime.modelsModule = () => import('./runtime/models.js');
window.__sift.runtime = runtime;

// On a host that cannot set COOP/COEP itself (GitHub Pages), the service worker supplies them, but
// only on responses it serves. The very first load is therefore not cross-origin isolated, so
// SharedArrayBuffer is missing and WASM inference would be stuck on one thread. Once the worker is
// active and controlling this page, reload once so the isolated copy is the one that sticks.
const ISOLATION_RELOAD = 'sift.isolationReload';
const flag = {
  get: () => { try { return sessionStorage.getItem(ISOLATION_RELOAD); } catch { return '1'; } },
  set: () => { try { sessionStorage.setItem(ISOLATION_RELOAD, '1'); } catch {} },
  clear: () => { try { sessionStorage.removeItem(ISOLATION_RELOAD); } catch {} },
};

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('./sw.js').then(async () => {
    if (globalThis.crossOriginIsolated) { flag.clear(); return; }
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      // The worker calls clients.claim() on activate; wait for it to take over this page.
      await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
    if (flag.get()) return; // already reloaded once and still not isolated: do not loop
    flag.set();
    location.reload();
  }).catch(() => {});
}

import { openFolder } from './ui/connect.js';
window.__sift.openHandle = (handle, id = handle.name || 'opfs') => openFolder(store, id, handle);
