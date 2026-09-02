import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyRules, applyRule } from '../src/plan/rules.js';

const f = (name, lastModified = 0) => ({ path: name, name, dir: '', size: 1, lastModified, kind: 'file', ext: '' });

test('regex on stem keeps extension', () => {
  const ops = applyRules([{ type: 'regex', pattern: '^IMG_', flags: '', replacement: '', target: 'stem' }], [f('IMG_001.jpg'), f('other.jpg')]);
  assert.deepEqual(ops.map((o) => [o.from, o.to]), [['IMG_001.jpg', '001.jpg']]);
});

test('case modes', () => {
  const c = (mode, stem) => applyRule({ type: 'case', mode }, { stem, ext: '.TXT' }, {});
  assert.equal(c('lower', 'Hello World').stem, 'hello world');
  assert.equal(c('title', 'hello wORLD-again').stem, 'Hello World-Again');
  assert.equal(c('kebab', 'Hello World_fooBar').stem, 'hello-world-foo-bar');
  assert.equal(c('snake', 'Hello  World').stem, 'hello_world');
  assert.equal(c('lower', 'X').ext, '.TXT');
  assert.equal(applyRule({ type: 'case', mode: 'lower', extToo: true }, { stem: 'X', ext: '.TXT' }, {}).ext, '.txt');
});

test('sequence with padding and natural ordering', () => {
  const ops = applyRules([{ type: 'sequence', start: 1, pad: 3, template: '{n}_{stem}', sortBy: 'name' }], [f('b10.txt'), f('b2.txt'), f('a.txt')]);
  assert.deepEqual(ops.map((o) => o.to), ['001_a.txt', '002_b2.txt', '003_b10.txt']);
});

test('date prefix uses exif when present, else modified, and is idempotent', () => {
  const en = new Map([['x.jpg', { exifDate: Date.UTC(2020, 4, 6, 12) }]]);
  const ops = applyRules([{ type: 'datePrefix', source: 'exif-or-modified', format: 'YYYY-MM-DD', separator: ' ' }], [f('x.jpg', Date.UTC(2021, 0, 1, 12)), f('y.jpg', Date.UTC(2021, 0, 1, 12))], { enrichment: en });
  assert.equal(ops[0].to, '2020-05-06 x.jpg');
  assert.equal(ops[1].to, '2021-01-01 y.jpg');
  const again = applyRules([{ type: 'datePrefix', format: 'YYYY-MM-DD', separator: ' ' }], [f('2021-01-01 y.jpg', Date.UTC(2021, 0, 1, 12))]);
  assert.equal(again.length, 0);
});

test('whitespace and prefix/suffix chain', () => {
  const ops = applyRules([{ type: 'whitespace', separator: true }, { type: 'prefixSuffix', prefix: 'P ', suffix: ' S' }], [f('a__b - c.md')]);
  assert.equal(ops[0].to, 'P a b c S.md');
});
