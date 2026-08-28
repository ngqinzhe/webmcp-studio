import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { getAccessibleName } from "../../core/dom/accessibility";
import { discoverDocument } from "../../core/dom/traverse";
import { inferCapabilities } from "../../core/detection/infer";
import {
  scanDocument,
  scanDocumentSubtrees,
} from "../../core/detection/scanner";

describe("semantic DOM discovery", () => {
  it("extracts names with explicit labels before ARIA and fallback attributes", () => {
    const dom = new JSDOM(`
      <label for="query">Product search</label>
      <input id="query" name="q" aria-label="ARIA query" placeholder="Search products">
    `);
    const input = dom.window.document.querySelector("input");
    expect(input).not.toBeNull();
    expect(getAccessibleName(input!)).toBe("Product search");

    input!.removeAttribute("id");
    dom.window.document.querySelector("label")?.remove();
    expect(getAccessibleName(input!)).toBe("ARIA query");
    input!.removeAttribute("aria-label");
    expect(getAccessibleName(input!)).toBe("q");
  });

  it("infers a user-level search capability and stable semantic locators", () => {
    const dom = new JSDOM(
      `
      <main>
        <h1>Products</h1>
        <form id="product-search" aria-label="Search products">
          <label for="q">Search products</label>
          <input id="q" name="q" type="search" required>
          <label for="sort">Sort by</label>
          <select id="sort" name="sort">
            <option value="relevance">Relevance</option>
            <option value="price">Price</option>
          </select>
          <button type="submit">Search</button>
        </form>
      </main>
    `,
      { url: "https://shop.test/products" },
    );

    const result = scanDocument(dom.window.document);
    const search = result.capabilities.find(
      (capability) => capability.name === "search_products",
    );
    expect(search).toBeDefined();
    expect(search?.inputSchema.type).toBe("object");
    expect(search?.inputSchema.properties?.q?.type).toBe("string");
    expect(search?.inputSchema.required).toEqual(expect.arrayContaining(["q"]));
    expect(search?.locator.stableAttributes).toEqual(
      expect.arrayContaining([{ name: "id", value: "product-search" }]),
    );
    expect(
      search?.locator.fallbacks.some((fallback) => fallback.kind === "role"),
    ).toBe(true);
    expect(search?.executor.kind).toBe("form");
    expect(result.page.hostname).toBe("shop.test");
  });

  it("attaches product context to contextual actions", () => {
    const dom = new JSDOM(
      `
      <section>
        <article class="product-card" data-product-id="keyboard-1">
          <h2>Mechanical Keyboard</h2>
          <button type="button">Add to cart</button>
        </article>
      </section>
    `,
      { url: "https://shop.test/catalog" },
    );

    const result = scanDocument(dom.window.document);
    const addToCart = result.capabilities.find(
      (capability) => capability.name === "add_to_cart",
    );
    expect(addToCart).toBeDefined();
    expect(addToCart?.locator.context?.text).toContain("Mechanical Keyboard");
    expect(addToCart?.locator.context?.stableAttribute).toEqual({
      name: "data-product-id",
      value: "keyboard-1",
    });
    expect(addToCart?.executor.kind).toBe("action");
    if (addToCart?.executor.kind === "action")
      expect(addToCart.executor.entity?.text).toContain("Mechanical Keyboard");
  });

  it("skips action wrappers and resolves the enclosing product card", () => {
    const dom = new JSDOM(
      `
      <article class="product-card" data-product-id="keyboard-2">
        <h2>Mechanical Keyboard</h2>
        <div class="product-actions">
          <button type="button">Add to cart</button>
        </div>
      </article>
    `,
      { url: "https://shop.test/catalog" },
    );

    const addToCart = scanDocument(dom.window.document).capabilities.find(
      (capability) => capability.name === "add_to_cart",
    );
    expect(addToCart?.locator.context).toMatchObject({
      role: "article",
      text: "Mechanical Keyboard",
      stableAttribute: {
        name: "data-product-id",
        value: "keyboard-2",
      },
    });
  });

  it("traverses controls in open shadow roots and records their shadow identity", () => {
    const dom = new JSDOM("<main></main>", { url: "https://shop.test/shadow" });
    const host = dom.window.document.createElement("product-search");
    host.setAttribute("data-testid", "search-host");
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <form aria-label="Search products">
        <label for="shadow-query">Search products</label>
        <input id="shadow-query" name="q" type="search">
        <button>Search</button>
      </form>
    `;
    dom.window.document.querySelector("main")?.append(host);

    const result = scanDocument(dom.window.document);
    const search = result.capabilities.find(
      (capability) => capability.name === "search_products",
    );
    expect(search).toBeDefined();
    expect(search?.source.shadowPath).toHaveLength(1);
    expect(search?.source.shadowPath[0]?.stableAttribute).toEqual({
      name: "data-testid",
      value: "search-host",
    });
    expect(search?.executor.kind).toBe("form");
  });

  it("traverses same-origin iframe documents and preserves the frame path", () => {
    const main = new JSDOM(`<iframe id="same" src="/embedded"></iframe>`, {
      url: "https://shop.test/page",
    });
    const frame = new JSDOM(
      `
      <form aria-label="Search products">
        <label for="q">Search products</label>
        <input id="q" name="q" type="search">
        <button>Search</button>
      </form>
    `,
      { url: "https://shop.test/embedded" },
    );
    const iframe = main.window.document.querySelector("iframe")!;
    Object.defineProperty(iframe, "contentDocument", {
      configurable: true,
      value: frame.window.document,
    });

    const result = scanDocument(main.window.document);
    const search = result.capabilities.find(
      (capability) => capability.name === "search_products",
    );
    expect(search?.source.framePath).toEqual([0]);
    expect(result.documentsScanned).toBe(2);
    expect(result.blocked).toHaveLength(0);
  });

  it("reports cross-origin iframe access as an explicit blocked record", () => {
    const dom = new JSDOM(
      `<iframe title="Payments" src="https://payments.example.test/widget"></iframe>`,
      {
        url: "https://shop.test/checkout",
      },
    );
    const result = scanDocument(dom.window.document);
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]).toMatchObject({
      reason: "cross_origin_blocked",
      name: "Payments",
      framePath: [0],
    });
  });

  it("does not expose unnamed low-level buttons as capabilities", () => {
    const dom = new JSDOM(
      `<button>Click me</button><button aria-label=""></button>`,
    );
    const result = scanDocument(dom.window.document);
    expect(result.capabilities).toHaveLength(0);
  });

  it("can inspect a snapshot independently from capability compilation", () => {
    const dom = new JSDOM(
      `<form aria-label="Contact"><label>Name<input name="name"></label></form>`,
    );
    const snapshot = discoverDocument(dom.window.document);
    expect(snapshot.forms).toHaveLength(1);
    expect(snapshot.elements.some((element) => element.kind === "input")).toBe(
      true,
    );
    expect(snapshot.elements[0]?.locator.framePath).toEqual([]);
  });

  it("also accepts a document directly at the capability compilation boundary", () => {
    const dom = new JSDOM(`
      <form aria-label="Search products">
        <input name="query" type="search"><button>Search</button>
      </form>
    `);
    expect(
      inferCapabilities(dom.window.document).map(
        (capability) => capability.name,
      ),
    ).toContain("search_products");
  });

  it("scans a selected subtree and indexes its capability targets", () => {
    const dom = new JSDOM(
      `
        <main>
          <form aria-label="Search products">
            <label for="q">Search products</label>
            <input id="q" name="q" type="search">
            <button>Search</button>
          </form>
          <button data-action="Add to cart">Add to cart</button>
        </main>
      `,
      { url: "https://shop.test/products" },
    );
    const form = dom.window.document.querySelector("form");
    expect(form).not.toBeNull();

    const full = scanDocument(dom.window.document);
    const partial = scanDocumentSubtrees(dom.window.document, [form!]);
    const search = partial.capabilities.find(
      (capability) => capability.name === "search_products",
    );

    expect(partial.elementsScanned).toBeLessThan(full.elementsScanned);
    expect(search).toBeDefined();
    expect(partial.capabilityElements.get(search!.id)).toBe(form);
    expect(partial.capabilities.map(({ name }) => name)).not.toContain(
      "add_to_cart",
    );
  });
});
