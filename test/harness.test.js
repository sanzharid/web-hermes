import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRegistry } from '../src/harness/registry.js';
import { runLoop, createLoopState, stripThinking } from '../src/harness/loop.js';

function fakeAdapter(script) {
  let i = 0;
  return {
    async complete({ messages, tools }) {
      const step = script[i++] ?? { content: 'done' };
      return { content: step.content, thinking: step.thinking ?? '', stats: {}, messages, tools };
    },
  };
}

test('two-tool query completes without looping and strips thinking from history', async () => {
  const reg = createRegistry()
    .register({ name: 'a', description: 'a', handler: () => ({ x: 1 }) })
    .register({ name: 'b', description: 'b', handler: (args) => ({ y: args.n * 2 }) })
    .register({ name: 'w', description: 'write', sideEffects: true, handler: () => { throw new Error('never'); } });
  const adapter = fakeAdapter([
    { content: '<|tool_call_start|>[a()]<|tool_call_end|>', thinking: 'let me call a' },
    { content: '<|tool_call_start|>[{"name":"b","arguments":{"n":21}}, {"name":"w","arguments":{"from":"x","to":"y"}}]<|tool_call_end|>' },
    { content: 'The answer is 42.' },
  ]);
  const state = createLoopState({ system: 'sys', user: 'q' });
  const events = [];
  await runLoop({ adapter, registry: reg, state, onEvent: (e) => events.push(e.type) });
  assert.equal(state.done, true);
  assert.equal(state.answer, 'The answer is 42.');
  assert.equal(state.iteration, 3);
  assert.deepEqual(state.plan, [{ name: 'w', arguments: { from: 'x', to: 'y' } }]);
  assert.ok(!state.messages.some((m) => m.content.includes('let me call a')), 'thinking not in history');
  assert.equal(state.messages.filter((m) => m.role === 'tool').length, 3);
  assert.ok(state.messages[2].content.startsWith('<|tool_call_start|>[{"name":"a"'));
  assert.ok(events.includes('queued') && events.includes('tool-result'));
  assert.ok(JSON.stringify(state).length > 0, 'serialisable');
});

test('iteration cap stops runaway loops', async () => {
  const reg = createRegistry().register({ name: 'a', description: 'a', handler: () => 1 });
  const adapter = fakeAdapter(Array.from({ length: 20 }, () => ({ content: '<|tool_call_start|>[a()]<|tool_call_end|>' })));
  const state = createLoopState({ system: 's', user: 'u' });
  await runLoop({ adapter, registry: reg, state, maxIterations: 8 });
  assert.equal(state.iteration, 8);
  assert.equal(state.answer, null);
  assert.equal(state.events.at(-1).type, 'cap');
});

test('exposure filters tools per turn', async () => {
  const reg = createRegistry().register({ name: 'a', description: 'a', handler: () => 1 }).register({ name: 'hidden', description: 'h', handler: () => 2 });
  const adapter = fakeAdapter([{ content: '<|tool_call_start|>[hidden()]<|tool_call_end|>' }, { content: 'ok' }]);
  const state = createLoopState({ system: 's', user: 'u' });
  await runLoop({ adapter, registry: reg, state, expose: ['a'] });
  assert.match(state.messages[3].content, /not available/);
});

test('abort is honoured between awaits', async () => {
  const reg = createRegistry().register({ name: 'a', description: 'a', handler: () => 1 });
  const ctrl = new AbortController();
  const adapter = { async complete() { ctrl.abort(); return { content: '<|tool_call_start|>[a()]<|tool_call_end|>', thinking: '' }; } };
  const state = createLoopState({ system: 's', user: 'u' });
  await assert.rejects(runLoop({ adapter, registry: reg, state, signal: ctrl.signal }), /aborted/);
});

test('stripThinking removes stray tags', () => {
  assert.equal(stripThinking({ content: '<think>x</think>hello' }).content, 'hello');
});
