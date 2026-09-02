import { h } from './dom.js';
export function renderInterpret(root, store) {
  root.append(h('div', { class: 'page' }, h('h1', null, 'Interpret'), h('button', { onclick: () => store.set({ screen: 'work' }) }, '← Back')));
}
