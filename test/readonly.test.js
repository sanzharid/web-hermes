import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirFromFiles, isReadOnly } from '../src/fs/readonly.js';
import { listEntries, readExcerpt, applyPlan } from '../src/fs/index.js';

// What <input webkitdirectory> hands over: File objects whose webkitRelativePath includes the root.
function upload(root, entries) {
  return Object.entries(entries).map(([rel, body]) => {
    const f = new File([body], rel.split('/').pop(), { lastModified: 1000 });
    Object.defineProperty(f, 'webkitRelativePath', { value: `${root}/${rel}` });
    return f;
  });
}

test('an uploaded folder lists and reads like a directory handle', async () => {
  const dir = dirFromFiles(upload('Downloads', {
    'invoice.txt': 'INVOICE #1 Acme',
    'setup.exe': 'MZ',
    'Taxes/2025 return.txt': 'tax return notes',
    'Taxes/deep/older.txt': 'beyond one level',
  }));
  assert.equal(dir.name, 'Downloads');
  assert.ok(isReadOnly(dir));

  const flat = await listEntries(dir);
  assert.deepEqual(flat.map((e) => `${e.kind}:${e.path}`), ['directory:Taxes', 'file:invoice.txt', 'file:setup.exe']);

  const nested = await listEntries(dir, { recursive: true });
  assert.ok(nested.some((e) => e.path === 'Taxes/2025 return.txt'), 'one level of subfolders, as for picked folders');
  assert.ok(!nested.some((e) => e.path.includes('deep/')), 'and no deeper');

  assert.equal(await readExcerpt(dir, 'Taxes/2025 return.txt'), 'tax return notes');
  const f = flat.find((e) => e.path === 'invoice.txt');
  assert.equal(f.size, 15);
});

test('every write is refused with a clear reason, and apply stops on it', async () => {
  const dir = dirFromFiles(upload('Downloads', { 'a.txt': 'x' }));
  await assert.rejects(dir.getFileHandle('new.txt', { create: true }), /read-only/);
  await assert.rejects(dir.removeEntry('a.txt'), /read-only/);
  assert.equal(await dir.queryPermission({ mode: 'readwrite' }), 'denied');

  const r = await applyPlan(dir, [{ type: 'rename', from: 'a.txt', to: 'b.txt' }]);
  assert.equal(r.applied, 0);
  assert.equal(r.stopped, true);
  assert.match(r.error, /read-only/);
  assert.deepEqual((await listEntries(dir)).map((e) => e.name), ['a.txt'], 'nothing changed');
});

test('missing paths and kind mismatches raise the same errors as the real API', async () => {
  const dir = dirFromFiles(upload('D', { 'a.txt': 'x', 'sub/b.txt': 'y' }));
  await assert.rejects(dir.getFileHandle('nope.txt'), (e) => e.name === 'NotFoundError');
  await assert.rejects(dir.getFileHandle('sub'), (e) => e.name === 'TypeMismatchError');
  await assert.rejects(dir.getDirectoryHandle('a.txt'), (e) => e.name === 'TypeMismatchError');
});
