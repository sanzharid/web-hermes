const KEY = 'sift.settings';
export const DEFAULT_SETTINGS = {
  rootPathLength: 64,      // assumed length of the connected folder's absolute path (not exposed by the API)
  allowExtensionChange: false,
  batchSize: 25,
  lastFolderId: null,
  modelId: null,
  excerptBytes: 500,
};
export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}
export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch {}
  return s;
}
