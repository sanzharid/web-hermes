// Tool registry. Domain-agnostic: file tools are the first set registered, not a special case.
// { name, description, schema, handler(args, ctx) -> any, sideEffects: bool }
// Registration is separate from exposure: each turn gets a filtered subset.

export function createRegistry() {
  const tools = new Map();
  return {
    register(tool) {
      if (!tool?.name || typeof tool.handler !== 'function') throw new Error('tool needs a name and a handler');
      tools.set(tool.name, { sideEffects: false, schema: { type: 'object', properties: {} }, ...tool });
      return this;
    },
    get: (name) => tools.get(name) ?? null,
    list: () => [...tools.values()],
    names: () => [...tools.keys()],
    /** Return the tools to expose this turn. `names` may be an array or a predicate. */
    expose(names) {
      const all = [...tools.values()];
      if (!names) return all;
      if (typeof names === 'function') return all.filter(names);
      const set = new Set(names);
      return all.filter((t) => set.has(t.name));
    },
  };
}
