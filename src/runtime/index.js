// Runtime singleton: owns the adapter, reports status into the store, handles cache and storage.
import { TransformersAdapter } from './adapter.js';
import { getModel, variantFor, fmtMB } from './models.js';
import { recommend } from './envcheck.js';
import { saveSettings } from '../settings.js';

const CACHE_NAME = 'transformers-cache';

class Runtime {
  constructor() {
    this.adapter = null;
    this.store = null;
    this.abort = null;
    this.backend = null;
    this.remoteHost = null; // test hook: local mirror of the Hugging Face layout
  }

  attach(store) {
    this.store = store;
    const unsub = store.subscribe((s) => {
      if (s.env && !this.backend) {
        this.backend = recommend(s.env).backend;
        unsub();
        if (s.settings.modelId && s.settings.autoLoad !== false) this.autoLoad(s.settings.modelId);
      }
    });
  }

  ortBase() {
    return new URL('ort/', document.baseURI).href;
  }

  threads() {
    if (!globalThis.crossOriginIsolated) return 1;
    return Math.max(1, Math.min(navigator.hardwareConcurrency ?? 4, 8));
  }

  async autoLoad(modelId) {
    const m = getModel(modelId);
    if (!m || m.status !== 'ok') return;
    if (await this.isCached(m)) this.load(modelId).catch(() => {});
  }

  status(patch) {
    const cur = this.store.get().model;
    this.store.set({ model: { ...cur, ...patch } });
  }

  dtypeFor(model) {
    return this.store?.get().settings.dtype?.[model.id];
  }

  async isCached(model) {
    try {
      const cache = await caches.open(CACHE_NAME);
      const keys = await cache.keys();
      const v = variantFor(model, this.backend ?? 'wasm', this.dtypeFor(model));
      const need = `/${model.hf}/resolve/main/onnx/model_${v.dtype}.onnx`;
      return keys.some((r) => r.url.includes(need) && !r.url.includes('.onnx_data')) && keys.some((r) => r.url.includes(`${need}_data`));
    } catch {
      return false;
    }
  }

  async cachedBytes(model) {
    try {
      const cache = await caches.open(CACHE_NAME);
      const keys = await cache.keys();
      let total = 0;
      for (const r of keys) {
        if (!r.url.includes(`/${model.hf}/`)) continue;
        const res = await cache.match(r);
        const len = Number(res?.headers.get('content-length')) || 0;
        total += len || (await res.blob()).size;
      }
      return total;
    } catch {
      return 0;
    }
  }

  async deleteCached(model) {
    const cache = await caches.open(CACHE_NAME);
    for (const r of await cache.keys()) if (r.url.includes(`/${model.hf}/`)) await cache.delete(r);
  }

  async storageCheck(bytes) {
    if (!navigator.storage?.estimate) return { ok: true };
    const est = await navigator.storage.estimate();
    const free = (est.quota ?? 0) - (est.usage ?? 0);
    return { ok: free > bytes * 1.15, free, quota: est.quota, usage: est.usage };
  }

  async load(modelId) {
    const model = getModel(modelId);
    if (!model) throw new Error('unknown model');
    if (model.status !== 'ok') throw new Error(model.blockedReason);
    const backend = this.backend ?? recommend(this.store.get().env).backend ?? 'wasm';
    const variant = variantFor(model, backend, this.dtypeFor(model));
    if (!(await this.isCached(model))) {
      const s = await this.storageCheck(variant.bytes);
      if (!s.ok) throw new Error(`Not enough storage: ${fmtMB(variant.bytes)} needed, ${fmtMB(s.free)} free of ${fmtMB(s.quota)}.`);
    }
    this.abort?.abort();
    this.abort = new AbortController();
    if (this.adapter) this.adapter.unload();
    this.adapter = new TransformersAdapter({ backend, ortBase: this.ortBase(), threads: this.threads(), remoteHost: this.remoteHost ?? undefined, dtype: variant.dtype });
    this.status({ status: 'loading', id: model.id, backend, dtype: variant.dtype, progress: { loaded: 0, total: variant.bytes, text: '0 MB' }, error: null, tps: null });
    try {
      await this.adapter.init(model.id, (p) => {
        const total = p.total || variant.bytes;
        this.status({ progress: { loaded: p.loaded, total, text: `${fmtMB(p.loaded)} / ${fmtMB(total)}`, file: p.file } });
      }, { signal: this.abort.signal });
      this.status({ status: 'ready', progress: null, loadInfo: this.adapter.loadInfo });
      const settings = saveSettings({ ...this.store.get().settings, modelId: model.id });
      this.store.set({ settings });
      try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {}
    } catch (e) {
      if (e?.name === 'AbortError') this.status({ status: 'none', id: null, progress: null });
      else this.status({ status: 'error', error: e.message, progress: null });
      throw e;
    }
  }

  cancel() {
    this.abort?.abort();
  }

  unload() {
    this.adapter?.unload();
    this.adapter = null;
    this.status({ status: 'none', id: null, progress: null, tps: null });
  }

  get ready() {
    return !!this.adapter?.ready;
  }

  /** Measure tokens/sec with a fixed prompt. */
  async bench({ signal } = {}) {
    if (!this.ready) throw new Error('no model loaded');
    const r = await this.adapter.complete({
      messages: [{ role: 'user', content: 'List ten short, distinct English nouns as a comma-separated line, then stop.' }],
      thinking: false, maxNewTokens: 48, signal, sampling: { temperature: 0 },
    });
    this.status({ tps: r.stats.tps, bench: r.stats });
    return r.stats;
  }
}

let runtime = null;
export function getRuntime() {
  if (!runtime) runtime = new Runtime();
  return runtime;
}
