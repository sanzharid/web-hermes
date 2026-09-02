// Undo journal: .sift-undo-<ISO8601>.json in the connected folder.

export const JOURNAL_RE = /^\.sift-undo-(.+)\.json$/;

export function journalName(date = new Date()) {
  return `.sift-undo-${date.toISOString().replace(/[:.]/g, '-')}.json`;
}

export async function writeJournal(root, entry) {
  const name = journalName(new Date(entry.createdAt ?? Date.now()));
  const fh = await root.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(entry, null, 1));
  await w.close(); // close() commits; nothing is mutated before this resolves
  return name;
}

export async function readJournal(root, name) {
  const fh = await root.getFileHandle(name);
  const text = await (await fh.getFile()).text();
  return JSON.parse(text);
}

export async function updateJournal(root, name, patch) {
  const current = await readJournal(root, name);
  const next = { ...current, ...patch };
  const fh = await root.getFileHandle(name);
  const w = await fh.createWritable(); // atomic: swap file committed on close
  await w.write(JSON.stringify(next, null, 1));
  await w.close();
  return next;
}

export async function listJournals(root) {
  const out = [];
  for await (const [name, entry] of root.entries()) {
    if (entry.kind !== 'file' || !JOURNAL_RE.test(name)) continue;
    try {
      const j = await readJournal(root, name);
      out.push({ name, createdAt: j.createdAt, label: j.label ?? '', status: j.status ?? 'unknown', total: j.ops?.length ?? 0, applied: j.applied?.length ?? 0, restored: j.restored ?? false });
    } catch {
      out.push({ name, createdAt: null, status: 'unreadable', total: 0, applied: 0 });
    }
  }
  out.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
  return out;
}

/**
 * Build the operations that reverse a journal's applied operations, in reverse order.
 * Folders that were created are left in place (this app never deletes anything).
 */
export function reverseOps(journal) {
  const applied = journal.applied ?? [];
  const ops = [];
  const skipped = [];
  for (let k = applied.length - 1; k >= 0; k--) {
    const a = applied[k];
    const op = journal.ops[a.index];
    if (!op) continue;
    if (op.type === 'create_folder') {
      skipped.push({ op, reason: 'folders are left in place' });
      continue;
    }
    ops.push({ type: op.type, from: op.to, to: op.from, expect: a.after ?? undefined, reason: `undo: ${op.to} → ${op.from}` });
  }
  return { ops, skipped };
}
