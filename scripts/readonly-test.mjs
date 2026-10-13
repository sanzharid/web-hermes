// Read-only folder path: a real <input webkitdirectory> upload of a folder named "Downloads" through
// Chrome's file chooser. Lists, indexes and searches it (with HF_MIRROR, real model), and proves
// nothing can be applied or persisted as a writable handle.
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import http from 'node:http';
import { createReadStream, existsSync, statSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let failures = 0;
const check = (c, m) => { console.log(`${c ? 'ok' : 'FAIL'} - ${m}`); if (!c) failures++; };

const base = mkdtempSync(join(tmpdir(), 'sift-ro-'));
const DL = join(base, 'Downloads');
mkdirSync(join(DL, 'Taxes'), { recursive: true });
const FILES = {
  'scan0001.txt': 'INVOICE #4471 Acme Supplies Ltd. Office chairs x4. Total due: 1,240.00 EUR',
  'acme-invoice.txt': 'INVOICE #5120 Acme Supplies Ltd. Desk lamps x6. Total due: 310.00 EUR',
  'untitled.txt': 'Grocery list: eggs, milk, flour, butter, maple syrup.',
  'trip.txt': 'Lisbon day 2: Belem tower, pasteis de nata, tram 28 through Alfama.',
  'Taxes/2025 return.txt': 'Income tax return 2025, deductions for home office and pension contributions.',
};
for (const [p, c] of Object.entries(FILES)) writeFileSync(join(DL, p), c);
// Real modification dates, which a folder upload carries through as File.lastModified.
const MTIME = { 'untitled.txt': '2019-04-02', 'acme-invoice.txt': '2021-03-15' };
for (const [p, d] of Object.entries(MTIME)) utimesSync(join(DL, p), new Date(d), new Date(d));
const before = JSON.stringify(readdirSync(DL, { recursive: true }).sort());

let MIRROR = null;
if (process.env.HF_MIRROR) {
  const port = Number(process.env.HF_MIRROR_PORT ?? 48212);
  http.createServer((req, res) => {
    const f = join(process.env.HF_MIRROR, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!existsSync(f) || statSync(f).isDirectory()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Length', statSync(f).size); res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    createReadStream(f).pipe(res);
  }).listen(port, '127.0.0.1');
  MIRROR = `http://127.0.0.1:${port}/`;
}

const server = await createServer({ configFile: 'vite.config.js', server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath: CHROME, env: { ...process.env, LANG: 'C.UTF-8' } });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
page.on('pageerror', (e) => { console.log('PAGE ERROR', e.message); failures++; });

await page.goto(server.resolvedUrls.local[0]);
await page.waitForSelector('.connect');
if (MIRROR) await page.evaluate((m) => { window.__sift.runtime.remoteHost = m; }, MIRROR);

const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('button:has-text("Search a folder, read-only")')]);
check(chooser.isMultiple(), 'the read-only button opens a directory upload chooser');
await chooser.setFiles(DL);
await page.waitForSelector('.crumb:has-text("read-only")');
const st = await page.evaluate(() => { const s = window.__sift.store.get(); return { name: s.folder.name, id: s.folder.id, ro: s.folder.readOnly, files: s.listing.filter((e) => e.kind === 'file').map((e) => e.path).sort() }; });
check(st.name === 'Downloads' && st.ro && st.id === 'ro:Downloads', `opened "${st.name}" read-only`);
check(JSON.stringify(st.files) === JSON.stringify(['acme-invoice.txt', 'scan0001.txt', 'trip.txt', 'untitled.txt']), `top-level listing: ${st.files.join(', ')}`);
check(await page.locator('nav a:has-text("Undo journals")').count() === 0, 'no undo journals nav for a read-only folder');

const persisted = await page.evaluate(() => new Promise((res) => {
  const r = indexedDB.open('sift', 1);
  r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains('dirs')) r.result.createObjectStore('dirs', { keyPath: 'id' }); };
  r.onsuccess = () => { const q = r.result.transaction('dirs').objectStore('dirs').getAllKeys(); q.onsuccess = () => res(q.result); };
}));
check(!persisted.length, `no handle remembered (${JSON.stringify(persisted)})`);

async function find(q) {
  await page.fill('.left input[type=text]', q);
  await page.press('.left input[type=text]', 'Enter');
  await page.waitForFunction((q) => { const s = window.__sift.store.get().search; return (s.query === q && s.results && !s.searching) || s.error; }, q, { timeout: 30000 });
  return page.evaluate(() => { const s = window.__sift.store.get().search; return { paths: s.results?.map((r) => r.path) ?? [], error: s.error, labels: s.parsed?.labels, text: s.parsed?.text }; });
}

// Metadata queries work before the model is downloaded.
let r = await find('old files');
check(r.paths.slice(0, 2).join() === 'untitled.txt,acme-invoice.txt', `"old files" without the model, oldest first: ${r.paths.join(', ')}`);
check(await page.locator('.understood:has-text("oldest first")').count() === 1, 'the screen says how the query was read');
r = await find('files from 2021');
check(r.paths.join() === 'acme-invoice.txt', `"files from 2021": ${r.paths.join(', ')}`);
r = await find('older than 3 years');
check(r.paths.join() === 'untitled.txt,acme-invoice.txt', `"older than 3 years": ${r.paths.join(', ')}`);
check(await page.locator('.result .num:has-text("years ago")').count() === 2, 'results show their age');
r = await find('invoices');
check(/needs the model/.test(r.error ?? ''), 'a content query before the model says it needs the model, and downloads nothing');

if (MIRROR) {
  await page.evaluate(() => window.__sift.store.set({ search: { ...window.__sift.store.get().search, error: null } }));
  await page.click('button:has-text("Download & load")');
  await page.waitForFunction(() => { const s = window.__sift.store.get().search; return s.model === 'ready' && !s.build && s.lastBuild; }, null, { timeout: 600000 });
  const b = await page.evaluate(() => window.__sift.store.get().search.lastBuild);
  check(b.embedded === st.files.length, `indexed ${b.embedded} files`);
  r = await find('grocery shopping');
  check(r.paths[0] === 'untitled.txt', `"grocery shopping" finds untitled.txt (got ${r.paths[0]})`);
  r = await find('invoices');
  const plain = r.paths.slice(0, 2);
  check(plain.slice().sort().join() === 'acme-invoice.txt,scan0001.txt', `"invoices": ${plain.join(', ')}`);
  r = await find('old invoices');
  check(r.text === 'invoices' && r.paths[0] === 'acme-invoice.txt', `"old invoices" puts the 2021 invoice first: ${r.paths.slice(0, 2).join(', ')} (plain order was ${plain.join(', ')})`);
  r = await find('newest invoices');
  check(r.paths[0] === 'scan0001.txt', `"newest invoices" puts the recent one first: ${r.paths.slice(0, 2).join(', ')}`);
  r = await find('invoices from 2021');
  check(r.paths.join() === 'acme-invoice.txt', `"invoices from 2021": ${r.paths.join(', ')}`);
} else console.log('skip - search part (HF_MIRROR not set)');

await page.click('.tabs button:has-text("Rename")');
check(await page.locator('.note:has-text("read-only")').count() === 1, 'rename tab explains the folder is read-only');

await page.evaluate(async () => {
  const { openPlan } = await import('/src/plan/build.js');
  openPlan(window.__sift.store, [{ type: 'rename', from: 'untitled.txt', to: 'groceries.txt' }], { title: 'test', source: 'test' });
});
const apply = page.locator('.footer-actions button.primary:not(.danger)');
await apply.waitFor();
check(await apply.isDisabled(), `apply is disabled: "${await apply.textContent()}"`);
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
check(await page.evaluate(() => window.__sift.store.get().screen) === 'review', 'Enter does not apply either');
check(JSON.stringify(readdirSync(DL, { recursive: true }).sort()) === before, 'folder on disk unchanged');

await browser.close();
await server.close();
console.log(failures ? `${failures} failure(s)` : 'all read-only checks passed');
process.exit(failures ? 1 : 0);
