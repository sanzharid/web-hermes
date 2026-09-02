import { chromium } from 'playwright-core';
import http from 'node:http';
const srv = http.createServer((q, s) => { s.setHeader('Cross-Origin-Opener-Policy','same-origin'); s.setHeader('Cross-Origin-Embedder-Policy','require-corp'); s.end('<!doctype html><title>probe</title>'); }).listen(0);
const port = srv.address().port;
const b = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--enable-unsafe-webgpu','--enable-features=Vulkan'] });
const p = await b.newPage();
await p.goto(`http://127.0.0.1:${port}/`);
const r = await p.evaluate(async () => {
  const a = await navigator.gpu?.requestAdapter();
  const opfs = await navigator.storage.getDirectory();
  const fh = await opfs.getFileHandle('probe.txt', { create: true });
  return { webgpu: !!navigator.gpu, adapter: a ? (a.info ? {vendor:a.info.vendor, architecture:a.info.architecture, device:a.info.device, description:a.info.description} : 'no-info') : null, maxBuf: a?.limits.maxBufferSize, sab: typeof SharedArrayBuffer, crossOriginIsolated: self.crossOriginIsolated, hw: navigator.hardwareConcurrency, mem: navigator.deviceMemory, hasMove: typeof fh.move, ua: navigator.userAgent };
});
console.log(JSON.stringify(r, null, 1));
await b.close(); srv.close();
