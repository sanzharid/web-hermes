// Main-thread handle on the embedding worker.
export const EMBED_MODEL = {
  id: 'embeddinggemma-2',
  name: 'EmbeddingGemma 2 (text)',
  hf: 'onnx-community/embeddinggemma-2-ONNX',
  dtype: 'q4',
  bytes: 174_028_800 + 490_742 + 32_170_510, // q4 text weights + tokenizer
  dims: 256, // Matryoshka truncation: Google reports minimal quality loss down to 256d
};

// Task prefixes from the model card. Retrieval is asymmetric: queries and documents differ.
export const queryText = (q) => `task: search result | query: ${q}`;
export const documentText = (title, text) => `title: ${title || 'none'} | text: ${text}`;

export class Embedder {
  constructor({ ortBase, threads, remoteHost, device = 'wasm' } = {}) {
    Object.assign(this, { ortBase, threads, remoteHost, device });
    this.worker = null;
    this.seq = 0;
    this.pending = new Map();
    this.ready = false;
    this.info = null;
  }

  _call(msg, transfer) {
    if (!this.worker) {
      this.worker = new Worker(new URL('./embed-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.pending.get(e.data.id)?.(e.data);
      this.worker.onerror = (e) => { for (const h of this.pending.values()) h({ type: 'error', message: e.message ?? 'worker error' }); this.pending.clear(); };
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) => {
        if (m.type === 'progress') { msg.onProgress?.(m); return; }
        this.pending.delete(id);
        if (m.type === 'error') reject(new Error(m.message)); else resolve(m);
      });
      const { onProgress, ...plain } = msg;
      this.worker.postMessage({ ...plain, id }, transfer ?? []);
    });
  }

  async init(onProgress) {
    const m = await this._call({ type: 'init', hf: EMBED_MODEL.hf, dtype: EMBED_MODEL.dtype, device: this.device, ortBase: this.ortBase, threads: this.threads, remoteHost: this.remoteHost, onProgress });
    this.ready = true;
    this.info = m.info;
    return m.info;
  }

  /** @returns {Promise<{vectors: Float32Array[], stats: object}>} */
  async embed(texts, { dims = EMBED_MODEL.dims, maxLength = 512 } = {}) {
    const m = await this._call({ type: 'embed', texts, dims, maxLength });
    return { vectors: m.vectors, stats: m.stats };
  }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
  }
}
