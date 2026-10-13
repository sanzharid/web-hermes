import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, combine, hasMeta, RELEVANCE_WINDOW } from '../src/search/query.js';

const NOW = new Date(2026, 9, 13, 12).getTime(); // 13 Oct 2026, local noon
const D = (y, m, d = 1) => new Date(y, m - 1, d).getTime();
const parse = (q) => parseQuery(q, NOW);

test('pure metadata queries leave no text for the model', () => {
  for (const q of ['old files', 'show me my oldest stuff', 'large files', 'recently downloaded photos', 'installers', 'PDFs from last year', 'files not touched in 6 months']) {
    const p = parse(q);
    assert.equal(p.text, '', q);
    assert.ok(hasMeta(p), q);
  }
});

test('content queries pass through untouched, including look-alike words', () => {
  for (const q of ['small business plan', 'new york trip', 'image processing paper', 'the contract with the cleaning company', 'big data course notes', 'things I need to pick up at the supermarket']) {
    const p = parse(q);
    assert.ok(!hasMeta(p), q);
    assert.equal(p.text, q, 'sent to the model exactly as typed');
  }
});

test('mixed queries split into filters and text', () => {
  const p = parse('pdf invoices from 2023');
  assert.equal(p.text, 'invoices');
  assert.deepEqual(p.kinds, ['PDF document']);
  assert.equal(p.after, D(2023, 1));
  assert.equal(p.before, D(2024, 1));
  assert.deepEqual(p.labels, ['in 2023', 'PDFs']);

  const q = parse('old tax returns');
  assert.equal(q.sort, 'oldest');
  assert.equal(q.text, 'tax returns');

  assert.equal(parse('slides about next quarter plans').text, 'about next quarter plans');
});

test('relative and calendar dates', () => {
  assert.equal(parse('older than 2 years').before, NOW - 2 * 365.25 * 86400000);
  assert.equal(parse('more than a year old').before, NOW - 365.25 * 86400000);
  assert.equal(parse('not touched in 6 months').before, NOW - 6 * 30.44 * 86400000);
  assert.equal(parse('files from the last 3 days').after, NOW - 3 * 86400000);
  assert.equal(parse('in the past year').after, NOW - 365.25 * 86400000);
  const ly = parse('stuff from last year');
  assert.deepEqual([ly.after, ly.before], [D(2025, 1), D(2026, 1)]);
  const lm = parse('last month');
  assert.deepEqual([lm.after, lm.before], [D(2026, 9), D(2026, 10)]);
  const y = parse('yesterday');
  assert.deepEqual([y.after, y.before], [D(2026, 10, 12), D(2026, 10, 13)]);
  const lw = parse('last week'); // weeks start on Monday; 13 Oct 2026 is a Tuesday
  assert.deepEqual([lw.after, lw.before], [D(2026, 10, 5), D(2026, 10, 12)]);
  assert.equal(parse('before March 2022').before, D(2022, 3));
  assert.equal(parse('after 2023').after, D(2024, 1));
  assert.equal(parse('since 2023').after, D(2023, 1));
  const m = parse('notes from june 2024');
  assert.deepEqual([m.after, m.before, m.text], [D(2024, 6), D(2024, 7), 'notes']);
});

test('sizes and ordering', () => {
  assert.equal(parse('videos over 1 GB').minSize, 1073741824);
  assert.equal(parse('files under 10kb').maxSize, 10240);
  assert.equal(parse('> 2.5 mb').minSize, 2.5 * 1048576);
  assert.equal(parse('big videos').sort, 'largest');
  assert.equal(parse('biggest').sort, 'largest');
  assert.equal(parse('tiny files').sort, 'smallest');
  assert.equal(parse('newest pdfs').sort, 'newest');
});

const files = [
  { path: 'a-2019.pdf', name: 'a-2019.pdf', ext: '.pdf', size: 5e6, lastModified: D(2019, 5) },
  { path: 'b-2023.pdf', name: 'b-2023.pdf', ext: '.pdf', size: 2e5, lastModified: D(2023, 7) },
  { path: 'c-2026.jpg', name: 'c-2026.jpg', ext: '.jpg', size: 3e6, lastModified: D(2026, 10, 1) },
  { path: 'd-2021.txt', name: 'd-2021.txt', ext: '.txt', size: 100, lastModified: D(2021, 2) },
];

test('metadata-only results sort and filter the listing, no scores', () => {
  assert.deepEqual(combine(parse('old files'), files, null).map((r) => r.path), ['a-2019.pdf', 'd-2021.txt', 'b-2023.pdf', 'c-2026.jpg']);
  assert.deepEqual(combine(parse('pdfs'), files, null).map((r) => r.path), ['b-2023.pdf', 'a-2019.pdf'], 'newest first by default');
  assert.deepEqual(combine(parse('older than 4 years'), files, null).map((r) => r.path), ['a-2019.pdf', 'd-2021.txt'], 'an upper bound alone lists oldest first');
  assert.deepEqual(combine(parse('largest files over 1 MB'), files, null).map((r) => r.path), ['a-2019.pdf', 'c-2026.jpg']);
  assert.equal(combine(parse('old files'), files, null)[0].score, null);
});

test('with text, metadata filters semantic hits and reorders only near-ties', () => {
  const scored = [
    { path: 'b-2023.pdf', score: 0.70 },
    { path: 'a-2019.pdf', score: 0.70 - RELEVANCE_WINDOW / 2 }, // near-tie
    { path: 'd-2021.txt', score: 0.70 - RELEVANCE_WINDOW * 3 }, // clearly worse
    { path: 'gone.txt', score: 0.99 }, // indexed but no longer in the folder
  ];
  assert.deepEqual(combine(parse('invoices'), files, scored).map((r) => r.path), ['b-2023.pdf', 'a-2019.pdf', 'd-2021.txt']);
  assert.deepEqual(combine(parse('old invoices'), files, scored).map((r) => r.path), ['a-2019.pdf', 'b-2023.pdf', 'd-2021.txt'], 'older near-tie moves up, weak match stays below');
  assert.deepEqual(combine(parse('invoices from 2023'), files, scored).map((r) => r.path), ['b-2023.pdf']);
  const r = combine(parse('invoices'), files, scored)[0];
  assert.equal(r.lastModified, D(2023, 7));
  assert.equal(r.size, 2e5);
});
