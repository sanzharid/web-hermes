import { h } from './dom.js';
export function renderModels(root) {
  root.append(h('div', { class: 'page' }, h('h1', null, 'Models'), h('p', { class: 'muted' }, 'Model runtime arrives in step 3. Rule-based renaming works without it.')));
}
