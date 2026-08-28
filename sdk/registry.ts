import type { CapabilityGraph } from "../core/types";
import type { AdapterApplicationResult, AdapterDefinition } from "./types";
import { applyAdapters, matchAdapters } from "./transform";
import { validateAdapter } from "./validation";

/** Ordered collection of validated adapters. */
export class AdapterRegistry {
  private readonly adapters = new Map<string, AdapterDefinition>();

  constructor(adapters: readonly AdapterDefinition[] = []) {
    this.registerAll(adapters);
  }

  register(adapter: AdapterDefinition): this {
    const validated = validateAdapter(adapter);
    if (this.adapters.has(validated.id)) {
      throw new Error(`Adapter already registered: ${validated.id}`);
    }
    this.adapters.set(validated.id, validated);
    return this;
  }

  registerAll(adapters: readonly AdapterDefinition[]): this {
    for (const adapter of adapters) this.register(adapter);
    return this;
  }

  unregister(id: string): boolean {
    return this.adapters.delete(id);
  }

  clear(): void {
    this.adapters.clear();
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  get(id: string): AdapterDefinition | undefined {
    return this.adapters.get(id);
  }

  list(): readonly AdapterDefinition[] {
    return [...this.adapters.values()];
  }

  matching(graph: CapabilityGraph): readonly AdapterDefinition[] {
    return matchAdapters(graph, this.list());
  }

  match(graph: CapabilityGraph): readonly AdapterDefinition[] {
    return this.matching(graph);
  }

  apply(graph: CapabilityGraph): AdapterApplicationResult {
    return applyAdapters(graph, this.list());
  }

  transform(graph: CapabilityGraph): AdapterApplicationResult {
    return this.apply(graph);
  }
}
