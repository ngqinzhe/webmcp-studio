import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  mutationScanRoots,
  nodeAffectedByMutation,
} from "../../core/detection/incremental";

function mutation(
  target: Node,
  overrides: Partial<MutationRecord> = {},
): MutationRecord {
  return {
    type: "childList",
    target,
    addedNodes: [] as unknown as NodeList,
    removedNodes: [] as unknown as NodeList,
    ...overrides,
  } as unknown as MutationRecord;
}

describe("incremental DOM scanning", () => {
  it("prefers an added semantic subtree over a broad parent target", () => {
    const dom = new JSDOM(`<main></main>`, { url: "https://shop.test/" });
    const document = dom.window.document;
    const form = document.createElement("form");
    form.setAttribute("aria-label", "Search products");
    form.innerHTML = '<input name="q" type="search"><button>Search</button>';
    const record = mutation(document.body, {
      addedNodes: [form] as unknown as NodeList,
    });

    const roots = mutationScanRoots(document, [record]);

    expect(roots).toEqual([form]);
    expect(roots).not.toContain(document.body);
  });

  it("marks indexed capabilities inside removed subtrees as stale", () => {
    const dom = new JSDOM(
      `<main><article><button>Add to cart</button></article></main>`,
      { url: "https://shop.test/" },
    );
    const document = dom.window.document;
    const card = document.querySelector("article")!;
    const button = card.querySelector("button")!;
    const record = mutation(document.body, {
      removedNodes: [card] as unknown as NodeList,
    });

    expect(nodeAffectedByMutation(button, [record], [])).toBe(true);
    expect(mutationScanRoots(document, [record])).toEqual([]);
  });
});
