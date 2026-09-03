import { h, fmtBytes } from './dom.js';
import { MODELS, variantFor, variantsFor, fmtMB } from '../runtime/models.js';
import { recommend } from '../runtime/envcheck.js';
import { getRuntime } from '../runtime/index.js';
import { saveSettings } from '../settings.js';

let scratchPrompt = 'Suggest a short, tidy filename for a PDF whose first line is "Quarterly Report Q3 2024 — Finance". Reply with the filename only.';
let scratchThinking = false;
let scratchOut = null;

export function renderModels(root, store) {
  const state = store.get();
  const rt = getRuntime();
  const rec = recommend(state.env);
  const backend = rec.backend ?? 'wasm';
  const page = h('div', { class: 'page models' });
  root.append(page);
  page.append(
    h('h1', null, 'Models'),
    h('p', { class: 'muted' }, state.env ? rec.text : 'Waiting for the environment check…'),
  );

  const m = state.model;
  for (const model of MODELS) {
    const chosen = state.settings.dtype?.[model.id];
    const v = variantFor(model, backend, chosen);
    const isLoaded = m.status === 'ready' && m.id === model.id;
    const isLoading = m.status === 'loading' && m.id === model.id;
    const card = h('div', { class: `model ${rec.tier === model.id ? 'recommended' : ''}` });
    const cached = h('span', { class: 'muted' }, '');
    rt.isCached(model).then((c) => { cached.textContent = c ? 'cached' : 'not downloaded'; });
    const actions = h('div', { class: 'row' });
    const note = h('div', { class: 'note warn', hidden: true });
    if (model.status === 'blocked') {
      actions.append(h('button', { disabled: true }, 'Not loadable in a browser'));
      note.hidden = false; note.textContent = model.blockedReason;
    } else if (isLoading) {
      const pct = m.progress?.total ? (m.progress.loaded / m.progress.total) * 100 : 0;
      actions.append(
        h('div', { style: { flex: 1 } }, h('div', { class: 'progress' }, h('div', { style: { width: `${pct}%` } })), h('span', { class: 'muted' }, `${m.progress?.text ?? ''}${m.progress?.file ? ` · ${m.progress.file}` : ''}`)),
        h('button', { onclick: () => rt.cancel() }, 'Cancel'),
      );
    } else if (isLoaded) {
      actions.append(
        h('span', { class: 'note ok', style: { margin: 0, padding: '2px 8px' } }, `loaded · ${m.backend} · ${m.loadInfo?.threads ? `${m.loadInfo.threads} threads · ` : ''}${m.loadInfo?.loadMs ? `${(m.loadInfo.loadMs / 1000).toFixed(1)} s to load` : ''}`),
        h('button', { onclick: async () => { note.hidden = true; try { const s = await rt.bench(); note.hidden = false; note.className = 'note ok'; note.textContent = `${s.tps.toFixed(2)} tokens/s decode · ${s.generated} tokens · prefill ${s.promptTokens} tokens in ${s.prefillMs} ms`; } catch (e) { note.hidden = false; note.textContent = e.message; } } }, 'Measure tokens/s'),
        h('button', { onclick: () => rt.unload() }, 'Unload'),
      );
    } else {
      const sel = h('select', { style: { width: 'auto' }, onchange: (e) => { const dtype = { ...(state.settings.dtype ?? {}), [model.id]: e.target.value }; store.set({ settings: saveSettings({ ...store.get().settings, dtype }) }); } },
        variantsFor(model, backend).map((x) => h('option', { value: x.dtype, selected: x.dtype === v.dtype }, `${x.dtype} · ${fmtMB(x.bytes)}`)));
      actions.append(
        sel,
        h('button', { class: 'primary', onclick: async () => { note.hidden = true; try { await rt.load(model.id); } catch (e) { if (e?.name !== 'AbortError') { note.hidden = false; note.textContent = e.message; } } } }, `Download & load (${fmtMB(v.bytes)})`),
        h('button', { class: 'small', onclick: async () => { await rt.deleteCached(model); store.set({}); } }, 'Delete cached'),
      );
    }
    card.append(
      h('div', { class: 'head' }, h('b', null, model.name), h('span', { class: 'muted' }, model.params), rec.tier === model.id ? h('span', { class: 'tag' }, 'recommended') : null, h('span', { class: 'spacer' }), cached),
      h('div', { class: 'muted', style: { margin: '4px 0' } }, `${model.notes} Context ${model.context.toLocaleString()} tokens. Reasoning: ${model.reasoning}.`),
      actions,
      note,
    );
    page.append(card);
  }

  // Settings relevant to the runtime
  const auto = h('input', { type: 'checkbox', checked: state.settings.autoLoad !== false, onchange: (e) => store.set({ settings: saveSettings({ ...store.get().settings, autoLoad: e.target.checked }) }) });
  page.append(h('div', { class: 'row' }, h('label', null, auto, ' Load the last used model automatically at startup when it is cached')));
  if (state.env?.storage) page.append(h('p', { class: 'muted' }, `Storage: ${fmtBytes(state.env.storage.usage)} used of ${fmtBytes(state.env.storage.quota)}. Persisted: ${state.env.persisted}.`));

  // Scratch generation: bare generate rendered to screen.
  page.append(h('h2', null, 'Try a prompt'));
  const ta = h('textarea', { rows: 3, value: scratchPrompt, oninput: (e) => { scratchPrompt = e.target.value; } });
  const think = h('input', { type: 'checkbox', checked: scratchThinking, onchange: (e) => { scratchThinking = e.target.checked; } });
  const out = h('div', { class: 'output' });
  if (scratchOut) out.append(scratchOut);
  let ctrl = null;
  const stop = h('button', { hidden: true, onclick: () => ctrl?.abort() }, 'Stop');
  const stats = h('span', { class: 'muted' });
  const run = h('button', { class: 'primary', disabled: !rt.ready, onclick: async () => {
    ctrl = new AbortController();
    run.disabled = true; stop.hidden = false; out.textContent = ''; stats.textContent = '';
    const thinkEl = h('span', { class: 'think' });
    const contentEl = h('span');
    out.append(thinkEl, contentEl);
    try {
      const r = await rt.adapter.complete({ messages: [{ role: 'user', content: scratchPrompt }], thinking: scratchThinking, signal: ctrl.signal, maxNewTokens: 512 }, (t) => {
        (t.kind === 'think' ? thinkEl : contentEl).append(t.text);
      });
      stats.textContent = `${r.stats.generated} tokens · ${r.stats.tps.toFixed(2)} tok/s · prefill ${r.stats.promptTokens} tokens in ${r.stats.prefillMs} ms${r.stats.interrupted ? ' · stopped' : ''}`;
      store.set({ model: { ...store.get().model, tps: r.stats.tps } });
      scratchOut = out.cloneNode(true).childNodes.length ? h('span', null, ...[...out.childNodes].map((n) => n.cloneNode(true))) : null;
    } catch (e) {
      out.textContent = `Error: ${e.message}`;
    } finally {
      run.disabled = !rt.ready; stop.hidden = true;
    }
  } }, 'Generate');
  page.append(
    ta,
    h('div', { class: 'row' }, run, stop, h('label', null, think, ' thinking (only has an effect on a reasoning checkpoint)'), stats),
    out,
  );
}
