// Minimal observable state container.
export function createStore(initial) {
  let state = { ...initial };
  const subs = new Set();
  const store = {
    get: () => state,
    set(patch) {
      state = { ...state, ...patch };
      for (const s of subs) s(state);
    },
    update(fn) {
      store.set(fn(state));
    },
    /** Update state without re-rendering (for text fields that are re-read on the next action). */
    silent(patch) {
      state = { ...state, ...patch };
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
  return store;
}
