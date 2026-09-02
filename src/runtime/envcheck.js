// Environment check. Classifies the machine into one of three outcomes:
//   'gpu'      hardware-backed WebGPU
//   'software' WebGPU present but software-rasterized (SwiftShader, llvmpipe, etc.) — treated as no GPU
//   'none'     no WebGPU

const SOFTWARE_HINTS = /swiftshader|llvmpipe|software|lavapipe|warp\b|microsoft basic render/i;

export async function runEnvironmentCheck() {
  const out = {
    checkedAt: new Date().toISOString(),
    userAgent: navigator.userAgent,
    chromium: /Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] ?? null,
    webgpu: !!navigator.gpu,
    adapter: null,
    limits: null,
    isSoftware: false,
    fileSystemAccess: typeof window !== 'undefined' && 'showDirectoryPicker' in window,
    crossOriginIsolated: !!globalThis.crossOriginIsolated,
    sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemoryGB: navigator.deviceMemory ?? null, // capped at 8 by the browser
    storage: null,
    persisted: null,
    outcome: 'none',
  };
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (adapter) {
        let info = adapter.info ?? null;
        if (!info && typeof adapter.requestAdapterInfo === 'function') info = await adapter.requestAdapterInfo();
        out.adapter = info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } : {};
        out.limits = {
          maxBufferSize: adapter.limits.maxBufferSize,
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
          maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
          maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
        };
        out.features = [...adapter.features].sort();
        out.isFallback = !!adapter.isFallbackAdapter;
        const text = `${info?.vendor ?? ''} ${info?.architecture ?? ''} ${info?.device ?? ''} ${info?.description ?? ''}`;
        out.isSoftware = out.isFallback || SOFTWARE_HINTS.test(text);
        out.outcome = out.isSoftware ? 'software' : 'gpu';
      }
    }
  } catch (e) {
    out.adapterError = String(e?.message ?? e);
  }
  try {
    if (navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      out.storage = { usage: est.usage, quota: est.quota };
    }
    if (navigator.storage?.persisted) out.persisted = await navigator.storage.persisted();
  } catch {}
  return out;
}

/** Human-readable recommendation for the model picker and the Environment screen. */
export function recommend(env) {
  if (!env) return { tier: null, backend: null, text: 'Environment check has not run yet.' };
  if (env.outcome === 'gpu') {
    const maxBind = env.limits?.maxStorageBufferBindingSize ?? 0;
    return {
      tier: 'lfm2.5-1.2b-instruct',
      backend: 'webgpu',
      text: `Hardware WebGPU adapter (${env.adapter?.vendor || 'unknown vendor'} ${env.adapter?.architecture || ''}). Largest single weight buffer: ${(maxBind / 1024 / 1024).toFixed(0)} MB. LFM2.5-1.2B at q4f16 (~760 MB) fits. The 8B-A1B ONNX export is marked by Liquid as too large for browser WebGPU; it is listed but disabled.`,
    };
  }
  const why = env.outcome === 'software' ? `WebGPU is present but software-rasterized (${env.adapter?.architecture || env.adapter?.vendor || 'fallback adapter'}); treated as no GPU.` : 'No WebGPU adapter.';
  return {
    tier: 'lfm2.5-1.2b-instruct',
    backend: 'wasm',
    text: `${why} Inference runs on the CPU through WebAssembly${env.crossOriginIsolated ? ` with ${env.hardwareConcurrency ?? '?'} threads` : ' on a single thread (page is not cross-origin isolated; SharedArrayBuffer unavailable)'}. LFM2.5-1.2B q4 (~850 MB) is the usable tier. LFM2.5-8B-A1B at q4f16 is 4.7 GB, above the 4 GB address space of 32-bit WebAssembly, so it cannot be loaded here.`,
  };
}
