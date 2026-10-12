// Embedding worker: EmbeddingGemma 2, text encoder only. One forward pass per batch, no decoding,
// which is why this stays usable on a CPU backend where token-by-token generation does not.
import { env, AutoConfig, AutoModel, AutoTokenizer } from '@huggingface/transformers';

let model = null;
let tokenizer = null;
let loaded = null;

env.allowLocalModels = false;
env.useBrowserCache = true;

const post = (m) => self.postMessage(m);

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') await init(m);
    else if (m.type === 'embed') await embed(m);
  } catch (err) {
    post({ type: 'error', id: m.id, message: err?.message ?? String(err) });
  }
};

async function init({ id, hf, dtype, device, ortBase, threads, remoteHost }) {
  if (loaded && loaded.hf === hf && loaded.dtype === dtype && loaded.device === device) { post({ type: 'ready', id, info: loaded }); return; }
  if (remoteHost) env.remoteHost = remoteHost; // test mirrors only
  const onnx = env.backends.onnx;
  if (ortBase) {
    // Same reasoning as the generation worker: the CPU-only build has the full kernel set.
    const flavour = device === 'webgpu' ? '.asyncify' : '';
    onnx.wasm.wasmPaths = { mjs: `${ortBase}ort-wasm-simd-threaded${flavour}.mjs`, wasm: `${ortBase}ort-wasm-simd-threaded${flavour}.wasm` };
  }
  if (threads) onnx.wasm.numThreads = threads;

  const files = new Map();
  let last = 0;
  const progress_callback = (p) => {
    if (p.status === 'progress' || p.status === 'done') {
      const prev = files.get(p.file) ?? { loaded: 0, total: 0 };
      files.set(p.file, { loaded: p.status === 'done' ? (prev.total || p.total || 0) : (p.loaded ?? 0), total: p.total ?? prev.total });
    } else if (p.status === 'initiate' && !files.has(p.file)) files.set(p.file, { loaded: 0, total: 0 });
    const now = performance.now();
    if (now - last > 100 || p.status === 'done') {
      last = now;
      let l = 0, t = 0;
      for (const f of files.values()) { l += f.loaded; t += f.total; }
      post({ type: 'progress', id, loaded: l, total: t, file: p.file });
    }
  };

  const t0 = performance.now();
  // Text only: without the vision and audio configs, their encoders (~1.3 GB more) are never fetched.
  const config = await AutoConfig.from_pretrained(hf, { progress_callback });
  config.vision_config = null;
  config.audio_config = null;
  tokenizer = await AutoTokenizer.from_pretrained(hf, { progress_callback });
  model = await AutoModel.from_pretrained(hf, { config, dtype, device, progress_callback });
  loaded = { hf, dtype, device, loadMs: Math.round(performance.now() - t0), threads: onnx.wasm.numThreads ?? null };
  post({ type: 'ready', id, info: loaded });
}

/**
 * Embed texts. Returns one Float32Array per text, truncated to `dims` (Matryoshka) and
 * re-normalised, so a dot product is cosine similarity.
 */
async function embed({ id, texts, dims = 768, maxLength = 512 }) {
  if (!model) throw new Error('embedding model not loaded');
  const t0 = performance.now();
  const inputs = tokenizer(texts, { padding: true, truncation: true, max_length: maxLength });
  const tokens = Number(inputs.attention_mask.data.reduce((a, b) => a + Number(b), 0));
  const out = await model(inputs);
  const emb = out.sentence_embedding;
  const [n, full] = emb.dims;
  const d = Math.min(dims, full);
  const data = emb.data;
  const vectors = [];
  for (let i = 0; i < n; i++) {
    const v = new Float32Array(d);
    let s = 0;
    for (let j = 0; j < d; j++) { v[j] = data[i * full + j]; s += v[j] * v[j]; }
    const inv = s > 0 ? 1 / Math.sqrt(s) : 0;
    for (let j = 0; j < d; j++) v[j] *= inv;
    vectors.push(v);
  }
  const ms = performance.now() - t0;
  post({ type: 'embedded', id, vectors, stats: { texts: n, tokens, ms: Math.round(ms), tokensPerSec: tokens / (ms / 1000) } }, vectors.map((v) => v.buffer));
}
