import { h, fmtDate } from './dom.js';
import { listJournals } from '../fs/journal.js';
import { startUndo } from './result.js';

export function renderJournals(root, store) {
  const state = store.get();
  if (!state.folder) { store.set({ screen: 'connect' }); return; }
  const page = h('div', { class: 'page' }, h('h1', null, 'Undo journals'), h('p', { class: 'muted' }, `Each applied batch writes a .sift-undo-<time>.json file into ${state.folder.name} before the first change. Restoring reverses the applied operations, through the review screen.`));
  root.append(page);
  const tbody = h('tbody');
  page.append(h('table', { class: 'files' }, h('thead', null, h('tr', null, h('th', null, 'Journal'), h('th', null, 'Batch'), h('th', null, 'Status'), h('th', { style: { textAlign: 'right' } }, 'Applied'), h('th'))), tbody));
  listJournals(state.folder.handle).then((js) => {
    if (!js.length) tbody.append(h('tr', null, h('td', { colspan: 5, class: 'muted' }, 'No journals in this folder. Apply a batch to create one.')));
    for (const j of js) {
      tbody.append(h('tr', null,
        h('td', { class: 'name' }, j.name),
        h('td', null, j.label || fmtDate(Date.parse(j.createdAt))),
        h('td', null, j.status),
        h('td', { class: 'num' }, `${j.applied} / ${j.total}`),
        h('td', null, j.applied > 0 ? h('button', { class: 'small', onclick: () => startUndo(store, j.name) }, 'Restore') : null),
      ));
    }
  });
}
