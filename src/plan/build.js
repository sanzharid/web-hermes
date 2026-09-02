import { validatePlan } from './validate.js';

/** Validate proposed ops against the current listing and open the review screen. */
export function openPlan(store, ops, { title, source, meta = {} }) {
  const { listing, settings } = store.get();
  const v = validatePlan(ops, listing, { rootPathLength: settings.rootPathLength, allowExtensionChange: settings.allowExtensionChange });
  const decisions = {};
  v.accepted.forEach((op, i) => { decisions[i] = true; });
  store.set({ plan: { title, source, ...v, decisions, meta }, screen: 'review', result: null });
  return v;
}
