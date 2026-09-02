import { h, plural } from './dom.js';
import { reverseOps, readJournal } from '../fs/journal.js';
import { openPlan } from '../plan/build.js';

export async function startUndo(store, journalName) {
  const { folder } = store.get();
  const journal = await readJournal(folder.handle, journalName);
  const { ops, skipped } = reverseOps(journal);
  openPlan(store, ops, { title: `Undo: ${journal.label || journal.createdAt}`, source: 'undo', meta: { journalName, skipped } });
}

export function renderResult(root, store) {
  const state = store.get();
  const r = state.result;
  if (!r) { store.set({ screen: 'work' }); return; }
  const failed = r.results.filter((x) => !x.ok);
  const tbody = h('tbody');
  for (const res of r.results) {
    tbody.append(h('tr', { class: res.ok ? 'applied' : 'failed' },
      h('td', { class: 'mark' }, res.ok ? '✓' : '✗'),
      h('td', { class: 'path' }, res.op.type === 'create_folder' ? h('span', { class: 'muted' }, 'new folder') : res.op.from),
      h('td', { class: 'arrow' }, '→'),
      h('td', { class: 'path to' }, res.op.to),
      h('td', { class: 'reason' }, res.ok ? (res.method === 'copy' ? 'copied (move unsupported)' : res.method ?? (res.created === false ? 'already existed' : 'created')) : res.error),
    ));
  }
  const notApplied = r.ops.length - r.results.length;
  root.append(
    h('div', { class: 'toolbar' },
      h('b', null, r.title),
      h('span', { class: r.stopped ? 'note warn' : 'note ok', style: { margin: 0, padding: '2px 8px' } },
        r.stopped ? `Stopped after ${plural(r.applied, 'change')}: ${r.error}. ${notApplied ? `${notApplied} not attempted.` : ''}` : `Applied ${plural(r.applied, 'change')}.`),
      h('span', { class: 'spacer' }),
      r.journal ? h('span', { class: 'muted mono' }, r.journal) : h('span', { class: 'muted' }, 'no journal'),
    ),
    h('div', { class: 'tablewrap' }, h('table', { class: 'files' },
      h('thead', null, h('tr', null, h('th', { class: 'mark' }), h('th', null, 'From'), h('th'), h('th', null, 'To'), h('th', null, 'Outcome'))),
      tbody,
    )),
    h('div', { class: 'footer-actions' },
      h('button', { onclick: () => store.set({ screen: 'work', result: null }) }, '← Back to files'),
      h('span', { class: 'spacer' }),
      failed.length ? h('span', { class: 'muted' }, `${plural(failed.length, 'failure')} — journal left intact`) : null,
      r.journal && r.applied > 0 ? h('button', { onclick: () => startUndo(store, r.journal) }, `Undo this batch (${plural(r.applied, 'change')})`) : null,
    ),
  );
}
