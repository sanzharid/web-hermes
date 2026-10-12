// Owns the embedding model and the current folder's index, and reports into the store.
import { Embedder, EMBED_MODEL } from '../runtime/embedder.js';
import { SearchIndex } from './index.js';
import { getRuntime } from '../runtime/index.js';

let embedder = null;
let index = null;
let buildCtrl = null;

export const searchInitial = {
  model: 'none', // none | loading | ready | error
  progress: null,
  error: null,
  indexed: 0,
  build: null, // { done, total, skipped, tokens, ms } while running
  lastBuild: null,
  query: '',
  results: null,
  ms: null,
  searching: null, // query in flight
};

function set(store, patch) {
  store.set({ search: { ...store.get().search, ...patch } });
}

export function searchIndex() {
  return index;
}

export function searchEmbedder() {
  return embedder?.ready ? embedder : null;
}

export async function isModelCached() {
  try {
    const keys = await (await caches.open('transformers-cache')).keys();
    return keys.some((r) => r.url.includes(`/${EMBED_MODEL.hf}/`) && r.url.includes(`model_${EMBED_MODEL.dtype}.onnx_data`));
  } catch {
    return false;
  }
}

export async function loadModel(store) {
  if (embedder?.ready) return embedder;
  const rt = getRuntime();
  embedder = new Embedder({ ortBase: rt.ortBase(), threads: rt.threads(), remoteHost: rt.remoteHost ?? undefined });
  set(store, { model: 'loading', error: null, progress: { loaded: 0, total: EMBED_MODEL.bytes } });
  try {
    await embedder.init((p) => set(store, { progress: { loaded: p.loaded, total: p.total || EMBED_MODEL.bytes } }));
    set(store, { model: 'ready', progress: null });
    try { await navigator.storage?.persist?.(); } catch {}
    return embedder;
  } catch (e) {
    embedder = null;
    set(store, { model: 'error', error: e.message, progress: null });
    throw e;
  }
}

/** Point the index at the connected folder and load whatever is already stored for it. */
export async function attachFolder(store) {
  const { folder } = store.get();
  if (!folder) return;
  if (index?.folder !== folder.id) {
    buildCtrl?.abort();
    index = new SearchIndex(folder.id);
    set(store, { results: null, query: '', lastBuild: null, build: null });
  }
  const n = await index.load();
  set(store, { indexed: n });
}

export function staleCount(store) {
  if (!index) return null;
  const files = store.get().listing.filter((f) => f.kind === 'file');
  const byPath = new Map(index.entries.map((e) => [e.path, e.key]));
  let stale = 0;
  for (const f of files) if (byPath.get(f.path) !== `${f.size}:${f.lastModified}`) stale++;
  const live = new Set(files.map((f) => f.path));
  const gone = index.entries.filter((e) => !live.has(e.path)).length;
  return stale + gone;
}

export async function buildIndex(store) {
  const { folder, listing } = store.get();
  if (!folder) return;
  await attachFolder(store);
  const e = await loadModel(store);
  buildCtrl?.abort();
  buildCtrl = new AbortController();
  const signal = buildCtrl.signal;
  set(store, { build: { done: 0, total: 0, skipped: 0 } });
  try {
    const r = await index.build({
      root: folder.handle,
      files: listing.filter((f) => f.kind === 'file'),
      embedder: e,
      signal,
      onProgress: (p) => set(store, { build: p, indexed: p.skipped + p.done }),
    });
    set(store, { build: null, lastBuild: r, indexed: index.entries.length });
    return r;
  } catch (err) {
    set(store, { build: null, error: err.message });
    throw err;
  } finally {
    if (buildCtrl?.signal === signal) buildCtrl = null;
  }
}

export function cancelBuild() {
  buildCtrl?.abort();
}

export async function runSearch(store, query) {
  if (!query.trim() || !index) return;
  const e = await loadModel(store);
  // The query and its results change together; in between, the old results stay up, marked stale.
  set(store, { searching: query });
  try {
    const { results, ms } = await index.search(query, e, 25);
    set(store, { query, results, ms, searching: null });
    return results;
  } catch (err) {
    set(store, { searching: null, error: err.message });
    throw err;
  }
}
