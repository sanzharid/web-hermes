// Filesystem layer. Wraps File System Access. Nothing above this touches handles directly.
//
// Paths are relative to the connected directory, "/"-separated, at most one level deep
// when recursion is enabled. Operations are plain objects:
//   { type: 'rename'|'move', from, to, expect?: {size,lastModified}, reason? }
//   { type: 'create_folder', to }

import { getDirectory, saveDirectory, listDirectories, removeDirectory } from './handles.js';
import { writeJournal, updateJournal } from './journal.js';
import { basename, dirname, extOf, sameName } from '../util/names.js';

export { listDirectories, removeDirectory };

export function isSupported() {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** Requires a user gesture. */
export async function pickDirectory() {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'sift-folder' });
  return handle;
}

export async function rememberDirectory(id, handle) {
  return saveDirectory(id, handle);
}

export async function queryPermission(handle) {
  return handle.queryPermission({ mode: 'readwrite' });
}

/** Must be called from a click handler. */
export async function requestPermission(handle) {
  return handle.requestPermission({ mode: 'readwrite' });
}

/** Returns { record, handle, permission } or null when nothing is remembered under that id. */
export async function restoreDirectory(id) {
  const record = await getDirectory(id);
  if (!record) return null;
  const permission = await queryPermission(record.handle);
  return { record, handle: record.handle, permission };
}

// ---------- listing ----------

/**
 * @typedef {Object} FileMeta
 * @property {string} path      relative path ("sub/file.txt")
 * @property {string} name      basename
 * @property {string} dir       relative dir ("" for root)
 * @property {number} size
 * @property {number} lastModified
 * @property {'file'|'directory'} kind
 * @property {string} ext       lower-cased extension including the dot, "" if none
 * @property {string} type      MIME type reported by the browser (may be "")
 */

export async function listEntries(dir, { recursive = false, includeHidden = false } = {}) {
  const out = [];
  await walk(dir, '', 0);
  out.sort((a, b) => (a.kind !== b.kind ? (a.kind === 'directory' ? -1 : 1) : naturalCompare(a.path, b.path)));
  return out;

  async function walk(handle, prefix, depth) {
    for await (const [name, entry] of handle.entries()) {
      if (!includeHidden && name.startsWith('.')) continue;
      const path = prefix ? `${prefix}/${name}` : name;
      if (entry.kind === 'directory') {
        out.push({ path, name, dir: prefix, size: 0, lastModified: 0, kind: 'directory', ext: '', type: '' });
        if (recursive && depth < 1) await walk(entry, path, depth + 1);
      } else {
        let file;
        try {
          file = await entry.getFile();
        } catch {
          continue; // unreadable entry (locked, permission) — skip rather than fail the listing
        }
        out.push({ path, name, dir: prefix, size: file.size, lastModified: file.lastModified, kind: 'file', ext: extOf(name), type: file.type });
      }
    }
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export function naturalCompare(a, b) {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

// ---------- resolution ----------

export async function resolveDir(root, path, { create = false } = {}) {
  let h = root;
  if (!path) return h;
  for (const part of path.split('/')) {
    if (!part) continue;
    h = await h.getDirectoryHandle(part, { create });
  }
  return h;
}

export async function resolveFile(root, path) {
  const d = await resolveDir(root, dirname(path));
  return d.getFileHandle(basename(path));
}

export async function statFile(root, path) {
  const fh = await resolveFile(root, path);
  const f = await fh.getFile();
  return { size: f.size, lastModified: f.lastModified };
}

export async function readBytes(root, path, bytes) {
  const fh = await resolveFile(root, path);
  const f = await fh.getFile();
  const blob = bytes ? f.slice(0, bytes) : f;
  return new Uint8Array(await blob.arrayBuffer());
}

export async function readExcerpt(root, path, bytes = 2000) {
  const buf = await readBytes(root, path, bytes);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  // Drop the trailing partial character and any control noise.
  return text.replace(/�+$/, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

// ---------- mutation ----------

/** Set once the first move() attempt tells us whether the native method works on this filesystem. */
let nativeMove = null; // null = unknown, true = works, false = fall back to copy

export function moveSupport() {
  return nativeMove;
}

/** Test hook: force the copy fallback (or reset detection with null). */
export function setMoveSupport(v) {
  nativeMove = v;
}

function isUnsupportedMoveError(err) {
  return (
    err instanceof TypeError ||
    err?.name === 'NotSupportedError' ||
    /not (yet )?(supported|implemented)/i.test(err?.message ?? '')
  );
}

async function doMove(fromDir, fh, toDir, newName, sameDir) {
  if (nativeMove !== false && typeof fh.move === 'function') {
    try {
      if (sameDir) await fh.move(newName);
      else await fh.move(toDir, newName);
      nativeMove = true;
      return 'move';
    } catch (err) {
      if (!isUnsupportedMoveError(err)) throw err;
      nativeMove = false;
    }
  }
  return copyThenRemove(fromDir, fh, toDir, newName);
}

async function copyThenRemove(fromDir, fh, toDir, newName) {
  const src = await fh.getFile();
  const dest = await toDir.getFileHandle(newName, { create: true });
  const writable = await dest.createWritable();
  try {
    await src.stream().pipeTo(writable); // pipeTo closes the writable
  } catch (err) {
    try { await writable.abort(); } catch {}
    try { await toDir.removeEntry(newName); } catch {}
    throw err;
  }
  const check = await (await dest.getFile()).size;
  if (check !== src.size) {
    try { await toDir.removeEntry(newName); } catch {}
    throw new Error(`copy verification failed (${check} of ${src.size} bytes)`);
  }
  await fromDir.removeEntry(fh.name);
  return 'copy';
}

async function entryExists(dirHandle, name) {
  try {
    await dirHandle.getFileHandle(name);
    return 'file';
  } catch (e) {
    if (e?.name === 'TypeMismatchError') return 'directory';
    if (e?.name !== 'NotFoundError') throw e;
  }
  try {
    await dirHandle.getDirectoryHandle(name);
    return 'directory';
  } catch (e) {
    if (e?.name === 'TypeMismatchError') return 'file';
    if (e?.name !== 'NotFoundError') throw e;
  }
  return null;
}

/**
 * Move/rename a single file. Returns { method: 'move'|'copy', after: {size,lastModified} }.
 * Throws with a readable message on any precondition failure.
 */
export async function moveFile(root, from, to, expect) {
  if (from === to) throw new Error('source and target are identical');
  const fromDir = await resolveDir(root, dirname(from));
  let fh;
  try {
    fh = await fromDir.getFileHandle(basename(from));
  } catch {
    throw new Error('source no longer exists');
  }
  if (expect) {
    const f = await fh.getFile();
    if (f.size !== expect.size || f.lastModified !== expect.lastModified) throw new Error('source changed since it was listed');
  }
  let toDir;
  try {
    toDir = await resolveDir(root, dirname(to));
  } catch {
    throw new Error(`target folder "${dirname(to)}" does not exist`);
  }
  const sameDir = dirname(from) === dirname(to);
  const newName = basename(to);
  const caseOnly = sameDir && sameName(basename(from), newName);

  if (!caseOnly) {
    const kind = await entryExists(toDir, newName);
    if (kind) throw new Error(`target already exists (${kind})`);
    const method = await doMove(fromDir, fh, toDir, newName, sameDir);
    return { method, after: await statFile(root, to) };
  }

  // Case-only rename on a case-insensitive filesystem: go through a temporary name.
  // On a case-sensitive filesystem the target may be a different file; refuse to clobber it.
  try {
    const existing = await toDir.getFileHandle(newName);
    if (!(await existing.isSameEntry(fh))) throw new Error('target already exists (file)');
  } catch (e) {
    if (e?.name !== 'NotFoundError') throw e;
  }
  const tmp = `${newName}.sift-${Math.random().toString(36).slice(2, 8)}.tmp`;
  const m1 = await doMove(fromDir, fh, toDir, tmp, true);
  const th = await toDir.getFileHandle(tmp);
  const m2 = await doMove(toDir, th, toDir, newName, true);
  return { method: m1 === 'copy' || m2 === 'copy' ? 'copy' : 'move', after: await statFile(root, to) };
}

export async function createFolder(root, path) {
  const parent = await resolveDir(root, dirname(path));
  const name = basename(path);
  const kind = await entryExists(parent, name);
  if (kind === 'file') throw new Error('a file with that name already exists');
  if (kind === 'directory') return { created: false };
  await parent.getDirectoryHandle(name, { create: true });
  return { created: true };
}

/**
 * Apply a confirmed plan. Sequential; stops on first error; journal written and closed
 * before the first mutation and annotated afterwards.
 *
 * @returns {Promise<{ journal: string|null, results: Array, applied: number, stopped: boolean, error: string|null }>}
 */
export async function applyPlan(root, ops, { onProgress, signal, journal = true, label = '' } = {}) {
  const results = [];
  if (!ops.length) return { journal: null, results, applied: 0, stopped: false, error: null };

  const createdAt = new Date().toISOString();
  let journalName = null;
  if (journal) {
    journalName = await writeJournal(root, { version: 1, createdAt, folder: root.name, label, ops, applied: [], status: 'running' });
  }

  let error = null;
  let stopped = false;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (signal?.aborted) { stopped = true; error = 'cancelled'; break; }
    try {
      let res;
      if (op.type === 'create_folder') res = await createFolder(root, op.to);
      else if (op.type === 'rename' || op.type === 'move') res = await moveFile(root, op.from, op.to, op.expect);
      else throw new Error(`unknown operation type "${op.type}"`);
      results.push({ index: i, ok: true, op, ...res });
    } catch (err) {
      error = err?.message ?? String(err);
      results.push({ index: i, ok: false, op, error });
      stopped = true;
      break;
    }
    onProgress?.(i + 1, ops.length, results[results.length - 1]);
  }

  const applied = results.filter((r) => r.ok);
  if (journalName) {
    try {
      await updateJournal(root, journalName, {
        applied: applied.map((r) => ({ index: r.index, method: r.method, created: r.created, after: r.after })),
        status: stopped ? 'stopped' : 'complete',
        error,
        finishedAt: new Date().toISOString(),
      });
    } catch {
      // The original journal (ops only) is still on disk; annotation is best-effort.
    }
  }
  return { journal: journalName, results, applied: applied.length, stopped, error };
}
