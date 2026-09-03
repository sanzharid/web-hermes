// LFM2.5 prompt conventions. Verified against the chat template in the HF repos:
//   tools go into the system prompt as `List of tools: [...]` (the template does this when `tools` is passed);
//   calls come back between <|tool_call_start|> and <|tool_call_end|>, Pythonic by default,
//   JSON when the system prompt asks for it; reasoning is wrapped in <think>…</think>.

export const TOOL_CALL_START = '<|tool_call_start|>';
export const TOOL_CALL_END = '<|tool_call_end|>';
export const JSON_TOOL_DIRECTIVE = 'Output function calls as JSON: a list of objects with "name" and "arguments" keys.';
export const EMPTY_THINK_PREFILL = '<think>\n\n</think>\n'; // kept for experiments; measured ineffective on 1.2B-Thinking

/** Split a raw completion into { thinking, content } and strip think tags. */
export function splitThinking(text) {
  let thinking = '';
  let content = text ?? '';
  const re = /<think>([\s\S]*?)(<\/think>|$)/g;
  content = content.replace(re, (_, t) => { thinking += t; return ''; });
  return { thinking: thinking.trim(), content: content.replace(/^\s+/, '') };
}

/**
 * Parse tool calls out of a completion. Supports the JSON form and the Pythonic default.
 * Returns { calls: [{name, arguments}], content: text with call blocks removed, parseErrors: [] }
 */
export function parseToolCalls(text) {
  const calls = [];
  const parseErrors = [];
  let content = text ?? '';
  const re = new RegExp(`${escapeRe(TOOL_CALL_START)}([\\s\\S]*?)(?:${escapeRe(TOOL_CALL_END)}|$)`, 'g');
  content = content.replace(re, (_, body) => {
    const parsed = parseCallBody(body.trim());
    if (parsed.error) parseErrors.push(parsed.error);
    calls.push(...parsed.calls);
    return '';
  });
  return { calls, content: content.trim(), parseErrors };
}

function parseCallBody(body) {
  if (!body) return { calls: [] };
  // JSON list or object
  if (body.startsWith('[') || body.startsWith('{')) {
    try {
      let v = JSON.parse(body);
      if (!Array.isArray(v)) v = [v];
      const calls = v.map((c) => ({ name: c.name ?? c.function?.name, arguments: c.arguments ?? c.function?.arguments ?? c.parameters ?? {} }))
        .filter((c) => typeof c.name === 'string');
      if (calls.length) return { calls };
    } catch { /* fall through to pythonic */ }
  }
  try {
    return { calls: parsePythonic(body) };
  } catch (e) {
    return { calls: [], error: `could not parse tool call: ${e.message}` };
  }
}

/** Parse `[fn(a='x', b=3), other()]` or `fn(a='x')`. */
export function parsePythonic(src) {
  let i = 0;
  const s = src.trim();
  const calls = [];
  const peek = () => s[i];
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const expect = (c) => { ws(); if (s[i] !== c) throw new Error(`expected "${c}" at ${i}`); i++; };
  const ident = () => { ws(); const m = /^[A-Za-z_][\w.]*/.exec(s.slice(i)); if (!m) throw new Error(`identifier expected at ${i}`); i += m[0].length; return m[0]; };
  const value = () => {
    ws();
    const c = peek();
    if (c === "'" || c === '"') {
      const q = c; i++; let out = '';
      while (i < s.length && s[i] !== q) { if (s[i] === '\\') { i++; const e = s[i]; out += ({ n: '\n', t: '\t', r: '\r' })[e] ?? e; } else out += s[i]; i++; }
      expect(q); return out;
    }
    if (c === '[') { i++; const arr = []; ws(); if (peek() === ']') { i++; return arr; } for (;;) { arr.push(value()); ws(); if (peek() === ',') { i++; continue; } expect(']'); return arr; } }
    if (c === '{') { i++; const obj = {}; ws(); if (peek() === '}') { i++; return obj; } for (;;) { const k = value(); expect(':'); obj[k] = value(); ws(); if (peek() === ',') { i++; continue; } expect('}'); return obj; } }
    const m = /^(True|False|None|-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/.exec(s.slice(i));
    if (m) { i += m[0].length; return m[0] === 'True' ? true : m[0] === 'False' ? false : m[0] === 'None' ? null : Number(m[0]); }
    throw new Error(`unexpected "${c}" at ${i}`);
  };
  const call = () => {
    const name = ident();
    expect('(');
    const args = {};
    ws();
    if (peek() === ')') { i++; return { name, arguments: args }; }
    let pos = 0;
    for (;;) {
      ws();
      const save = i;
      let key = null;
      try { key = ident(); ws(); if (peek() === '=') i++; else { key = null; i = save; } } catch { i = save; }
      const v = value();
      args[key ?? `arg${pos++}`] = v;
      ws();
      if (peek() === ',') { i++; continue; }
      expect(')');
      return { name, arguments: args };
    }
  };
  ws();
  if (peek() === '[') {
    i++; ws();
    if (peek() === ']') return calls;
    for (;;) { calls.push(call()); ws(); if (peek() === ',') { i++; continue; } expect(']'); break; }
  } else {
    calls.push(call());
  }
  return calls;
}

/** Tool definitions in the shape the chat template serialises: {name, description, parameters}. */
export function toolSpec(tool) {
  return { name: tool.name, description: tool.description, parameters: tool.schema ?? { type: 'object', properties: {} } };
}

/** Lenient JSON extraction for model output: strips fences and prose, repairs trailing commas. */
export function extractJson(text, { expect = 'any' } = {}) {
  if (typeof text !== 'string') return { value: null, error: 'no text' };
  let s = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  const open = expect === 'array' ? '[' : expect === 'object' ? '{' : null;
  const start = open ? s.indexOf(open) : Math.min(...['[', '{'].map((c) => s.indexOf(c)).filter((x) => x >= 0));
  if (start < 0 || !Number.isFinite(start)) return { value: null, error: 'no JSON found' };
  s = s.slice(start);
  const closer = s[0] === '[' ? ']' : '}';
  const end = s.lastIndexOf(closer);
  if (end > 0) s = s.slice(0, end + 1);
  const attempts = [s, s.replace(/,\s*([\]}])/g, '$1'), balance(s)];
  for (const a of attempts) {
    try { return { value: JSON.parse(a), error: null }; } catch { /* next */ }
  }
  return { value: null, error: 'invalid JSON' };
}

/** Close unterminated strings/brackets so a truncated array of objects still yields the complete items. */
function balance(s) {
  let out = '';
  const stack = [];
  let inStr = false, esc = false;
  for (const ch of s) {
    out += ch;
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === '[' || ch === '{') stack.push(ch === '[' ? ']' : '}');
    else if (ch === ']' || ch === '}') stack.pop();
  }
  if (inStr) out += '"';
  // drop a trailing partial element: cut back to the last complete "}," or "}"
  if (stack.length && stack[stack.length - 1] === '}') {
    const cut = out.lastIndexOf('},');
    if (cut > 0) { out = out.slice(0, cut + 1); stack.pop(); }
  }
  out = out.replace(/,\s*$/, '');
  while (stack.length) out += stack.pop();
  return out;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
