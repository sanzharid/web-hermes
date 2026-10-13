// Metadata in a search query: age, dates, size and file type. Embeddings cannot answer "old files"
// (age is relative to today, and a vector is fixed when the file is indexed), so these words are read
// here, deterministically, and turned into filters and an ordering. Whatever text is left goes to the
// model; a query that is only metadata ("old files", "large videos") needs no model at all.
import { kindOf } from './index.js';

const DAY = 86400000;
const UNIT_MS = { day: DAY, week: 7 * DAY, month: 30.44 * DAY, year: 365.25 * DAY };
const NUM_WORDS = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, few: 3 };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = `(${MONTHS.join('|')}|${MONTHS.map((m) => m.slice(0, 3)).join('|')}|sept)`;
const N = `(\\d+|${Object.keys(NUM_WORDS).join('|')})`;
const UNIT = '(day|week|month|year)s?';

// Plural or unambiguous type words only: "image processing paper" must stay a content query.
const KIND_WORDS = [
  [/\b(pdfs?|pdf files?)\b/, 'PDF document'],
  [/\b(word (?:documents?|docs?|files?)|docx(?: files?)?|doc files?)\b/, 'Word document'],
  [/\b((?:slide )?decks?|slides|presentations?|powerpoints?|pptx(?: files?)?)\b/, 'presentation slides'],
  [/\b(spreadsheets?|excel(?: files?| sheets?)?|workbooks?|xlsx(?: files?)?|csvs?|csv files?)\b/, 'spreadsheet'],
  [/\b(images|photos|pictures|pics|screenshots|jpe?gs|pngs)\b/, 'image'],
  [/\b(videos|movies|clips|mp4s?)\b/, 'video'],
  [/\b(audio(?: files?)?|voice memos?|mp3s?|songs|music)\b/, 'audio recording'],
  [/\b(emails|e-mails|\.?eml files?)\b/, 'email'],
  [/\b(zips?|zip files?|archives|compressed files?)\b/, 'archive'],
  [/\b(installers?|setup files?|exes|\.?exe files?|executables?|msis?)\b/, 'installer or program'],
  [/\b(source code|scripts|source files)\b/, 'source code'],
];
const KIND_LABEL = {
  'PDF document': 'PDFs', 'Word document': 'Word documents', 'presentation slides': 'slides', spreadsheet: 'spreadsheets',
  image: 'images', video: 'videos', 'audio recording': 'audio', email: 'emails', archive: 'archives',
  'installer or program': 'installers', 'source code': 'source code',
};
const KIND_ALT = KIND_WORDS.map(([re]) => re.source.replace(/^\\b|\\b$/g, '')).join('|');

// Words that carry no content once the metadata is taken out ("show me all my old files").
const FILLER = new Set(('files file stuff things items documents document docs all any every everything my me show find list get give ' +
  'the a an that which what are is were was been be i have has with of from in on for to and or ones one folder folders there by ' +
  'modified changed created downloaded saved edited opened touched used added last ago than since before after during please').split(' '));

const num = (s) => (/^\d/.test(s) ? Number(s) : NUM_WORDS[s] ?? 1);
const monthIndex = (s) => (s === 'sept' ? 8 : MONTHS.findIndex((m) => m.startsWith(s.slice(0, 3))));
const SIZE_UNIT = { b: 1, byte: 1, bytes: 1, k: 1024, kb: 1024, m: 1048576, mb: 1048576, g: 1073741824, gb: 1073741824 };

const startOfDay = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const startOfWeek = (t) => { const d = new Date(startOfDay(t)); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.getTime(); }; // Monday
const monthStart = (y, m) => new Date(y, m, 1).getTime();

/**
 * @returns {{ text: string, after: number|null, before: number|null, minSize: number|null, maxSize: number|null,
 *   kinds: string[], sort: 'oldest'|'newest'|'largest'|'smallest'|null, labels: string[] }}
 *   `after`/`before` bound lastModified (after inclusive, before exclusive).
 */
export function parseQuery(query, now = Date.now()) {
  let q = ` ${String(query).toLowerCase().replace(/[“”"?!,]/g, ' ').replace(/\s+/g, ' ').trim()} `;
  const out = { text: '', after: null, before: null, minSize: null, maxSize: null, kinds: [], sort: null, labels: [] };
  const take = (re, fn) => { q = q.replace(re, (...m) => { fn(...m); return ' '; }); };
  const narrow = (after, before) => {
    if (after != null) out.after = Math.max(out.after ?? -Infinity, after);
    if (before != null) out.before = Math.min(out.before ?? Infinity, before);
  };
  const today = startOfDay(now);
  const y = new Date(now).getFullYear();
  const mo = new Date(now).getMonth();

  // Age relative to today. "older than 2 years", "not touched in 6 months", "over a year old".
  take(new RegExp(`\\b(?:older than|more than|over|at least)\\s+(?:a\\s+)?${N}?\\s*${UNIT}\\s+old\\b`, 'g'), (_, n, u) => { narrow(null, now - num(n ?? '1') * UNIT_MS[u]); out.labels.push(`older than ${n ?? 1} ${u}${num(n ?? '1') > 1 ? 's' : ''}`); });
  take(new RegExp(`\\bolder than\\s+${N}\\s+${UNIT}\\b`, 'g'), (_, n, u) => { narrow(null, now - num(n) * UNIT_MS[u]); out.labels.push(`older than ${n} ${u}${num(n) > 1 ? 's' : ''}`); });
  take(new RegExp(`\\b(?:not|never|haven'?t been|hasn'?t been)\\s+(?:been\\s+)?(?:touched|modified|changed|opened|edited|used|updated)\\s+(?:in|for)\\s+(?:(?:the\\s+)?(?:last|past)\\s+)?(?:over\\s+)?${N}\\s+${UNIT}\\b`, 'g'), (_, n, u) => { narrow(null, now - num(n) * UNIT_MS[u]); out.labels.push(`untouched for ${n} ${u}${num(n) > 1 ? 's' : ''}`); });
  take(new RegExp(`\\b${N}\\s+${UNIT}\\s+(?:ago|old)\\b`, 'g'), (_, n, u) => { narrow(null, now - num(n) * UNIT_MS[u]); out.labels.push(`older than ${n} ${u}${num(n) > 1 ? 's' : ''}`); });
  take(new RegExp(`\\b(?:(?:in|from|during|within|over)\\s+)?(?:the\\s+)?(?:last|past)\\s+${N}\\s+${UNIT}\\b`, 'g'), (_, n, u) => { narrow(now - num(n) * UNIT_MS[u], null); out.labels.push(`last ${n} ${u}${num(n) > 1 ? 's' : ''}`); });

  take(new RegExp(`\\b(?:(?:in|over|within|during|from)\\s+)?(?:the\\s+)?past\\s+${UNIT}\\b|\\b(?:in|over|within|during)\\s+the\\s+last\\s+${UNIT}\\b`, 'g'), (_, u1, u2) => { const u = u1 ?? u2; narrow(now - UNIT_MS[u], null); out.labels.push(`past ${u}`); });

  // Calendar periods.
  const periods = [
    ['today', () => [today, null]],
    ['yesterday', () => [today - DAY, today]],
    ['this week', () => [startOfWeek(now), null]],
    ['last week', () => [startOfWeek(now) - 7 * DAY, startOfWeek(now)]],
    ['this month', () => [monthStart(y, mo), null]],
    ['last month', () => [monthStart(y, mo - 1), monthStart(y, mo)]],
    ['this year', () => [monthStart(y, 0), null]],
    ['last year', () => [monthStart(y - 1, 0), monthStart(y, 0)]],
  ];
  for (const [p, range] of periods) {
    take(new RegExp(`\\b(?:(?:from|in|during|since|of)\\s+)?${p}(?:'s)?\\b`, 'g'), () => { narrow(...range()); out.labels.push(p); });
  }

  // Absolute dates: "before 2022", "after March 2023", "from 2021", "in june 2024".
  const span = (m, yr) => (m == null ? [monthStart(+yr, 0), monthStart(+yr + 1, 0)] : [monthStart(+yr, monthIndex(m)), monthStart(+yr, monthIndex(m) + 1)]);
  const label = (m, yr) => (m ? `${MONTHS[monthIndex(m)].replace(/^./, (c) => c.toUpperCase())} ${yr}` : yr);
  take(new RegExp(`\\b(?:before|until|prior to|earlier than|older than)\\s+(?:${MONTH_RE}\\s+)?((?:19|20)\\d\\d)\\b`, 'g'), (_, m, yr) => { narrow(null, span(m, yr)[0]); out.labels.push(`before ${label(m, yr)}`); });
  take(new RegExp(`\\b(?:after|since|newer than|later than)\\s+(?:${MONTH_RE}\\s+)?((?:19|20)\\d\\d)\\b`, 'g'), (_, m, yr) => { const [a, b] = span(m, yr); narrow(/since/.test(_) ? a : b, null); out.labels.push(`${/since/.test(_) ? 'since' : 'after'} ${label(m, yr)}`); });
  take(new RegExp(`\\b(?:from|in|during|dated|of)\\s+(?:${MONTH_RE}\\s+)?((?:19|20)\\d\\d)\\b`, 'g'), (_, m, yr) => { narrow(...span(m, yr)); out.labels.push(`in ${label(m, yr)}`); });

  // Size.
  const SZ = '(\\d+(?:\\.\\d+)?)\\s*(kb|mb|gb|k|m|g|bytes?|b)\\b';
  take(new RegExp(`(?:\\b(?:over|above|more than|bigger than|larger than|greater than|at least)\\s+|>\\s*)${SZ}`, 'g'), (_, n, u) => { out.minSize = Number(n) * SIZE_UNIT[u]; out.labels.push(`over ${n} ${u.toUpperCase()}`); });
  take(new RegExp(`(?:\\b(?:under|below|less than|smaller than|at most)\\s+|<\\s*)${SZ}`, 'g'), (_, n, u) => { out.maxSize = Number(n) * SIZE_UNIT[u]; out.labels.push(`under ${n} ${u.toUpperCase()}`); });

  // Ordering words. Superlatives always count; "big"/"small" only next to a file word, so
  // "small business plan" is still a content query.
  const FILEWORD = `(?:files?|ones|stuff|downloads?|${KIND_ALT})\\b`;
  const ORDER = [
    [String.raw`\b(?:oldest|old|older|ancient|stale|outdated|forgotten|earliest)\b`, 'oldest'],
    [String.raw`\b(?:newest|latest|most recent|recently(?: (?:added|downloaded|modified|changed|saved|edited))?|recent)\b|\bnew\b(?= ${FILEWORD})`, 'newest'],
    [String.raw`\b(?:largest|biggest|heaviest|huge|massive)\b|\b(?:large|big|heavy)\b(?= ${FILEWORD})`, 'largest'],
    [String.raw`\b(?:smallest|tiniest|tiny)\b|\b(?:small|little)\b(?= ${FILEWORD})`, 'smallest'],
  ].map(([src, sort]) => [new RegExp(src, 'g'), sort]);
  for (const [re, sort] of ORDER) take(re, () => { out.sort ??= sort; });
  // File types.
  for (const [re, kind] of KIND_WORDS) {
    take(new RegExp(re.source, 'g'), () => { if (!out.kinds.includes(kind)) out.kinds.push(kind); });
  }

  if (out.sort) out.labels.unshift({ oldest: 'oldest first', newest: 'newest first', largest: 'largest first', smallest: 'smallest first' }[out.sort]);
  if (out.kinds.length) out.labels.push(out.kinds.map((k) => KIND_LABEL[k] ?? k).join(' or '));

  const words = q.trim().split(/\s+/).filter(Boolean);
  // Nothing taken out: the model gets the query exactly as typed; trimming would only change its meaning.
  if (!hasMeta(out)) out.text = String(query).trim();
  else out.text = words.some((w) => !FILLER.has(w)) ? trimFiller(words).join(' ') : '';
  if (out.after != null && out.before != null && out.after >= out.before) out.labels.push('(no date can match both)');
  return out;
}

function trimFiller(words) {
  let a = 0;
  let b = words.length;
  while (a < b && FILLER.has(words[a])) a++;
  while (b > a && FILLER.has(words[b - 1])) b--;
  return words.slice(a, b);
}

/** Whether the query asks for anything besides content. */
export function hasMeta(p) {
  return p.sort != null || p.after != null || p.before != null || p.minSize != null || p.maxSize != null || p.kinds.length > 0;
}

export function matchesMeta(p, f) {
  if (p.after != null && !(f.lastModified >= p.after)) return false;
  if (p.before != null && !(f.lastModified < p.before)) return false;
  if (p.minSize != null && !(f.size >= p.minSize)) return false;
  if (p.maxSize != null && !(f.size <= p.maxSize)) return false;
  if (p.kinds.length && !p.kinds.includes(kindOf(f.ext))) return false;
  return true;
}

const ORDER_BY = {
  oldest: (a, b) => a.lastModified - b.lastModified,
  newest: (a, b) => b.lastModified - a.lastModified,
  largest: (a, b) => b.size - a.size,
  smallest: (a, b) => a.size - b.size,
};

// Among results this close to the best semantic match, metadata decides the order.
export const RELEVANCE_WINDOW = 0.05;

/**
 * Combine metadata with semantic scores.
 * @param p parsed query
 * @param files the live listing (files only): source of size and lastModified
 * @param scored null for a metadata-only query, else [{path, score, ...entry}] from the model
 */
export function combine(p, files, scored, k = 25) {
  const meta = new Map(files.map((f) => [f.path, f]));
  if (!scored) {
    // With only an upper date bound ("older than 2 years") the oldest are the point; otherwise newest first.
    const order = ORDER_BY[p.sort ?? (p.before != null && p.after == null ? 'oldest' : 'newest')];
    return files.filter((f) => matchesMeta(p, f)).sort(order).slice(0, k)
      .map((f) => ({ path: f.path, name: f.name, ext: f.ext, size: f.size, lastModified: f.lastModified, score: null }));
  }
  const hits = scored
    .filter((e) => meta.has(e.path))
    .map((e) => ({ ...e, size: meta.get(e.path).size, lastModified: meta.get(e.path).lastModified }))
    .filter((e) => matchesMeta(p, e))
    .sort((a, b) => b.score - a.score);
  if (!p.sort || !hits.length) return hits.slice(0, k);
  const best = hits[0].score;
  const near = hits.filter((e) => e.score >= best - RELEVANCE_WINDOW).sort(ORDER_BY[p.sort]);
  return [...near, ...hits.slice(near.length)].slice(0, k);
}
