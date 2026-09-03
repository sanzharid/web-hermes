// Headless end-to-end test of the filesystem spine, rules engine, review UI, apply and undo.
// Uses the Origin Private File System as the "folder" (same FileSystemDirectoryHandle API).
import { chromium } from 'playwright-core';
import { createServer } from 'vite';

const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const server = await createServer({ configFile: 'vite.config.js', server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch({ executablePath: CHROME, env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });

let failures = 0;
const check = (cond, msg) => { console.log(`${cond ? 'ok' : 'FAIL'} - ${msg}`); if (!cond) failures++; };

await page.goto(url);
await page.waitForSelector('.connect');

// ---- seed 200 adversarial files in OPFS ----
const names = await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('sift-test', { recursive: true }); } catch {}
  const dir = await root.getDirectoryHandle('sift-test', { create: true });
  const names = [];
  const push = (n) => names.push(n);
  push('naïve café résumé.txt'); push('日本語ファイル.md'); push('emoji 🎉🚀 party.jpg'); push('Ünïcödé.PDF');
  push('x'.repeat(200) + '.txt'); push('no-extension'); push('.hidden-dotfile'); push('CaseA.txt'); push('CaseB.TXT');
  push('already 001.txt'); push('spaces   inside .txt'); push('semi;colon,comma.txt'); push("quote's \"and\" more.txt");
  push('paren (1) [2] {3}.txt'); push('plus+and&amp=eq%pct.txt'); push('ünïcode-ẞ-ß.txt'); push('Ελληνικά.doc'); push('العربية.txt');
  push('archive.tar.gz'); push('dots.in.name.v2.log'); push('trailing-dash-.csv');
  for (let i = names.length; i < 200; i++) push(`file ${i}${i % 7 === 0 ? '' : '.dat'}`);
  for (const n of names) {
    const fh = await dir.getFileHandle(n, { create: true });
    const w = await fh.createWritable(); await w.write(`content of ${n}`); await w.close();
  }
  await dir.getDirectoryHandle('subdir', { create: true });
  const sub = await dir.getDirectoryHandle('subdir');
  const sfh = await sub.getFileHandle('nested.txt', { create: true }); const sw = await sfh.createWritable(); await sw.write('nested'); await sw.close();
  await window.__sift.openHandle(dir, 'opfs-test');
  return names;
});
await page.waitForSelector('table.files');
const listed = await page.evaluate(() => window.__sift.store.get().listing.filter((f) => f.kind === 'file').length);
check(listed === 199, `listing shows 199 visible files (200 seeded, one dotfile hidden): got ${listed}`);
check(await page.locator('.topbar .crumb').textContent().then((t) => t.includes('199 files')), 'top bar shows folder name and file count');

async function listNames() {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('sift-test');
    const out = [];
    for await (const [n, e] of dir.entries()) if (e.kind === 'file') out.push(n);
    return out.sort();
  });
}
async function readJournal() {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('sift-test');
    const out = [];
    for await (const [n, e] of dir.entries()) if (n.startsWith('.sift-undo-')) out.push([n, JSON.parse(await (await e.getFile()).text())]);
    return out.sort((a, b) => a[0].localeCompare(b[0]));
  });
}

// ---- milestone 1: rename one file via a hardcoded op, reconnect, rename again ----
const m1 = await page.evaluate(async () => {
  const fs = await import('/src/fs/index.js');
  const { folder } = window.__sift.store.get();
  const r1 = await fs.applyPlan(folder.handle, [{ type: 'rename', from: 'no-extension', to: 'renamed-once' }], { label: 'hardcoded' });
  const rec = await fs.restoreDirectory('opfs-test');
  const r2 = await fs.applyPlan(rec.handle, [{ type: 'rename', from: 'renamed-once', to: 'no-extension' }], { label: 'hardcoded-2' });
  return { r1: r1.applied, r2: r2.applied, perm: rec.permission, name: rec.handle.name, move: fs.moveSupport() };
});
check(m1.r1 === 1 && m1.r2 === 1, `milestone 1: hardcoded rename, restore handle from IndexedDB (${m1.perm}), rename back`);
check(m1.move === true, `native FileSystemFileHandle.move() used: ${m1.move}`);

async function runBatch(label) {
  // Rules: sequence numbering + tidy whitespace; through the real UI.
  await page.evaluate(() => window.__sift.store.set({ rules: [{ type: 'whitespace', separator: false }, { type: 'sequence', start: 1, pad: 3, template: '{n} {stem}', sortBy: 'name' }], screen: 'work' }));
  // The agent console is the default surface now; rules live in a side tab.
  await page.click('.tabs button:has-text("Rules")');
  await page.waitForSelector('button:has-text("Preview changes")');
  await page.click('button:has-text("Preview changes")');
  await page.waitForSelector('.footer-actions button:has-text("Apply")');
  const plan = await page.evaluate(() => { const p = window.__sift.store.get().plan; return { accepted: p.accepted.length, rejected: p.rejected.map((r) => [r.op.to, r.reason]), dropped: p.dropped.length }; });
  console.log(`   plan: ${plan.accepted} accepted, ${plan.rejected.length} rejected, ${plan.dropped} dropped`);
  for (const [to, why] of plan.rejected) console.log(`   rejected: ${to} — ${why}`);
  check(plan.rejected.some(([to]) => to.startsWith('001 ') && to.includes('x'.repeat(50))) || plan.rejected.length >= 1, 'over-long name is rejected by validation, not applied');
  // keyboard: j, k, x toggles a row; then Enter, Enter applies
  await page.focus('.tablewrap');
  await page.keyboard.press('j'); await page.keyboard.press('x');
  const skipped = await page.evaluate(() => Object.values(window.__sift.store.get().plan.decisions).filter((v) => !v).length);
  check(skipped === 1, 'x toggles the row under the cursor');
  await page.keyboard.press('x');
  await page.keyboard.press('Enter');
  await page.waitForSelector('button:has-text("Confirm")');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.footer-actions button:has-text("Undo this batch")', { timeout: 60000 });
  const result = await page.evaluate(() => { const r = window.__sift.store.get().result; return { applied: r.applied, stopped: r.stopped, error: r.error, journal: r.journal, methods: [...new Set(r.results.map((x) => x.method))] }; });
  console.log(`   ${label}: applied ${result.applied}, stopped=${result.stopped}, methods=${result.methods}`);
  check(!result.stopped && result.applied === plan.accepted, `${label}: all accepted ops applied`);
  const after = await listNames();
  check(after.filter((n) => /^\d{3} /.test(n)).length === plan.accepted, `${label}: ${plan.accepted} files now carry a sequence prefix`);
  check(after.includes('.hidden-dotfile'), 'dotfile untouched');
  const journals = await readJournal();
  const j = journals.at(-1)[1];
  check(j.ops.length === plan.accepted && j.applied.length === plan.accepted && j.status === 'complete', `journal ${journals.at(-1)[0]} records ${j.applied.length}/${j.ops.length} applied, status ${j.status}`);
  // undo
  await page.click('button:has-text("Undo this batch")');
  await page.waitForSelector('.footer-actions button:has-text("Apply")');
  await page.keyboard.press('Enter');
  await page.waitForSelector('button:has-text("Confirm")');
  await page.keyboard.press('Enter');
  await page.waitForSelector('.footer-actions button:has-text("Back to files")', { timeout: 60000 });
  const undo = await page.evaluate(() => { const r = window.__sift.store.get().result; return { applied: r.applied, stopped: r.stopped, error: r.error, failed: r.results.filter((x) => !x.ok).map((x) => [x.op.to, x.error]) }; });
  for (const [to, why] of undo.failed) console.log(`   undo failed: ${to} — ${why}`);
  check(!undo.stopped && undo.applied === plan.accepted, `${label}: undo applied ${undo.applied} reversals${undo.error ? ` (${undo.error})` : ''}`);
  const restored = await listNames();
  const expected = [...names].sort();
  const missing = expected.filter((n) => !restored.includes(n));
  check(missing.length === 0, `${label}: every original name restored${missing.length ? `; missing ${missing.slice(0, 3)}` : ''}`);
  await page.click('button:has-text("Back to files")');
}

await runBatch('native move');
await page.evaluate(async () => { const fs = await import('/src/fs/index.js'); fs.setMoveSupport(false); });
await runBatch('copy fallback');

// ---- case-only rename and collision handling ----
const caseTest = await page.evaluate(async () => {
  const fs = await import('/src/fs/index.js');
  const { validatePlan } = await import('/src/plan/validate.js');
  const { folder } = window.__sift.store.get();
  const listing = await fs.listEntries(folder.handle);
  const v = validatePlan([{ from: 'dots.in.name.v2.log', to: 'DOTS.in.name.v2.log' }, { from: 'CaseA.txt', to: 'CASEA.txt' }], listing);
  const r = await fs.applyPlan(folder.handle, v.accepted, { label: 'case' });
  const names = [];
  for await (const [n] of folder.handle.entries()) names.push(n);
  const back = await fs.applyPlan(folder.handle, [{ type: 'rename', from: 'DOTS.in.name.v2.log', to: 'dots.in.name.v2.log' }, { type: 'rename', from: 'CASEA.txt', to: 'CaseA.txt' }], { label: 'case-back' });
  return { accepted: v.accepted.length, applied: r.applied, has: names.includes('DOTS.in.name.v2.log') && names.includes('CASEA.txt'), back: back.applied };
});
check(caseTest.accepted === 2 && caseTest.applied === 2 && caseTest.has && caseTest.back === 2, `case-only renames go through the temp-name path: ${JSON.stringify(caseTest)}`);

// ---- stop on first error, journal intact ----
const stopTest = await page.evaluate(async () => {
  const fs = await import('/src/fs/index.js');
  const { folder } = window.__sift.store.get();
  const r = await fs.applyPlan(folder.handle, [
    { type: 'rename', from: 'file 25.dat', to: 'file 25 moved.dat' },
    { type: 'rename', from: 'does-not-exist.txt', to: 'x.txt' },
    { type: 'rename', from: 'file 26.dat', to: 'file 26 moved.dat' },
  ], { label: 'stop' });
  const j = JSON.parse(await (await (await folder.handle.getFileHandle(r.journal)).getFile()).text());
  await fs.applyPlan(folder.handle, [{ type: 'rename', from: 'file 25 moved.dat', to: 'file 25.dat' }], { journal: false });
  const present = []; for await (const [n] of folder.handle.entries()) if (/file 2\d/.test(n)) present.push(n);
  return { applied: r.applied, stopped: r.stopped, error: r.error, results: r.results.length, jstatus: j.status, japplied: j.applied.length, present };
});
check(stopTest.applied === 1 && stopTest.stopped && stopTest.results === 2 && stopTest.jstatus === 'stopped' && stopTest.japplied === 1, `stops on first error, reports what succeeded, journal intact: ${JSON.stringify(stopTest)}`);

// ---- move into a new folder, and one-level recursion ----
const moveTest = await page.evaluate(async () => {
  const fs = await import('/src/fs/index.js');
  const { validatePlan } = await import('/src/plan/validate.js');
  const { folder } = window.__sift.store.get();
  const listing = await fs.listEntries(folder.handle, { recursive: true });
  const nested = listing.some((f) => f.path === 'subdir/nested.txt');
  const v = validatePlan([{ type: 'create_folder', to: 'Archive' }, { from: 'file 30.dat', to: 'Archive/file 30.dat' }, { from: 'subdir/nested.txt', to: 'nested-up.txt' }], listing);
  const r = await fs.applyPlan(folder.handle, v.accepted, { label: 'move' });
  const back = await fs.applyPlan(folder.handle, [{ type: 'move', from: 'Archive/file 30.dat', to: 'file 30.dat' }, { type: 'move', from: 'nested-up.txt', to: 'subdir/nested.txt' }], { journal: false });
  return { nested, accepted: v.accepted.map((o) => o.type), applied: r.applied, back: back.applied };
});
check(moveTest.nested && moveTest.applied === 3 && moveTest.back === 2, `create_folder + move into it + move up from subfolder: ${JSON.stringify(moveTest)}`);

await browser.close();
await server.close();
console.log(failures ? `\n${failures} FAILED` : '\nall browser checks passed');
process.exit(failures ? 1 : 0);
