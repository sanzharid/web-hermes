// Plan validation. Every rule on every entry; reject the entry, not the batch.

import { checkRelativePath, dirname, extOf, splitExt } from '../util/names.js';

/**
 * @param {Array} ops        proposed operations ({type, from, to, reason, allowExtensionChange?})
 * @param {Array} listing    FileMeta[] from listEntries (files and directories)
 * @param {Object} opts      { rootPathLength, allowExtensionChange }
 * @returns {{ accepted: Array, rejected: Array<{op, reason}>, dropped: Array }}
 */
export function validatePlan(ops, listing, opts = {}) {
  const { rootPathLength = 0, allowExtensionChange = false } = opts;
  // Windows compares names case-insensitively. If the listing itself contains names that differ
  // only by case, the filesystem is case-sensitive and comparisons switch to exact matching.
  const seen = new Set();
  let caseSensitive = false;
  for (const m of listing) {
    const k = m.path.toLowerCase();
    if (seen.has(k)) { caseSensitive = true; break; }
    seen.add(k);
  }
  const fold = (p) => (caseSensitive ? p : p.toLowerCase());
  const files = new Map(); // folded path -> meta
  const dirs = new Set(['']);
  for (const m of listing) {
    if (m.kind === 'directory') dirs.add(fold(m.path));
    else files.set(fold(m.path), m);
  }
  const accepted = [];
  const rejected = [];
  const dropped = [];
  const targets = new Set(); // lower paths claimed within this batch
  const sources = new Set();
  const createdDirs = new Set();

  for (const raw of ops ?? []) {
    const op = normalise(raw);
    if (!op) { rejected.push({ op: raw, reason: 'malformed operation' }); continue; }

    if (op.type === 'create_folder') {
      const reason = checkRelativePath(op.to, { rootPathLength });
      if (reason) { rejected.push({ op, reason: `folder name: ${reason}` }); continue; }
      const lower = fold(op.to);
      if (dirs.has(lower) || createdDirs.has(lower)) { dropped.push({ op, reason: 'folder already exists' }); continue; }
      if (files.has(lower) || targets.has(lower)) { rejected.push({ op, reason: 'a file with that name exists' }); continue; }
      const parent = fold(dirname(op.to));
      if (!dirs.has(parent) && !createdDirs.has(parent)) { rejected.push({ op, reason: 'parent folder does not exist' }); continue; }
      createdDirs.add(lower);
      targets.add(lower);
      accepted.push(op);
      continue;
    }

    const fromLower = fold(op.from);
    const toLower = fold(op.to);
    const meta = files.get(fromLower);
    if (!meta) { rejected.push({ op, reason: 'source file not found in listing' }); continue; }
    if (op.expect && (op.expect.size !== meta.size || op.expect.lastModified !== meta.lastModified)) {
      rejected.push({ op, reason: 'source changed since it was listed' }); continue;
    }
    if (op.from === op.to) { dropped.push({ op, reason: 'no change' }); continue; }
    if (sources.has(fromLower)) { rejected.push({ op, reason: 'source appears twice in this batch' }); continue; }

    const reason = checkRelativePath(op.to, { rootPathLength });
    if (reason) { rejected.push({ op, reason }); continue; }

    const toDir = fold(dirname(op.to));
    if (!dirs.has(toDir) && !createdDirs.has(toDir)) { rejected.push({ op, reason: `target folder "${dirname(op.to)}" does not exist` }); continue; }

    if (!(allowExtensionChange || op.allowExtensionChange)) {
      if (extOf(op.from) !== extOf(op.to)) { rejected.push({ op, reason: `extension changed (${extOf(op.from) || 'none'} → ${extOf(op.to) || 'none'})` }); continue; }
      if (!splitExt(op.to).stem) { rejected.push({ op, reason: 'name would be only an extension' }); continue; }
    }

    const caseOnly = op.from.toLowerCase() === op.to.toLowerCase();
    if ((!caseOnly || caseSensitive) && (files.has(toLower) || dirs.has(toLower))) { rejected.push({ op, reason: 'target already exists' }); continue; }
    if (targets.has(toLower)) { rejected.push({ op, reason: 'target used twice in this batch' }); continue; }

    sources.add(fromLower);
    targets.add(toLower);
    accepted.push({
      ...op,
      type: dirname(op.from) === dirname(op.to) ? 'rename' : 'move',
      expect: { size: meta.size, lastModified: meta.lastModified },
    });
  }
  return { accepted, rejected, dropped, caseSensitive };
}

function normalise(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type ?? (raw.from && raw.to ? 'rename' : null);
  if (type === 'create_folder') {
    const to = clean(raw.to ?? raw.path ?? raw.name);
    return to ? { type, to, reason: raw.reason ?? '' } : null;
  }
  if (type !== 'rename' && type !== 'move') return null;
  const from = clean(raw.from);
  const to = clean(raw.to);
  if (!from || !to) return null;
  return { type, from, to, reason: raw.reason ?? '', expect: raw.expect, allowExtensionChange: raw.allowExtensionChange };
}

function clean(s) {
  if (typeof s !== 'string') return null;
  return s.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
}
