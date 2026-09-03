import { h, plural } from './dom.js';
import { getRuntime } from '../runtime/index.js';
import { loadPresets } from '../plan/interpret.js';
import { runInterpret, runExecute, runAgent, currentJob, reviewQueued } from './jobs.js';

let mode = 'instruction';
let query = '';

export function renderModelPanel(right, store, selected) {
  const state = store.get();
  const rt = getRuntime();
  const ready = rt.ready;
  const caps = ready ? rt.adapter.capabilities() : null;
  const job = currentJob();

  right.append(h('div', { class: 'tabs' },
    h('button', { class: mode === 'instruction' ? 'active' : '', onclick: () => { mode = 'instruction'; store.set({}); } }, 'Instruction'),
    h('button', { class: mode === 'ask' ? 'active' : '', onclick: () => { mode = 'ask'; store.set({}); } }, 'Ask'),
  ));

  if (!ready) {
    right.append(h('div', { class: 'note' }, state.model.status === 'loading' ? `Loading ${state.model.id}: ${state.model.progress?.text ?? ''}` : state.model.status === 'error' ? `Model failed to load: ${state.model.error}` : 'No model loaded. Load one under Models, or use rules.'),
      h('div', { class: 'row' }, h('button', { onclick: () => store.set({ screen: 'models' }) }, 'Open Models')));
  } else {
    right.append(h('p', { class: 'muted' }, `${caps.model} on ${caps.backend}${caps.thinking ? ', reasoning checkpoint' : ', instruct checkpoint (no reasoning trace)'}${caps.grammarConstraints ? '' : '. Output is validated and retried rather than grammar-constrained.'}`));
  }
  if (state.notice) right.append(h('div', { class: 'note warn' }, state.notice, ' ', h('button', { class: 'small', onclick: () => store.set({ notice: null }) }, 'dismiss')));
  if (job) right.append(job.el);

  if (mode === 'instruction') renderInstruction(right, store, selected, ready && !job);
  else renderAsk(right, store, ready && !job);
}

function renderInstruction(right, store, selected, enabled) {
  const state = store.get();
  const ta = h('textarea', { rows: 4, placeholder: 'e.g. make these look nicer and group them by project', value: state.instruction, oninput: (e) => store.silent({ instruction: e.target.value }) });
  const presets = loadPresets();
  const presetSel = h('select', null, h('option', { value: '' }, presets.length ? 'Load a saved preset…' : 'No saved presets'), presets.map((p) => h('option', { value: p.name }, p.name)));
  presetSel.addEventListener('change', () => {
    const p = presets.find((x) => x.name === presetSel.value);
    if (p) store.set({ spec: p.spec, specMeta: { instruction: p.instruction ?? '', preset: p.name }, instruction: p.instruction ?? state.instruction, screen: 'interpret' });
  });
  const interpretBtn = h('button', { class: 'primary', disabled: !enabled || !selected.length, onclick: () => runInterpret(store, ta.value, selected) }, 'Interpret');
  const directBtn = h('button', { disabled: !enabled || !selected.length, onclick: () => runExecute(store, ta.value, selected, { title: `Instruction: ${ta.value.slice(0, 60)}` }) }, 'Plan directly');
  const guard = () => { const ok = ta.value.trim().length > 0; interpretBtn.disabled = !enabled || !ok || !selected.length; directBtn.disabled = interpretBtn.disabled; };
  ta.addEventListener('input', guard);
  guard();
  right.append(
    h('h2', null, 'Instruction'),
    ta,
    h('div', { class: 'row' }, interpretBtn, directBtn, h('span', { class: 'muted' }, `${plural(selected.length, 'file')}`)),
    h('p', { class: 'muted' }, 'Interpret turns the instruction into a written naming specification you can edit before any names are proposed. Plan directly skips that and uses the instruction as the specification.'),
    h('div', { class: 'row' }, presetSel),
    state.spec ? h('div', { class: 'row' }, h('button', { class: 'small', onclick: () => store.set({ screen: 'interpret' }) }, 'Open current specification')) : null,
  );
}

function renderAsk(right, store, enabled) {
  const state = store.get();
  const ta = h('textarea', { rows: 3, placeholder: 'e.g. which of these PDFs are invoices, and what years do they cover?', value: query, oninput: (e) => { query = e.target.value; } });
  const run = h('button', { class: 'primary', disabled: !enabled, onclick: () => { if (ta.value.trim()) runAgent(store, ta.value); } }, 'Run');
  right.append(h('h2', null, 'Ask about these files'), ta, h('div', { class: 'row' }, run),
    h('p', { class: 'muted' }, 'The model can list files, read the start of text files and get folder statistics. Any rename, move or new folder it proposes is queued for review, never applied.'));
  const a = state.agent;
  if (a) {
    right.append(h('h2', null, 'Answer'), h('div', { class: 'output' }, a.answer ?? h('span', { class: 'muted' }, 'No final answer (stopped at the iteration cap).')));
    if (a.plan?.length) right.append(h('div', { class: 'row' }, h('button', { onclick: () => reviewQueued(store, a.plan) }, `Review ${plural(a.plan.length, 'queued change')}`)));
  }
}
