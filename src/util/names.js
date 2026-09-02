// Windows filename rules. Pure functions, no DOM, no FS.

export const RESERVED_CHARS = /[<>:"|?*]/;
export const CONTROL_CHARS = /[\x00-\x1f]/;
export const RESERVED_DEVICE_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

export const MAX_PATH = 260;
export const MAX_COMPONENT = 255;

/** Split "name.ext" into { stem, ext } where ext includes the dot ("" if none). Dotfiles have no ext. */
export function splitExt(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return { stem: name, ext: '' };
  return { stem: name.slice(0, i), ext: name.slice(i) };
}

export function extOf(name) {
  return splitExt(name).ext.toLowerCase();
}

/** Compare names the way NTFS does: case-insensitive. */
export function sameName(a, b) {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Validate a single path component (file or folder name).
 * Returns null if fine, otherwise a short reason string.
 */
export function checkComponent(name) {
  if (typeof name !== 'string' || name.length === 0) return 'empty name';
  if (name === '.' || name === '..') return 'name is "." or ".."';
  if (name.includes('/') || name.includes('\\')) return 'contains a path separator';
  if (RESERVED_CHARS.test(name)) return 'contains a reserved character (< > : " | ? *)';
  if (CONTROL_CHARS.test(name)) return 'contains a control character';
  if (/[. ]$/.test(name)) return 'ends with a dot or space';
  if (/^ /.test(name)) return 'starts with a space';
  const base = splitExt(name).stem.toUpperCase();
  if (RESERVED_DEVICE_NAMES.has(name.toUpperCase()) || RESERVED_DEVICE_NAMES.has(base)) return 'reserved device name';
  if (name.length > MAX_COMPONENT) return `longer than ${MAX_COMPONENT} characters`;
  return null;
}

/**
 * Validate a relative path (components separated by "/"). Returns null or a reason.
 * `rootPathLength` is the assumed length of the absolute path of the connected folder;
 * the File System Access API does not expose it, so it is a setting.
 */
export function checkRelativePath(path, { rootPathLength = 0 } = {}) {
  if (typeof path !== 'string' || path.length === 0) return 'empty path';
  if (path.includes('\\')) return 'contains a backslash';
  const parts = path.split('/');
  for (const p of parts) {
    if (p === '..') return 'contains ".."';
    const r = checkComponent(p);
    if (r) return r;
  }
  if (rootPathLength + 1 + path.length >= MAX_PATH) return `full path would reach ${MAX_PATH} characters`;
  return null;
}

/** Sanitise a proposed name so it passes checkComponent, keeping as much as possible. */
export function sanitiseComponent(name) {
  let s = String(name ?? '')
    .replace(/[\\/]/g, '-')
    .replace(RESERVED_CHARS, '')
    .replace(/[<>:"|?*]/g, '')
    .replace(/[\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (s.length > MAX_COMPONENT) {
    const { stem, ext } = splitExt(s);
    s = stem.slice(0, MAX_COMPONENT - ext.length) + ext;
  }
  const { stem, ext } = splitExt(s);
  if (RESERVED_DEVICE_NAMES.has(stem.toUpperCase())) s = `${stem}_${ext}`;
  return s;
}

export function dirname(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function basename(path) {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export function joinPath(dir, name) {
  return dir ? `${dir}/${name}` : name;
}
