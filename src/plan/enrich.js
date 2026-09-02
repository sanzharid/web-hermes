// Per-file enrichment: pulled on demand, per file, never in bulk. Compact facts only.

import { readBytes, readExcerpt } from '../fs/index.js';

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.html', '.htm', '.xml', '.yaml', '.yml', '.ini', '.cfg', '.js', '.mjs', '.ts', '.py', '.sh', '.bat', '.ps1', '.sql', '.rtf', '.tex', '.srt']);

/**
 * Enrich files. Results are cached in store.enrichment (Map path -> facts).
 * @returns {Promise<Map>}
 */
export async function enrichFiles(store, files, { text = true, excerptBytes, signal, onProgress } = {}) {
  const state = store.get();
  const { folder, settings } = state;
  const bytes = excerptBytes ?? settings.excerptBytes ?? 500;
  const map = new Map(state.enrichment);
  let done = 0;
  for (const f of files) {
    if (signal?.aborted) break;
    const key = `${f.path}@${f.lastModified}:${f.size}`;
    const existing = map.get(f.path);
    if (!existing || existing.key !== key || (text && existing.textPending)) {
      const facts = { key };
      try {
        await enrichOne(folder.handle, f, facts, { text, bytes });
      } catch (e) {
        facts.error = e?.message ?? String(e);
      }
      map.set(f.path, facts);
    }
    onProgress?.(++done, files.length);
  }
  store.set({ enrichment: map });
  return map;
}

async function enrichOne(root, f, facts, { text, bytes }) {
  const ext = f.ext;
  if (ext === '.jpg' || ext === '.jpeg' || ext === '.tif' || ext === '.tiff') {
    const buf = await readBytes(root, f.path, 128 * 1024);
    const exif = parseExif(buf);
    if (exif) Object.assign(facts, exif);
  } else if (ext === '.pdf') {
    const buf = await readBytes(root, f.path, 64 * 1024);
    Object.assign(facts, parsePdf(buf));
  } else if (text && (TEXT_EXT.has(ext) || f.type.startsWith('text/'))) {
    const excerpt = await readExcerpt(root, f.path, bytes * 2);
    facts.excerpt = excerpt.replace(/\s+/g, ' ').trim().slice(0, bytes);
  } else if (!text && (TEXT_EXT.has(ext) || f.type.startsWith('text/'))) {
    facts.textPending = true;
  }
}

/** Format facts into one compact line for a prompt. */
export function summariseFacts(facts) {
  if (!facts) return '';
  const parts = [];
  if (facts.exifDate) parts.push(`taken ${new Date(facts.exifDate).toISOString().slice(0, 10)}`);
  if (facts.camera) parts.push(`camera ${facts.camera}`);
  if (facts.pdfTitle) parts.push(`title "${facts.pdfTitle}"`);
  if (facts.pdfAuthor) parts.push(`author "${facts.pdfAuthor}"`);
  if (facts.pages) parts.push(`${facts.pages} pages`);
  if (facts.excerpt) parts.push(`starts: "${facts.excerpt.slice(0, 200)}"`);
  return parts.join('; ');
}

// ---------- EXIF (JPEG APP1 / TIFF) ----------

export function parseExif(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let tiff = -1;
  if (dv.getUint16(0) === 0xffd8) {
    // JPEG: walk segments to APP1 "Exif\0\0"
    let off = 2;
    while (off + 4 <= dv.byteLength) {
      if (dv.getUint8(off) !== 0xff) return null;
      const marker = dv.getUint8(off + 1);
      const len = dv.getUint16(off + 2);
      if (marker === 0xe1 && off + 10 <= dv.byteLength && dv.getUint32(off + 4) === 0x45786966) { tiff = off + 10; break; }
      if (marker === 0xda) return null; // start of scan, no EXIF
      off += 2 + len;
    }
    if (tiff < 0) return null;
  } else if (dv.getUint16(0) === 0x4949 || dv.getUint16(0) === 0x4d4d) {
    tiff = 0;
  } else return null;
  if (tiff + 8 > dv.byteLength) return null;
  const le = dv.getUint16(tiff) === 0x4949;
  const u16 = (o) => dv.getUint16(o, le);
  const u32 = (o) => dv.getUint32(o, le);
  if (u16(tiff + 2) !== 0x2a) return null;
  const out = {};
  const readIfd = (ifdOff, tags) => {
    if (tiff + ifdOff + 2 > dv.byteLength) return;
    const n = u16(tiff + ifdOff);
    for (let i = 0; i < n; i++) {
      const e = tiff + ifdOff + 2 + i * 12;
      if (e + 12 > dv.byteLength) return;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1 })[type] ?? 1;
      const total = size * count;
      const valOff = total <= 4 ? e + 8 : tiff + u32(e + 8);
      const handler = tags[tag];
      if (!handler) continue;
      if (type === 2) {
        if (valOff + count > dv.byteLength) continue;
        let s = '';
        for (let k = 0; k < count; k++) { const c = dv.getUint8(valOff + k); if (c === 0) break; s += String.fromCharCode(c); }
        handler(s.trim());
      } else if (type === 4 || type === 3) {
        handler(type === 4 ? u32(valOff) : u16(valOff));
      }
    }
  };
  let make = '', model = '';
  readIfd(u32(tiff + 4), {
    0x010f: (v) => { make = v; },
    0x0110: (v) => { model = v; },
    0x0132: (v) => { out.modifyDate = exifDate(v); },
    0x8769: (v) => readIfd(v, { 0x9003: (s) => { out.exifDate = exifDate(s); }, 0x9004: (s) => { out.digitizedDate = exifDate(s); } }),
  });
  if (!out.exifDate) out.exifDate = out.digitizedDate ?? out.modifyDate ?? undefined;
  if (make || model) out.camera = model.startsWith(make) ? model : `${make} ${model}`.trim();
  delete out.digitizedDate; delete out.modifyDate;
  return Object.keys(out).length ? out : null;
}

function exifDate(s) {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) return undefined;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(t) ? t : undefined;
}

// ---------- PDF (Info dictionary, first chunk only) ----------

export function parsePdf(buf) {
  const text = new TextDecoder('latin1').decode(buf);
  const out = {};
  const title = pdfString(text, 'Title');
  const author = pdfString(text, 'Author');
  if (title) out.pdfTitle = title;
  if (author) out.pdfAuthor = author;
  const count = /\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/.exec(text) ?? /\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages/.exec(text);
  if (count) out.pages = Number(count[1]);
  return out;
}

function pdfString(text, key) {
  const re = new RegExp(`/${key}\\s*(\\((?:\\\\.|[^\\\\)])*\\)|<[0-9A-Fa-f\\s]*>)`);
  const m = re.exec(text);
  if (!m) return '';
  let raw = m[1];
  let s;
  if (raw.startsWith('<')) {
    const hex = raw.slice(1, -1).replace(/\s/g, '');
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    s = decodePdfBytes(bytes);
  } else {
    raw = raw.slice(1, -1).replace(/\\([nrtbf()\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' })[c] ?? c).replace(/\\(\d{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0) & 0xff);
    s = decodePdfBytes(bytes);
  }
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > 200 ? s.slice(0, 200) : s;
}

function decodePdfBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
  return new TextDecoder('latin1').decode(bytes);
}
