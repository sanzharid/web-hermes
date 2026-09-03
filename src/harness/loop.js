// The agent loop. Interruptible at every await; state is a plain object that survives reload.
//
//   messages = [system, user]
//   for i in 0..maxIterations:
//       response = adapter.generate({ messages, tools: exposed, thinking: true })
//       calls = parseToolCalls(response)
//       messages.push(stripThinking(response))
//       if calls.empty: return response
//       for call in calls:
//           if registry[call.name].sideEffects: plan.push(call)
//           else: messages.push(toolResult(handler(call.args)))

import { parseToolCalls, TOOL_CALL_START, TOOL_CALL_END } from '../runtime/lfm.js';

export const MAX_ITERATIONS = 8;

export function createLoopState({ system, user }) {
  return { version: 1, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], plan: [], iteration: 0, done: false, answer: null, events: [] };
}

/** Assistant turn as stored in history: final content plus the tool-call block, reasoning trace discarded. */
export function stripThinking(response, calls) {
  let content = response.content ?? '';
  // content from the adapter already has <think> removed; make sure a stray tag never survives
  content = content.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
  if (calls?.length) {
    const block = `${TOOL_CALL_START}${JSON.stringify(calls.map((c) => ({ name: c.name, arguments: c.arguments })))}${TOOL_CALL_END}`;
    const text = parseToolCalls(content).content; // strip any raw call text the model emitted
    content = `${block}${text ? text : ''}`;
  }
  return { role: 'assistant', content };
}

export function toolResult(name, result) {
  const body = typeof result === 'string' ? result : JSON.stringify(result);
  return { role: 'tool', content: body.length > 6000 ? `${body.slice(0, 6000)}… (truncated)` : body };
}

/**
 * Run (or resume) the loop.
 * @param {Object} p
 * @param {import('../runtime/adapter.js').TransformersAdapter} p.adapter
 * @param {ReturnType<typeof import('./registry.js').createRegistry>} p.registry
 * @param {Array|Function} [p.expose]  names or predicate; default all tools
 * @param {Object} p.state             from createLoopState (mutated and returned)
 * @param {Object} [p.ctx]             passed to handlers
 * @param {AbortSignal} [p.signal]
 * @param {Function} [p.onEvent]       ({type, ...}) for UI
 * @param {Function} [p.onToken]
 */
export async function runLoop({ adapter, registry, expose, state, ctx = {}, signal, onEvent, onToken, maxIterations = MAX_ITERATIONS, thinking = true }) {
  const tools = registry.expose(expose);
  const emit = (e) => { state.events.push(e); onEvent?.(e); };
  while (!state.done && state.iteration < maxIterations) {
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    state.iteration++;
    emit({ type: 'iteration', n: state.iteration });
    const response = await adapter.complete({ messages: state.messages, tools, thinking, signal }, onToken);
    if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
    const { calls, content, parseErrors } = parseToolCalls(response.content);
    state.messages.push(stripThinking({ content }, calls));
    if (response.thinking) emit({ type: 'thinking', text: response.thinking });
    if (parseErrors.length) emit({ type: 'parse-error', errors: parseErrors });
    if (!calls.length) {
      state.done = true;
      state.answer = content;
      emit({ type: 'answer', text: content, stats: response.stats });
      return state;
    }
    for (const call of calls) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const tool = registry.get(call.name);
      if (!tool) {
        emit({ type: 'tool-unknown', name: call.name });
        state.messages.push(toolResult(call.name, { error: `unknown tool "${call.name}". Available: ${tools.map((t) => t.name).join(', ')}` }));
        continue;
      }
      if (!tools.includes(tool)) {
        state.messages.push(toolResult(call.name, { error: `tool "${call.name}" is not available in this turn` }));
        continue;
      }
      if (tool.sideEffects) {
        state.plan.push({ name: call.name, arguments: call.arguments });
        emit({ type: 'queued', name: call.name, arguments: call.arguments });
        state.messages.push(toolResult(call.name, { queued: true, note: 'This change is queued for user review; it has not been applied. Continue as if it will be.' }));
        continue;
      }
      emit({ type: 'tool-call', name: call.name, arguments: call.arguments });
      let result;
      try {
        result = await tool.handler(call.arguments ?? {}, ctx);
      } catch (e) {
        result = { error: e?.message ?? String(e) };
      }
      emit({ type: 'tool-result', name: call.name, result });
      state.messages.push(toolResult(call.name, result));
    }
  }
  if (!state.done) {
    state.done = true;
    state.answer = null;
    emit({ type: 'cap', n: maxIterations });
  }
  return state;
}
