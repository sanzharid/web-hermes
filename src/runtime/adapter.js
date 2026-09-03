// Runtime adapter. The harness only sees this interface:
//   init(modelId, onProgress) -> Promise<void>
//   generate({ messages, tools?, schema?, thinking?, signal }) -> AsyncIterable<Token>
//   capabilities() -> { grammarConstraints, thinking, backend }
//   unload() -> void
// Backed by Transformers.js in a Web Worker. Tokens are { kind: 'think'|'content'|'done', text, stats? }.

import { getModel, variantFor } from './models.js';
import { JSON_TOOL_DIRECTIVE, toolSpec, splitThinking } from './lfm.js';

export class TransformersAdapter {
  constructor({ backend, ortBase, threads, remoteHost, dtype } = {}) {
    this.remoteHost = remoteHost;
    this.dtype = dtype;
    this.backend = backend ?? 'wasm';
    this.ortBase = ortBase;
    this.threads = threads;
    this.worker = null;
    this.model = null;
    this.variant = null;
    this.ready = false;
    this.seq = 0;
    this.pending = new Map();
    this.loadInfo = null;
  }

  _spawn() {
    if (this.worker) return;
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      p.handler(m);
    };
    this.worker.onerror = (e) => {
      for (const p of this.pending.values()) p.handler({ type: 'error', message: e.message ?? 'worker error' });
      this.pending.clear();
    };
  }

  _call(msg, handler) {
    this._spawn();
    const id = ++this.seq;
    this.pending.set(id, { handler });
    this.worker.postMessage({ ...msg, id });
    return id;
  }

  async init(modelId, onProgress, { signal } = {}) {
    const model = getModel(modelId);
    if (!model) throw new Error(`unknown model ${modelId}`);
    if (model.status === 'blocked') throw new Error(model.blockedReason);
    const variant = variantFor(model, this.backend, this.dtype);
    this.ready = false;
    this.model = model;
    this.variant = variant;
    await new Promise((resolve, reject) => {
      const id = this._call({ type: 'init', hf: model.hf, dtype: variant.dtype, external: variant.external ?? null, device: this.backend, ortBase: this.ortBase, threads: this.threads, remoteHost: this.remoteHost }, (m) => {
        if (m.type === 'progress') onProgress?.(m);
        else if (m.type === 'ready') { this.pending.delete(id); this.loadInfo = m.info; this.ready = true; resolve(); }
        else if (m.type === 'error') { this.pending.delete(id); reject(new Error(m.message)); }
      });
      signal?.addEventListener('abort', () => {
        this.pending.delete(id);
        this.terminate();
        reject(new DOMException('download cancelled', 'AbortError'));
      }, { once: true });
    });
  }

  capabilities() {
    return {
      grammarConstraints: false, // Transformers.js has no sampler-level grammar; plan layer validates and retries
      thinking: this.model?.reasoning === 'always',
      // Measured on LFM2.5-1.2B-Thinking: prefilling an empty <think></think> block does not stop the
      // model reasoning, it just reasons untagged in the content. Reasoning is per checkpoint, so a
      // call's `thinking` flag cannot be honoured on this runtime; callers pick the checkpoint instead.
      thinkingControl: false,
      backend: this.backend,
      model: this.model?.id ?? null,
      context: this.model?.context ?? null,
    };
  }

  /**
   * Stream tokens. `thinking: false` on a reasoning checkpoint prefills an empty think block.
   * `tools` are {name, description, schema} registry entries; the JSON call format is requested.
   * `schema` has no sampler-level effect (see capabilities) but is folded into the prompt hint and
   * used to prefill the opening bracket so output starts as JSON.
   */
  async *generate({ messages, tools, schema, thinking = false, signal, sampling, maxNewTokens, prefill = '' }) {
    if (!this.ready) throw new Error('model not loaded');
    const msgs = messages.map((m) => ({ ...m }));
    let system = msgs[0]?.role === 'system' ? msgs.shift() : null;
    let sysText = system?.content ?? '';
    if (tools?.length) sysText += (sysText ? '\n' : '') + JSON_TOOL_DIRECTIVE;
    const finalMessages = sysText ? [{ role: 'system', content: sysText }, ...msgs] : msgs;

    let pre = prefill;
    // `thinking` is accepted for interface compatibility; see capabilities().thinkingControl.
    void thinking;
    if (schema && !pre.trim()) pre += schema.type === 'array' ? '[' : schema.type === 'object' ? '{' : '';

    const queue = [];
    let notify = null;
    let done = false;
    let error = null;
    const push = (t) => { queue.push(t); notify?.(); };
    const id = this._call({
      type: 'generate',
      req: { messages: finalMessages, tools: tools?.map(toolSpec), prefill: pre, sampling: { ...this.model.sampling, ...(sampling ?? {}) }, maxNewTokens: maxNewTokens ?? 1024 },
    }, (m) => {
      if (m.type === 'token') push({ kind: 'raw', text: m.text });
      else if (m.type === 'done') { this.pending.delete(id); push({ kind: 'done', text: m.text, stats: m.stats }); done = true; notify?.(); }
      else if (m.type === 'error') { this.pending.delete(id); error = new Error(m.message); done = true; notify?.(); }
    });
    const onAbort = () => this.worker?.postMessage({ type: 'abort', id });
    signal?.addEventListener('abort', onAbort, { once: true });

    // Re-tag raw pieces as think/content by tracking <think> … </think> in the stream (prefill included).
    let buf = '';
    let inThink = pre.startsWith('<think>') && !pre.includes('</think>');
    let pendingTag = '';
    try {
      while (true) {
        if (!queue.length) {
          if (done) break;
          await new Promise((r) => { notify = r; });
          notify = null;
          continue;
        }
        const t = queue.shift();
        if (t.kind === 'done') {
          if (pendingTag) yield { kind: inThink ? 'think' : 'content', text: pendingTag };
          const { thinking: th, content } = splitThinking(pre + t.text);
          yield { kind: 'done', text: t.text, content, thinking: th, stats: t.stats, prefill: pre };
          break;
        }
        buf = pendingTag + t.text;
        pendingTag = '';
        // emit text up to a possible partial tag at the end
        let out = '';
        for (;;) {
          const open = buf.indexOf('<think>');
          const close = buf.indexOf('</think>');
          const next = [open, close].filter((x) => x >= 0).sort((a, b) => a - b)[0];
          if (next === undefined) break;
          out += buf.slice(0, next);
          if (out) { yield { kind: inThink ? 'think' : 'content', text: out }; out = ''; }
          if (next === open) { inThink = true; buf = buf.slice(next + 7); } else { inThink = false; buf = buf.slice(next + 8); }
        }
        // keep a trailing partial "<", "</th" etc. for the next chunk
        const lt = buf.lastIndexOf('<');
        if (lt >= 0 && buf.length - lt < 8 && '<think></think>'.startsWith(buf.slice(lt)) ) { pendingTag = buf.slice(lt); buf = buf.slice(0, lt); }
        if (buf) yield { kind: inThink ? 'think' : 'content', text: buf };
        buf = '';
      }
      if (error) throw error;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  /** Convenience: run generate() to completion. Returns { content, thinking, raw, stats }. */
  async complete(req, onToken) {
    let last = null;
    for await (const t of this.generate(req)) {
      if (t.kind === 'done') last = t;
      else onToken?.(t);
    }
    return { content: last?.content ?? '', thinking: last?.thinking ?? '', raw: last?.text ?? '', stats: last?.stats ?? null, prefill: last?.prefill ?? '' };
  }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.pending.clear();
    this.ready = false;
  }

  unload() {
    this.terminate();
    this.model = null;
    this.variant = null;
    this.loadInfo = null;
  }
}
