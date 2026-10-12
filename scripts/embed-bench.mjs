// EmbeddingGemma 2 in headless Chromium on the WASM/CPU path: load time, throughput, and a
// retrieval sanity check. HF_MIRROR=<dir> serves the Hugging Face layout locally.
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = Number(process.env.HF_MIRROR_PORT ?? 48211);
let mirrorUrl = null;
if (process.env.HF_MIRROR) {
  http.createServer((req, res) => {
    const f = join(process.env.HF_MIRROR, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!existsSync(f) || statSync(f).isDirectory()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Length', statSync(f).size); res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    createReadStream(f).pipe(res);
  }).listen(PORT, '127.0.0.1');
  mirrorUrl = `http://127.0.0.1:${PORT}/`;
}
const server = await createServer({ configFile: 'vite.config.js', server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath: CHROME, args: ['--js-flags=--max-old-space-size=8192'], env: { ...process.env, LANG: 'C.UTF-8' } });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.goto(server.resolvedUrls.local[0]);
await page.waitForFunction(() => window.__sift?.store.get().env);

const r = await page.evaluate(async ({ mirror }) => {
  const { Embedder, queryText, documentText } = await window.__sift.embedderModule();
  const threads = crossOriginIsolated ? Math.min(navigator.hardwareConcurrency, 8) : 1;
  const e = new Embedder({ ortBase: new URL('ort/', document.baseURI).href, threads, remoteHost: mirror ?? undefined });
  const t0 = performance.now();
  await e.init();
  const loadMs = performance.now() - t0;

  const docs = [
    ['invoice-acme-2024-03.txt', 'INVOICE #4471 Acme Supplies Ltd. Date 2024-03-11. Total due 1,240.00 EUR for office chairs and desks.'],
    ['falcon-kickoff.md', 'Project Falcon kickoff meeting minutes, 12 January 2024. Attendees J. Smith and A. Rivera. Decided to use a message queue for ingestion.'],
    ['pancakes.txt', 'Recipe: pancakes. Flour, milk, eggs, a pinch of salt. Mix, rest ten minutes, fry in butter.'],
    ['lease.txt', 'Residential lease agreement between landlord Mr Jones and tenant. Monthly rent 1,200 EUR, deposit two months, notice period one month.'],
    ['lecture-linear-algebra-3.txt', 'Linear algebra lecture 3: eigenvalues and eigenvectors, characteristic polynomial, diagonalisation.'],
    ['trip-lisbon.txt', 'Trip to Lisbon day 2: Belem tower, pasteis de nata, tram 28 through Alfama.'],
    ['README.md', 'Build instructions: run npm install then npm run build. Requires Node 22.'],
    ['cv-2024.txt', 'John Smith curriculum vitae. Senior data engineer, eight years experience with Spark and Kafka.'],
  ];
  const queries = [
    ['how much do I owe the furniture supplier', 'invoice-acme-2024-03.txt'],
    ['what did we decide about the ingestion architecture', 'falcon-kickoff.md'],
    ['how long is the notice period on my flat', 'lease.txt'],
    ['breakfast cooking instructions', 'pancakes.txt'],
    ['matrix diagonalization notes', 'lecture-linear-algebra-3.txt'],
    ['holiday in Portugal', 'trip-lisbon.txt'],
    ['resume of the kafka engineer', 'cv-2024.txt'],
    ['how do I compile this project', 'README.md'],
  ];
  const d = await e.embed(docs.map(([t, x]) => documentText(t, x)));
  let hits = 0;
  const rows = [];
  for (const [q, want] of queries) {
    const { vectors: [qv] } = await e.embed([queryText(q)]);
    const scored = d.vectors.map((v, i) => [docs[i][0], v.reduce((s, x, j) => s + x * qv[j], 0)]).sort((a, b) => b[1] - a[1]);
    if (scored[0][0] === want) hits++;
    rows.push([q, scored[0][0], scored[0][1].toFixed(3), scored[1][1].toFixed(3), scored[0][0] === want]);
  }

  // Throughput on realistic chunks: ~400-token passages, batched.
  const para = 'The quarterly report describes revenue, costs, staffing changes and the outlook for the next period in considerable detail. ';
  const chunk = para.repeat(20);
  const sizes = [];
  for (const batch of [1, 4, 8]) {
    const { stats } = await e.embed(Array.from({ length: batch }, (_, i) => documentText(`report-${i}`, chunk)));
    sizes.push({ batch, ...stats });
  }
  const single = [];
  for (let i = 0; i < 3; i++) single.push((await e.embed([queryText('where is my lease agreement')])).stats.ms);
  return { loadMs, info: e.info, hits, of: queries.length, rows, sizes, queryMs: single, threads, coi: crossOriginIsolated };
}, { mirror: mirrorUrl });

console.log(`load ${(r.loadMs / 1000).toFixed(1)}s  info=${JSON.stringify(r.info)}  coi=${r.coi} threads=${r.threads}`);
console.log(`\nretrieval: ${r.hits}/${r.of} queries ranked the right file first`);
for (const [q, top, s1, s2, ok] of r.rows) console.log(`  ${ok ? 'ok  ' : 'MISS'} ${q.padEnd(48)} -> ${top.padEnd(28)} ${s1} (next ${s2})`);
console.log('\nthroughput (~400-token chunks):');
for (const s of r.sizes) console.log(`  batch ${String(s.batch).padStart(2)}: ${s.tokens} tok in ${s.ms} ms = ${s.tokensPerSec.toFixed(0)} tok/s  (${(s.ms / s.batch).toFixed(0)} ms per chunk)`);
console.log(`single query latency: ${r.queryMs.join(', ')} ms`);
await browser.close(); await server.close();
process.exit(0);
