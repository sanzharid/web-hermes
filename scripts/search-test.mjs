// End-to-end semantic search with the real EmbeddingGemma 2 model, through the real UI.
// HF_MIRROR=<dir> serves the Hugging Face layout locally (the sandbox browser cannot reach HF).
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = Number(process.env.HF_MIRROR_PORT ?? 48211);
if (!process.env.HF_MIRROR) { console.log('skip - HF_MIRROR not set'); process.exit(0); }
http.createServer((req, res) => {
  const f = join(process.env.HF_MIRROR, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!existsSync(f) || statSync(f).isDirectory()) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Length', statSync(f).size); res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  createReadStream(f).pipe(res);
}).listen(PORT, '127.0.0.1');
const MIRROR = `http://127.0.0.1:${PORT}/`;

const server = await createServer({ configFile: 'vite.config.js', server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath: CHROME, env: { ...process.env, LANG: 'C.UTF-8' } });
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
let failures = 0;
const check = (c, m) => { console.log(`${c ? 'ok' : 'FAIL'} - ${m}`); if (!c) failures++; };

const FILES = {
  'scan0001.txt': 'INVOICE #4471\nAcme Supplies Ltd\nDate: 2024-03-11\nOffice chairs x4, standing desk x1\nTotal due: 1,240.00 EUR',
  'scan0002.txt': 'Receipt - Hotel Mercure Paris - 2023-11-20 - 2 nights, breakfast included',
  'doc1.txt': 'Project Falcon: kickoff meeting minutes, 12 January 2024. We agreed to put a message queue in front of the ingestion service.',
  'doc3.txt': 'Project Heron: weekly status, week 14. Risks: the vendor is late delivering the sensors.',
  'untitled.txt': 'Grocery list: eggs, milk, flour, butter, maple syrup.',
  'final_FINAL_v3.txt': 'Quarterly report Q3 2024, Finance department. Revenue up 4%, operating costs flat.',
  'lease agreement.txt': 'Residential lease between landlord Mr Jones and the tenant. Rent 1,200 EUR per month. Notice period: one month.',
  'letter.txt': 'Dear Mr Jones, the kitchen tap has been leaking for two weeks; please send a plumber.',
  'lecture 10.txt': 'Linear algebra lecture 10: eigenvalues, eigenvectors and diagonalisation of symmetric matrices.',
  'cv.txt': 'John Smith - curriculum vitae - senior data engineer, Spark, Kafka, Airflow, eight years.',
  'recipe - soup.txt': 'Onion soup: slice onions, caramelise slowly, add stock and thyme, simmer 40 minutes, gratin with cheese.',
  'todo.txt': '- renew passport\n- call dentist about the crown\n- buy stamps',
  'notes.md': '# Book club\nMarch pick: The Overstory. Discussion about trees and time.',
  'trip.txt': 'Lisbon day 2: Belem tower, pasteis de nata, tram 28 through Alfama, sunset at the miradouro.',
  'IMG_2041.jpg': 'not really a jpeg',
  'budget.csv': 'item,amount\nrent,1200\ngroceries,400\nelectricity,85',
};

// Genuine Office files, written by python-docx / python-pptx / openpyxl.
const OFFICE = Object.fromEntries(['sample.docx', 'sample.pptx', 'sample.xlsx'].map((n) => [n, [...readFileSync(new URL(`../test/fixtures/${n}`, import.meta.url))]]));
const TOTAL = Object.keys(FILES).length + Object.keys(OFFICE).length;

await page.goto(server.resolvedUrls.local[0]);
await page.waitForSelector('.connect');
await page.evaluate(async ({ files, office, mirror }) => {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('sift-search', { recursive: true }); } catch {}
  const dir = await root.getDirectoryHandle('sift-search', { create: true });
  for (const [n, c] of Object.entries(files)) { const fh = await dir.getFileHandle(n, { create: true }); const w = await fh.createWritable(); await w.write(c); await w.close(); }
  for (const [n, b] of Object.entries(office)) { const fh = await dir.getFileHandle(n, { create: true }); const w = await fh.createWritable(); await w.write(new Uint8Array(b)); await w.close(); }
  window.__sift.runtime.remoteHost = mirror;
  await window.__sift.openHandle(dir, 'opfs-search');
}, { files: FILES, office: OFFICE, mirror: MIRROR });

await page.waitForSelector('.toolbar b:has-text("Search")');
check(await page.locator('.tabs button.active:has-text("Search")').count() === 1, 'search is the default main surface');

const t0 = Date.now();
await page.click('button:has-text("Download & load")');
await page.waitForFunction(() => window.__sift.store.get().search.model === 'ready', null, { timeout: 300000 });
const loadS = (Date.now() - t0) / 1000;
await page.waitForFunction(() => { const s = window.__sift.store.get().search; return !s.build && s.lastBuild; }, null, { timeout: 600000 });
const build = await page.evaluate(() => window.__sift.store.get().search.lastBuild);
console.log(`   model ready in ${loadS.toFixed(1)}s; indexed ${build.embedded} files, ${build.tokens} tokens in ${(build.ms / 1000).toFixed(1)}s (${Math.round(build.tokens / (build.ms / 1000))} tok/s)`);
check(build.embedded === TOTAL, `every file was indexed (${build.embedded})`);

async function search(q) {
  await page.fill('.left input[type=text]', q);
  await page.press('.left input[type=text]', 'Enter');
  try {
    await page.waitForFunction((q) => window.__sift.store.get().search.query === q && window.__sift.store.get().search.results, q, { timeout: 30000 });
  } catch (e) {
    console.log('DEBUG', JSON.stringify(await page.evaluate(() => { const s = window.__sift.store.get().search; return { model: s.model, indexed: s.indexed, err: s.error, q: s.query, n: s.results?.length, input: document.querySelector('.left input[type=text]')?.value, btn: document.querySelector('.left button.primary')?.disabled, btnText: [...document.querySelectorAll('.left button')].map((b) => b.textContent) }; })));
    throw e;
  }
  return page.evaluate(() => { const s = window.__sift.store.get().search; return { top: s.results.slice(0, 3).map((r) => [r.path, r.score.toFixed(3)]), ms: s.ms }; });
}

// Paraphrased: none of these share their key words with the file that should win.
const cases = [
  ['how much do we owe for the office furniture', 'scan0001.txt'],
  ['when is the notice deadline on my apartment', 'lease agreement.txt'],
  ['complaint about the plumbing', 'letter.txt'],
  ['what did the team decide about the data pipeline', 'doc1.txt'],
  ['is the sensor supplier behind schedule', ['doc3.txt', 'sample.pptx']], // both say the sensor vendor is late
  ['things I need to pick up at the supermarket', 'untitled.txt'],
  ['matrix maths class', 'lecture 10.txt'],
  ['vacation in Portugal', 'trip.txt'],
  ['resume of the streaming engineer', 'cv.txt'],
  ['how much do I spend on power each month', ['budget.csv', 'sample.xlsx']], // both list electricity 85
  // Office files: found by what is inside them, not their names.
  ['who cleans the office and how do we cancel', 'sample.docx'],
  ['slides about next quarter plans', 'sample.pptx'],
];
let hits = 0;
for (const [q, want] of cases) {
  const r = await search(q);
  const ok = [].concat(want).includes(r.top[0][0]);
  if (ok) hits++;
  console.log(`   ${ok ? 'hit ' : 'MISS'} ${q.padEnd(46)} -> ${r.top[0][0].padEnd(20)} ${r.top[0][1]} (then ${r.top[1] ? `${r.top[1][0]} ${r.top[1][1]}` : 'nothing else matches the filter'}) ${r.ms}ms`);
}
check(hits >= cases.length - 1, `paraphrased queries find the right file first: ${hits}/${cases.length}`);
await search('vacation in Portugal'); // unfiltered, so every indexed file is a candidate
check(await page.locator('.result').count() > 0 && await page.locator('.result .tag:has-text("name only")').count() >= 1, 'results render, and files matched without content are labelled');

// Incremental: change one file, only that one is re-embedded.
await page.evaluate(async () => {
  const dir = window.__sift.store.get().folder.handle;
  const fh = await dir.getFileHandle('todo.txt'); const w = await fh.createWritable(); await w.write('- book flights to Tokyo\n- renew passport'); await w.close();
});
await page.click('.right button:has-text("Refresh")').catch(() => {});
await page.evaluate(async () => { const m = await import('/src/ui/connect.js'); await m.refreshListing(window.__sift.store); });
await page.waitForSelector('button:has-text("Update index (1)")');
await page.click('button:has-text("Update index (1)")');
await page.waitForFunction(() => { const s = window.__sift.store.get().search; return !s.build && s.lastBuild?.embedded === 1; }, null, { timeout: 120000 });
const inc = await page.evaluate(() => window.__sift.store.get().search.lastBuild);
check(inc.embedded === 1 && inc.reused === TOTAL - 1, `a changed file re-embeds alone (${inc.embedded} embedded, ${inc.reused} reused)`);
const tokyo = await search('travel plans for Japan');
check(tokyo.top[0][0] === 'todo.txt', `new content is searchable at once: ${tokyo.top[0][0]}`);

// Agent tool over the same index.
const tool = await page.evaluate(async () => {
  const { getRegistry } = await import('/src/harness/index.js');
  return getRegistry().get('search_files').handler({ query: 'soup recipe', limit: 2 }, { store: window.__sift.store });
});
check(tool.results?.[0]?.path === 'recipe - soup.txt', `agent tool search_files works: ${JSON.stringify(tool.results?.[0])}`);

// Selecting results hands them to the file tools.
await page.click('button:has-text("Select top")');
const sel = await page.evaluate(() => [...(window.__sift.store.get().selection ?? [])].length);
check(sel > 0 && await page.locator('.right .tabs button.active:has-text("Files")').count() === 1, `results can be selected in Files (${sel})`);

// Persistence: reload, reconnect, nothing is re-embedded.
await page.reload();
await page.waitForSelector('.connect');
await page.evaluate(async ({ mirror }) => {
  window.__sift.runtime.remoteHost = mirror;
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('sift-search');
  await window.__sift.openHandle(dir, 'opfs-search');
}, { mirror: MIRROR });
await page.waitForFunction(() => window.__sift.store.get().search.model === 'ready' && window.__sift.store.get().search.indexed > 0, null, { timeout: 120000 });
const after = await page.evaluate(() => ({ indexed: window.__sift.store.get().search.indexed, stale: document.body.innerText.includes('new or changed') }));
check(after.indexed === TOTAL && !after.stale, `after reload the index is reused from storage and the cached model loads by itself (${after.indexed} indexed)`);
const again = await search('how much do we owe for the office furniture');
check(again.top[0][0] === 'scan0001.txt', 'search works straight after reload');

await page.screenshot({ path: process.env.SHOT ?? '/dev/null' }).catch(() => {});
await browser.close(); await server.close();
console.log(failures ? `\n${failures} FAILED` : '\nall search checks passed');
process.exit(failures ? 1 : 0);
