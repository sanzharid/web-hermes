// End-to-end model test: 40 mixed files in OPFS -> execution pass (thinking off) -> validation,
// then the interpretation pass with thinking on vs off on the same instruction (when the checkpoint reasons).
// Usage: HF_MIRROR=<dir> node scripts/plan-test.mjs [modelId]
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const modelId = process.argv[2] ?? 'lfm2.5-1.2b-instruct';
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let mirrorUrl = null;
if (process.env.HF_MIRROR) {
  const mirror = http.createServer((req, res) => {
    const f = join(process.env.HF_MIRROR, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    if (!existsSync(f) || statSync(f).isDirectory()) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Length', statSync(f).size); res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    createReadStream(f).pipe(res);
  }).listen(Number(process.env.HF_MIRROR_PORT ?? 48211), '127.0.0.1');
  mirrorUrl = `http://127.0.0.1:${process.env.HF_MIRROR_PORT ?? 48211}/`;
}
const server = await createServer({ configFile: 'vite.config.js', server: { port: Number(process.env.PORT ?? 4173), strictPort: true, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0];
const userDataDir = process.env.PROFILE_DIR ?? new URL('../.bench-profile', import.meta.url).pathname;
const context = await chromium.launchPersistentContext(userDataDir, { executablePath: CHROME, headless: true, args: ['--js-flags=--max-old-space-size=8192'], env: { ...process.env, LANG: 'C.UTF-8' } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
await page.goto(url + (process.env.FILES ? `?files=${process.env.FILES}` : ''));
await page.waitForFunction(() => window.__sift?.store.get().env);

// seed 40 mixed files with content that enrichment can read
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('sift-plan', { recursive: true }); } catch {}
  const dir = await root.getDirectoryHandle('sift-plan', { create: true });
  const files = {
    'IMG_2041.txt': 'Trip to Lisbon, day 1. Notes on the tram ride and the Alfama district.',
    'IMG_2042.txt': 'Trip to Lisbon, day 2. Belem tower and pastel de nata.',
    'scan0001.txt': 'INVOICE #4471\nAcme Supplies Ltd\nDate: 2024-03-11\nTotal due: 1,240.00 EUR',
    'scan0002.txt': 'INVOICE #4498\nAcme Supplies Ltd\nDate: 2024-04-02\nTotal due: 310.00 EUR',
    'scan0003.txt': 'Receipt - Hotel Mercure Paris - 2023-11-20 - 2 nights',
    'doc1.txt': 'Project Falcon: kickoff meeting minutes, 12 January 2024. Attendees: J. Smith, A. Rivera.',
    'doc2.txt': 'Project Falcon: architecture decision record 003 — use message queue for ingestion.',
    'doc3.txt': 'Project Heron: weekly status, week 14. Risks: vendor delay.',
    'doc4.txt': 'Project Heron: requirements v2 draft.',
    'untitled.txt': 'Grocery list: eggs, milk, flour.',
    'untitled (1).txt': 'Grocery list: apples, bread.',
    'notes.md': '# Book club\nMarch pick: The Overstory.',
    'README.md': '# Sift test corpus',
    'final_FINAL_v3.txt': 'Quarterly report Q3 2024 — Finance department. Revenue up 4%.',
    'Copy of budget.csv': 'item,amount\nrent,1200\nfood,400',
    'budget (2).csv': 'item,amount\nrent,1250\nfood,380',
    'CON.txt': 'this name is only legal on non-Windows systems',
    'lecture 1.txt': 'Linear algebra lecture 1: vectors and spaces.',
    'lecture 2.txt': 'Linear algebra lecture 2: matrices.',
    'lecture 10.txt': 'Linear algebra lecture 10: eigenvalues.',
    'Screenshot 2024-05-01 at 10.31.44.txt': 'screenshot placeholder',
    'Screenshot 2024-05-02 at 09.12.03.txt': 'screenshot placeholder',
    'resume-john-smith-2022.txt': 'John Smith — Curriculum Vitae — updated 2022',
    'resume-john-smith-2024.txt': 'John Smith — Curriculum Vitae — updated 2024',
    'contract signed.txt': 'Service agreement between Acme and Beta Corp, signed 2024-02-14.',
    'contract draft.txt': 'Service agreement between Acme and Beta Corp, DRAFT.',
    'photo_émilie_🎉.txt': 'party photo caption',
    'letter to landlord.txt': 'Dear Mr Jones, regarding the leak in the kitchen…',
    'todo.txt': '- buy stamps\n- call dentist',
    'ideas.txt': 'App idea: bulk file renamer that runs in the browser.',
    'log-2024-06-01.log': 'INFO started\nINFO done',
    'log-2024-06-02.log': 'INFO started\nERROR failed',
    'data.json': '{"a":1}',
    'export.json': '{"rows":[]}',
    'presentation notes.txt': 'Slides for the June all-hands.',
    'recipe - pancakes.txt': 'Flour, milk, eggs. Mix. Fry.',
    'recipe - soup.txt': 'Onion, stock, thyme. Simmer 40 minutes.',
    'x.txt': 'x',
    'a very long descriptive file name that goes on and on and on about nothing in particular.txt': 'filler',
    'archive.tar.gz': 'not really a tarball',
  };
  for (const [n, c] of Object.entries(files)) {
    const fh = await dir.getFileHandle(n, { create: true }); const w = await fh.createWritable(); await w.write(c); await w.close();
  }
  await window.__sift.openHandle(dir, 'opfs-plan');
});
await page.waitForSelector('table.files');

const t0 = Date.now();
const loaded = await page.evaluate(async ({ id, mirror, dtype }) => {
  const rt = window.__sift.runtime;
  if (mirror) rt.remoteHost = mirror;
  if (dtype) { const st = window.__sift.store; st.set({ settings: { ...st.get().settings, dtype: { [id]: dtype } } }); }
  try { await rt.load(id); return { ok: true, info: rt.adapter.loadInfo }; } catch (e) { return { ok: false, error: e.message }; }
}, { id: modelId, mirror: mirrorUrl, dtype: process.env.DTYPE ?? null });
console.log(`model: ${JSON.stringify(loaded)} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
if (!loaded.ok) process.exit(1);

// ---- execution pass ----
const spec = process.env.SPEC ?? `1. Pattern: <category>-<topic>-<date or version>.<ext>, e.g. invoice-acme-2024-03-11.txt
2. category: one of invoice, receipt, project, notes, lecture, screenshot, cv, contract, recipe, log, data, photo, misc — from the content facts.
3. topic: 1–3 lowercase words from the content; project files use the project name.
4. date: YYYY-MM-DD when a date is in the content or the name; otherwise omit. Lecture files use a two-digit number.
5. Lowercase, hyphens as separators, no spaces. Keep the extension exactly.
6. Do not create folders. Leave files unchanged when no sensible category applies.`;
const t1 = Date.now();
const exec = await page.evaluate(async (spec) => {
  const { executePlan } = await import('/src/plan/execute.js');
  const { enrichFiles } = await import('/src/plan/enrich.js');
  const { validatePlan } = await import('/src/plan/validate.js');
  const store = window.__sift.store; const rt = window.__sift.runtime;
  const limit = Number(new URLSearchParams(location.search).get('files')) || 0;
  let files = store.get().listing.filter((f) => f.kind === 'file');
  if (limit) files = files.slice(0, limit);
  const enrichment = await enrichFiles(store, files, { text: true });
  const batches = [];
  const r = await executePlan({ adapter: rt.adapter, spec, files, enrichment, folders: [], batchSize: 25, onBatch: (b) => { if (b.phase === 'end') batches.push(b); } });
  const v = validatePlan(r.ops, store.get().listing, { rootPathLength: 64 });
  return { proposed: r.ops.length, failures: r.failures, batches: r.batches, stats: r.stats, accepted: v.accepted.map((o) => [o.from, o.to, o.reason]), rejected: v.rejected.map((x) => [x.op.from, x.op.to, x.reason]), dropped: v.dropped.length };
}, spec);
console.log(`\n== execution pass: ${exec.proposed} proposed, ${exec.accepted.length} valid, ${exec.rejected.length} rejected, ${exec.dropped} no-op; ${exec.stats.generated} tokens in ${((Date.now() - t1) / 1000).toFixed(0)}s wall (${exec.stats.ms} ms model time)`);
for (const b of exec.batches) { console.log(`   batch ${b.index + 1}: ${b.ok ? `${b.proposed} proposed` : 'unparseable'}${b.unmatched.length ? `, unmatched ${JSON.stringify(b.unmatched)}` : ''}`); console.log(`   raw: ${b.raw}`); }
for (const f of exec.failures) console.log(`   failure batch ${f.batch}: ${f.error}\n   ${f.raw.slice(0, 300)}`);
console.log('   accepted:'); for (const [a, b, r] of exec.accepted) console.log(`     ${a}  →  ${b}   (${r})`);
console.log('   rejected:'); for (const [a, b, r] of exec.rejected) console.log(`     ${a}  →  ${b}   [${r}]`);

// ---- interpretation pass: thinking on vs off ----
const instruction = process.env.INSTRUCTION ?? 'make these look nicer and group them by project';
for (const thinking of (process.env.SKIP_INTERPRET ? [] : [false, true])) {
  const t = Date.now();
  const r = await page.evaluate(async ({ instruction, thinking }) => {
    const { interpret } = await import('/src/plan/interpret.js');
    const store = window.__sift.store; const rt = window.__sift.runtime;
    const files = store.get().listing.filter((f) => f.kind === 'file');
    const caps = rt.adapter.capabilities();
    if (thinking && !caps.thinking) return { skipped: 'checkpoint has no reasoning mode' };
    const r = await interpret({ adapter: rt.adapter, instruction, files, enrichment: store.get().enrichment, folders: [], thinking });
    return { spec: r.spec, thinking: r.thinking.length, stats: r.stats };
  }, { instruction, thinking });
  console.log(`\n== interpretation (thinking ${thinking ? 'on' : 'off'}): ${r.skipped ? `skipped — ${r.skipped}` : `${r.stats.generated} tokens, ${r.thinking} chars of reasoning, ${((Date.now() - t) / 1000).toFixed(0)}s`}`);
  if (r.spec) console.log(r.spec.split('\n').map((l) => `   ${l}`).join('\n'));
}
await context.close();
await server.close();
process.exit(0);
