import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../src/plan/validate.js';

const f = (path, extra = {}) => ({ path, name: path.split('/').pop(), dir: path.includes('/') ? path.split('/')[0] : '', size: 10, lastModified: 1000, kind: 'file', ext: '', ...extra });
const d = (path) => ({ path, name: path, dir: '', size: 0, lastModified: 0, kind: 'directory', ext: '' });
const listing = [f('a.txt'), f('b.txt'), f('Photo.JPG'), f('noext'), d('sub'), f('sub/c.txt')];

test('accepts a simple rename and fills expect', () => {
  const r = validatePlan([{ from: 'a.txt', to: 'alpha.txt' }], listing);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0].type, 'rename');
  assert.deepEqual(r.accepted[0].expect, { size: 10, lastModified: 1000 });
});

test('drops no-ops silently', () => {
  const r = validatePlan([{ from: 'a.txt', to: 'a.txt' }], listing);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.dropped.length, 1);
});

test('rejects collisions with existing files, case-insensitively', () => {
  const r = validatePlan([{ from: 'a.txt', to: 'B.TXT' }], listing);
  assert.match(r.rejected[0].reason, /already exists/);
});

test('allows case-only renames', () => {
  const r = validatePlan([{ from: 'Photo.JPG', to: 'photo.JPG' }], listing);
  assert.equal(r.accepted.length, 1);
});

test('rejects extension change unless allowed', () => {
  assert.match(validatePlan([{ from: 'a.txt', to: 'a.md' }], listing).rejected[0].reason, /extension/);
  assert.match(validatePlan([{ from: 'Photo.JPG', to: 'photo.jpeg' }], listing).rejected[0].reason, /extension/);
  assert.equal(validatePlan([{ from: 'a.txt', to: 'a.md' }], listing, { allowExtensionChange: true }).accepted.length, 1);
  assert.equal(validatePlan([{ from: 'Photo.JPG', to: 'photo.jpg' }], listing).accepted.length, 1, 'ext case change is fine');
});

test('rejects within-batch duplicates', () => {
  const r = validatePlan([{ from: 'a.txt', to: 'x.txt' }, { from: 'b.txt', to: 'X.txt' }], listing);
  assert.equal(r.accepted.length, 1);
  assert.match(r.rejected[0].reason, /used twice/);
});

test('rejects windows rules and paths', () => {
  const r = validatePlan([
    { from: 'a.txt', to: 'a:b.txt' },
    { from: 'b.txt', to: '../b.txt' },
    { from: 'noext', to: 'CON' },
    { from: 'sub/c.txt', to: 'sub/c.txt.' },
  ], listing);
  assert.equal(r.accepted.length, 0);
  assert.equal(r.rejected.length, 4);
});

test('rejects modified source', () => {
  const r = validatePlan([{ from: 'a.txt', to: 'z.txt', expect: { size: 11, lastModified: 1000 } }], listing);
  assert.match(r.rejected[0].reason, /changed/);
});

test('moves need an existing or newly created folder', () => {
  const bad = validatePlan([{ from: 'a.txt', to: 'new/a.txt' }], listing);
  assert.match(bad.rejected[0].reason, /does not exist/);
  const good = validatePlan([{ type: 'create_folder', to: 'new' }, { from: 'a.txt', to: 'new/a.txt' }], listing);
  assert.equal(good.accepted.length, 2);
  assert.equal(good.accepted[1].type, 'move');
  const existing = validatePlan([{ type: 'create_folder', to: 'sub' }], listing);
  assert.equal(existing.dropped.length, 1);
});

test('rejects chains since B exists', () => {
  const r = validatePlan([{ from: 'a.txt', to: 'b.txt' }, { from: 'b.txt', to: 'c.txt' }], listing);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.accepted[0].from, 'b.txt');
});

test('malformed entries are rejected not thrown', () => {
  const r = validatePlan([null, {}, { from: 'a.txt' }, 'x'], listing);
  assert.equal(r.rejected.length, 4);
});

test('case-sensitive listing switches to exact matching', () => {
  const l = [f('a.txt'), f('A.txt'), f('b.txt')];
  const r = validatePlan([{ from: 'b.txt', to: 'B.txt' }, { from: 'a.txt', to: 'A.txt' }], l);
  assert.equal(r.caseSensitive, true);
  assert.equal(r.accepted.length, 1);
  assert.match(r.rejected[0].reason, /already exists/);
});
