// Semantic search: the primary surface. Describe what a file is about; the model finds it by
// meaning rather than by name.
import { h, plural, fmtBytes } from './dom.js';
import { EMBED_MODEL } from '../runtime/embedder.js';
import { buildIndex, cancelBuild, runSearch, staleCount, loadModel } from '../search/controller.js';

let draft = '';

const MB = (n) => `${Math.round((n ?? 0) / 1048576)} MB`;
const section = (t) => h('h2', { class: 'muted', style: { fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.04em', margin: '16px 0 6px' } }, t);

export function renderSearch(main, store) {
  const state = store.get();
  const s = state.search;
  const files = state.listing.filter((f) => f.kind === 'file');
  const stale = staleCount(store);
  const building = !!s.build;

  main.append(h('div', { class: 'toolbar' },
    h('b', null, 'Search'),
    h('span', { class: 'muted' }, indexLine(s, files.length, stale)),
    h('span', { class: 'spacer' }),
    building ? h('button', { class: 'small', onclick: () => cancelBuild() }, 'Stop indexing') : null,
    !building && s.model === 'ready' && stale ? h('button', { class: 'small', onclick: () => buildIndex(store).catch(() => {}) }, s.indexed ? `Update index (${stale})` : 'Index this folder') : null,
  ));

  const body = h('div', { class: 'tablewrap', style: { padding: '12px 16px' } });
  main.append(body);

  if (s.model !== 'ready') {
    const loading = s.model === 'loading';
    const pct = s.progress?.total ? (s.progress.loaded / s.progress.total) * 100 : 0;
    body.append(h('div', { class: 'note' },
      h('b', null, 'Semantic search needs a model, downloaded once. '),
      `${EMBED_MODEL.name}, ${MB(EMBED_MODEL.bytes)}, runs on this machine; nothing about your files leaves it.`,
      loading
        ? h('div', null, h('div', { class: 'progress' }, h('div', { style: { width: `${pct}%` } })), h('span', { class: 'muted' }, `${MB(s.progress?.loaded)} / ${MB(s.progress?.total)}`))
        : h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => loadModel(store).then(() => { if (staleCount(store)) buildIndex(store).catch(() => {}); }).catch(() => {}) }, `Download & load (${MB(EMBED_MODEL.bytes)})`)),
    ));
    if (s.error) body.append(h('div', { class: 'note warn' }, s.error));
  }

  if (building) {
    const b = s.build;
    const pct = b.total ? (b.done / b.total) * 100 : 0;
    const rate = b.ms && b.done ? b.ms / b.done : null;
    const eta = rate ? Math.round(((b.total - b.done) * rate) / 1000) : null;
    body.append(h('div', { class: 'note' },
      h('b', null, `Indexing ${b.done} of ${b.total}`), b.skipped ? ` · ${b.skipped} already indexed` : '',
      eta != null ? ` · about ${eta >= 90 ? `${Math.round(eta / 60)} min` : `${eta} s`} left` : '',
      h('div', { class: 'progress' }, h('div', { style: { width: `${pct}%` } })),
      h('span', { class: 'muted' }, 'Search works on what is indexed so far. Progress is saved; stopping loses nothing.'),
    ));
  }

  const input = h('input', {
    type: 'text', class: 'mono', value: draft || s.query,
    placeholder: 'e.g. the contract with the cleaning company, or notes from the budget meeting',
    oninput: (e) => { draft = e.target.value; },
    onkeydown: (e) => { if (e.key === 'Enter') go(); },
  });
  const btn = h('button', { class: 'primary', disabled: s.model !== 'ready' || !s.indexed || !!s.searching, onclick: () => go() }, 'Find');
  function go() {
    const q = (draft || input.value).trim();
    if (q) runSearch(store, q).catch((e) => store.set({ search: { ...store.get().search, error: e.message } }));
  }
  body.append(section('Describe what you are looking for'), h('div', { style: { display: 'flex', gap: '8px' } }, input, btn));
  if (!s.indexed && s.model === 'ready' && !building) body.append(h('p', { class: 'muted' }, files.length ? 'Index the folder first: each file is read once and remembered.' : 'This folder has no files.'));

  if (s.searching) body.append(h('p', { class: 'muted' }, `Searching for “${s.searching}”…`));
  if (s.results) renderResults(body, store, s, files);
  setTimeout(() => input.focus({ preventScroll: true }), 0);
}

function indexLine(s, nFiles, stale) {
  if (!s.indexed && !s.build) return `${plural(nFiles, 'file')}, not indexed`;
  const parts = [`${s.indexed} of ${plural(nFiles, 'file')} indexed`];
  if (stale && !s.build) parts.push(`${stale} new or changed`);
  if (s.lastBuild?.tokens && s.lastBuild.ms) parts.push(`${Math.round(s.lastBuild.tokens / (s.lastBuild.ms / 1000))} tok/s`);
  return parts.join(' · ');
}

function renderResults(body, store, s, files) {
  const byPath = new Map(files.map((f) => [f.path, f]));
  body.append(section(`Results for “${s.query}”${s.ms != null ? ` · ${s.ms} ms` : ''}`));
  if (!s.results.length) { body.append(h('p', { class: 'muted' }, 'Nothing indexed yet.')); return; }
  const top = s.results[0].score;
  const list = h('div', { style: { opacity: s.searching ? '0.45' : '1' } });
  for (const r of s.results) {
    const f = byPath.get(r.path);
    // Scores are relative: bar length is against the best match, so the gap between results reads at a glance.
    const rel = Math.max(0, Math.min(1, (r.score - (top - 0.25)) / 0.25));
    list.append(h('div', { class: 'result', title: `cosine ${r.score.toFixed(3)}` },
      h('div', { class: 'result-head' },
        h('span', { class: 'bar' }, h('i', { style: { width: `${Math.round(rel * 100)}%` } })),
        h('span', { class: 'mono name' }, r.path),
        r.hasText ? null : h('span', { class: 'tag' }, 'name only'),
        h('span', { class: 'muted num' }, f ? fmtBytes(f.size) : 'missing'),
      ),
      r.snippet ? h('div', { class: 'snippet' }, r.snippet) : null,
    ));
  }
  body.append(list);
  const n = Math.min(10, s.results.length);
  body.append(h('div', { class: 'row' },
    h('button', { onclick: () => store.set({ selection: new Set(s.results.slice(0, n).map((r) => r.path).filter((p) => byPath.has(p))), sideTab: 'files' }) }, `Select top ${n} in Files`),
    h('span', { class: 'muted' }, 'then rename or move them with Rules or Rename. Files marked “name only” were matched on their name and metadata, not their contents.'),
  ));
}
