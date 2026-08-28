import type {
  Capability,
  CapabilityGraph,
  ExecutionResult,
  SemanticLocator,
} from "../../core/types";
import {
  AdapterRegistry,
  AdapterValidationError,
  applyAdapters,
  defineAdapter,
  executeWithAdapters,
} from "../../sdk";

function locator(overrides: Partial<SemanticLocator> = {}): SemanticLocator {
  return {
    framePath: [],
    shadowPath: [],
    role: "button",
    accessibleName: "Submit",
    stableAttributes: [],
    fallbacks: [],
    ...overrides,
  };
}

function capability(overrides: Partial<Capability> = {}): Capability {
  return {
    id: "search",
    name: "search",
    description: "Search the catalog",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    effect: "read",
    confidence: 0.72,
    source: {
      type: "inferred",
      url: "https://shop.test/catalog",
      framePath: [],
      shadowPath: [],
      nodeSignature: "search-form",
    },
    locator: locator(),
    executor: {
      kind: "action",
      action: "click",
      target: locator(),
      expected: { event: "click" },
    },
    ...overrides,
  };
}

function graph(
  capabilities: readonly Capability[] = [capability()],
): CapabilityGraph {
  return {
    version: 1,
    page: {
      url: "https://shop.test/catalog",
      title: "Catalog",
      origin: "https://shop.test",
      hostname: "shop.test",
    },
    capabilities: Object.fromEntries(
      capabilities.map((item) => [item.id, item]),
    ),
    blocked: [],
    generatedAt: 100,
  };
}

const completed: ExecutionResult = {
  success: true,
  status: "completed",
  urlBefore: "https://shop.test/catalog",
  urlAfter: "https://shop.test/catalog",
  navigationOccurred: false,
  stateChanged: true,
  matchedTarget: "search",
  result: { ok: true },
  warnings: [],
};

describe("adapter SDK", () => {
  it("validates adapter definitions and rejects malformed hooks", () => {
    const adapter = defineAdapter({ id: "catalog", match: () => true });
    expect(adapter.id).toBe("catalog");
    expect(Object.isFrozen(adapter)).toBe(true);

    expect(() =>
      defineAdapter({
        id: "bad adapter",
        match: () => true,
      }),
    ).toThrow(AdapterValidationError);
    expect(() =>
      defineAdapter({
        id: "bad-hook",
        match: () => true,
        suppress: "yes" as never,
      }),
    ).toThrow(AdapterValidationError);
  });

  it("applies name, description, schema, and locator overrides without mutating the input graph", () => {
    const input = graph();
    const adapter = defineAdapter({
      id: "catalog-brand",
      match: ({ page, capabilities }) =>
        page.hostname === "shop.test" &&
        capabilities.some((item) => item.id === "search"),
      override: ({ capability: item }) => ({
        name: "find_products",
        description: "Find products by their title",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string", minLength: 2 } },
          required: ["query"],
          additionalProperties: false,
        },
        locator: {
          ...item.locator,
          role: "textbox",
          accessibleName: "Product search",
          labelText: "Product search",
          fallbacks: [
            {
              kind: "label",
              description: "Use the product search label",
              labelText: "Product search",
            },
          ],
        },
      }),
    });

    const applied = applyAdapters(input, [adapter]);
    const transformed = applied.graph.capabilities.search!;
    expect(transformed).toMatchObject({
      id: "search",
      name: "find_products",
      description: "Find products by their title",
      effect: "read",
      source: { type: "adapter", adapterId: "catalog-brand" },
    });
    expect(transformed.inputSchema).toEqual({
      type: "object",
      properties: { query: { type: "string", minLength: 2 } },
      required: ["query"],
      additionalProperties: false,
    });
    expect(transformed.locator.role).toBe("textbox");
    expect(transformed.locator.accessibleName).toBe("Product search");
    expect(input.capabilities.search!.name).toBe("search");
    expect(input.capabilities.search!.source.type).toBe("inferred");
    expect(applied.diff.changed).toHaveLength(1);
  });

  it("supports wrapped overrides, graph discovery, and suppression", () => {
    const input = graph([
      capability(),
      capability({ id: "noise", name: "noise" }),
    ]);
    const discovered = capability({
      id: "catalog_summary",
      name: "catalog_summary",
      description: "Read the current catalog summary",
      effect: "read",
    });
    const adapter = defineAdapter({
      id: "graph-transformer",
      match: () => true,
      discover: () => ({ capabilities: [discovered] }),
      override: ({ capability: item }) =>
        item.id === "search"
          ? { capability: { description: "Overridden search" } }
          : undefined,
      suppress: ({ capability: item }) => item.id === "noise",
    });

    const applied = applyAdapters(input, [adapter]);
    expect(applied.graph.capabilities.catalog_summary!.source).toMatchObject({
      type: "adapter",
      adapterId: "graph-transformer",
    });
    expect(applied.graph.capabilities.search!.description).toBe(
      "Overridden search",
    );
    expect(applied.graph.capabilities.noise).toBeUndefined();
    expect(applied.records[0]).toEqual({
      adapterId: "graph-transformer",
      discovered: ["catalog_summary"],
      overridden: ["search"],
      suppressed: ["noise"],
      executorCapabilities: [],
    });
  });

  it("matches adapters through the registry in registration order", () => {
    const calls: string[] = [];
    const first = defineAdapter({
      id: "first",
      match: ({ page }) => page.hostname === "shop.test",
      override: () => {
        calls.push("first");
        return { description: "first" };
      },
    });
    const second = defineAdapter({
      id: "second",
      match: ({ capabilities }) => capabilities.length === 1,
      override: () => {
        calls.push("second");
        return { description: "second" };
      },
    });
    const skipped = defineAdapter({ id: "skipped", match: () => false });
    const registry = new AdapterRegistry([first, second, skipped]);

    expect(registry.match(graph()).map((adapter) => adapter.id)).toEqual([
      "first",
      "second",
    ]);
    const applied = registry.apply(graph());
    expect(calls).toEqual(["first", "second"]);
    expect(applied.graph.capabilities.search!.description).toBe("second");
  });

  it("dispatches optional executor overrides and falls back to the default executor", async () => {
    const adapter = defineAdapter({
      id: "executor-adapter",
      match: () => true,
      override: ({ capability: item }) =>
        item.id === "search" ? {} : undefined,
      execute: async ({ args, capability: item, executeDefault }) => {
        const result = await executeDefault(item, args);
        return {
          ...result,
          result: {
            ...(result.result &&
            typeof result.result === "object" &&
            !Array.isArray(result.result)
              ? result.result
              : {}),
            adapterArgs: "keyboard",
          },
        };
      },
    });
    const applied = applyAdapters(graph(), [adapter]);
    const defaultExecute = vi.fn(
      async (
        _capability: Capability,
        _args: unknown,
      ): Promise<ExecutionResult> => completed,
    );

    const result = await executeWithAdapters(
      applied,
      "search",
      { query: "keyboard" },
      defaultExecute,
    );
    const defaultCall = defaultExecute.mock.calls[0]!;
    expect(defaultCall[0]).toMatchObject({
      id: "search",
      source: { type: "adapter", adapterId: "executor-adapter" },
    });
    expect(defaultCall[1]).toEqual({ query: "keyboard" });
    expect(result).toMatchObject({
      success: true,
      result: { ok: true, adapterArgs: "keyboard" },
    });
  });

  it("rejects discovered capability ID collisions instead of replacing graph nodes", () => {
    const adapter = defineAdapter({
      id: "collision",
      match: () => true,
      discover: () => capability(),
    });
    expect(() => applyAdapters(graph(), [adapter])).toThrow(/already exists/);
  });
});
