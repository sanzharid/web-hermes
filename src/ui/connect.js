import { h, plural, fmtDate } from './dom.js';
import * as fs from '../fs/index.js';
import { saveSettings } from '../settings.js';

export async function openFolder(store, id, handle) {
  const listing = await fs.listEntries(handle, { recursive: store.get().recursive });
  store.set({ folder: { id, handle, name: handle.name }, listing, selection: null, plan: null, result: null, screen: 'work', notice: null });
  await fs.rememberDirectory(id, handle);
  const settings = saveSettings({ ...store.get().settings, lastFolderId: id });
  store.set({ settings });
}

export async function refreshListing(store) {
  const { folder, recursive } = store.get();
  if (!folder) return;
  const listing = await fs.listEntries(folder.handle, { recursive });
  store.set({ listing });
}

export function renderConnect(root, store) {
  const state = store.get();
  const box = h('div', { class: 'connect' });
  root.append(h('div', { class: 'center' }, box));

  if (!fs.isSupported()) {
    box.append(
      h('h1', null, 'This browser cannot open folders.'),
      h('p', { class: 'lead' }, 'Sift needs the File System Access API. Use Chrome or Edge on desktop.'),
    );
    return;
  }

  const err = h('div', { class: 'note warn', hidden: true });
  const pick = h('button', { class: 'primary', onclick: async () => {
    try {
      const handle = await fs.pickDirectory();
      await openFolder(store, handle.name, handle);
    } catch (e) {
      if (e?.name === 'AbortError') return;
      err.hidden = false; err.textContent = `Could not open folder: ${e.message}`;
    }
  } }, 'Pick a folder');

  box.append(
    h('h1', null, state.folder ? 'Switch folder' : 'No folder connected.'),
    h('p', { class: 'lead' }, 'Pick one to start. Nothing is written until you confirm a reviewed batch.'),
    h('div', { class: 'row' }, pick),
    err,
  );

  const list = h('div', { class: 'remembered' });
  fs.listDirectories().then((records) => {
    if (!records.length) return;
    box.append(h('h2', { class: 'muted', style: { fontSize: '12px', textTransform: 'uppercase', letterSpacing: '.04em', marginTop: '24px' } }, 'Remembered folders'), list);
    for (const rec of records) {
      const item = h('div', { class: 'item' });
      const meta = h('span', { class: 'meta' }, `last used ${fmtDate(rec.lastUsed)}`);
      fs.queryPermission(rec.handle).then((p) => { meta.textContent = `${p === 'granted' ? 'access granted' : 'needs reconnect'} · last used ${fmtDate(rec.lastUsed)}`; });
      const reconnect = h('button', { onclick: async () => {
        try {
          let p = await fs.queryPermission(rec.handle);
          if (p !== 'granted') p = await fs.requestPermission(rec.handle); // inside the click handler
          if (p !== 'granted') { err.hidden = false; err.textContent = 'Access was not granted. Pick the folder again to reconnect.'; return; }
          await openFolder(store, rec.id, rec.handle);
        } catch (e) {
          err.hidden = false; err.textContent = `Could not reconnect: ${e.message}. The folder may have moved; pick it again.`;
        }
      } }, 'Reconnect');
      const forget = h('button', { class: 'small', onclick: async () => { await fs.removeDirectory(rec.id); item.remove(); } }, 'Forget');
      item.append(h('div', null, h('div', { class: 'name' }, rec.name), meta), reconnect, forget);
      list.append(item);
    }
  });
}
