import {
  analyzeExternalHtml,
  handleExternalDiscovery,
  inspectExternalSite,
  validateExternalUrl,
} from "../../scripts/external-discovery.mjs";

describe("external discovery", () => {
  test("derives inferred tools from fetched page evidence", () => {
    const result = analyzeExternalHtml({
      url: "https://shop.example/catalog",
      html: `
        <html>
          <head><title>Example catalog</title></head>
          <body>
            <form id="search-form">
              <input name="q" type="search" placeholder="Search products" />
              <button type="submit">Search</button>
            </form>
            <a href="/cart">Cart</a>
            <button>Add to cart</button>
          </body>
        </html>
      `,
      headers: new Headers(),
      studioOrigin: "https://studio.example",
    });

    expect(result.status).toBe("inspected");
    expect(result.title).toBe("Example catalog");
    expect(result.tools.map((tool) => tool.name)).toEqual([
      "search_content",
      "view_cart",
      "add_to_cart",
    ]);
    expect(result.tools.every((tool) => tool.source !== "webmcp")).toBe(true);
    expect(result.tools.every((tool) => (tool.confidence ?? 0) > 0)).toBe(true);
    expect(result.tools[0]?.evidence?.[0]).toMatchObject({
      type: "dom",
      selector: "#search-form",
    });
  });

  test("does not create URL-keyword tools without page evidence", () => {
    const result = analyzeExternalHtml({
      url: "https://travel.example/booking/catalog",
      html: "<html><head><title>Welcome</title></head><body><p>Hello</p></body></html>",
      headers: new Headers(),
      studioOrigin: "https://studio.example",
    });

    expect(result.status).toBe("no_tools");
    expect(result.tools).toEqual([]);
  });

  test("reports explicit framing restrictions", () => {
    const headers = new Headers({
      "content-security-policy": "frame-ancestors 'none'",
    });
    const result = analyzeExternalHtml({
      url: "https://blocked.example/",
      html: "<html><body>Blocked preview</body></html>",
      headers,
      studioOrigin: "https://studio.example",
    });

    expect(result.frame).toMatchObject({ status: "blocked" });
  });

  test("extracts named form fields and empty labeled controls", () => {
    const result = analyzeExternalHtml({
      url: "https://shop.example/",
      html: `
        <form id="checkout" action="/checkout">
          <input name="email" type="email" required />
          <input name="quantity" type="number" />
        </form>
        <button aria-label="Add to cart"></button>
      `,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "submit_form",
      "add_to_cart",
    ]);
    expect(result.tools[0]?.inputSchema).toMatchObject({
      properties: {
        email: { type: "string" },
        quantity: { type: "number" },
      },
      required: ["email"],
    });
    expect(result.tools[1]?.evidence?.[0]).toMatchObject({
      note: expect.stringContaining("Add to cart"),
    });
  });

  test("requires an exact HTML media type", () => {
    const result = analyzeExternalHtml({
      url: "https://example.com/",
      contentType: "text/htmlfoo; charset=utf-8",
      html: '<form><input name="q" type="search" /></form>',
    });

    expect(result.status).toBe("blocked");
    expect(result.tools).toEqual([]);
  });

  test("follows validated redirects without credentials", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (
      input: RequestInfo | URL,
      init: RequestInit = {},
    ) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      if (calls.length === 1)
        return new Response(null, {
          status: 302,
          headers: { location: "https://shop.example/catalog" },
        });
      return new Response(
        '<html><title>Catalog</title><form><input name="q" type="search" /></form></html>',
        { headers: { "content-type": "text/html; charset=utf-8" } },
      );
    };

    const result = await inspectExternalSite("https://shop.example/", {
      fetchImpl,
      studioOrigin: "https://studio.example",
    });

    expect(result.status).toBe("inspected");
    expect(calls.map((call) => call.url)).toEqual([
      "https://shop.example/",
      "https://shop.example/catalog",
    ]);
    expect(calls[0]?.init).toMatchObject({
      method: "GET",
      redirect: "manual",
      credentials: "omit",
    });
  });

  test("keeps the inspection API same-origin and bounded", async () => {
    const crossOrigin = await handleExternalDiscovery(
      new Request("https://studio.example/api/analyze-external", {
        method: "POST",
        headers: { origin: "https://attacker.example" },
        body: JSON.stringify({ url: "https://example.com/" }),
      }),
    );
    expect(crossOrigin.status).toBe(403);

    const oversized = await handleExternalDiscovery(
      new Request("https://studio.example/api/analyze-external", {
        method: "POST",
        headers: {
          origin: "https://studio.example",
          "content-length": "20000",
        },
        body: JSON.stringify({ url: "https://example.com/" }),
      }),
    );
    expect(oversized.status).toBe(413);
  });

  test("rejects private, credentialed, and non-standard external targets", () => {
    expect(() => validateExternalUrl("http://127.0.0.1/")).toThrow(
      /private|reserved/i,
    );
    expect(() => validateExternalUrl("https://user:pass@example.com/")).toThrow(
      /credentials/i,
    );
    expect(() => validateExternalUrl("https://example.com:8443/")).toThrow(
      /standard web ports/i,
    );
    expect(() =>
      validateExternalUrl("http://example.com/", { requireHttps: true }),
    ).toThrow(/https/i);
    expect(() => validateExternalUrl("https://127.0.0.1.nip.io/")).toThrow(
      /private|reserved/i,
    );
    expect(() => validateExternalUrl("https://[::ffff:ac10:0001]/")).toThrow(
      /private|reserved/i,
    );
  });
});
