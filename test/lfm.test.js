import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseToolCalls, splitThinking, extractJson, parsePythonic } from '../src/runtime/lfm.js';

test('pythonic tool calls', () => {
  const r = parseToolCalls('<|tool_call_start|>[get_candidate_status(candidate_id="12345"), list_files(recursive=True, limit=5, exts=[\'.jpg\', ".png"])]<|tool_call_end|>Checking.');
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.calls[0], { name: 'get_candidate_status', arguments: { candidate_id: '12345' } });
  assert.deepEqual(r.calls[1].arguments, { recursive: true, limit: 5, exts: ['.jpg', '.png'] });
  assert.equal(r.content, 'Checking.');
});

test('json tool calls', () => {
  const r = parseToolCalls('<|tool_call_start|>[{"name": "read_excerpt", "arguments": {"path": "a.txt", "bytes": 200}}]<|tool_call_end|>');
  assert.deepEqual(r.calls, [{ name: 'read_excerpt', arguments: { path: 'a.txt', bytes: 200 } }]);
});

test('unterminated tool call block and garbage', () => {
  const r = parseToolCalls('<|tool_call_start|>[oops(');
  assert.equal(r.calls.length, 0);
  assert.equal(r.parseErrors.length, 1);
  assert.deepEqual(parsePythonic('f()'), [{ name: 'f', arguments: {} }]);
  assert.deepEqual(parsePythonic("g('a b', {'k': None})"), [{ name: 'g', arguments: { arg0: 'a b', arg1: { k: null } } }]);
});

test('thinking split', () => {
  const r = splitThinking('<think>\nlet me see\n</think>\nAnswer here');
  assert.equal(r.thinking, 'let me see');
  assert.equal(r.content, 'Answer here');
  assert.equal(splitThinking('<think>unterminated').content, '');
  assert.equal(splitThinking('plain').content, 'plain');
});

test('extractJson tolerates fences, prose, trailing commas, truncation', () => {
  assert.deepEqual(extractJson('Here:\n```json\n[{"from":"a","to":"b"},]\n```\nDone').value, [{ from: 'a', to: 'b' }]);
  assert.deepEqual(extractJson('[{"from":"a","to":"b"},{"from":"c","to":"d').value, [{ from: 'a', to: 'b' }]);
  assert.deepEqual(extractJson('{"a":1} trailing', { expect: 'object' }).value, { a: 1 });
  assert.equal(extractJson('nothing').value, null);
});

test('normaliseItems accepts alternative shapes', async () => {
  const { normaliseItems } = await import('../src/plan/execute.js');
  assert.deepEqual(normaliseItems([{ from: 3, to: 'a.txt' }]), [{ from: 3, to: 'a.txt', reason: '' }]);
  assert.deepEqual(normaliseItems([{ file: 'x.txt', new_name: 'y.txt', reason: 'r' }]), [{ from: 'x.txt', to: 'y.txt', reason: 'r' }]);
  assert.deepEqual(normaliseItems([{ 1: 'a.txt', 2: 'b.txt' }]), [{ from: '1', to: 'a.txt', reason: '' }, { from: '2', to: 'b.txt', reason: '' }]);
  assert.deepEqual(normaliseItems({ 'old.txt': 'new.txt' }), [{ from: 'old.txt', to: 'new.txt', reason: '' }]);
  assert.deepEqual(normaliseItems([[4, 'z.txt']]), [{ from: 4, to: 'z.txt', reason: '' }]);
});

test('normaliseItems unwraps a nested array from a repeated bracket', async () => {
  const { normaliseItems } = await import('../src/plan/execute.js');
  assert.deepEqual(normaliseItems([[{ from: 1, to: 'a.txt' }, { from: 2, to: 'b.txt' }]]).map((x) => x.to), ['a.txt', 'b.txt']);
});
