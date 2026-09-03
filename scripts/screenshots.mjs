// Screenshots of the main screens over an OPFS folder (no model needed). Output: scratch dir or ./shots.
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { mkdirSync } from 'node:fs';
const out = process.env.OUT ?? 'shots'; mkdirSync(out, { recursive: true });
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const server = await createServer({ configFile: 'vite.config.js', server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
await server.listen();
const browser = await chromium.launch({ executablePath: CHROME, env: { ...process.env, LANG: 'C.UTF-8' } });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(server.resolvedUrls.local[0]);
await page.waitForSelector('.connect');
await page.screenshot({ path: `${out}/1-connect.png` });
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  try { await root.removeEntry('sift-shots', { recursive: true }); } catch {}
  const dir = await root.getDirectoryHandle('sift-shots', { create: true });
  const names = ['IMG_2041.jpg', 'IMG_2042.jpg', 'scan0001.pdf', 'scan0002.pdf', 'final_FINAL_v3.docx', 'Copy of budget.xlsx', 'lecture 1.txt', 'lecture 2.txt', 'lecture 10.txt', 'Screenshot 2024-05-01 at 10.31.44.png', 'résumé-2024.pdf', 'notes.md', 'contract signed.pdf', 'contract draft.pdf', 'todo.txt', 'a very long descriptive file name that goes on and on and on about nothing in particular.txt', 'archive.tar.gz', 'x.csv'];
  for (const n of names) { const fh = await dir.getFileHandle(n, { create: true }); const w = await fh.createWritable(); await w.write('content of ' + n); await w.close(); }
  await dir.getDirectoryHandle('Archive', { create: true });
  await window.__sift.openHandle(dir, 'Documents');
});
await page.waitForSelector('table.files');
await page.evaluate(() => window.__sift.store.set({ rules: [{ type: 'whitespace', separator: true }, { type: 'case', mode: 'title', extToo: false }, { type: 'sequence', start: 1, pad: 2, template: '{n} {stem}', sortBy: 'name' }] }));
await page.screenshot({ path: `${out}/2-work.png` });
await page.click('.tabs button:has-text("Instruction")');
await page.screenshot({ path: `${out}/3-instruction.png` });
await page.click('.tabs button:has-text("Rules")');
await page.click('button:has-text("Preview changes")');
await page.waitForSelector('.footer-actions button:has-text("Apply")');
await page.keyboard.press('j'); await page.keyboard.press('j'); await page.keyboard.press('x');
await page.screenshot({ path: `${out}/4-review.png` });
await page.keyboard.press('Enter'); await page.waitForSelector('button:has-text("Confirm")'); await page.keyboard.press('Enter');
await page.waitForSelector('.footer-actions button:has-text("Undo this batch")');
await page.screenshot({ path: `${out}/5-result.png` });
await page.click('nav a:has-text("Undo journals")');
await page.waitForSelector('table.files');
await page.screenshot({ path: `${out}/6-journals.png` });
await page.click('nav a:has-text("Models")');
await page.screenshot({ path: `${out}/7-models.png` });
await page.click('nav a:has-text("Environment")');
await page.screenshot({ path: `${out}/8-env.png` });
await browser.close(); await server.close();
console.log('screenshots in', out);
