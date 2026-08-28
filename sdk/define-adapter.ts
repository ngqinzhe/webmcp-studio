import type { AdapterDefinition } from "./types";
import { validateAdapter } from "./validation";

/**
 * Define an adapter and validate its hooks before it can enter a registry.
 *
 * Adapters are intentionally declarative at the graph boundary: hooks receive
 * capabilities and return graph data or execution results. They do not receive
 * DOM nodes or extension privileges.
 */
export function defineAdapter(
  definition: AdapterDefinition,
): AdapterDefinition {
  const validated = validateAdapter(definition);
  return Object.freeze({ ...validated });
}

export function isAdapterDefinition(
  value: unknown,
): value is AdapterDefinition {
  try {
    validateAdapter(value);
    return true;
  } catch {
    return false;
  }
}
