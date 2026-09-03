// Execution pass: approved spec + batch of enriched filenames -> JSON rename plan.
// Constrained, non-thinking, batched. Never sends file contents in bulk: only the compact facts.

import { extractJson } from '../runtime/lfm.js';
import { summariseFacts } from './enrich.js';
import { dirname, basename } from '../util/names.js';

export const PLAN_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { from: { type: 'string' }, to: { type: 'string' }, reason: { type: 'string' } },
    required: ['from', 'to'],
  },
};

const SYSTEM = `You rename and organise files. You receive a naming specification, the folders that exist, and a numbered list of files with facts about each.
Reply with ONLY a minified JSON array, one element per file that should change: {"from":<file number>,"to":"<new path>","reason":"<3-6 words, optional>"}.
Rules:
- Keep each file's extension exactly as it is.
- Use "/" only to place a file inside a folder named in the specification or listed as existing. Never use ".." or absolute paths.
- Windows-safe names: no < > : " | ? *, no trailing dot or space.
- Omit files that need no change. Only use file numbers from the list.
- Do not explain outside the JSON.`;

export function buildBatchPrompt(spec, files, enrichment, folders) {
  const lines = files.map((f, i) => {
    const facts = summariseFacts(enrichment?.get?.(f.path));
    return `${i + 1}. ${f.path}${facts ? ` — ${facts}` : ''}`;
  });
  return `Specification:\n${spec.trim()}\n\nExisting folders: ${folders.length ? folders.map((d) => `"${d}"`).join(', ') : '(none)'}\n\nFiles:\n${lines.join('\n')}`;
}

/** Resolve the model's "from" against the batch leniently: exact path, basename, or 1-based index. */
function resolveFrom(from, files) {
  if (typeof from === 'number') return files[from - 1] ?? null;
  if (typeof from !== 'string') return null;
  const s = from.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  return files.find((f) => f.path === s) ?? files.find((f) => f.name === basename(s)) ?? (/^\d+$/.test(s) ? files[Number(s) - 1] : null) ?? null;
}

/**
 * @param {Object} p
 * @param {import('../runtime/adapter.js').TransformersAdapter} p.adapter
 * @param {string} p.spec
 * @param {Array} p.files             FileMeta[] to process (files only)
 * @param {Map} p.enrichment
 * @param {Array<string>} p.folders   existing folder paths
 * @returns {Promise<{ops, failures, batches, stats}>}
 */
export async function executePlan({ adapter, spec, files, enrichment, folders = [], batchSize = 25, signal, onBatch, onToken, allowNewFolders = true, maxRetries = 1 }) {
  const ops = [];
  const failures = [];
  const created = new Set(folders.map((d) => d.toLowerCase()));
  const newFolders = [];
  const batches = [];
  let totalGenerated = 0, totalMs = 0;
  for (let b = 0; b * batchSize < files.length; b++) {
    if (signal?.aborted) break;
    const batch = files.slice(b * batchSize, (b + 1) * batchSize);
    const messages = [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: buildBatchPrompt(spec, batch, enrichment, folders) },
    ];
    onBatch?.({ index: b, count: Math.ceil(files.length / batchSize), size: batch.length, phase: 'start' });
    let parsed = null, raw = '', attempt = 0, lastError = null;
    while (attempt <= maxRetries && !parsed) {
      const r = await adapter.complete({ messages, schema: PLAN_SCHEMA, thinking: false, signal, maxNewTokens: 90 * batch.length + 64 }, onToken);
      raw = r.prefill + r.content;
      totalGenerated += r.stats?.generated ?? 0; totalMs += (r.stats?.decodeMs ?? 0) + (r.stats?.prefillMs ?? 0);
      const j = extractJson(raw, { expect: 'array' });
      if (Array.isArray(j.value)) parsed = j.value;
      else {
        lastError = j.error;
        attempt++;
        messages.push({ role: 'assistant', content: r.content });
        messages.push({ role: 'user', content: 'That was not a valid JSON array. Reply with only the JSON array, nothing else.' });
      }
      if (signal?.aborted) break;
    }
    const batchOps = [];
    const unmatched = [];
    if (parsed) {
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        const file = resolveFrom(item.from, batch);
        if (!file) { unmatched.push(item.from); continue; }
        let to = String(item.to ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
        if (!to) continue;
        if (!to.includes('/') && file.dir) to = `${file.dir}/${to}`; // model answered with a bare name for a nested file
        const dir = dirname(to);
        if (dir && !created.has(dir.toLowerCase())) {
          if (!allowNewFolders) { unmatched.push(`${file.path} → ${to} (new folder not allowed)`); continue; }
          created.add(dir.toLowerCase());
          newFolders.push(dir);
          ops.push({ type: 'create_folder', to: dir, reason: 'folder named in plan' });
        }
        batchOps.push({ type: dir === file.dir ? 'rename' : 'move', from: file.path, to, reason: String(item.reason ?? '').slice(0, 120) });
      }
      ops.push(...batchOps);
    } else {
      failures.push({ batch: b, error: lastError ?? 'no output', raw: raw.slice(0, 2000) });
    }
    batches.push({ index: b, size: batch.length, proposed: batchOps.length, unmatched, ok: !!parsed });
    onBatch?.({ index: b, count: Math.ceil(files.length / batchSize), size: batch.length, phase: 'end', proposed: batchOps.length, ok: !!parsed, unmatched });
  }
  return { ops, failures, batches, newFolders, stats: { generated: totalGenerated, ms: totalMs } };
}
