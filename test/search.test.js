import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nameWords, documentFor, planIndex, rank, fileKey, EXCERPT_CHARS } from '../src/search/index.js';
import { queryText, documentText } from '../src/runtime/embedder.js';

const f = (path, extra = {}) => ({ path, name: path.split('/').pop(), dir: path.includes('/') ? path.split('/')[0] : '', size: 10, lastModified: 1, ext: '.' + path.split('.').pop(), ...extra });

test('task prefixes follow the model card', () => {
  assert.equal(queryText('red planet'), 'task: search result | query: red planet');
  assert.equal(documentText('', 'x'), 'title: none | text: x');
  assert.equal(documentText('Mars', 'x'), 'title: Mars | text: x');
});

test('filenames become words', () => {
  assert.equal(nameWords('Q3_report-final.v2.pdf'), 'Q3 report final v2');
  assert.equal(nameWords('invoiceAcmeMarch.txt'), 'invoice Acme March');
  assert.equal(nameWords('.bashrc'), 'bashrc');
});

test('document text carries name, facts, folder and capped excerpt', () => {
  const d = documentFor(f('Invoices/acme_2024.pdf'), { facts: { pdfTitle: 'Invoice 4471', pdfAuthor: 'Acme' } });
  assert.match(d.input, /^title: acme 2024 \| text: PDF document; folder Invoices; title Invoice 4471; author Acme$/);
  assert.equal(d.hasText, false);
  const long = documentFor(f('notes.txt'), { excerpt: 'word '.repeat(2000) });
  assert.ok(long.input.length < EXCERPT_CHARS + 100, 'excerpt is capped');
  assert.equal(long.hasText, true);
  assert.ok(long.snippet.length <= 240);
  const bare = documentFor(f('photo.heic'));
  assert.equal(bare.input, 'title: photo | text: image', 'name-only files still get a document');
  assert.equal(documentFor(f('x.weird')).input, 'title: x | text: .weird file');
});

test('planIndex re-embeds only changed files and drops vanished ones', () => {
  const files = [f('a.txt'), f('b.txt', { size: 99 }), f('c.txt')];
  const existing = [
    { path: 'a.txt', key: fileKey(f('a.txt')) },          // unchanged
    { path: 'b.txt', key: fileKey(f('b.txt')) },          // size changed since
    { path: 'gone.txt', key: '1:1', id: 'x|gone.txt' },   // deleted from disk
  ];
  const p = planIndex(files, existing);
  assert.deepEqual(p.current.map((e) => e.path), ['a.txt']);
  assert.deepEqual(p.toEmbed.map((x) => x.path), ['b.txt', 'c.txt']);
  assert.deepEqual(p.removed.map((e) => e.path), ['gone.txt']);
});

test('rank orders by cosine and caps k', () => {
  const v = (...xs) => Float32Array.from(xs);
  const entries = [{ path: 'x', vec: v(1, 0) }, { path: 'y', vec: v(0, 1) }, { path: 'z', vec: v(0.6, 0.8) }];
  const r = rank(v(0.8, 0.6), entries, 2);
  // q=(0.8,0.6): z scores 0.96, x scores 0.8, y scores 0.6
  assert.deepEqual(r.map((e) => e.path), ['z', 'x']);
  assert.ok(Math.abs(r[0].score - 0.96) < 1e-6);
});

test('kindOf names file types the way queries do', async () => {
  const { kindOf } = await import('../src/search/index.js');
  assert.equal(kindOf('.pptx'), 'presentation slides');
  assert.equal(kindOf('.xlsx'), 'spreadsheet');
  assert.equal(kindOf('.csv'), 'spreadsheet');
  assert.equal(kindOf('.docx'), 'Word document');
  assert.equal(kindOf('.JPG'.toLowerCase()), 'image');
  assert.equal(kindOf('.txt'), '');
});
