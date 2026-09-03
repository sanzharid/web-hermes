// Inference worker. Owns the Transformers.js model; the main thread talks to it through messages.
import { env, AutoTokenizer, AutoModelForCausalLM, TextStreamer, InterruptableStoppingCriteria } from '@huggingface/transformers';

let tokenizer = null;
let model = null;
let loaded = null; // { hf, dtype, device }
let stopper = null;
let busy = false;

env.allowLocalModels = false;
env.useBrowserCache = true;

function post(msg) {
  self.postMessage(msg);
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') await init(m);
    else if (m.type === 'generate') await generate(m);
    else if (m.type === 'abort') stopper?.interrupt();
    else if (m.type === 'unload') { await unload(); post({ type: 'unloaded', id: m.id }); }
    else if (m.type === 'ping') post({ type: 'pong', id: m.id });
  } catch (err) {
    post({ type: 'error', id: m.id, message: err?.message ?? String(err), stack: err?.stack });
  }
};

async function unload() {
  try { await model?.dispose?.(); } catch {}
  model = null; tokenizer = null; loaded = null;
}

async function init({ id, hf, dtype, device, ortBase, threads, remoteHost, external }) {
  if (remoteHost) env.remoteHost = remoteHost; // test mirrors only; production always uses the Hugging Face host
  if (loaded && loaded.hf === hf && loaded.dtype === dtype && loaded.device === device) { post({ type: 'ready', id, info: loaded }); return; }
  await unload();
  const onnx = env.backends.onnx;
  if (ortBase) {
    // The asyncify build carries the WebGPU execution provider; its CPU kernel set lacks
    // GatherBlockQuantized, which the q4 exports use for embeddings. The plain build is CPU-only
    // and complete, so it is used whenever inference runs on the CPU.
    const flavour = device === 'webgpu' ? '.asyncify' : '';
    onnx.wasm.wasmPaths = { mjs: `${ortBase}ort-wasm-simd-threaded${flavour}.mjs`, wasm: `${ortBase}ort-wasm-simd-threaded${flavour}.wasm` };
  }
  if (threads) onnx.wasm.numThreads = threads;

  const files = new Map(); // file -> { loaded, total }
  let lastPost = 0;
  const progress_callback = (p) => {
    if (p.status === 'progress' || p.status === 'done') {
      files.set(p.file, { loaded: p.status === 'done' ? (files.get(p.file)?.total ?? p.total ?? 0) : p.loaded ?? 0, total: p.total ?? files.get(p.file)?.total ?? 0 });
    } else if (p.status === 'initiate') {
      if (!files.has(p.file)) files.set(p.file, { loaded: 0, total: 0 });
    }
    const now = performance.now();
    if (now - lastPost > 100 || p.status === 'done' || p.status === 'ready') {
      lastPost = now;
      let l = 0, t = 0;
      for (const f of files.values()) { l += f.loaded; t += f.total; }
      post({ type: 'progress', id, file: p.file, status: p.status, loaded: l, total: t });
    }
  };
  const t0 = performance.now();
  tokenizer = await AutoTokenizer.from_pretrained(hf, { progress_callback });
  // `external` is the number of external weight files; passed explicitly because some repo configs key it wrongly.
  model = await AutoModelForCausalLM.from_pretrained(hf, { device, dtype, progress_callback, ...(external ? { use_external_data_format: external } : {}) });
  loaded = { hf, dtype, device, loadMs: Math.round(performance.now() - t0), threads: onnx.wasm.numThreads ?? null };
  post({ type: 'ready', id, info: loaded });
}

async function generate({ id, req }) {
  if (!model) throw new Error('no model loaded');
  if (busy) throw new Error('generation already in progress');
  busy = true;
  try {
    const { messages, tools, prefill = '', sampling = {}, maxNewTokens = 1024 } = req;
    let text = tokenizer.apply_chat_template(messages, { tools: tools?.length ? tools : undefined, add_generation_prompt: true, tokenize: false });
    if (prefill) text += prefill;
    const inputs = tokenizer(text, { add_special_tokens: false });
    const promptTokens = inputs.input_ids.dims.at(-1);

    stopper = new InterruptableStoppingCriteria();
    let first = 0;
    let count = 0;
    const t0 = performance.now();
    const streamer = new TextStreamer(tokenizer, {
      skip_prompt: true,
      skip_special_tokens: false,
      callback_function: (piece) => { post({ type: 'token', id, text: piece }); },
      token_callback_function: () => { count++; if (!first) first = performance.now(); },
    });
    const temperature = sampling.temperature ?? 0.1;
    const gen = {
      ...inputs,
      max_new_tokens: maxNewTokens,
      do_sample: temperature > 0,
      temperature: temperature > 0 ? temperature : 1,
      top_k: sampling.top_k ?? 50,
      top_p: sampling.top_p ?? 1,
      repetition_penalty: sampling.repetition_penalty ?? 1,
      streamer,
      stopping_criteria: stopper,
      return_dict_in_generate: false,
    };
    const out = await model.generate(gen);
    const t1 = performance.now();
    const ids = typeof out.tolist === 'function' ? out.tolist()[0] : Array.from(out.data);
    const newIds = ids.slice(promptTokens).map(Number);
    // keep <|tool_call_start|>/<|tool_call_end|> (they are special tokens the parser needs); drop turn markers
    const full = tokenizer.decode(newIds, { skip_special_tokens: false }).replace(/<\|im_end\|>|<\|im_start\|>|<\|startoftext\|>|<\|pad\|>/g, '');
    const generated = newIds.length;
    post({
      type: 'done', id, text: full,
      stats: {
        promptTokens, generated,
        prefillMs: Math.round((first || t1) - t0),
        decodeMs: Math.round(t1 - (first || t0)),
        tps: generated > 1 && first ? (generated - 1) / ((t1 - first) / 1000) : generated / ((t1 - t0) / 1000),
        interrupted: stopper.interrupted ?? false,
      },
    });
  } finally {
    busy = false;
    stopper = null;
  }
}
