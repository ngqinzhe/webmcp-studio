import {
  capabilitiesEqual,
  createCapabilityGraph,
  deduplicateGraphNativeCapabilities,
  deduplicateNativeCapabilities,
  diffGraphs,
  listCapabilities,
  markNativeEquivalents,
} from "../../core/graph";
import type {
  Capability,
  JSONSchema,
  PageIdentity,
  SemanticLocator,
} from "../../core/types";

const page: PageIdentity = {
  url: "https://shop.test/products",
  title: "Products",
  origin: "https://shop.test",
  hostname: "shop.test",
};

function locator(name: string): SemanticLocator {
  return {
    framePath: [],
    shadowPath: [],
    role: "button",
    accessibleName: name,
    stableAttributes: [{ name: "data-testid", value: name }],
    fallbacks: [
      {
        kind: "role",
        description: `button named ${name}`,
        role: "button",
        accessibleName: name,
      },
    ],
  };
}

function capability(
  id: string,
  name: string,
  overrides: Partial<Capability> = {},
): Capability {
  const inputSchema: JSONSchema = {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  };
  return {
    id,
    name,
    description: `${name} description`,
    inputSchema,
    effect: "interact",
    confidence: 0.9,
    source: {
      type: "inferred",
      url: page.url,
      framePath: [],
      shadowPath: [],
      nodeSignature: id,
    },
    locator: locator(name),
    executor: {
      kind: "action",
      action: "click",
      target: locator(name),
      expected: { event: "click", textIncludes: "done" },
    },
    ...overrides,
  };
}

describe("CapabilityGraph", () => {
  it("constructs a deterministic graph keyed by capability ID", () => {
    const second = capability("b", "second");
    const first = capability("a", "first");
    const graph = createCapabilityGraph({
      page,
      capabilities: [second, first],
      generatedAt: 123,
    });

    expect(graph.version).toBe(1);
    expect(graph.generatedAt).toBe(123);
    expect(Object.keys(graph.capabilities)).toEqual(["a", "b"]);
    expect(listCapabilities(graph)).toEqual([first, second]);
  });

  it("treats reordered object keys as the same capability", () => {
    const before = capability("search", "search_products");
    const after: Capability = {
      ...before,
      inputSchema: {
        required: ["query"],
        properties: { query: { type: "string" } },
        type: "object",
      },
    };

    expect(capabilitiesEqual(before, after)).toBe(true);
  });

  it("rejects conflicting duplicate IDs", () => {
    expect(() =>
      createCapabilityGraph(page, [
        capability("same", "first"),
        capability("same", "second"),
      ]),
    ).toThrow("Duplicate capability id: same");
  });
});

describe("diffGraphs", () => {
  it("reports added, removed, changed, and unchanged capabilities", () => {
    const unchanged = capability("unchanged", "keep");
    const removed = capability("removed", "remove");
    const changedBefore = capability("changed", "old");
    const changedAfter = capability("changed", "new");
    const added = capability("added", "add");

    const previous = createCapabilityGraph(
      page,
      [changedBefore, removed, unchanged],
      [],
      1,
    );
    const next = createCapabilityGraph(
      page,
      [unchanged, changedAfter, added],
      [],
      2,
    );
    const diff = diffGraphs(previous, next);

    expect(diff.added.map(({ id }) => id)).toEqual(["added"]);
    expect(diff.removed.map(({ id }) => id)).toEqual(["removed"]);
    expect(diff.changed.map(({ before }) => before.id)).toEqual(["changed"]);
    expect(diff.changed[0]?.after.name).toBe("new");
    expect(diff.unchanged.map(({ id }) => id)).toEqual(["unchanged"]);
  });

  it("treats the first scan as all additions", () => {
    const diff = diffGraphs(
      null,
      createCapabilityGraph(page, [capability("a", "a")]),
    );

    expect(diff.added.map(({ id }) => id)).toEqual(["a"]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });
});

describe("native capability deduplication", () => {
  it("suppresses exact normalized-name overlaps and retains supplements", () => {
    const native = capability("native-overlap", "search_products");
    const supplement = capability("supplement", "add_to_cart");
    const result = deduplicateNativeCapabilities(
      [native, supplement],
      [{ name: "search-products", description: "Native search" }],
    );

    expect(result.suppressed.map(({ id }) => id)).toEqual(["native-overlap"]);
    expect(result.retained.map(({ id }) => id)).toEqual(["supplement"]);
    expect(result.matches[0]?.nativeTool.name).toBe("search-products");
  });

  it("honors explicit nativeEquivalent annotations", () => {
    const inferred = capability("filter", "filter_results", {
      nativeEquivalent: "native_filter",
    });
    const marked = markNativeEquivalents(
      [inferred],
      [{ name: "native_filter" }],
    );

    expect(marked[0]?.nativeEquivalent).toBe("native_filter");
    expect(
      deduplicateNativeCapabilities(marked, [{ name: "native_filter" }])
        .suppressed,
    ).toHaveLength(1);
  });

  it("can apply filtering without mutating the source graph", () => {
    const overlap = capability("overlap", "search_products");
    const supplement = capability("other", "open_product");
    const graph = createCapabilityGraph(page, [overlap, supplement], [], 7);
    const result = deduplicateGraphNativeCapabilities(graph, [
      { name: "search_products" },
    ]);

    expect(listCapabilities(result.graph).map(({ id }) => id)).toEqual([
      "other",
    ]);
    expect(listCapabilities(graph).map(({ id }) => id)).toEqual([
      "other",
      "overlap",
    ]);
    expect(result.graph.generatedAt).toBe(7);
  });
});
