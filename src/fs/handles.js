// IndexedDB persistence for directory handles. Keyed by a user-facing label (id).

const DB_NAME = 'sift';
const DB_VERSION = 1;
const STORE = 'dirs';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const req = fn(store);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export async function saveDirectory(id, handle, extra = {}) {
  const db = await openDb();
  const record = { id, name: handle.name, handle, lastUsed: Date.now(), ...extra };
  await tx(db, 'readwrite', (s) => s.put(record));
  db.close();
  return record;
}

export async function getDirectory(id) {
  const db = await openDb();
  const rec = await tx(db, 'readonly', (s) => s.get(id));
  db.close();
  return rec ?? null;
}

export async function listDirectories() {
  const db = await openDb();
  const all = await tx(db, 'readonly', (s) => s.getAll());
  db.close();
  return (all ?? []).sort((a, b) => b.lastUsed - a.lastUsed);
}

export async function removeDirectory(id) {
  const db = await openDb();
  await tx(db, 'readwrite', (s) => s.delete(id));
  db.close();
}

export async function touchDirectory(id) {
  const rec = await getDirectory(id);
  if (rec) await saveDirectory(id, rec.handle, { lastUsed: Date.now() });
}
