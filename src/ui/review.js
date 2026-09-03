import { h, diffName, plural } from './dom.js';
import * as fs from '../fs/index.js';
import { refreshListing } from './connect.js';

let cursor = 0;

export function renderReview(root, store) {
  const state = store.get();
  const plan = state.plan;
  if (!plan || !state.folder) { store.set({ screen: 'work' }); return; }
  const rows = [
    ...plan.accepted.map((op, i) => ({ kind: 'op', op, i })),
    ...plan.rejected.map((r) => ({ kind: 'invalid', op: r.op, reason: r.reason })),
  ];
  const accepted = plan.accepted.filter((_, i) => plan.decisions[i]);
  if (cursor >= rows.length) cursor = Math.max(0, rows.length - 1);

  let confirming = false;
  let applying = false;

  const tbody = h('tbody');
  const trs = [];
  rows.forEach((row, ri) => {
    const on = row.kind === 'op' && plan.decisions[row.i];
    const cls = row.kind === 'invalid' ? 'invalid' : on ? 'changed' : 'rejected';
    const op = row.op;
    const from = op.type === 'create_folder' ? '' : op.from ?? '';
    const to = op.to ?? '';
    const tr = h('tr', { class: `${cls} ${ri === cursor ? 'cursor' : ''}`, onclick: () => { cursor = ri; if (row.kind === 'op') toggle(row.i); else store.set({}); } },
      h('td', { class: 'mark' }, row.kind === 'invalid' ? '!' : on ? '✓' : '–'),
      h('td', { class: 'path', title: from }, op.type === 'create_folder' ? h('span', { class: 'muted' }, 'new folder') : from),
      h('td', { class: 'arrow' }, '→'),
      h('td', { class: 'path to', title: to }, row.kind === 'invalid' || !from ? to : diffName(from, to)),
      h('td', { class: 'reason' }, row.kind === 'invalid' ? row.reason : (op.reason ?? '')),
    );
    trs.push(tr);
    tbody.append(tr);
  });

  function toggle(i) {
    const decisions = { ...plan.decisions, [i]: !plan.decisions[i] };
    store.set({ plan: { ...plan, decisions } });
  }

  const table = h('table', { class: 'files review' },
    h('thead', null, h('tr', null, h('th', { class: 'mark' }), h('th', { class: 'path' }, 'From'), h('th', { class: 'arrow' }), h('th', { class: 'path' }, 'To'), h('th', null, 'Reason'))),
    tbody,
  );
  const wrap = h('div', { class: 'tablewrap', tabIndex: 0 }, rows.length ? table : h('div', { class: 'empty' }, 'Nothing to review. Every proposed change was a no-op.'));

  const status = h('span', { class: 'muted' });
  const progress = h('div', { class: 'progress', hidden: true }, h('div', { style: { width: '0%' } }));
  const err = h('div', { class: 'note warn', hidden: true });

  const applyBtn = h('button', { class: 'primary', disabled: !accepted.length }, `Apply ${plural(accepted.length, 'change')}`);
  const confirmBtn = h('button', { class: 'primary danger', hidden: true }, `Confirm: write ${plural(accepted.length, 'change')} to ${state.folder.name}`);
  const cancelBtn = h('button', { hidden: true }, 'Cancel');
  const backBtn = h('button', { onclick: () => store.set({ screen: 'work' }) }, '← Back');

  applyBtn.addEventListener('click', () => { confirming = true; applyBtn.hidden = true; confirmBtn.hidden = false; cancelBtn.hidden = false; confirmBtn.focus(); });
  cancelBtn.addEventListener('click', () => { confirming = false; applyBtn.hidden = false; confirmBtn.hidden = true; cancelBtn.hidden = true; });
  confirmBtn.addEventListener('click', apply);

  async function apply() {
    if (applying) return;
    applying = true;
    confirmBtn.disabled = true; cancelBtn.disabled = true; backBtn.disabled = true;
    progress.hidden = false;
    const ops = accepted;
    const ctrl = new AbortController();
    try {
      const result = await fs.applyPlan(state.folder.handle, ops, {
        label: plan.title,
        signal: ctrl.signal,
        onProgress: (done, total, r) => {
          progress.firstChild.style.width = `${(done / total) * 100}%`;
          status.textContent = `${done} / ${total} · ${r.ok ? r.op.to : 'failed'}`;
        },
      });
      await refreshListing(store);
      store.set({ result: { ...result, ops, title: plan.title, folder: state.folder.name }, screen: 'result', plan: null });
    } catch (e) {
      err.hidden = false; err.textContent = `Apply failed: ${e.message}`;
      applying = false; confirmBtn.disabled = false; cancelBtn.disabled = false; backBtn.disabled = false;
    }
  }

  root.append(
    h('div', { class: 'toolbar' },
      h('b', null, plan.title),
      h('span', { class: 'muted' }, `${accepted.length} to apply · ${plan.accepted.length - accepted.length} skipped · ${plan.rejected.length} invalid · ${plan.dropped.length} unchanged`),
      h('span', { class: 'spacer' }),
      h('span', { class: 'legend' },
        h('span', null, h('i', { style: { background: 'var(--changed-bg)' } }), 'will change'),
        h('span', null, h('i', { style: { background: 'var(--rejected-bg)' } }), 'skipped'),
        h('span', null, h('i', { style: { background: 'var(--invalid-bg)' } }), 'invalid'),
      ),
      h('span', { class: 'muted' }, h('kbd', null, 'j'), ' ', h('kbd', null, 'k'), ' move · ', h('kbd', null, 'x'), ' toggle · ', h('kbd', null, 'Enter'), ' apply'),
    ),
    wrap,
    err,
    h('div', { class: 'footer-actions' }, backBtn, h('span', { class: 'spacer' }), status, progress, cancelBtn, applyBtn, confirmBtn),
  );

  wrap.focus({ preventScroll: true });
  trs[cursor]?.scrollIntoView({ block: 'nearest' });

  function onKey(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'j' || e.key === 'ArrowDown') { cursor = Math.min(rows.length - 1, cursor + 1); e.preventDefault(); repaintCursor(); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { cursor = Math.max(0, cursor - 1); e.preventDefault(); repaintCursor(); }
    else if (e.key === 'x' || e.key === ' ') { const row = rows[cursor]; if (row?.kind === 'op') toggle(row.i); e.preventDefault(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (!applying && accepted.length) { if (!confirming) applyBtn.click(); else apply(); } }
    else if (e.key === 'Escape') { if (confirming) cancelBtn.click(); else store.set({ screen: 'work' }); }
  }
  function repaintCursor() {
    trs.forEach((tr, i) => tr.classList.toggle('cursor', i === cursor));
    trs[cursor]?.scrollIntoView({ block: 'nearest' });
  }
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}
