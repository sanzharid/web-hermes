import { createRegistry } from './registry.js';
import { registerFileTools } from './tools/files.js';

let registry = null;
export function getRegistry() {
  if (!registry) registry = registerFileTools(createRegistry());
  return registry;
}
export const READ_ONLY = (t) => !t.sideEffects;
