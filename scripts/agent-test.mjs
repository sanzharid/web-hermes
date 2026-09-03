// Harness checkpoint with the real model: a two-tool query completes without looping,
// and a request that implies a change ends up queued, not applied.
// Usage: HF_MIRROR=<dir> node scripts/agent-test.mjs [modelId]
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const modelId = process.argv[2] ?? 'lfm2.5-1.2b-instruct';
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
let mirrorUrl = null;
if (process.env.HF_MIRROR) {
  http.createServer((req, res) => {
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
await page.goto(url);
await page.waitForFunction(() => window.__sift?.store.get().env);
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('sift-agent', { recursive: true }); } catch {}
  const dir = await root.getDirectoryHandle('sift-agent', { create: true });
  const files = { 'invoice-2024-03.txt': 'INVOICE #1 Acme, March 2024, total 120 EUR', 'invoice-2024-04.txt': 'INVOICE #2 Acme, April 2024, total 80 EUR', 'notes.txt': 'meeting notes about the Falcon project', 'photo.jpg': 'x', 'todo.md': '- buy milk' };
  for (const [n, c] of Object.entries(files)) { const fh = await dir.getFileHandle(n, { create: true }); const w = await fh.createWritable(); await w.write(c); await w.close(); }
  await window.__sift.openHandle(dir, 'opfs-agent');
});
await page.waitForSelector('table.files');
const loaded = await page.evaluate(async ({ id, mirror }) => {
  const rt = window.__sift.runtime; if (mirror) rt.remoteHost = mirror;
  try { await rt.load(id); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
}, { id: modelId, mirror: mirrorUrl });
console.log('model:', JSON.stringify(loaded));
if (!loaded.ok) process.exit(1);

let failures = 0;
const check = (c, m) => { console.log(`${c ? 'ok' : 'FAIL'} - ${m}`); if (!c) failures++; };
for (const q of [
  'How many text files are there, and what is the first invoice about? Use the tools.',
  'Rename notes.txt to falcon-meeting-notes.txt.',
]) {
  const t = Date.now();
  const r = await page.evaluate(async (q) => {
    const { runLoop, createLoopState } = await import('/src/harness/loop.js');
    const { getRegistry } = await import('/src/harness/index.js');
    const rt = window.__sift.runtime; const store = window.__sift.store;
    const state = createLoopState({ system: 'You are Sift, an assistant for one folder of files. Use the tools to look before answering. Renames are queued for review, never applied. Answer briefly.', user: q });
    const events = [];
    await runLoop({ adapter: rt.adapter, registry: getRegistry(), state, ctx: { store }, thinking: rt.adapter.capabilities().thinking, onEvent: (e) => events.push(e.type === 'tool-call' ? `${e.type}:${e.name}` : e.type) });
    const names = []; for await (const [n] of store.get().folder.handle.entries()) names.push(n);
    return { iterations: state.iteration, answer: state.answer, plan: state.plan, events, names };
  }, q);
  console.log(`\n== ${q} (${((Date.now() - t) / 1000).toFixed(0)}s)`);
  console.log(`   ${r.iterations} iterations; events: ${r.events.join(' ')}`);
  console.log(`   answer: ${JSON.stringify(r.answer)}`);
  if (r.plan.length) console.log(`   queued: ${JSON.stringify(r.plan)}`);
  if (q.startsWith('How')) check(r.iterations >= 2 && r.iterations < 8 && r.answer, `two-tool query completes in ${r.iterations} iterations with an answer`);
  else check(r.plan.some((p) => p.name === 'rename') && r.names.includes('notes.txt') && !r.names.includes('falcon-meeting-notes.txt'), 'rename was queued and nothing was written');
}
await context.close(); await server.close();
console.log(failures ? `\n${failures} FAILED` : '\nall agent checks passed');
process.exit(failures ? 1 : 0);
