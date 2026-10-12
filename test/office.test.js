import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { officeText, zipEntries, xmlText } from '../src/search/office.js';

// Fixtures were written by python-docx, python-pptx and openpyxl, so these are genuine OOXML files
// rather than zips shaped to match this parser.
const fx = (n) => new Uint8Array(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));

test('word: body text, entities decoded, title from core properties', async () => {
  const r = await officeText(fx('sample.docx'), '.docx');
  assert.match(r.text, /Cleaning services agreement/);
  assert.match(r.text, /Sparkle Facilities B\.V\. & the tenant/);
  assert.match(r.text, /30 days' notice/);
  assert.equal(r.title, 'Supplier agreement 2025');
});

test('powerpoint: slides in order, escaped markup restored', async () => {
  const r = await officeText(fx('sample.pptx'), '.pptx');
  assert.ok(r.text.indexOf('Q3 roadmap') < r.text.indexOf('Risks'), 'slide order kept');
  assert.match(r.text, /Sensor vendor is late <by two weeks>/);
});

test('excel: shared strings', async () => {
  const r = await officeText(fx('sample.xlsx'), '.xlsx');
  assert.match(r.text, /electricity/);
  assert.match(r.text, /rent/);
});

test('limit caps the text', async () => {
  const r = await officeText(fx('sample.docx'), '.docx', 20);
  assert.equal(r.text.length, 20);
});

test('non-zip input throws rather than returning garbage', () => {
  assert.throws(() => zipEntries(new TextEncoder().encode('plain text pretending to be a docx')), /not a zip/);
});

test('xmlText keeps paragraph breaks and drops markup', () => {
  assert.equal(xmlText('<w:p><w:r><w:t>a</w:t></w:r><w:r><w:t xml:space="preserve"> b</w:t></w:r></w:p><w:p><w:r><w:t>c &amp; d</w:t></w:r></w:p>'), 'a b\nc & d');
});

test('excel: cells are separated, numbers kept, shared-string indexes not mistaken for values', () => {
  assert.equal(xmlText('<row><c><is><t>rent</t></is></c><c t="n"><v>1200</v></c></row>'), 'rent 1200');
});

test('excel-written sheets: shared-string index cells are dropped', async () => {
  const { officeText } = await import('../src/search/office.js');
  // Build a minimal Excel-style workbook in memory with stored (uncompressed) entries.
  const enc = new TextEncoder();
  const files = {
    'xl/sharedStrings.xml': '<sst><si><t>electricity</t></si><si><t>rent</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row><c t="s"><v>0</v></c><c><v>85</v></c></row><row><c t="s"><v>1</v></c><c><v>1200</v></c></row></sheetData></worksheet>',
  };
  const parts = []; const central = []; let off = 0;
  for (const [name, body] of Object.entries(files)) {
    const n = enc.encode(name), d = enc.encode(body);
    const lh = new Uint8Array(30 + n.length); const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint32(18, d.length, true); lv.setUint32(22, d.length, true); lv.setUint16(26, n.length, true); lh.set(n, 30);
    const ch = new Uint8Array(46 + n.length); const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint32(20, d.length, true); cv.setUint32(24, d.length, true); cv.setUint16(28, n.length, true); cv.setUint32(42, off, true); ch.set(n, 46);
    parts.push(lh, d); central.push(ch); off += lh.length + d.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const eocd = new Uint8Array(22); const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, central.length, true); ev.setUint16(10, central.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, off, true);
  const all = new Uint8Array(off + cdSize + 22); let p = 0;
  for (const x of [...parts, ...central, eocd]) { all.set(x, p); p += x.length; }
  const r = await officeText(all, '.xlsx');
  assert.match(r.text, /electricity/);
  assert.match(r.text, /85/);
  // shared strings first, then the sheet: values kept, the indexes 0 and 1 absent
  assert.equal(r.text, 'electricity\nrent\n85\n1200');
});
