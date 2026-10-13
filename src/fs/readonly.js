// A read-only folder built from <input type="file" webkitdirectory>.
//
// Chrome's folder picker (showDirectoryPicker) refuses the roots of Downloads, Desktop, Documents and
// the home folder, because it grants persistent write access; folders inside them are allowed. Folder
// *upload* is not subject to that rule: it hands over read-only File objects after a confirmation.
// Search only needs to read, so this adapter makes such an upload look like a directory handle to the
// rest of the app. Every read path (listing, excerpts, indexing) works unchanged; every write is refused.

const notFound = (name) => new DOMException(`"${name}" not found`, 'NotFoundError');
const mismatch = (name) => new DOMException(`"${name}" is not of the requested kind`, 'TypeMismatchError');
const readOnly = () => new DOMException('This folder was opened read-only: renaming and moving are not available.', 'NotAllowedError');

class ReadOnlyFile {
  constructor(file) {
    this.kind = 'file';
    this.name = file.name;
    this._file = file;
  }
  async getFile() { return this._file; }
  async createWritable() { throw readOnly(); }
  async move() { throw readOnly(); }
  async isSameEntry(other) { return other === this; }
  async queryPermission({ mode } = {}) { return mode === 'readwrite' ? 'denied' : 'granted'; }
}

class ReadOnlyDir {
  constructor(name) {
    this.kind = 'directory';
    this.name = name;
    this.readOnly = true;
    this._children = new Map();
  }
  async *entries() { yield* this._children.entries(); }
  async *keys() { yield* this._children.keys(); }
  async *values() { yield* this._children.values(); }
  [Symbol.asyncIterator]() { return this.entries(); }
  async getDirectoryHandle(name, { create } = {}) {
    const c = this._children.get(name);
    if (!c) throw create ? readOnly() : notFound(name);
    if (c.kind !== 'directory') throw mismatch(name);
    return c;
  }
  async getFileHandle(name, { create } = {}) {
    const c = this._children.get(name);
    if (!c) throw create ? readOnly() : notFound(name);
    if (c.kind !== 'file') throw mismatch(name);
    return c;
  }
  async removeEntry() { throw readOnly(); }
  async isSameEntry(other) { return other === this; }
  async queryPermission({ mode } = {}) { return mode === 'readwrite' ? 'denied' : 'granted'; }
  async requestPermission(opts) { return this.queryPermission(opts); }
}

/**
 * Build the tree from File objects carrying `webkitRelativePath` ("Downloads/sub/a.pdf").
 * @param {File[]} files
 * @returns {ReadOnlyDir}
 */
export function dirFromFiles(files) {
  const first = files[0]?.webkitRelativePath || '';
  const root = new ReadOnlyDir(first.split('/')[0] || 'folder');
  for (const f of files) {
    const parts = (f.webkitRelativePath || f.name).split('/');
    parts.shift(); // the root's own name
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      let next = dir._children.get(parts[i]);
      if (!next) { next = new ReadOnlyDir(parts[i]); dir._children.set(parts[i], next); }
      dir = next;
    }
    const leaf = parts[parts.length - 1];
    if (leaf) dir._children.set(leaf, new ReadOnlyFile(f));
  }
  return root;
}

/**
 * Ask for a folder through the upload dialog. Must run inside a click handler.
 * Resolves to a ReadOnlyDir, or null if the user cancels.
 */
export function pickFolderReadOnly() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.webkitdirectory = true;
    input.multiple = true;
    input.style.display = 'none';
    document.body.append(input);
    const done = (v, err) => { input.remove(); err ? reject(err) : resolve(v); };
    input.addEventListener('change', () => {
      const files = [...(input.files ?? [])];
      if (!files.length) done(null);
      else done(dirFromFiles(files));
    }, { once: true });
    input.addEventListener('cancel', () => done(null), { once: true });
    input.click();
  });
}

export function isReadOnly(handle) {
  return !!handle?.readOnly;
}
