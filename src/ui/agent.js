// Agent console. The primary surface: you state a goal, the model plans and calls tools, and
// anything with side effects queues for review rather than executing.
import { h, plural } from './dom.js';
import { getRuntime } from '../runtime/index.js';
import { runAgent, currentJob, reviewQueued } from './jobs.js';
import { getRegistry } from '../harness/index.js';
import { MAX_ITERATIONS } from '../harness/loop.js';

let goal = '';

export function renderAgent(main, store) {
  const state = store.get();
  const rt = getRuntime();
  const ready = rt.ready;
  const job = currentJob();
  const running = job?.kind === 'agent';

  main.append(h('div', { class: 'toolbar' },
    h('b', null, 'Agent'),
    h('span', { class: 'muted' }, `${plural(getRegistry().list().filter((t) => !t.sideEffects).length, 'read tool')}, ${getRegistry().list().filter((t) => t.sideEffects).length} that queue for review · up to ${MAX_ITERATIONS} steps`),
    h('span', { class: 'spacer' }),
    ready ? h('span', { class: 'muted' }, costHint(state)) : null,
  ));

  const body = h('div', { class: 'tablewrap', style: { padding: '12px 16px' } });
  main.append(body);

  if (!ready) {
    body.append(h('div', { class: 'note warn' },
      state.model.status === 'loading' ? `Loading ${state.model.id}: ${state.model.progress?.text ?? ''}` : 'No model loaded. The agent needs one.',
      ' ', h('button', { class: 'small', onclick: () => store.set({ screen: 'models' }) }, 'Open Models')));
  }

  const ta = h('textarea', {
    rows: 3, class: 'mono', value: goal, disabled: running,
    placeholder: 'e.g. find every invoice in this folder and tell me which months are missing',
    oninput: (e) => { goal = e.target.value; },
  });
  const run = h('button', { class: 'primary', disabled: !ready || running, onclick: () => { if (ta.value.trim()) runAgent(store, ta.value); } }, 'Run');
  body.append(h('h2', { class: 'muted', style: { fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.04em', margin: '0 0 6px' } }, 'Goal'), ta,
    h('div', { class: 'row' }, run, running ? h('span', { class: 'muted' }, 'running — each step is a full generation') : null));

  if (state.notice) body.append(h('div', { class: 'note warn' }, state.notice, ' ', h('button', { class: 'small', onclick: () => store.set({ notice: null }) }, 'dismiss')));

  // Live run: jobs.js owns this element, including its cancel button and token stream.
  if (running) body.append(job.el);

  const a = state.agent;
  if (a && !running) {
    body.append(h('h2', { class: 'muted', style: { fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.04em', margin: '18px 0 6px' } }, 'Result'));
    body.append(h('div', { class: 'muted', style: { marginBottom: '6px' } }, h('i', null, a.query)));
    body.append(h('div', { class: 'output' }, a.answer ?? h('span', { class: 'muted' }, `No final answer: the loop hit its ${MAX_ITERATIONS}-step cap. Narrow the goal, or ask for one thing at a time.`)));
    if (a.plan?.length) {
      body.append(h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => reviewQueued(store, a.plan) }, `Review ${plural(a.plan.length, 'queued change')}`),
        h('span', { class: 'muted' }, 'nothing has been written yet')));
    }
    body.append(renderTrace(a.events));
  }
}

function renderTrace(events = []) {
  const wrap = h('details', { style: { marginTop: '12px' } });
  const steps = events.filter((e) => e.type === 'iteration').length;
  const calls = events.filter((e) => e.type === 'tool-call').length;
  wrap.append(h('summary', { class: 'muted' }, `Trace: ${plural(steps, 'step')}, ${plural(calls, 'tool call')}`));
  const list = h('div', { class: 'mono', style: { fontSize: '12px', marginTop: '6px' } });
  for (const e of events) {
    if (e.type === 'iteration') list.append(h('div', { style: { marginTop: '6px', fontWeight: '600' } }, `step ${e.n}`));
    else if (e.type === 'tool-call') list.append(h('div', null, `→ ${e.name}(${JSON.stringify(e.arguments)})`));
    else if (e.type === 'tool-result') list.append(h('div', { class: 'muted' }, `← ${JSON.stringify(e.result).slice(0, 200)}`));
    else if (e.type === 'queued') list.append(h('div', { style: { color: 'var(--changed)' } }, `queued ${e.name}(${JSON.stringify(e.arguments)})`));
    else if (e.type === 'tool-unknown') list.append(h('div', { class: 'muted' }, `unknown tool ${e.name}`));
    else if (e.type === 'parse-error') list.append(h('div', { class: 'muted' }, `parse: ${e.errors.join('; ')}`));
    else if (e.type === 'cap') list.append(h('div', { class: 'muted' }, `stopped at the ${e.n}-step cap`));
  }
  wrap.append(list);
  return wrap;
}

/** Honest expectation-setting: on a CPU backend each step costs real time. */
function costHint(state) {
  const tps = state.model.tps;
  if (!tps) return 'throughput not measured — run Measure tokens/s under Models';
  if (tps >= 8) return `${tps.toFixed(1)} tok/s`;
  return `${tps.toFixed(1)} tok/s — expect roughly a minute per step`;
}
