import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  getAccessibleName,
  getSemanticRole,
  resolveSemanticLocator,
} from "../../core/locators";
import type { SemanticLocator } from "../../core/types";

function locator(overrides: Partial<SemanticLocator> = {}): SemanticLocator {
  return {
    framePath: [],
    shadowPath: [],
    stableAttributes: [],
    fallbacks: [],
    ...overrides,
  };
}

describe("semantic locator resolution", () => {
  it("extracts names in the product priority order and maps implicit roles", () => {
    const dom = new JSDOM(`
      <label for="email">Work email</label>
      <input id="email" aria-label="ARIA email" placeholder="Email placeholder">
    `);
    const input = dom.window.document.querySelector("input");
    expect(input).not.toBeNull();
    expect(getAccessibleName(dom.window.document, input!)).toBe("Work email");
    expect(getSemanticRole(input!)).toBe("textbox");
  });

  it("uses role/name first and context to disambiguate contextual actions", () => {
    const dom = new JSDOM(`
      <article><h2>Mechanical Keyboard</h2><button>Add to cart</button></article>
      <article><h2>Desk Lamp</h2><button>Add to cart</button></article>
    `);
    const result = resolveSemanticLocator(
      dom.window.document,
      locator({
        role: "button",
        accessibleName: "Add to cart",
        context: { role: "article", text: "Mechanical Keyboard" },
      }),
    );
    expect(result.status).toBe("matched");
    expect(result.element?.closest("article")?.textContent).toContain(
      "Mechanical Keyboard",
    );
    expect(result.strategy).toBe("role-name");
  });

  it("falls through label, stable attributes, relationship, and CSS in order", () => {
    const dom = new JSDOM(`
      <form data-testid="account-form">
        <label for="email">Email address</label>
        <input id="email" name="email">
        <button class="legacy-submit">Continue</button>
      </form>
    `);
    const document = dom.window.document;

    const labelled = resolveSemanticLocator(
      document,
      locator({ labelText: "Email address" }),
    );
    expect(labelled.status).toBe("matched");
    expect(labelled.element?.getAttribute("id")).toBe("email");
    expect(labelled.strategy).toBe("label");

    const relationship = resolveSemanticLocator(
      document,
      locator({
        context: {
          role: "form",
          stableAttribute: { name: "data-testid", value: "account-form" },
        },
        relationship: "form-control",
      }),
    );
    expect(relationship.status).toBe("matched");
    expect(relationship.element?.getAttribute("id")).toBe("email");
    expect(relationship.strategy).toBe("relationship");

    const stable = resolveSemanticLocator(
      document,
      locator({
        stableAttributes: [{ name: "id", value: "email" }],
      }),
    );
    expect(stable.status).toBe("matched");
    expect(stable.strategy).toBe("stable-attribute");

    const css = resolveSemanticLocator(
      document,
      locator({
        fallbacks: [
          {
            kind: "css",
            description: "legacy submit",
            selector: ".legacy-submit",
          },
        ],
      }),
    );
    expect(css.status).toBe("matched");
    expect(css.element?.textContent).toBe("Continue");
    expect(css.strategy).toBe("css");
  });

  it("reports ambiguity instead of selecting an arbitrary matching control", () => {
    const dom = new JSDOM(`<button>Save</button><button>Save</button>`);
    const result = resolveSemanticLocator(
      dom.window.document,
      locator({ role: "button", accessibleName: "Save" }),
    );
    expect(result.status).toBe("ambiguous");
    expect(result.candidates).toHaveLength(2);
  });

  it("walks an open shadow root using the explicit shadow path", () => {
    const dom = new JSDOM(
      `<search-box data-testid="search-host"></search-box>`,
    );
    const document = dom.window.document;
    const host = document.querySelector("search-box")!;
    const shadowRoot = host.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = `<label for="term">Search products</label><input id="term">`;

    const result = resolveSemanticLocator(
      document,
      locator({
        shadowPath: [
          {
            stableAttribute: { name: "data-testid", value: "search-host" },
          },
        ],
        role: "textbox",
        accessibleName: "Search products",
      }),
    );
    expect(result.status).toBe("matched");
    expect(result.element?.getAttribute("id")).toBe("term");
  });

  it("walks same-origin frame documents and reports inaccessible frames", () => {
    const dom = new JSDOM(`<iframe></iframe>`);
    const document = dom.window.document;
    const frame = document.querySelector("iframe")!;
    const frameDom = new JSDOM(`<button>Inside frame</button>`);
    Object.defineProperty(frame, "contentDocument", {
      configurable: true,
      value: frameDom.window.document,
    });

    const found = resolveSemanticLocator(
      document,
      locator({
        framePath: [0],
        role: "button",
        accessibleName: "Inside frame",
      }),
    );
    expect(found.status).toBe("matched");

    const blockedDom = new JSDOM(
      `<iframe src="https://payments.example.test/widget"></iframe>`,
      {
        url: "https://shop.example.test/checkout",
      },
    );
    const blocked = resolveSemanticLocator(
      blockedDom.window.document,
      locator({ framePath: [0], role: "button", accessibleName: "Blocked" }),
    );
    expect(blocked.status).toBe("cross_origin_blocked");
  });

  it("supports an iframe nested inside an open shadow root", () => {
    const dom = new JSDOM(
      `<embed-shell data-testid="embed-host"></embed-shell>`,
    );
    const host = dom.window.document.querySelector("embed-shell")!;
    const shadowRoot = host.attachShadow({ mode: "open" });
    const iframe = dom.window.document.createElement("iframe");
    shadowRoot.append(iframe);
    const frameDom = new JSDOM(`<button>Embedded action</button>`);
    Object.defineProperty(iframe, "contentDocument", {
      configurable: true,
      value: frameDom.window.document,
    });

    const result = resolveSemanticLocator(
      dom.window.document,
      locator({
        framePath: [0],
        shadowPath: [
          {
            stableAttribute: { name: "data-testid", value: "embed-host" },
          },
        ],
        role: "button",
        accessibleName: "Embedded action",
      }),
    );
    expect(result.status).toBe("matched");
    expect(result.element?.textContent).toBe("Embedded action");
  });
});
