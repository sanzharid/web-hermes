// Text from Word, PowerPoint and Excel files (OOXML: a zip of XML parts), using only the browser's
// built-in DecompressionStream. Reads just the parts that carry prose, so a large deck costs little.

const MAX_BYTES = 25 * 1024 * 1024;

function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

/** Central-directory listing: name -> { method, compSize, offset }. Throws if not a zip. */
export function zipEntries(bytes) {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = u16(bytes, eocd + 10);
  let p = u32(bytes, eocd + 16);
  const out = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count && p + 46 <= bytes.length; n++) {
    if (u32(bytes, p) !== 0x02014b50) break;
    const method = u16(bytes, p + 10);
    const compSize = u32(bytes, p + 20);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const offset = u32(bytes, p + 42);
    out.set(dec.decode(bytes.subarray(p + 46, p + 46 + nameLen)), { method, compSize, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

async function readEntry(bytes, e) {
  const nameLen = u16(bytes, e.offset + 26);
  const extraLen = u16(bytes, e.offset + 28);
  const start = e.offset + 30 + nameLen + extraLen;
  const data = bytes.subarray(start, start + e.compSize);
  if (e.method === 0) return new TextDecoder().decode(data);
  if (e.method !== 8) throw new Error(`unsupported zip method ${e.method}`);
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

const decodeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/&amp;/g, '&');

/** Visible text from an OOXML part: paragraph and row ends become line breaks. */
export function xmlText(xml) {
  return decodeXml(
    xml
      .replace(/<\/(w:p|a:p|row|si)>/g, '\n')
      .replace(/<\/c>/g, ' ')
      .replace(/<(w:tab|w:br)\b[^>]*\/>/g, ' ')
      .replace(/<(?!\/?(w:t|a:t|t)\b)[^>]+>/g, '')
      .replace(/<\/?(w:t|a:t|t)\b[^>]*>/g, ''),
  ).replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n\s*\n+/g, '\n').trim();
}

const slideNo = (n) => Number(/(\d+)\.xml$/.exec(n)?.[1] ?? 0);

/**
 * @param {Uint8Array} bytes  the whole file
 * @param {string} ext        '.docx' | '.pptx' | '.xlsx' (and macro/template variants)
 * @param {number} limit      characters wanted
 * @returns {Promise<{ text: string, title: string }>}
 */
export async function officeText(bytes, ext, limit = 2000) {
  const entries = zipEntries(bytes);
  let parts;
  if (/^\.do[ct][xm]$/.test(ext)) parts = ['word/document.xml'];
  else if (/^\.pp[st][xm]$/.test(ext)) parts = [...entries.keys()].filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => slideNo(a) - slideNo(b));
  // Excel writes a shared-strings table; other producers (openpyxl, many exporters) write strings
  // inline in each sheet. Read both.
  else if (/^\.xl[st][xm]$/.test(ext)) parts = ['xl/sharedStrings.xml', ...[...entries.keys()].filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => slideNo(a) - slideNo(b))];
  else parts = [];
  let text = '';
  for (const name of parts) {
    const e = entries.get(name);
    if (!e) continue;
    let xml = await readEntry(bytes, e);
    // In a sheet, a shared-string cell's value is an index into the table, not content.
    if (name.startsWith('xl/worksheets/')) xml = xml.replace(/<c\b[^>]*\bt="s"[^>]*>[\s\S]*?<\/c>/g, '');
    text += (text ? '\n' : '') + xmlText(xml);
    if (text.length >= limit) break;
  }
  let title = '';
  const core = entries.get('docProps/core.xml');
  if (core) {
    const m = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(await readEntry(bytes, core));
    if (m) title = decodeXml(m[1]).trim();
  }
  return { text: text.slice(0, limit), title };
}

export const OFFICE_EXT = new Set(['.docx', '.docm', '.dotx', '.pptx', '.pptm', '.potx', '.xlsx', '.xlsm', '.xltx']);
export const OFFICE_MAX_BYTES = MAX_BYTES;
