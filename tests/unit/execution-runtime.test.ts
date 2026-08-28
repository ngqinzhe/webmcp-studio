import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { executeExecutor } from "../../core/execution";
import type { ExecutorDefinition, SemanticLocator } from "../../core/types";

function locator(overrides: Partial<SemanticLocator> = {}): SemanticLocator {
  return {
    framePath: [],
    shadowPath: [],
    stableAttributes: [],
    fallbacks: [],
    ...overrides,
  };
}

function controlExecutor(
  control: Extract<ExecutorDefinition, { kind: "control" }>["control"],
  target: SemanticLocator,
  valueField = "value",
): ExecutorDefinition {
  return {
    kind: "control",
    control,
    target,
    valueField,
    expected: { event: "change" },
  };
}

describe("visible UI execution", () => {
  it("sets text controls and dispatches realistic input/change events", async () => {
    const dom = new JSDOM(`
      <label for="query">Search</label>
      <input id="query" name="query">
      <output id="events"></output>
    `);
    const document = dom.window.document;
    const input = document.querySelector("input")!;
    const events: string[] = [];
    input.addEventListener("input", () => events.push("input"));
    input.addEventListener("change", () => {
      events.push("change");
      document.querySelector("output")!.textContent = input.value;
    });

    const result = await executeExecutor(
      controlExecutor("input", locator({ labelText: "Search" })),
      { value: "keyboard" },
      { document },
    );
    expect(result.success).toBe(true);
    expect(result.status).toBe("completed");
    expect(input.value).toBe("keyboard");
    expect(events).toEqual(["input", "change"]);
    expect(result.stateChanged).toBe(true);
  });

  it("handles checkbox, radio, and select controls through native UI semantics", async () => {
    const dom = new JSDOM(`
      <label><input id="agree" type="checkbox"> Accept terms</label>
      <label><input id="pro" type="radio" name="plan" value="pro"> Pro</label>
      <label for="sort">Sort</label>
      <select id="sort"><option value="relevance">Relevance</option><option value="price">Price</option></select>
      <output id="state"></output>
    `);
    const document = dom.window.document;

    const checkbox = await executeExecutor(
      controlExecutor(
        "checkbox",
        locator({ role: "checkbox", accessibleName: "Accept terms" }),
        "accepted",
      ),
      { accepted: true },
      { document },
    );
    expect(checkbox.success).toBe(true);
    expect((document.querySelector("#agree") as HTMLInputElement).checked).toBe(
      true,
    );

    const radio = await executeExecutor(
      controlExecutor(
        "radio",
        locator({ role: "radio", accessibleName: "Pro" }),
        "plan",
      ),
      { plan: true },
      { document },
    );
    expect(radio.success).toBe(true);
    expect((document.querySelector("#pro") as HTMLInputElement).checked).toBe(
      true,
    );

    const radioInvalid = await executeExecutor(
      controlExecutor(
        "radio",
        locator({ role: "radio", accessibleName: "Pro" }),
        "plan",
      ),
      { plan: "missing" },
      { document },
    );
    expect(radioInvalid.status).toBe("invalid_arguments");

    const basicRadio = document.createElement("input");
    basicRadio.type = "radio";
    basicRadio.name = "plan";
    basicRadio.value = "basic";
    basicRadio.setAttribute("aria-label", "Basic");
    document.body.append(basicRadio);
    const radioByEnum = await executeExecutor(
      controlExecutor(
        "radio",
        locator({ role: "radio", accessibleName: "Pro" }),
        "plan",
      ),
      { plan: "basic" },
      { document },
    );
    expect(radioByEnum.success).toBe(true);
    expect(basicRadio.checked).toBe(true);

    const select = await executeExecutor(
      controlExecutor(
        "select",
        locator({ role: "combobox", accessibleName: "Sort" }),
      ),
      { value: "price" },
      { document },
    );
    expect(select.success).toBe(true);
    expect((document.querySelector("#sort") as HTMLSelectElement).value).toBe(
      "price",
    );
  });

  it("fills a form and submits through requestSubmit", async () => {
    const dom = new JSDOM(`
      <form id="search-form">
        <label for="term">Query</label><input id="term" name="term" required>
        <button id="submit" type="submit">Search</button>
        <output id="result"></output>
      </form>
    `);
    const document = dom.window.document;
    const form = document.querySelector("form")!;
    form.addEventListener("submit", (event: Event) => {
      event.preventDefault();
      document.querySelector("output")!.textContent =
        `submitted:${(document.querySelector("#term") as HTMLInputElement).value}`;
    });

    const executor: ExecutorDefinition = {
      kind: "form",
      form: locator({
        role: "form",
        stableAttributes: [{ name: "id", value: "search-form" }],
      }),
      fields: { term: locator({ labelText: "Query" }) },
      submit: locator({ role: "button", accessibleName: "Search" }),
      expected: { event: "submit", textIncludes: "submitted:polyfill" },
    };
    const result = await executeExecutor(
      executor,
      { term: "polyfill" },
      { document },
    );
    expect(result.success).toBe(true);
    expect(result.navigationOccurred).toBe(false);
    expect(document.querySelector("output")?.textContent).toBe(
      "submitted:polyfill",
    );
  });

  it("detects navigation supplied by the normal click handler", async () => {
    const dom = new JSDOM(`<a id="next" href="/next">Next</a>`);
    const document = dom.window.document;
    let currentUrl = "https://example.test/start";
    document.querySelector("a")!.addEventListener("click", () => {
      currentUrl = "https://example.test/next";
    });
    const executor: ExecutorDefinition = {
      kind: "action",
      action: "navigate",
      target: locator({ role: "link", accessibleName: "Next" }),
      expected: { event: "navigation" },
    };

    const result = await executeExecutor(
      executor,
      {},
      {
        document,
        urlProvider: () => currentUrl,
        timeoutMs: 0,
      },
    );
    expect(result.success).toBe(true);
    expect(result.navigationOccurred).toBe(true);
    expect(result.urlBefore).toBe("https://example.test/start");
    expect(result.urlAfter).toBe("https://example.test/next");
  });

  it("executes a control in an open shadow root and observes its shadow state", async () => {
    const dom = new JSDOM(
      `<search-box data-testid="search-host"></search-box>`,
    );
    const host = dom.window.document.querySelector("search-box")!;
    const shadowRoot = host.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = `
      <label for="term">Search</label>
      <input id="term">
      <output id="status"></output>
    `;
    const input = shadowRoot.querySelector("input")!;
    input.addEventListener("change", () => {
      shadowRoot.querySelector("output")!.textContent = input.value;
    });

    const result = await executeExecutor(
      controlExecutor(
        "input",
        locator({
          shadowPath: [
            { stableAttribute: { name: "data-testid", value: "search-host" } },
          ],
          labelText: "Search",
        }),
      ),
      { value: "shadow value" },
      { document: dom.window.document },
    );
    expect(result.success).toBe(true);
    expect(shadowRoot.querySelector("output")?.textContent).toBe(
      "shadow value",
    );
  });

  it("executes visible controls in a same-origin iframe", async () => {
    const main = new JSDOM(`<iframe src="/embedded"></iframe>`, {
      url: "https://example.test/page",
    });
    const frame = new JSDOM(
      `
      <label for="term">Frame query</label>
      <input id="term">
      <output id="result"></output>
    `,
      { url: "https://example.test/embedded" },
    );
    const iframe = main.window.document.querySelector("iframe")!;
    Object.defineProperty(iframe, "contentDocument", {
      configurable: true,
      value: frame.window.document,
    });
    const input = frame.window.document.querySelector("input")!;
    input.addEventListener("change", () => {
      frame.window.document.querySelector("output")!.textContent = input.value;
    });

    const result = await executeExecutor(
      controlExecutor(
        "input",
        locator({ framePath: [0], labelText: "Frame query" }),
      ),
      { value: "inside frame" },
      { document: main.window.document },
    );
    expect(result.success).toBe(true);
    expect(frame.window.document.querySelector("output")?.textContent).toBe(
      "inside frame",
    );
    expect(result.navigationOccurred).toBe(false);
  });

  it("does not report success for a click with no observable outcome", async () => {
    const dom = new JSDOM(`<button id="noop">Do nothing</button>`);
    const executor: ExecutorDefinition = {
      kind: "action",
      action: "click",
      target: locator({ role: "button", accessibleName: "Do nothing" }),
      expected: { event: "click" },
    };
    const result = await executeExecutor(
      executor,
      {},
      {
        document: dom.window.document,
        timeoutMs: 0,
      },
    );
    expect(result.success).toBe(false);
    expect(result.status).toBe("no_observable_change");
    expect(result.error?.code).toBe("no_observable_change");
  });

  it("distinguishes a bounded expected-outcome timeout from no observable change", async () => {
    const dom = new JSDOM(`<button>Wait</button>`);
    const result = await executeExecutor(
      {
        kind: "action",
        action: "click",
        target: locator({ role: "button", accessibleName: "Wait" }),
        expected: { event: "click", textIncludes: "never appears" },
      },
      {},
      { document: dom.window.document, timeoutMs: 0 },
    );
    expect(result.success).toBe(false);
    expect(result.status).toBe("execution_timeout");
    expect(result.error?.code).toBe("execution_timeout");
  });

  it("returns structured target, argument, validation, and unsupported failures", async () => {
    const dom = new JSDOM(`
      <label for="email">Email</label>
      <input id="email" type="email" required>
      <button hidden>Hidden</button>
    `);
    const document = dom.window.document;

    const missing = await executeExecutor(
      controlExecutor(
        "input",
        locator({ role: "textbox", accessibleName: "Missing" }),
      ),
      { value: "x@example.com" },
      { document },
    );
    expect(missing.status).toBe("target_not_found");
    expect(missing.error?.code).toBe("target_not_found");

    const invalidArgs = await executeExecutor(
      controlExecutor("input", locator({ labelText: "Email" })),
      {},
      { document },
    );
    expect(invalidArgs.status).toBe("invalid_arguments");

    const invalidValue = await executeExecutor(
      controlExecutor("input", locator({ labelText: "Email" })),
      { value: "not-an-email" },
      { document },
    );
    expect(invalidValue.status).toBe("validation_failed");

    const hidden = await executeExecutor(
      {
        kind: "action",
        action: "click",
        target: locator({ role: "button", accessibleName: "Hidden" }),
        expected: { event: "click" },
      },
      {},
      { document, timeoutMs: 0 },
    );
    expect(hidden.status).toBe("unsupported_control");
  });
});
