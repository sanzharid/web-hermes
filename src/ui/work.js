import { h, fmtBytes, fmtDate, plural } from './dom.js';
import { refreshListing } from './connect.js';
import { RULE_DEFS, defaultRule, applyRules } from '../plan/rules.js';
import { openPlan } from '../plan/build.js';
import { enrichFiles } from '../plan/enrich.js';
import { renderModelPanel } from './modelpanel.js';

let tab = 'rules';

export function selectedFiles(state) {
  const files = state.listing.filter((f) => f.kind === 'file');
  if (!state.selection) return files;
  return files.filter((f) => state.selection.has(f.path));
}

export function renderWork(root, store) {
  const state = store.get();
  if (!state.folder) { store.set({ screen: 'connect' }); return; }
  const files = state.listing.filter((f) => f.kind === 'file');
  const selected = selectedFiles(state);

  const left = h('div', { class: 'left' });
  const right = h('div', { class: 'right panel' });
  root.append(h('div', { class: 'split' }, left, right));

  // ---- toolbar ----
  const recursive = h('input', { type: 'checkbox', checked: state.recursive, onchange: async (e) => {
    store.set({ recursive: e.target.checked, selection: null });
    await refreshListing(store);
  } });
  left.append(h('div', { class: 'toolbar' },
    h('span', null, `${plural(files.length, 'file')}, ${selected.length} selected`),
    h('span', { class: 'spacer' }),
    h('label', null, recursive, ' include subfolders (one level)'),
    h('button', { class: 'small', onclick: () => store.set({ selection: null }) }, 'All'),
    h('button', { class: 'small', onclick: () => store.set({ selection: new Set() }) }, 'None'),
    h('button', { class: 'small', onclick: () => refreshListing(store) }, 'Refresh'),
  ));

  // ---- table ----
  if (!state.listing.length) {
    left.append(h('div', { class: 'empty' }, 'This folder is empty. Pick another one, or add files and refresh.'));
  } else {
    const tbody = h('tbody');
    for (const f of state.listing) {
      const isSel = f.kind === 'file' && (!state.selection || state.selection.has(f.path));
      const cb = f.kind === 'file' ? h('input', { type: 'checkbox', checked: isSel, onchange: (e) => {
        const sel = new Set(state.selection ?? files.map((x) => x.path));
        if (e.target.checked) sel.add(f.path); else sel.delete(f.path);
        store.set({ selection: sel.size === files.length ? null : sel });
      } }) : null;
      tbody.append(h('tr', { class: `${f.kind === 'directory' ? 'dir' : ''} ${isSel ? 'selected' : ''}` },
        h('td', { class: 'check' }, cb),
        h('td', { class: 'name', title: f.path }, f.kind === 'directory' ? `${f.path}/` : f.path),
        h('td', { class: 'num' }, f.kind === 'file' ? fmtBytes(f.size) : ''),
        h('td', { class: 'num' }, f.kind === 'file' ? fmtDate(f.lastModified) : ''),
        h('td', { class: 'num' }, f.ext),
      ));
    }
    left.append(h('div', { class: 'tablewrap' }, h('table', { class: 'files' },
      h('thead', null, h('tr', null, h('th', { class: 'check' }), h('th', null, 'Name'), h('th', { style: { textAlign: 'right' } }, 'Size'), h('th', { style: { textAlign: 'right' } }, 'Modified'), h('th', { style: { textAlign: 'right' } }, 'Ext'))),
      tbody,
    )));
  }

  // ---- right panel ----
  const tabs = h('div', { class: 'tabs' },
    h('button', { class: tab === 'rules' ? 'active' : '', onclick: () => { tab = 'rules'; store.set({}); } }, 'Rules'),
    h('button', { class: tab === 'model' ? 'active' : '', onclick: () => { tab = 'model'; store.set({}); } }, 'Instruction'),
  );
  right.append(tabs);
  if (tab === 'rules') renderRules(right, store, selected);
  else renderModelPanel(right, store, selected);
}

function renderRules(right, store, selected) {
  const state = store.get();
  const rules = state.rules;
  const err = h('div', { class: 'note warn', hidden: true });

  const list = h('div');
  rules.forEach((rule, idx) => {
    const def = RULE_DEFS[rule.type];
    const box = h('div', { class: 'rule' });
    box.append(h('div', { class: 'rule-head' },
      h('b', null, def.label),
      h('button', { class: 'small', disabled: idx === 0, onclick: () => move(idx, -1) }, '↑'),
      h('button', { class: 'small', disabled: idx === rules.length - 1, onclick: () => move(idx, 1) }, '↓'),
      h('button', { class: 'small', onclick: () => store.set({ rules: rules.filter((_, i) => i !== idx) }) }, '×'),
    ));
    for (const f of def.fields) {
      let input;
      const set = (v) => { const next = rules.map((r, i) => (i === idx ? { ...r, [f.key]: v } : r)); store.set({ rules: next }); };
      if (f.type === 'select') input = h('select', { onchange: (e) => set(e.target.value) }, f.options.map((o) => h('option', { value: o, selected: rule[f.key] === o }, o)));
      else if (f.type === 'checkbox') input = h('input', { type: 'checkbox', checked: !!rule[f.key], onchange: (e) => set(e.target.checked) });
      else if (f.type === 'number') input = h('input', { type: 'number', value: rule[f.key], onchange: (e) => set(Number(e.target.value)) });
      else input = h('input', { type: 'text', value: rule[f.key] ?? '', placeholder: f.placeholder ?? '', class: 'mono', onchange: (e) => set(e.target.value) });
      box.append(h('div', { class: 'field' }, h('label', null, f.label), input));
    }
    list.append(box);
  });
  function move(i, d) {
    const next = [...rules];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    store.set({ rules: next });
  }

  const add = h('select', null, h('option', { value: '' }, 'Add a rule…'), Object.entries(RULE_DEFS).map(([k, d]) => h('option', { value: k }, d.label)));
  add.addEventListener('change', () => { if (add.value) store.set({ rules: [...rules, defaultRule(add.value)] }); });

  const preview = h('button', { class: 'primary', disabled: !rules.length || !selected.length, onclick: async () => {
    err.hidden = true;
    try {
      preview.disabled = true; preview.textContent = 'Building…';
      let enrichment = state.enrichment;
      if (rules.some((r) => r.type === 'datePrefix' && r.source !== 'modified')) {
        enrichment = await enrichFiles(store, selected, { text: false });
      }
      const ops = applyRules(rules, selected, { enrichment });
      if (!ops.length) { err.hidden = false; err.textContent = 'These rules change nothing for the selected files.'; return; }
      openPlan(store, ops, { title: `Rules: ${rules.map((r) => RULE_DEFS[r.type].label).join(' → ')}`, source: 'rules' });
    } catch (e) {
      err.hidden = false; err.textContent = e.message;
    } finally {
      preview.disabled = false; preview.textContent = 'Preview changes';
    }
  } }, 'Preview changes');

  right.append(
    h('h2', null, 'Rule-based rename'),
    h('p', { class: 'muted' }, 'Rules run without the model, in order, on the selected files. Nothing is written until you review.'),
    list,
    h('div', { class: 'row' }, add),
    h('div', { class: 'row' }, preview, h('span', { class: 'muted' }, `${plural(selected.length, 'file')} selected`)),
    err,
  );
}
