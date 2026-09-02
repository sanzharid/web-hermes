import { h } from './dom.js';
export function renderModelPanel(right) {
  right.append(h('h2', null, 'Instruction'), h('p', { class: 'muted' }, 'No model loaded. Load one under Models, or use rules.'));
}
