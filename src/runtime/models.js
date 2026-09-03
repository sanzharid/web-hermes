// Model registry. Facts verified against the Hugging Face repos on 2026-09-02.
// Per-call thinking is not a template flag in LFM2.5: it is a property of the checkpoint.
// `reasoning: 'always'` checkpoints open every answer with <think>…</think>; the adapter
// suppresses that with an empty think-block prefill when a call asks for thinking: false.

export const MODELS = [
  {
    id: 'lfm2.5-1.2b-instruct',
    name: 'LFM2.5-1.2B-Instruct',
    hf: 'LiquidAI/LFM2.5-1.2B-Instruct-ONNX',
    params: '1.2B',
    reasoning: 'never',
    context: 32768,
    variants: { q4f16: 760_279_040 + 182_795, q4: 850_059_264 + 183_173, q8: 1_520_558_080 + 185_703 /* model_quantized.onnx: transformers.js maps dtype q8 to that file */ },
    defaults: { webgpu: 'q4f16', wasm: 'q4' },
    sampling: { temperature: 0.1, top_p: 0.1, top_k: 50, repetition_penalty: 1.05 },
    notes: 'Instruction following and tool use. No reasoning trace. Default tier for planning and structured output.',
    status: 'ok',
  },
  {
    id: 'lfm2.5-1.2b-thinking',
    name: 'LFM2.5-1.2B-Thinking',
    hf: 'LiquidAI/LFM2.5-1.2B-Thinking-ONNX',
    params: '1.2B',
    reasoning: 'always',
    context: 32768,
    variants: { q4f16: 760_279_040 + 182_795, q4: 850_059_264 + 183_173, q8: 1_520_558_080 + 185_703 /* model_quantized.onnx: transformers.js maps dtype q8 to that file */ },
    defaults: { webgpu: 'q4f16', wasm: 'q4' },
    sampling: { temperature: 0.05, top_p: 0.1, top_k: 50, repetition_penalty: 1.05 },
    notes: 'Same size, reasoning-tuned. Emits a <think> block first; the adapter can suppress it per call. Use for interpretation and planning; slower per answer.',
    status: 'ok',
  },
  {
    id: 'lfm2.5-8b-a1b',
    name: 'LFM2.5-8B-A1B',
    hf: 'LiquidAI/LFM2.5-8B-A1B-ONNX',
    params: '8.3B total / 1.5B active (MoE)',
    reasoning: 'always',
    context: 128000,
    variants: { q4f16: 2_146_754_560 + 2_130_632_704 + 767_897_600, q4: 2_137_366_528 + 2_146_213_888 + 1_310_531_584 },
    defaults: { webgpu: 'q4f16', wasm: 'q4' },
    sampling: { temperature: 0.2, top_p: 0.1, top_k: 80, repetition_penalty: 1.05 },
    notes: 'The tier the spec wants for a general harness. Not loadable in a browser today.',
    status: 'blocked',
    blockedReason: 'Liquid\'s ONNX card states this export is too large for WebGPU browser inference, and its smallest variant (q4f16, 4.7 GB) exceeds the 4 GB address space of 32-bit WebAssembly. No browser runtime has an LFM2-MoE build under that limit. Registry entry kept so it can be enabled when one exists.',
  },
];

export function getModel(id) {
  return MODELS.find((m) => m.id === id) ?? null;
}

/** Pick the weight variant: an explicit dtype (if the model has it) or the backend default. */
export function variantFor(model, backend, dtype) {
  const d = dtype && model.variants[dtype] ? dtype : model.defaults[backend] ?? model.defaults.wasm;
  return { dtype: d, bytes: model.variants[d] };
}

/** Variants usable on a backend: fp16-based ones need WebGPU. */
export function variantsFor(model, backend) {
  return Object.entries(model.variants).filter(([d]) => backend === 'webgpu' || !d.includes('f16')).map(([dtype, bytes]) => ({ dtype, bytes }));
}

export function fmtMB(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}
