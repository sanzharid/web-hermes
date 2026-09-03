// UI flow test with a fake adapter (no model): instruction -> interpret screen -> use spec -> execution -> review,
// and Ask -> harness loop -> queued change -> review. Exercises jobs.js, modelpanel.js, interpret.js end to end.
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const server = await createServer({ configFile: 'vite.config.js', server: { port: 0, host: '127.0.0.1', hmr: false }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath: CHROME, env: { ...process.env, LANG: 'C.UTF-8' } });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
let failures = 0;
const check = (c, m) => { console.log(`${c ? 'ok' : 'FAIL'} - ${m}`); if (!c) failures++; };
await page.goto(server.resolvedUrls.local[0]);
await page.waitForSelector('.connect');
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('sift-ui', { recursive: true }); } catch {}
  const dir = await root.getDirectoryHandle('sift-ui', { create: true });
  for (const [n, c] of Object.entries({ 'scan0001.txt': 'INVOICE #4471 Acme 2024-03-11', 'doc1.txt': 'Project Falcon kickoff', 'notes.txt': 'misc', 'IMG_1.txt': 'photo' })) {
    const fh = await dir.getFileHandle(n, { create: true }); const w = await fh.createWritable(); await w.write(c); await w.close();
  }
  await window.__sift.openHandle(dir, 'opfs-ui');
  // Fake adapter: scripted answers keyed by what the prompt asks for.
  const rt = window.__sift.runtime;
  rt.adapter = {
    ready: true,
    capabilities: () => ({ grammarConstraints: false, thinking: true, backend: 'fake', model: 'fake' }),
    async complete({ messages, tools, thinking, schema }, onToken) {
      const last = messages.at(-1).content;
      const emit = (kind, text) => onToken?.({ kind, text });
      if (thinking) emit('think', 'considering the files…');
      if (schema?.type === 'array') {
        emit('content', '[{"from":1,"to":"project-falcon-kickoff.txt"},{"from":3,"to":"Invoices/invoice-acme-2024-03-11.txt","reason":"invoice"},{"from":9,"to":"ghost.txt"},{"from":2,"to":"bad:name.txt"}]');
        return { content: '{"from":1,"to":"project-falcon-kickoff.txt"},{"from":3,"to":"Invoices/invoice-acme-2024-03-11.txt","reason":"invoice"},{"from":9,"to":"ghost.txt"},{"from":2,"to":"bad:name.txt"}]', thinking: '', prefill: '[', stats: { generated: 40, tps: 1, prefillMs: 1, decodeMs: 1, promptTokens: 100 } };
      }
      if (tools?.length) {
        const hasToolResult = messages.some((m) => m.role === 'tool');
        if (!hasToolResult) return { content: '<|tool_call_start|>[{"name":"get_stats","arguments":{}}]<|tool_call_end|>', thinking: 'need stats', stats: {} };
        if (!messages.some((m) => m.role === 'tool' && m.content.includes('"queued":true'))) return { content: '<|tool_call_start|>[{"name":"rename","arguments":{"from":"notes.txt","to":"misc-notes.txt","reason":"clearer"}}]<|tool_call_end|>', thinking: '', stats: {} };
        emit('content', 'There are 4 files; I queued one rename.');
        return { content: 'There are 4 files; I queued one rename.', thinking: '', stats: {} };
      }
      if (last.startsWith('Instruction:')) { emit('content', '1. Pattern: <category>-<topic>.txt\n2. keep extension'); return { content: '1. Pattern: <category>-<topic>.txt\n2. keep extension', thinking: 'thinking about it', stats: { generated: 20, tps: 2 } }; }
      return { content: 'ok', thinking: '', stats: {} };
    },
  };
});
await page.waitForSelector('table.files');
await page.click('.tabs button:has-text("Instruction")');
await page.fill('textarea', 'tidy these up and group invoices');
await page.click('button:has-text("Interpret")');
try { await page.waitForSelector('.spec textarea', { timeout: 15000 }); } catch (e) {
  const st = await page.evaluate(() => { const s = window.__sift.store.get(); return { screen: s.screen, notice: s.notice, job: !!s.job, spec: s.spec, ready: window.__sift.runtime.ready, model: s.model }; });
  console.log('DEBUG state:', JSON.stringify(st));
  const direct = await page.evaluate(async () => { const { runInterpret } = await import('/src/ui/jobs.js'); const store = window.__sift.store; const files = store.get().listing.filter((f) => f.kind === 'file'); try { await runInterpret(store, 'test', files); return { screen: store.get().screen, notice: store.get().notice }; } catch (err) { return { error: err.message, stack: err.stack }; } });
  console.log('DEBUG direct:', JSON.stringify(direct)); throw e;
}
const spec = await page.inputValue('.spec textarea');
check(spec.startsWith('1. Pattern'), 'interpretation produced an editable spec');
check(await page.locator('details summary').count() === 1, 'reasoning trace is shown collapsed');
await page.fill('.spec textarea', spec + '\n3. edited by user');
await page.click('button:has-text("Save as preset")').catch(() => {});
page.once('dialog', (d) => d.accept('invoices-preset'));
await page.click('button:has-text("Use this")');
await page.waitForSelector('.footer-actions button:has-text("Apply")', { timeout: 15000 });
const plan = await page.evaluate(() => { const p = window.__sift.store.get().plan; return { accepted: p.accepted.map((o) => [o.type, o.from ?? '', o.to]), rejected: p.rejected.map((r) => [r.op.to, r.reason]), notice: window.__sift.store.get().notice }; });
console.log('   plan:', JSON.stringify(plan));
check(plan.accepted.some(([t]) => t === 'create_folder') && plan.accepted.some(([t, , to]) => t === 'move' && to.startsWith('Invoices/')), 'new folder + move accepted');
check(plan.rejected.some(([to, why]) => to === 'bad:name.txt' && /reserved/.test(why)), 'invalid name caught by validation');
check(/not in the batch/.test(plan.notice ?? ''), `unmatched file index reported: ${plan.notice}`);
await page.keyboard.press('Escape');
await page.waitForSelector('table.files');
await page.click('.tabs button:has-text("Instruction")');
await page.click('.tabs button:has-text("Ask")');
await page.fill('textarea', 'how many files?');
await page.click('button:has-text("Run")');
try { await page.waitForSelector('button:has-text("Review 1 queued change")', { timeout: 15000 }); } catch (e) {
  const st = await page.evaluate(() => { const s = window.__sift.store.get(); return { screen: s.screen, notice: s.notice, job: !!s.job, agent: s.agent, loop: sessionStorage.getItem('sift.loop')?.slice(0, 600), panel: document.querySelector('.right')?.innerText.slice(0, 400) }; });
  console.log('DEBUG ask:', JSON.stringify(st, null, 1)); throw e;
}
const agent = await page.evaluate(() => window.__sift.store.get().agent);
check(agent.answer?.includes('4 files') && agent.plan.length === 1, `agent answered and queued a rename: ${JSON.stringify(agent.answer)}`);
await page.click('button:has-text("Review 1 queued change")');
await page.waitForSelector('.footer-actions button:has-text("Apply 1 change")');
check(true, 'queued change reaches the review screen without being applied');
const names = await page.evaluate(async () => { const out = []; for await (const [n] of window.__sift.store.get().folder.handle.entries()) out.push(n); return out; });
check(names.includes('notes.txt') && !names.includes('misc-notes.txt') && !names.includes('Invoices'), 'nothing written to disk');
await browser.close(); await server.close();
console.log(failures ? `\n${failures} FAILED` : '\nall ui-flow checks passed');
process.exit(failures ? 1 : 0);
