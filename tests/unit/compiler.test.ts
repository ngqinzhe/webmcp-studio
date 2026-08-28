import { describe, expect, it } from "vitest";
import {
  cloneJsonSchema,
  compileCapabilities,
  compileCapabilitiesWithDiagnostics,
} from "../../core/compiler";
import type {
  Capability,
  ExpectedOutcome,
  JSONSchema,
  SemanticLocator,
} from "../../core/types";

const locator: SemanticLocator = {
  framePath: [],
  shadowPath: [],
  stableAttributes: [],
  fallbacks: [],
};

const expected: ExpectedOutcome = { event: "click" };

function capability(overrides: Partial<Capability> = {}): Capability {
  return {
    id: "capability-1",
    name: "search_products",
    description: "Search the product catalog.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1 },
      },
      required: ["query"],
    },
    effect: "read",
    confidence: 0.95,
    source: {
      type: "inferred",
      url: "https://example.test/catalog",
      framePath: [],
      shadowPath: [],
    },
    locator,
    executor: { kind: "read", target: locator, expected },
    ...overrides,
  };
}

describe("WebMCP compiler", () => {
  it("emits a serializable descriptor and effect annotations", () => {
    const [tool] = compileCapabilities([capability()]);
    if (!tool) throw new Error("Expected one compiled tool.");

    expect(tool).toEqual({
      capabilityId: "capability-1",
      name: "search_products",
      description: "Search the product catalog.",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string", minLength: 1 } },
        required: ["query"],
      },
      annotations: { readOnlyHint: true },
    });
    expect(JSON.parse(JSON.stringify(tool))).toEqual(tool);
    expect("execute" in tool).toBe(false);
  });

  it("does not mutate or leak non-serializable schema values", () => {
    const schema = {
      type: "object",
      properties: {
        valid: { type: "string" },
        ignored: { type: "string", default: undefined },
      },
    } as unknown as JSONSchema;
    const clone = cloneJsonSchema(schema);

    expect(clone).toEqual({
      type: "object",
      properties: { valid: { type: "string" }, ignored: { type: "string" } },
    });
    expect(schema.properties?.ignored?.default).toBeUndefined();
  });

  it("suppresses disabled, duplicate, and native-equivalent tools", () => {
    const result = compileCapabilitiesWithDiagnostics(
      [
        capability(),
        capability({ id: "duplicate", description: "Duplicate." }),
        capability({
          id: "native-equivalent",
          name: "native_search",
          nativeEquivalent: "native_search",
        }),
        capability({ id: "disabled", name: "disabled_action", enabled: false }),
      ],
      { nativeTools: ["native_search"] },
    );

    expect(result.tools.map((tool) => tool.name)).toEqual(["search_products"]);
    expect(result.skipped.map((entry) => entry.reason)).toEqual([
      "duplicate-name",
      "native-equivalent",
      "disabled",
    ]);
  });

  it("accepts native summaries as the second compiler argument", () => {
    const tools = compileCapabilities(
      [capability(), capability({ id: "other", name: "checkout" })],
      [{ name: "search_products" }],
    );

    expect(tools.map((tool) => tool.name)).toEqual(["checkout"]);
  });
});
