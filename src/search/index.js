// Semantic file index. Embeds each file once (name, a few facts, and the opening text), stores the
// vectors in IndexedDB, and re-embeds only files whose size or modification time changed.
// The embedder is injected so tests can substitute a deterministic fake.

import { readBytes, readExcerpt } from '../fs/index.js';
import { TEXT_EXT, parseExif, parsePdf } from '../plan/enrich.js';
import { splitExt } from '../util/names.js';
import { queryText, documentText } from '../runtime/embedder.js';
import { officeText, OFFICE_EXT, OFFICE_MAX_BYTES } from './office.js';
import { parseQuery, combine } from './query.js';

export const EXCERPT_CHARS = 1800; // ~400-500 tokens: the first part of a document says what it is
export const BATCH = 4;

// ---------- pure helpers (unit-tested) ----------

export function fileKey(f) {
  return `${f.size}:${f.lastModified}`;
}

/** A filename as words: "Q3_report-final.v2.pdf" -> "Q3 report final v2". */
export function nameWords(name) {
  const { stem } = splitExt(name);
  return stem.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-.]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const KINDS = [
  [/^\.(pdf)$/, 'PDF document'],
  [/^\.(docx?|docm|dotx|odt|rtf|pages)$/, 'Word document'],
  [/^\.(pptx?|pptm|potx|odp|key)$/, 'presentation slides'],
  [/^\.(xlsx?|xlsm|xltx|ods|csv|tsv|numbers)$/, 'spreadsheet'],
  [/^\.(jpe?g|png|gif|heic|webp|tiff?|bmp|svg|raw|cr2|nef)$/, 'image'],
  [/^\.(mp3|wav|m4a|flac|ogg|aac)$/, 'audio recording'],
  [/^\.(mp4|mov|avi|mkv|webm)$/, 'video'],
  [/^\.(eml|msg)$/, 'email'],
  [/^\.(zip|7z|rar|tar|gz|tgz)$/, 'archive'],
  [/^\.(exe|msi|msix|appx|dmg|pkg)$/, 'installer or program'],
  [/^\.(js|mjs|ts|py|java|cs|go|rs|c|cpp|h|sh|ps1|bat|sql|rb|php)$/, 'source code'],
];

/** What kind of file this is, in words a query might use ("the slides about..."). */
export function kindOf(ext) {
  for (const [re, kind] of KINDS) if (re.test(ext || '')) return kind;
  return '';
}

/** Build the document string the model sees, and the snippet shown in results. */
export function documentFor(file, { facts = {}, excerpt = '' } = {}) {
  const bits = [];
  const kind = kindOf(file.ext);
  if (kind) bits.push(kind);
  if (file.dir) bits.push(`folder ${file.dir}`);
  if (facts.pdfTitle) bits.push(`title ${facts.pdfTitle}`);
  if (facts.pdfAuthor) bits.push(`author ${facts.pdfAuthor}`);
  if (facts.exifDate) bits.push(`photo taken ${new Date(facts.exifDate).toISOString().slice(0, 10)}`);
  if (facts.camera) bits.push(`camera ${facts.camera}`);
  const text = excerpt.replace(/\s+/g, ' ').trim().slice(0, EXCERPT_CHARS);
  const body = [bits.join('; '), text].filter(Boolean).join('. ') || `${file.ext || 'file'} file`;
  return {
    input: documentText(nameWords(file.name), body),
    snippet: (text || bits.join('; ')).slice(0, 240),
    hasText: text.length > 0,
  };
}

/** Which files need embedding, which are current, and which entries are stale. */
export function planIndex(files, existing) {
  const byPath = new Map(existing.map((e) => [e.path, e]));
  const toEmbed = [];
  const current = [];
  for (const f of files) {
    const e = byPath.get(f.path);
    if (e && e.key === fileKey(f)) current.push(e);
    else toEmbed.push(f);
  }
  const live = new Set(files.map((f) => f.path));
  const removed = existing.filter((e) => !live.has(e.path));
  return { toEmbed, current, removed };
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** Top-k entries by cosine similarity (vectors are unit length, so this is a dot product). */
export function rank(qv, entries, k = 20) {
  return entries
    .map((e) => ({ ...e, score: dot(qv, e.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ---------- persistence ----------

const DB = 'sift-search';
const STORE = 'entries';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE, { keyPath: 'id' });
      s.createIndex('folder', 'folder');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(t) {
  return new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = () => reject(t.error); t.onabort = () => reject(t.error); });
}

async function loadEntries(folder) {
  const db = await openDb();
  const t = db.transaction(STORE, 'readonly');
  const req = t.objectStore(STORE).index('folder').getAll(folder);
  await txDone(t);
  db.close();
  return req.result ?? [];
}

async function writeEntries(put, del) {
  const db = await openDb();
  const t = db.transaction(STORE, 'readwrite');
  const s = t.objectStore(STORE);
  for (const e of put) s.put(e);
  for (const id of del) s.delete(id);
  await txDone(t);
  db.close();
}

export async function clearIndex(folder) {
  const entries = await loadEntries(folder);
  await writeEntries([], entries.map((e) => e.id));
}

// ---------- extraction ----------

async function extract(root, f) {
  const facts = {};
  let excerpt = '';
  try {
    if (f.ext === '.jpg' || f.ext === '.jpeg' || f.ext === '.tif' || f.ext === '.tiff') {
      Object.assign(facts, parseExif(await readBytes(root, f.path, 128 * 1024)) ?? {});
    } else if (f.ext === '.pdf') {
      Object.assign(facts, parsePdf(await readBytes(root, f.path, 64 * 1024)));
    } else if (OFFICE_EXT.has(f.ext) && f.size <= OFFICE_MAX_BYTES) {
      const o = await officeText(await readBytes(root, f.path), f.ext, EXCERPT_CHARS);
      excerpt = o.text;
      if (o.title) facts.pdfTitle = o.title; // shown as "title" in the document text
    } else if (TEXT_EXT.has(f.ext) || f.type?.startsWith('text/')) {
      excerpt = await readExcerpt(root, f.path, EXCERPT_CHARS * 3);
    }
  } catch {
    // unreadable: index by name only
  }
  return documentFor(f, { facts, excerpt });
}

// ---------- the index ----------

export class SearchIndex {
  constructor(folder) {
    this.folder = folder;
    this.entries = [];
  }

  async load() {
    this.entries = await loadEntries(this.folder);
    return this.entries.length;
  }

  /**
   * Bring the index up to date with `files`. Writes every batch as it completes, so an
   * interrupted build keeps its progress and the next one resumes where it stopped.
   */
  async build({ root, files, embedder, signal, onProgress }) {
    const existing = await loadEntries(this.folder);
    const { toEmbed, current, removed } = planIndex(files, existing);
    if (removed.length) await writeEntries([], removed.map((e) => e.id));
    const fresh = [];
    let tokens = 0;
    const t0 = performance.now();
    onProgress?.({ done: 0, total: toEmbed.length, skipped: current.length });
    for (let i = 0; i < toEmbed.length; i += BATCH) {
      if (signal?.aborted) break;
      const batch = toEmbed.slice(i, i + BATCH);
      const docs = [];
      for (const f of batch) docs.push(await extract(root, f));
      const { vectors, stats } = await embedder.embed(docs.map((d) => d.input));
      tokens += stats?.tokens ?? 0;
      const put = batch.map((f, j) => ({
        id: `${this.folder}|${f.path}`, folder: this.folder, path: f.path, name: f.name, ext: f.ext,
        key: fileKey(f), vec: vectors[j], snippet: docs[j].snippet, hasText: docs[j].hasText,
      }));
      await writeEntries(put, []);
      fresh.push(...put);
      onProgress?.({ done: Math.min(i + BATCH, toEmbed.length), total: toEmbed.length, skipped: current.length, tokens, ms: performance.now() - t0 });
    }
    this.entries = [...current, ...fresh];
    return { embedded: fresh.length, reused: current.length, removed: removed.length, pending: toEmbed.length - fresh.length, tokens, ms: performance.now() - t0 };
  }

  /**
   * Search by meaning and metadata. `files` is the live listing, which supplies size and date.
   * A query that is only metadata ("old files", "large videos") never touches the model, so it
   * works before the model is loaded and over files that are not indexed yet.
   */
  async search(query, embedder, k = 20, files = []) {
    const p = parseQuery(query);
    if (!p.text) {
      const byPath = new Map(this.entries.map((e) => [e.path, e]));
      const results = combine(p, files, null, k).map((r) => ({ ...r, snippet: byPath.get(r.path)?.snippet ?? '', hasText: byPath.get(r.path)?.hasText ?? false }));
      return { results, ms: 0, parsed: p };
    }
    if (!embedder) throw new Error('Searching by content needs the model; date, size and type searches (\u201cold files\u201d, \u201clarge videos\u201d) work without it.');
    const { vectors: [qv], stats } = await embedder.embed([queryText(p.text)]);
    const scored = rank(qv, this.entries, this.entries.length);
    return { results: combine(p, files, scored, k), ms: stats?.ms, parsed: p };
  }
}
