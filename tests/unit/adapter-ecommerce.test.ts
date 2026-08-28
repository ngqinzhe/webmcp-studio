import type { Capability, CapabilityGraph } from "../../core/types";
import {
  createEcommerceProductCardAdapter,
  ecommerceProductCardAdapter,
} from "../../adapters";
import { applyAdapters } from "../../sdk";

function locator(
  overrides: Partial<Capability["locator"]> = {},
): Capability["locator"] {
  return {
    framePath: [],
    shadowPath: [],
    role: "button",
    accessibleName: "Add to cart",
    context: { role: "article", text: "Mechanical Keyboard" },
    stableAttributes: [{ name: "data-testid", value: "keyboard-card" }],
    fallbacks: [],
    ...overrides,
  };
}

function cartCapability(overrides: Partial<Capability> = {}): Capability {
  const target = locator();
  return {
    id: "card-keyboard-cart",
    name: "click_add_to_cart",
    description: "Add to cart",
    inputSchema: { type: "object", properties: {} },
    effect: "mutate",
    confidence: 0.7,
    source: {
      type: "inferred",
      url: "https://shop.test/products",
      framePath: [],
      shadowPath: [],
    },
    locator: target,
    executor: {
      kind: "action",
      action: "click",
      target,
      entity: {
        role: "article",
        text: "Mechanical Keyboard",
        stableAttribute: { name: "data-testid", value: "keyboard-card" },
      },
      expected: { event: "click", textIncludes: "Added to cart" },
    },
    ...overrides,
  };
}

function navigationCapability(): Capability {
  const target = locator({ accessibleName: "Mechanical Keyboard" });
  return {
    id: "card-keyboard-link",
    name: "product_link",
    description: "Open product",
    inputSchema: { type: "object", properties: {} },
    effect: "navigate",
    confidence: 0.68,
    source: {
      type: "inferred",
      url: "https://shop.test/products",
      framePath: [],
      shadowPath: [],
      nodeSignature: "keyboard-link",
    },
    locator: target,
    executor: {
      kind: "action",
      action: "navigate",
      target,
      entity: { role: "article", text: "Mechanical Keyboard" },
      expected: { event: "navigation" },
    },
  };
}

function page(capabilities: readonly Capability[]): CapabilityGraph {
  return {
    version: 1,
    generatedAt: 1,
    page: {
      url: "https://shop.test/products",
      title: "Products",
      origin: "https://shop.test",
      hostname: "shop.test",
    },
    capabilities: Object.fromEntries(
      capabilities.map((capability) => [capability.id, capability]),
    ),
    blocked: [],
  };
}

describe("ecommerce product-card adapter", () => {
  it("canonicalizes contextual cart actions and preserves product context in the locator", () => {
    const result = applyAdapters(page([cartCapability()]), [
      ecommerceProductCardAdapter,
    ]);
    const transformed = result.graph.capabilities["card-keyboard-cart"]!;

    expect(transformed.name).toBe("add_to_cart");
    expect(transformed.description).toContain("Mechanical Keyboard");
    expect(transformed.effect).toBe("mutate");
    expect(transformed.source).toMatchObject({
      type: "adapter",
      adapterId: "ecommerce-product-card",
    });
    expect(transformed.locator.context).toMatchObject({
      role: "article",
      text: "Mechanical Keyboard",
      stableAttribute: { name: "data-testid", value: "keyboard-card" },
    });
    expect(transformed.locator.relationship).toBe("context-action");
    expect(transformed.locator.fallbacks).toEqual([
      expect.objectContaining({
        kind: "relationship",
        relation: "context-action",
      }),
    ]);
  });

  it("discovers a canonical open_product capability from contextual navigation evidence", () => {
    const result = applyAdapters(page([navigationCapability()]), [
      ecommerceProductCardAdapter,
    ]);
    const discovered =
      result.graph.capabilities["card-keyboard-link:open-product"]!;

    expect(discovered).toMatchObject({
      name: "open_product",
      effect: "navigate",
      source: { type: "adapter", adapterId: "ecommerce-product-card" },
      executor: { kind: "action", action: "navigate" },
    });
    expect(discovered.locator.context?.text).toBe("Mechanical Keyboard");
  });

  it("suppresses an unscoped inferred cart action but leaves native tools alone", () => {
    const unscoped = cartCapability({
      id: "generic-cart",
      locator: {
        framePath: [],
        shadowPath: [],
        role: "button",
        accessibleName: "Add to cart",
        stableAttributes: [],
        fallbacks: [],
      },
      executor: {
        kind: "action",
        action: "click",
        target: {
          framePath: [],
          shadowPath: [],
          role: "button",
          accessibleName: "Add to cart",
          stableAttributes: [],
          fallbacks: [],
        },
        expected: { event: "click" },
      },
    });
    const native = cartCapability({
      id: "native-cart",
      source: {
        type: "native",
        url: "https://shop.test/products",
        framePath: [],
        shadowPath: [],
      },
    });
    const result = applyAdapters(page([cartCapability(), unscoped, native]), [
      ecommerceProductCardAdapter,
    ]);

    expect(result.graph.capabilities["generic-cart"]).toBeUndefined();
    expect(result.graph.capabilities["native-cart"]).toBeDefined();
    expect(result.graph.capabilities["native-cart"]!.source.type).toBe(
      "native",
    );
    expect(result.graph.capabilities["native-cart"]!.name).toBe(
      "click_add_to_cart",
    );
    expect(result.records[0]?.suppressed).toEqual(["generic-cart"]);
  });

  it("can be restricted to a hostname without weakening generic inference", () => {
    const adapter = createEcommerceProductCardAdapter({
      hostnames: ["store.example"],
    });
    const result = applyAdapters(page([cartCapability()]), [adapter]);

    expect(result.matchedAdapters).toHaveLength(0);
    expect(result.graph.capabilities["card-keyboard-cart"]!.name).toBe(
      "click_add_to_cart",
    );
  });
});
