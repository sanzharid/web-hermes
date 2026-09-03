// Long-running model jobs (interpretation, execution, agent loop) with a small live status box.
import { h, plural } from './dom.js';
import { getRuntime } from '../runtime/index.js';
import { enrichFiles } from '../plan/enrich.js';
import { executePlan } from '../plan/execute.js';
import { interpret } from '../plan/interpret.js';
import { openPlan } from '../plan/build.js';
import { runLoop, createLoopState } from '../harness/loop.js';
import { getRegistry } from '../harness/index.js';
import { queuedToOps } from '../harness/tools/files.js';

let current = null; // { kind, ctrl, el, ... }

export function currentJob() {
  return current;
}

function box(title) {
  const status = h('div', { class: 'muted' }, 'starting…');
  const thinkEl = h('span', { class: 'think' });
  const contentEl = h('span');
  const out = h('div', { class: 'output' }, thinkEl, contentEl);
  const progress = h('div', { class: 'progress' }, h('div', { style: { width: '0%' } }));
  const cancel = h('button', { class: 'small' }, 'Cancel');
  const skip = h('button', { class: 'small', hidden: true }, 'Skip thinking, retry without');
  const el = h('div', { class: 'rule' }, h('div', { class: 'rule-head' }, h('b', null, title), cancel, skip), status, progress, out);
  return { el, status, thinkEl, contentEl, out, progress, cancel, skip };
}

function tokenSink(ui) {
  let sawThink = false;
  return (t) => {
    if (t.kind === 'think') { sawThink = true; ui.thinkEl.append(t.text); ui.status.textContent = 'thinking…'; ui.skip.hidden = false; }
    else { ui.contentEl.append(t.text); if (sawThink) { ui.status.textContent = 'writing…'; ui.skip.hidden = true; } }
    ui.out.scrollTop = ui.out.scrollHeight;
  };
}

function finish(store) {
  current = null;
  store.set({ job: null });
}

function folders(store) {
  return store.get().listing.filter((f) => f.kind === 'directory').map((d) => d.path);
}

export async function runInterpret(store, instruction, files, { thinking } = {}) {
  const rt = getRuntime();
  if (!rt.ready) throw new Error('no model loaded');
  const caps = rt.adapter.capabilities();
  const useThinking = thinking ?? caps.thinking;
  const ctrl = new AbortController();
  const ui = box('Interpreting instruction');
  current = { kind: 'interpret', ctrl, el: ui.el };
  store.set({ job: current });
  ui.cancel.onclick = () => ctrl.abort();
  ui.skip.onclick = () => { ctrl.abort(); setTimeout(() => runInterpret(store, instruction, files, { thinking: false }), 50); };
  try {
    ui.status.textContent = 'reading file facts…';
    const enrichment = await enrichFiles(store, files.slice(0, 40), { text: true, signal: ctrl.signal, onProgress: (d, n) => { ui.progress.firstChild.style.width = `${(d / n) * 50}%`; } });
    ui.status.textContent = useThinking ? 'thinking…' : 'writing…';
    const r = await interpret({ adapter: rt.adapter, instruction, files, enrichment, folders: folders(store), signal: ctrl.signal, thinking: useThinking, onToken: tokenSink(ui) });
    ui.progress.firstChild.style.width = '100%';
    store.set({ spec: r.spec, specMeta: { instruction, thinking: r.thinking, stats: r.stats, usedThinking: useThinking }, screen: 'interpret' });
  } catch (e) {
    if (e?.name !== 'AbortError') store.set({ notice: `Interpretation failed: ${e.message}` });
  } finally {
    if (current?.ctrl === ctrl) finish(store);
  }
}

export async function runExecute(store, spec, files, { title } = {}) {
  const rt = getRuntime();
  if (!rt.ready) throw new Error('no model loaded');
  const ctrl = new AbortController();
  const ui = box('Building rename plan');
  ui.skip.remove();
  current = { kind: 'execute', ctrl, el: ui.el };
  store.set({ job: current });
  ui.cancel.onclick = () => ctrl.abort();
  const batchSize = store.get().settings.batchSize || 25;
  try {
    ui.status.textContent = `reading file facts (${plural(files.length, 'file')})…`;
    const enrichment = await enrichFiles(store, files, { text: true, signal: ctrl.signal, onProgress: (d, n) => { ui.progress.firstChild.style.width = `${(d / n) * 20}%`; } });
    const result = await executePlan({
      adapter: rt.adapter, spec, files, enrichment, folders: folders(store), batchSize, signal: ctrl.signal,
      onBatch: (b) => {
        ui.progress.firstChild.style.width = `${20 + ((b.index + (b.phase === 'end' ? 1 : 0)) / b.count) * 80}%`;
        ui.status.textContent = `batch ${b.index + 1} of ${b.count} (${b.size} files)${b.phase === 'end' ? ` → ${b.ok ? plural(b.proposed, 'change') : 'unparseable output'}` : ''}`;
        if (b.phase === 'start') { ui.contentEl.textContent = ''; }
      },
      onToken: tokenSink(ui),
    });
    if (ctrl.signal.aborted) return;
    const info = [];
    if (result.failures.length) info.push(`${plural(result.failures.length, 'batch', 'batches')} produced no usable JSON`);
    const unmatched = result.batches.flatMap((b) => b.unmatched);
    if (unmatched.length) info.push(`${unmatched.length} entries referred to files not in the batch`);
    openPlan(store, result.ops, { title: title ?? 'Model plan', source: 'model', meta: { spec, failures: result.failures, unmatched, stats: result.stats } });
    if (info.length) store.set({ notice: info.join('; ') });
  } catch (e) {
    if (e?.name !== 'AbortError') store.set({ notice: `Plan failed: ${e.message}` });
  } finally {
    if (current?.ctrl === ctrl) finish(store);
  }
}

const AGENT_SYSTEM = `You are Sift, an assistant that helps a user understand and organise the files in one folder. Use the tools to look at the files before answering. Renaming, moving and creating folders are queued for the user's review, never applied directly. Answer concisely.`;

export async function runAgent(store, query, { thinking } = {}) {
  const rt = getRuntime();
  if (!rt.ready) throw new Error('no model loaded');
  const caps = rt.adapter.capabilities();
  const ctrl = new AbortController();
  const ui = box('Working');
  const log = h('div', { class: 'mono', style: { fontSize: '12px', margin: '6px 0' } });
  ui.el.insertBefore(log, ui.out);
  current = { kind: 'agent', ctrl, el: ui.el };
  store.set({ job: current });
  ui.cancel.onclick = () => ctrl.abort();
  ui.skip.onclick = () => { ctrl.abort(); setTimeout(() => runAgent(store, query, { thinking: false }), 50); };
  const state = createLoopState({ system: AGENT_SYSTEM, user: query });
  try {
    sessionStorage.setItem('sift.loop', JSON.stringify(state));
    await runLoop({
      adapter: rt.adapter, registry: getRegistry(), state, ctx: { store }, signal: ctrl.signal, thinking: thinking ?? caps.thinking,
      onToken: tokenSink(ui),
      onEvent: (e) => {
        if (e.type === 'iteration') { ui.status.textContent = `step ${e.n}`; ui.thinkEl.textContent = ''; ui.contentEl.textContent = ''; ui.progress.firstChild.style.width = `${(e.n / 8) * 100}%`; }
        else if (e.type === 'tool-call') log.append(h('div', null, `→ ${e.name}(${JSON.stringify(e.arguments)})`));
        else if (e.type === 'tool-result') log.append(h('div', { class: 'muted' }, `← ${JSON.stringify(e.result).slice(0, 160)}`));
        else if (e.type === 'queued') log.append(h('div', { style: { color: 'var(--changed)' } }, `queued ${e.name}(${JSON.stringify(e.arguments)})`));
        else if (e.type === 'tool-unknown') log.append(h('div', { class: 'muted' }, `unknown tool ${e.name}`));
        else if (e.type === 'cap') log.append(h('div', { class: 'muted' }, `stopped after ${e.n} steps without a final answer`));
        try { sessionStorage.setItem('sift.loop', JSON.stringify(state)); } catch {}
      },
    });
    store.set({ agent: { query, answer: state.answer, plan: state.plan, events: state.events, capped: state.answer == null } });
  } catch (e) {
    if (e?.name !== 'AbortError') store.set({ notice: `Agent failed: ${e.message}` });
  } finally {
    if (current?.ctrl === ctrl) finish(store);
  }
}

export function reviewQueued(store, queued) {
  openPlan(store, queuedToOps(queued), { title: 'Agent-queued changes', source: 'agent' });
}
