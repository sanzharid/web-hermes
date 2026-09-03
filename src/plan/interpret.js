// Interpretation pass: vague instruction -> explicit, editable naming specification. One thinking call.

import { summariseFacts } from './enrich.js';

const SYSTEM = `You turn a user's instruction about renaming or organising files into an explicit naming specification that another tool will apply file by file.
Write the specification as plain text with short numbered rules covering:
1. The target name pattern, with one concrete example built from the listed files.
2. How each part of the name is derived (from the current name, from the facts given, or fixed text).
3. Casing, separators and date format.
4. What must stay unchanged (always the extension).
5. Folders to create, if grouping was asked for, and which files go where.
6. What to do with files that do not fit the pattern (usually: leave unchanged).
Be specific enough that two people applying it would produce the same names. Do not rename the files yourself and do not add a preamble.`;

export function buildInterpretPrompt(instruction, files, enrichment, folders, sample = 40) {
  const shown = files.slice(0, sample).map((f) => {
    const facts = summariseFacts(enrichment?.get?.(f.path));
    return `- ${f.path}${facts ? ` — ${facts}` : ''}`;
  });
  return `Instruction: ${instruction.trim()}\n\nExisting folders: ${folders.length ? folders.join(', ') : '(none)'}\n\nFiles (${files.length} total${files.length > sample ? `, first ${sample} shown` : ''}):\n${shown.join('\n')}`;
}

export async function interpret({ adapter, instruction, files, enrichment, folders = [], signal, onToken, thinking = true, temperature = 0.4, maxNewTokens }) {
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: buildInterpretPrompt(instruction, files, enrichment, folders) },
  ];
  const r = await adapter.complete({ messages, thinking, signal, maxNewTokens: maxNewTokens ?? (thinking ? 2048 : 1024), sampling: { temperature, top_p: 0.9 } }, onToken);
  return { spec: r.content.trim(), thinking: r.thinking, stats: r.stats };
}

// ---------- presets ----------
const KEY = 'sift.presets';
export function loadPresets() {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]'); } catch { return []; }
}
export function savePreset(p) {
  const all = loadPresets().filter((x) => x.name !== p.name);
  all.unshift({ ...p, savedAt: new Date().toISOString() });
  localStorage.setItem(KEY, JSON.stringify(all));
  return all;
}
export function deletePreset(name) {
  const all = loadPresets().filter((x) => x.name !== name);
  localStorage.setItem(KEY, JSON.stringify(all));
  return all;
}
