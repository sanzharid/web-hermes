// Drive the deployed site in headless Chromium and verify the real-world path:
// service worker installs, the app reloads itself into cross-origin isolation, env check runs.
import { chromium } from 'playwright-core';
const URL_ = process.argv[2] ?? 'https://sanzharid.github.io/web-hermes/';
const CHROME = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: CHROME,
  proxy: process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined,
  env: { ...process.env, LANG: 'C.UTF-8' },
});
let failures = 0;
const check = (c, m) => { console.log(`${c ? 'ok' : 'FAIL'} - ${m}`); if (!c) failures++; };
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });

await page.goto(URL_, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__sift?.store.get().env, null, { timeout: 60000 });
check(true, `app boots at ${URL_}`);

// The self-reload should take it to isolation without any server-set headers.
try { await page.waitForFunction(() => crossOriginIsolated, null, { timeout: 45000 }); } catch {}
const state = await page.evaluate(() => ({
  coi: crossOriginIsolated,
  sab: typeof SharedArrayBuffer !== 'undefined',
  sw: !!navigator.serviceWorker.controller,
  screen: window.__sift.store.get().screen,
  env: window.__sift.store.get().env?.outcome,
  fsa: 'showDirectoryPicker' in window,
  title: document.title,
}));
console.log('   state:', JSON.stringify(state));
check(state.sw, 'service worker controls the deployed page');
check(state.coi && state.sab, `cross-origin isolated on GitHub Pages: coi=${state.coi}, SharedArrayBuffer=${state.sab}`);
check(state.screen === 'connect' && state.fsa, 'connect screen renders and File System Access is available');
check(!!state.env, `environment check ran (outcome: ${state.env})`);

const rules = await page.evaluate(() => document.body.innerText.includes('Pick a folder'));
check(rules, 'folder picker is offered');
await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nlive site verified');
process.exit(failures ? 1 : 0);
