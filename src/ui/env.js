import { h, fmtBytes } from './dom.js';
import { runEnvironmentCheck, recommend } from '../runtime/envcheck.js';

export function renderEnv(root, store) {
  const env = store.get().env;
  const page = h('div', { class: 'page' });
  root.append(page);
  page.append(h('h1', null, 'Environment'));
  if (!env) { page.append(h('p', { class: 'muted' }, 'Checking…')); return; }
  if (env.error) { page.append(h('div', { class: 'note warn' }, `Check failed: ${env.error}`)); }
  const rec = recommend(env);
  const outcomeText = { gpu: 'Hardware WebGPU present', software: 'WebGPU present but software-rasterized (treated as no GPU)', none: 'No WebGPU' }[env.outcome];
  page.append(
    h('div', { class: `note ${env.outcome === 'gpu' ? 'ok' : 'warn'}` }, h('b', null, outcomeText), ' — ', rec.text),
    h('h2', null, 'Details'),
    h('dl', { class: 'kv' },
      kv('Chromium', env.chromium ?? 'not Chromium'),
      kv('File System Access', env.fileSystemAccess ? 'yes' : 'no — required'),
      kv('WebGPU', env.webgpu ? 'yes' : 'no'),
      kv('Adapter', env.adapter ? `${env.adapter.vendor || '?'} / ${env.adapter.architecture || '?'} / ${env.adapter.device || '?'} ${env.adapter.description || ''}` : env.adapterError ?? 'none'),
      kv('Fallback adapter', String(env.isFallback ?? 'n/a')),
      kv('maxBufferSize', env.limits ? fmtBytes(env.limits.maxBufferSize) : '—'),
      kv('maxStorageBufferBindingSize', env.limits ? fmtBytes(env.limits.maxStorageBufferBindingSize) : '—'),
      kv('shader-f16', env.features ? String(env.features.includes('shader-f16')) : '—'),
      kv('Cross-origin isolated', String(env.crossOriginIsolated)),
      kv('SharedArrayBuffer', String(env.sharedArrayBuffer)),
      kv('CPU threads', env.hardwareConcurrency ?? '?'),
      kv('Device memory (capped at 8)', env.deviceMemoryGB ? `${env.deviceMemoryGB} GB` : '?'),
      kv('Storage', env.storage ? `${fmtBytes(env.storage.usage)} used of ${fmtBytes(env.storage.quota)}` : '?'),
      kv('Storage persisted', String(env.persisted)),
    ),
    h('h2', null, 'Recommendation'),
    h('dl', { class: 'kv' }, kv('Backend', rec.backend ?? '—'), kv('Model tier', rec.tier ?? '—')),
    h('p', { class: 'muted' }, 'Also check chrome://gpu for whether WebGPU is hardware accelerated or blocklisted; a page cannot read that.'),
    h('div', { class: 'row' }, h('button', { onclick: async () => { store.set({ env: null }); store.set({ env: await runEnvironmentCheck() }); } }, 'Re-run check')),
    h('h2', null, 'Raw'),
    h('pre', null, JSON.stringify(env, null, 2)),
  );
}

function kv(k, v) {
  return [h('dt', null, k), h('dd', null, String(v))];
}
