import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkComponent, checkRelativePath, sanitiseComponent, splitExt } from '../src/util/names.js';

test('splitExt', () => {
  assert.deepEqual(splitExt('a.txt'), { stem: 'a', ext: '.txt' });
  assert.deepEqual(splitExt('archive.tar.gz'), { stem: 'archive.tar', ext: '.gz' });
  assert.deepEqual(splitExt('.bashrc'), { stem: '.bashrc', ext: '' });
  assert.deepEqual(splitExt('noext'), { stem: 'noext', ext: '' });
});

test('reserved characters and names', () => {
  assert.equal(checkComponent('ok name.txt'), null);
  assert.match(checkComponent('a:b.txt'), /reserved character/);
  assert.match(checkComponent('a?b'), /reserved character/);
  assert.match(checkComponent('trailing.'), /dot or space/);
  assert.match(checkComponent('trailing '), /dot or space/);
  assert.match(checkComponent('CON'), /device/);
  assert.match(checkComponent('con.txt'), /device/);
  assert.match(checkComponent('LPT9.log'), /device/);
  assert.equal(checkComponent('CONSOLE.txt'), null);
  assert.match(checkComponent('a/b'), /separator/);
  assert.match(checkComponent('x'.repeat(256)), /longer/);
  assert.equal(checkComponent('émoji 🎉 名前.pdf'), null);
});

test('relative path length uses assumed root length', () => {
  assert.equal(checkRelativePath('sub/file.txt', { rootPathLength: 10 }), null);
  assert.match(checkRelativePath('a'.repeat(200) + '.txt', { rootPathLength: 60 }), /260/);
  assert.match(checkRelativePath('../x', {}), /\.\./);
});

test('sanitise', () => {
  assert.equal(sanitiseComponent('  a:b*c?.txt. '), 'abc.txt');
  assert.equal(sanitiseComponent('nul.txt'), 'nul_.txt');
});
