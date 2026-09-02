// Rule-based renaming. No model involved. Each rule maps { stem, ext, ctx } -> { stem, ext }.

import { splitExt, joinPath } from '../util/names.js';
import { naturalCompare } from '../fs/index.js';

export const RULE_DEFS = {
  regex: {
    label: 'Regex replace',
    fields: [
      { key: 'pattern', label: 'Pattern', type: 'text', placeholder: '^(\\d+)[-_ ]' },
      { key: 'flags', label: 'Flags', type: 'text', placeholder: 'gi', default: 'g' },
      { key: 'replacement', label: 'Replacement', type: 'text', placeholder: '$1 ' },
      { key: 'target', label: 'Apply to', type: 'select', options: ['stem', 'name'], default: 'stem' },
    ],
  },
  replace: {
    label: 'Find and replace',
    fields: [
      { key: 'find', label: 'Find', type: 'text' },
      { key: 'replacement', label: 'Replace with', type: 'text' },
      { key: 'ignoreCase', label: 'Ignore case', type: 'checkbox', default: true },
    ],
  },
  case: {
    label: 'Change case',
    fields: [
      { key: 'mode', label: 'Mode', type: 'select', options: ['lower', 'upper', 'title', 'sentence', 'kebab', 'snake'], default: 'lower' },
      { key: 'extToo', label: 'Extension too', type: 'checkbox', default: false },
    ],
  },
  whitespace: {
    label: 'Tidy whitespace',
    fields: [
      { key: 'separator', label: 'Replace _ and - with space', type: 'checkbox', default: false },
    ],
  },
  sequence: {
    label: 'Sequence number',
    fields: [
      { key: 'start', label: 'Start at', type: 'number', default: 1 },
      { key: 'pad', label: 'Digits', type: 'number', default: 3 },
      { key: 'template', label: 'Template', type: 'text', default: '{n} {stem}', placeholder: '{n} {stem}' },
      { key: 'sortBy', label: 'Order by', type: 'select', options: ['name', 'modified'], default: 'name' },
    ],
  },
  datePrefix: {
    label: 'Date prefix',
    fields: [
      { key: 'source', label: 'Date from', type: 'select', options: ['exif-or-modified', 'modified'], default: 'exif-or-modified' },
      { key: 'format', label: 'Format', type: 'select', options: ['YYYY-MM-DD', 'YYYYMMDD', 'YYYY-MM'], default: 'YYYY-MM-DD' },
      { key: 'separator', label: 'Separator', type: 'text', default: ' ' },
    ],
  },
  prefixSuffix: {
    label: 'Prefix / suffix',
    fields: [
      { key: 'prefix', label: 'Prefix', type: 'text' },
      { key: 'suffix', label: 'Suffix', type: 'text' },
    ],
  },
};

export function defaultRule(type) {
  const def = RULE_DEFS[type];
  const rule = { type };
  for (const f of def.fields) rule[f.key] = f.default ?? (f.type === 'checkbox' ? false : '');
  return rule;
}

function toTitle(s) {
  return s.toLowerCase().replace(/(^|[\s\-_(\[])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
}
function toSentence(s) {
  const t = s.toLowerCase();
  return t.replace(/^\s*(\p{L})/u, (m) => m.toUpperCase());
}
function words(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s\-_]+/).filter(Boolean);
}

function formatDate(ts, format) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  if (format === 'YYYYMMDD') return `${y}${m}${day}`;
  if (format === 'YYYY-MM') return `${y}-${m}`;
  return `${y}-${m}-${day}`;
}

/** Apply one rule to one name. ctx: { index, file, enrichment } */
export function applyRule(rule, { stem, ext }, ctx) {
  switch (rule.type) {
    case 'regex': {
      if (!rule.pattern) return { stem, ext };
      const re = new RegExp(rule.pattern, rule.flags ?? 'g');
      if (rule.target === 'name') {
        const full = (stem + ext).replace(re, rule.replacement ?? '');
        return splitExt(full);
      }
      return { stem: stem.replace(re, rule.replacement ?? ''), ext };
    }
    case 'replace': {
      if (!rule.find) return { stem, ext };
      const esc = rule.find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(esc, rule.ignoreCase ? 'gi' : 'g');
      return { stem: stem.replace(re, rule.replacement ?? ''), ext };
    }
    case 'case': {
      const f = {
        lower: (s) => s.toLowerCase(),
        upper: (s) => s.toUpperCase(),
        title: toTitle,
        sentence: toSentence,
        kebab: (s) => words(s).join('-').toLowerCase(),
        snake: (s) => words(s).join('_').toLowerCase(),
      }[rule.mode] ?? ((s) => s);
      return { stem: f(stem), ext: rule.extToo ? ext.toLowerCase() : ext };
    }
    case 'whitespace': {
      let s = stem;
      if (rule.separator) s = s.replace(/[_-]+/g, ' ');
      s = s.replace(/\s+/g, ' ').trim();
      return { stem: s, ext };
    }
    case 'sequence': {
      const n = String((Number(rule.start) || 0) + ctx.seq).padStart(Number(rule.pad) || 0, '0');
      const t = rule.template || '{n} {stem}';
      return { stem: t.replace('{n}', n).replace('{stem}', stem), ext };
    }
    case 'datePrefix': {
      const en = ctx.enrichment ?? {};
      const ts = (rule.source !== 'modified' && en.exifDate) ? en.exifDate : ctx.file.lastModified;
      const date = formatDate(ts, rule.format);
      const sep = rule.separator ?? ' ';
      if (stem.startsWith(date)) return { stem, ext };
      return { stem: `${date}${sep}${stem}`, ext };
    }
    case 'prefixSuffix':
      return { stem: `${rule.prefix ?? ''}${stem}${rule.suffix ?? ''}`, ext };
    default:
      return { stem, ext };
  }
}

/**
 * Apply a rule chain to a set of files. Returns proposed ops (unvalidated).
 * @param {Array} rules
 * @param {Array} files       FileMeta[] (files only)
 * @param {Object} options    { enrichment: Map<path, {...}> }
 */
export function applyRules(rules, files, { enrichment } = {}) {
  const seqRule = rules.find((r) => r.type === 'sequence');
  const ordered = [...files];
  if (seqRule?.sortBy === 'modified') ordered.sort((a, b) => a.lastModified - b.lastModified || naturalCompare(a.path, b.path));
  else ordered.sort((a, b) => naturalCompare(a.path, b.path));

  const ops = [];
  ordered.forEach((file, seq) => {
    let cur = splitExt(file.name);
    const ctx = { seq, file, enrichment: enrichment?.get?.(file.path) };
    for (const rule of rules) cur = applyRule(rule, cur, ctx);
    const to = joinPath(file.dir, cur.stem + cur.ext);
    if (to !== file.path) ops.push({ type: 'rename', from: file.path, to, reason: describeRules(rules) });
  });
  return ops;
}

export function describeRules(rules) {
  return rules.map((r) => RULE_DEFS[r.type]?.label ?? r.type).join(' → ');
}
