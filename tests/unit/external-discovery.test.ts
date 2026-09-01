import {
  analyzeExternalHtml,
  handleExternalDiscovery,
  inspectExternalSite,
  validateExternalUrl,
} from "../../scripts/external-discovery.mjs";

describe("external discovery", () => {
  test("discovers semantic commerce tools from production-like markup", () => {
    const result = analyzeExternalHtml({
      url: "https://shop.example/catalog",
      html: `
        <html>
          <head><title>Acme Store</title></head>
          <body>
            <header>
              <form id="site-search" class="search-form" aria-label="Search products">
                <label for="search">Search products</label>
                <input id="search" name="q" type="search" placeholder="Search products" />
                <button type="submit" aria-label="Search products">Search</button>
              </form>
              <a href="/cart" aria-label="Cart (0)">Cart</a>
            </header>
            <aside>
              <form id="filters" class="product-filters" aria-label="Filter products">
                <label for="category">Category</label>
                <select id="category" name="category">
                  <option value="all">All</option>
                  <option value="keyboards">Keyboards</option>
                </select>
                <label for="max-price">Maximum price</label>
                <input id="max-price" name="max_price" type="range" min="0" max="500" />
                <label><input name="in_stock" type="checkbox" /> In stock</label>
                <label for="sort">Sort by</label>
                <select id="sort" name="sort_by">
                  <option value="rating">Top rated</option>
                  <option value="price">Price</option>
                </select>
                <button type="submit" data-action="apply-filters">Apply filters</button>
              </form>
            </aside>
            <main class="product-grid">
              <article class="product-card" data-product-id="product-1">
                <h2>Atlas Mechanical Keyboard</h2>
                <a href="/products/product-1" aria-label="View product details">Details</a>
                <button type="button" data-action="add_to_cart" aria-label="Add Atlas to cart">Add</button>
                <button type="button" aria-label="Add Atlas to wishlist">Save</button>
              </article>
              <article class="product-card" data-product-id="product-2">
                <h2>Orbit Desk Lamp</h2>
                <a href="/products/product-2" aria-label="View product details">Details</a>
                <button type="button" aria-label="Add Orbit to cart">Add</button>
              </article>
            </main>
            <nav aria-label="Catalog pagination">
              <button type="button" aria-label="Next page">Next</button>
            </nav>
          </body>
        </html>
      `,
    });

    const names = result.tools.map((tool) => tool.name);
    expect(result.status).toBe("inspected");
    expect(names).toEqual(
      expect.arrayContaining([
        "search_products",
        "filter_products",
        "change_sort",
        "view_cart",
        "get_product",
        "add_to_cart",
        "view_wishlist",
        "next_page",
      ]),
    );
    expect(names.length).toBeGreaterThanOrEqual(8);
    expect(
      result.tools.find((tool) => tool.name === "search_products")?.inputSchema,
    ).toMatchObject({
      properties: { q: { type: "string" } },
      required: ["q"],
    });
    expect(
      result.tools.find((tool) => tool.name === "filter_products")?.inputSchema,
    ).toMatchObject({
      properties: {
        category: { type: "string", enum: ["all", "keyboards"] },
        max_price: { type: "number", minimum: 0, maximum: 500 },
        in_stock: { type: "boolean" },
      },
    });
    expect(
      result.tools.find((tool) => tool.name === "add_to_cart")?.inputSchema,
    ).toMatchObject({
      properties: {
        productId: { type: "string" },
        quantity: { type: "integer", minimum: 1 },
      },
      required: ["productId"],
    });
    expect(
      result.tools.find((tool) => tool.name === "get_product")?.evidence,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "dom",
          selector: expect.stringContaining("product-1"),
        }),
      ]),
    );
  });

  test("discovers travel search and option tools from ARIA and card evidence", () => {
    const result = analyzeExternalHtml({
      url: "https://travel.example/flights",
      html: `
        <html>
          <head><title>Skyline Flights</title></head>
          <body>
            <form id="flight-search" class="booking-search" aria-label="Search flights">
              <div role="group" aria-label="Trip details">
                <input name="origin" aria-label="From" placeholder="Singapore" required />
                <input name="destination" aria-label="To" placeholder="Tokyo" required />
              </div>
              <input name="depart" type="date" aria-label="Departure date" required />
              <select name="passengers" aria-label="Passengers">
                <option value="1">1 passenger</option>
                <option value="2">2 passengers</option>
              </select>
              <button type="submit" aria-label="Search available flights">Search</button>
            </form>
            <section aria-label="Available flight options">
              <article class="flight-card" data-option-id="flight-123">
                <h2>Singapore to Tokyo</h2>
                <button type="button" role="button" data-action="select-option">Select flight</button>
                <a href="/flights/flight-123" aria-label="View flight details">Details</a>
              </article>
            </section>
            <a href="/itinerary" aria-label="View itinerary">Itinerary</a>
          </body>
        </html>
      `,
    });

    const names = result.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "search_options",
        "select_option",
        "get_details",
        "view_itinerary",
      ]),
    );
    expect(
      result.tools.find((tool) => tool.name === "search_options")?.inputSchema,
    ).toMatchObject({
      properties: {
        origin: { type: "string" },
        destination: { type: "string" },
        depart: { type: "string", format: "date" },
        passengers: { type: "string", enum: ["1", "2"] },
      },
      required: expect.arrayContaining(["origin", "destination", "depart"]),
    });
    expect(
      result.tools.find((tool) => tool.name === "select_option")?.inputSchema,
    ).toMatchObject({
      properties: { optionId: { type: "string" } },
      required: ["optionId"],
    });
  });

  test("reads multiple inline native declarations without executing page code", () => {
    const result = analyzeExternalHtml({
      url: "https://native.example/catalog",
      html: `
        <html>
          <head><title>Native catalog</title></head>
          <body>
            <script type="module">
              const ignored = "navigator.modelContext.provideTool({ name: 'fake' })";
              window.navigator.modelContext.provideTool({
                name: "search_products",
                description: "Search the product catalog.",
                inputSchema: {
                  type: "object",
                  properties: {
                    query: { type: "string", minLength: 1 },
                    limit: { type: "integer", minimum: 1 }
                  },
                  required: ["query"]
                },
                execute: async (input) => fetch('/search', { body: JSON.stringify(input) })
              });
              document.modelContext.registerTool({
                name: "view_cart",
                description: "View the cart.",
                inputSchema: { type: "object", properties: {} }
              });
            </script>
          </body>
        </html>
      `,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual([
      "search_products",
      "view_cart",
    ]);
    expect(result.tools.every((tool) => tool.source === "manual")).toBe(true);
    expect(result.tools[0]?.inputSchema).toMatchObject({
      properties: {
        query: { type: "string" },
        limit: { type: "integer" },
      },
      required: ["query"],
    });
    expect(result.tools[0]?.evidence?.[0]).toMatchObject({
      type: "manual",
      selector: "script",
    });
  });

  test("uses ARIA and data attributes for card actions without running page code", () => {
    const result = analyzeExternalHtml({
      url: "https://shop.example/products",
      html: `
        <main>
          <div class="product-card" data-product-id="p-7">
            <span aria-label="Wireless keyboard">Wireless keyboard</span>
            <div role="button" aria-label="View product details">Open</div>
            <button data-testid="add-to-cart-button">Add</button>
          </div>
          <button aria-label="Load more results">More</button>
        </main>
      `,
    });

    expect(result.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["get_product", "add_to_cart", "next_page"]),
    );
    expect(
      result.tools.find((tool) => tool.name === "get_product")?.evidence,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ selector: expect.stringContaining("p-7") }),
      ]),
    );
  });

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

  test("extracts actionable HTML from an HTTP challenge response", () => {
    const result = analyzeExternalHtml({
      url: "https://reddit.example/",
      status: 403,
      contentType: "text/html; charset=utf-8",
      headers: new Headers({ "x-frame-options": "SAMEORIGIN" }),
      html: `
        <html>
          <head><title>Prove your humanity</title></head>
          <body>
            <form method="post">
              <input name="solution" type="hidden" />
              <button type="submit">Continue</button>
            </form>
          </body>
        </html>
      `,
      studioOrigin: "https://studio.example",
    });

    expect(result.status).toBe("inspected");
    expect(result.tools.map((tool) => tool.name)).toContain("submit_form");
    expect(result.note).toContain("HTTP 403");
    expect(result.previewHtml).toContain("Prove your humanity");
    expect(result.previewHtml).not.toMatch(/<script|onclick=/i);
  });

  test("retries inference against normalized challenge markup", () => {
    const result = analyzeExternalHtml({
      url: "https://reddit.example/",
      html: `
        <html>
          <head><title>Prove your humanity</title></head>
          <body>
            <form hidden method="get">
              <input type="hidden" name="token" />
            </form >
          </body>
        </html>
      `,
      headers: new Headers({ "x-frame-options": "SAMEORIGIN" }),
      studioOrigin: "https://studio.example",
    });

    expect(result.tools.map((tool) => tool.name)).toContain("submit_form");
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

  test("keeps a non-2xx HTML body available for evidence extraction", async () => {
    const result = await inspectExternalSite("https://challenge.example/", {
      studioOrigin: "https://studio.example",
      fetchImpl: async () =>
        new Response(
          '<html><title>Challenge</title><form><input name="token" /></form></html>',
          {
            status: 429,
            headers: {
              "content-type": "text/html; charset=utf-8",
              "x-frame-options": "SAMEORIGIN",
            },
          },
        ),
    });

    expect(result.status).toBe("inspected");
    expect(result.tools.map((tool) => tool.name)).toContain("submit_form");
    expect(result.note).toContain("HTTP 429");
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
