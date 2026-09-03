import { h, plural } from './dom.js';
import { savePreset, deletePreset, loadPresets } from '../plan/interpret.js';
import { runExecute, runInterpret, currentJob } from './jobs.js';
import { selectedFiles } from './work.js';

export function renderInterpret(root, store) {
  const state = store.get();
  const files = selectedFiles(state);
  const meta = state.specMeta ?? {};
  const page = h('div', { class: 'page spec' });
  root.append(page);
  const ta = h('textarea', { class: 'mono', value: state.spec ?? '', oninput: (e) => store.silent({ spec: e.target.value }) });
  const job = currentJob();
  const note = h('div', { class: 'note', hidden: true });
  const useBtn = h('button', { class: 'primary', disabled: !!job || !files.length, onclick: () => { store.set({ spec: ta.value, screen: 'work' }); runExecute(store, ta.value, files, { title: meta.instruction ? `Instruction: ${meta.instruction.slice(0, 60)}` : 'Specification' }); } }, `Use this on ${plural(files.length, 'file')}`);
  const saveBtn = h('button', { onclick: () => {
    const name = prompt('Preset name', meta.preset ?? meta.instruction?.slice(0, 40) ?? 'preset');
    if (!name) return;
    savePreset({ name, spec: ta.value, instruction: meta.instruction ?? '' });
    note.hidden = false; note.textContent = `Saved preset "${name}".`;
  } }, 'Save as preset');
  const redo = h('button', { disabled: !!job || !meta.instruction, onclick: () => { store.set({ screen: 'work' }); runInterpret(store, meta.instruction, files); } }, 'Re-interpret');
  page.append(
    h('h1', null, 'Naming specification'),
    meta.instruction ? h('p', { class: 'muted' }, 'Instruction: ', h('i', null, meta.instruction)) : null,
    meta.preset ? h('p', { class: 'muted' }, `Loaded from preset "${meta.preset}".`) : null,
    h('p', { class: 'muted' }, 'This is what the model understood. Edit it until it says what you mean; the rename plan is generated from this text, not from the instruction.'),
    ta,
    h('div', { class: 'row' }, useBtn, saveBtn, redo, h('span', { class: 'spacer' }), h('button', { onclick: () => store.set({ screen: 'work' }) }, '← Back')),
    note,
  );
  if (meta.thinking) {
    page.append(h('details', null, h('summary', { class: 'muted' }, `Reasoning trace (${meta.thinking.length} chars${meta.stats ? `, ${meta.stats.generated} tokens at ${meta.stats.tps.toFixed(1)} tok/s` : ''})`), h('pre', null, meta.thinking)));
  } else if (meta.stats) {
    page.append(h('p', { class: 'muted' }, `${meta.usedThinking ? 'Thinking requested but the checkpoint has no reasoning mode. ' : 'Generated without reasoning. '}${meta.stats.generated} tokens at ${meta.stats.tps.toFixed(1)} tok/s.`));
  }
  const presets = loadPresets();
  if (presets.length) {
    page.append(h('h2', null, 'Saved presets'));
    for (const p of presets) {
      page.append(h('div', { class: 'row' }, h('b', null, p.name), h('span', { class: 'muted' }, p.instruction), h('button', { class: 'small', onclick: () => store.set({ spec: p.spec, specMeta: { instruction: p.instruction, preset: p.name } }) }, 'Load'), h('button', { class: 'small', onclick: () => { deletePreset(p.name); store.set({}); } }, 'Delete')));
    }
  }
}
