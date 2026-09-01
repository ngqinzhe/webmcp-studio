import { spawn, type ChildProcess } from "node:child_process";
import { expect, test, type Frame, type Page } from "@playwright/test";

const repositoryRoot = process.cwd();
const managedHost = process.env.HOSTED_E2E_HOST ?? "127.0.0.1";
const managedPort = process.env.HOSTED_E2E_PORT ?? "4177";
const configuredBaseUrl =
  process.env.HOSTED_STUDIO_URL ??
  `http://${managedHost.includes(":") ? `[${managedHost}]` : managedHost}:${managedPort}`;
const hostedBaseUrl = configuredBaseUrl.replace(/\/+$/, "");

let hostedServer: ChildProcess | undefined;
let hostedServerOutput = "";
let hostedServerError: Error | undefined;

interface ModelContextTool {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  execute?: (args: unknown) => Promise<unknown> | unknown;
}

interface ModelContextSnapshot {
  contextAvailable: boolean;
  toolFound: boolean;
  hasExecute: boolean;
  inputSchema: unknown;
}

interface WebMcpTestHostState {
  invocations: string[];
  executeToolCalls: string[];
}

interface ExternalToolFixture {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: Record<string, unknown>;
  source: "dom";
  confidence: number;
  evidence: Array<{
    type: "dom";
    selector: string;
    note: string;
  }>;
}

interface ToolListLayoutSnapshot {
  overflowY: string;
  panelOverflowY: string;
  clientHeight: number;
  scrollHeight: number;
  listBottom: number;
  panelBottom: number;
  cardBottoms: number[];
  schemaBottoms: number[];
}

const externalSnapshotHtml = `
<!doctype html>
<html>
  <head><title>Example Catalog</title></head>
  <body>
    <h1>Example Catalog</h1>
    <form id="search-form">
      <label>Search <input name="query" type="search" /></label>
      <button type="submit">Search</button>
    </form>
    <ul id="results">
      <li data-product="keyboard">Mechanical keyboard · $49</li>
      <li data-product="mouse">Wireless mouse · $29</li>
    </ul>
    <button id="add-button" type="button">Add keyboard to cart</button>
    <span id="cart-count">0</span>
  </body>
</html>`;

function inferredExternalTool(
  name: string,
  description: string,
  inputSchema: Record<string, unknown>,
  selector: string,
  options: { destructive?: boolean; note?: string } = {},
): ExternalToolFixture {
  return {
    name,
    description,
    inputSchema,
    annotations: options.destructive
      ? { destructiveHint: true }
      : { readOnlyHint: true },
    source: "dom",
    confidence: 0.76,
    evidence: [
      {
        type: "dom",
        selector,
        note: options.note ?? `Observed evidence for ${name}.`,
      },
    ],
  };
}

function inferredCommerceTools(): ExternalToolFixture[] {
  return [
    inferredExternalTool(
      "search_products",
      "Potentially search the visible product catalog.",
      {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      "#search-form",
      { note: "Observed a product search form." },
    ),
    inferredExternalTool(
      "add_to_cart",
      "Potentially add the selected product to the cart.",
      {
        type: "object",
        properties: {
          productId: { type: "string" },
          quantity: { type: "integer", minimum: 1, default: 1 },
        },
        required: ["productId", "quantity"],
        additionalProperties: false,
      },
      "#add-button",
      { destructive: true, note: "Observed an add-to-cart action." },
    ),
  ];
}

function externalInspectionPayload(
  tools: readonly ExternalToolFixture[],
  previewHtml = externalSnapshotHtml,
): Record<string, unknown> {
  return {
    status: "inspected",
    url: "https://example.com/catalog",
    title: "Example Catalog",
    tools,
    frame: {
      status: "blocked",
      reason: "The site only allows framing by its own origin.",
    },
    note: "Fetched page evidence produced potential tools.",
    previewHtml,
  };
}

async function mockExternalInspection(
  page: Page,
  tools: readonly ExternalToolFixture[],
  previewHtml = externalSnapshotHtml,
): Promise<void> {
  await page.route("**/api/analyze-external", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(externalInspectionPayload(tools, previewHtml)),
    });
  });
}

async function measureToolList(
  page: Page,
  selector: string,
): Promise<ToolListLayoutSnapshot> {
  return page.evaluate((listSelector) => {
    const list = document.querySelector<HTMLElement>(listSelector);
    if (!list) throw new Error(`Tool list ${listSelector} was not found.`);
    const cards = Array.from(
      list.querySelectorAll<HTMLElement>(".discovery-card"),
    );
    if (cards.length === 0)
      throw new Error(`Tool list ${listSelector} is empty.`);
    const listRect = list.getBoundingClientRect();
    const panel = list.closest<HTMLElement>(".discovery-panel");
    const cardBottoms = cards.map(
      (card) => card.getBoundingClientRect().bottom,
    );
    const schemaBottoms = cards.map((card) => {
      const schema = card.querySelector<HTMLElement>(".discovery-schema");
      if (!schema)
        throw new Error(`A card in ${listSelector} is missing its schema.`);
      return schema.getBoundingClientRect().bottom;
    });
    return {
      overflowY: getComputedStyle(list).overflowY,
      panelOverflowY: panel ? getComputedStyle(panel).overflowY : "visible",
      clientHeight: list.clientHeight,
      scrollHeight: list.scrollHeight,
      listBottom: listRect.bottom,
      panelBottom: panel?.getBoundingClientRect().bottom ?? listRect.bottom,
      cardBottoms,
      schemaBottoms,
    };
  }, selector);
}

function expectToolListNotClipped(layout: ToolListLayoutSnapshot): void {
  expect(layout.overflowY).not.toMatch(/auto|scroll/i);
  expect(layout.panelOverflowY).not.toMatch(/hidden|auto|scroll/i);
  expect(layout.clientHeight).toBeGreaterThanOrEqual(layout.scrollHeight);
  for (const bottom of layout.cardBottoms)
    expect(bottom).toBeLessThanOrEqual(layout.listBottom + 1);
  for (const bottom of layout.schemaBottoms)
    expect(bottom).toBeLessThanOrEqual(layout.listBottom + 1);
  expect(Math.max(...layout.cardBottoms)).toBeLessThanOrEqual(
    layout.panelBottom + 1,
  );
}

declare global {
  interface Window {
    __webmcpTestHost?: WebMcpTestHostState;
  }
}

function rememberOutput(chunk: unknown): void {
  hostedServerOutput += String(chunk);
  hostedServerOutput = hostedServerOutput.slice(-4_000);
}

function serverFailureDetails(): string {
  return (
    hostedServerError?.message ||
    hostedServerOutput.trim() ||
    "no server output"
  );
}

async function waitForHostedServer(
  url: string,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastFailure = "not reachable yet";
  while (Date.now() < deadline) {
    if (child.exitCode !== null)
      throw new Error(
        `serve-hosted.mjs exited before listening: ${serverFailureDetails()}`,
      );
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 750);
    try {
      const response = await fetch(`${url}/`, { signal: controller.signal });
      if (response.ok) {
        await response.text();
        return;
      }
      lastFailure = `HTTP ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(abortTimer);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out waiting for ${url}/ (${lastFailure}). Server output: ${serverFailureDetails()}`,
  );
}

async function stopHostedServer(): Promise<void> {
  const child = hostedServer;
  hostedServer = undefined;
  if (!child || child.exitCode !== null) return;
  await new Promise<void>((resolve) => {
    const forceStopTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
      resolve();
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(forceStopTimer);
      resolve();
    });
    if (child.exitCode === null) child.kill("SIGTERM");
  });
}

async function installSyntheticNativeHost(
  context: import("@playwright/test").BrowserContext,
): Promise<void> {
  // This is a test-only native host. It supplies the WebMCP registration
  // boundary in every document while keeping the browser context extension-free.
  await context.addInitScript(() => {
    type HostTool = {
      name?: unknown;
      description?: unknown;
      inputSchema?: unknown;
      execute?: (args: unknown) => Promise<unknown> | unknown;
    };
    const registered = new Map<string, HostTool>();
    const invocations: string[] = [];
    const executeToolCalls: string[] = [];
    const modelContext = {
      registerTool(tool: HostTool, options: { signal?: AbortSignal } = {}) {
        const name = typeof tool.name === "string" ? tool.name : "";
        if (!name) return Promise.reject(new Error("Tool name is required."));
        const wrapped: HostTool = {
          ...tool,
          execute: async (args: unknown) => {
            invocations.push(name);
            if (typeof tool.execute !== "function")
              throw new Error(`Tool ${name} is not executable.`);
            return await tool.execute(args);
          },
        };
        registered.set(name, wrapped);
        options.signal?.addEventListener(
          "abort",
          () => {
            if (registered.get(name) === wrapped) registered.delete(name);
          },
          { once: true },
        );
        return Promise.resolve(true);
      },
      unregisterTool(name: string) {
        registered.delete(name);
      },
      getTools() {
        return Array.from(registered.values());
      },
      async executeTool(tool: HostTool, input: unknown) {
        if (typeof tool.execute !== "function")
          throw new Error("Tool is not executable.");
        if (typeof tool.name === "string") executeToolCalls.push(tool.name);
        const args = typeof input === "string" ? JSON.parse(input) : input;
        return await tool.execute(args);
      },
    };
    Object.defineProperty(window, "__webmcpTestHost", {
      configurable: true,
      value: { invocations, executeToolCalls },
    });
    Object.defineProperty(document, "modelContext", {
      configurable: true,
      value: modelContext,
    });
  });
}

async function modelContextToolNames(surface: Page | Frame): Promise<string[]> {
  return surface.evaluate(() => {
    const context =
      (navigator as Navigator & { modelContext?: { getTools?: () => unknown } })
        .modelContext ??
      (document as Document & { modelContext?: { getTools?: () => unknown } })
        .modelContext;
    const tools = context?.getTools?.();
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((tool) => {
      if (!tool || typeof tool !== "object") return [];
      const name = (tool as ModelContextTool).name;
      return typeof name === "string" ? [name] : [];
    });
  });
}

async function waitForModelContextTool(
  surface: Page | Frame,
  name: string,
): Promise<void> {
  await expect
    .poll(() => modelContextToolNames(surface), { timeout: 20_000 })
    .toContain(name);
}

async function inspectModelContextTool(
  surface: Page | Frame,
  name: string,
): Promise<ModelContextSnapshot> {
  return surface.evaluate((requestedName) => {
    const context =
      (navigator as Navigator & { modelContext?: { getTools?: () => unknown } })
        .modelContext ??
      (document as Document & { modelContext?: { getTools?: () => unknown } })
        .modelContext;
    const tools = context?.getTools?.();
    const tool = Array.isArray(tools)
      ? tools.find(
          (candidate): candidate is ModelContextTool =>
            Boolean(candidate) &&
            typeof candidate === "object" &&
            (candidate as ModelContextTool).name === requestedName,
        )
      : undefined;
    return {
      contextAvailable: Boolean(context),
      toolFound: Boolean(tool),
      hasExecute: typeof tool?.execute === "function",
      inputSchema: tool?.inputSchema ?? null,
    };
  }, name);
}

async function invokeModelContextTool(
  surface: Page | Frame,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return surface.evaluate(
    async ({ requestedName, input }) => {
      const context =
        (
          navigator as Navigator & {
            modelContext?: {
              getTools?: () => unknown;
              executeTool?: (tool: unknown, value: unknown) => unknown;
            };
          }
        ).modelContext ??
        (
          document as Document & {
            modelContext?: {
              getTools?: () => unknown;
              executeTool?: (tool: unknown, value: unknown) => unknown;
            };
          }
        ).modelContext;
      const tools = context?.getTools?.();
      const tool = Array.isArray(tools)
        ? tools.find(
            (candidate) =>
              candidate &&
              typeof candidate === "object" &&
              (candidate as ModelContextTool).name === requestedName,
          )
        : undefined;
      const execute = (tool as ModelContextTool | undefined)?.execute;
      if (!tool || typeof execute !== "function")
        throw new Error(`WebMCP tool ${requestedName} is not executable.`);
      if (typeof context?.executeTool === "function")
        return await context.executeTool(tool, JSON.stringify(input));
      return await execute(input);
    },
    { requestedName: name, input: args },
  );
}

async function hostInvocations(surface: Page | Frame): Promise<string[]> {
  return surface.evaluate(() => window.__webmcpTestHost?.invocations ?? []);
}

async function hostExecuteToolCalls(surface: Page | Frame): Promise<string[]> {
  return surface.evaluate(
    () => window.__webmcpTestHost?.executeToolCalls ?? [],
  );
}

async function targetFrameFor(page: Page, pathname: string): Promise<Frame> {
  let targetFrame: Frame | undefined;
  await expect
    .poll(
      () => {
        targetFrame = page
          .frames()
          .find((frame) => frame.url().includes(pathname));
        return Boolean(targetFrame);
      },
      { timeout: 20_000 },
    )
    .toBe(true);
  if (!targetFrame) throw new Error(`Target frame ${pathname} was not found.`);
  return targetFrame;
}

async function discoverSite(page: Page, url: string): Promise<void> {
  const input = page.locator("#site-url");
  await expect(input).toBeVisible();
  await input.fill(url);
  const discover = page.locator("#discover-button");
  await expect(discover).toBeEnabled();
  await discover.click();
  await expect(
    page.locator("#discovery-list .discovery-card").first(),
  ).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.locator("#discovery-count")).toContainText("found");
}

function discoveryCard(page: Page, name: string) {
  return page
    .locator(
      `#discovery-list .discovery-card[data-name="${name}"], #discovery-list .discovery-card[data-tool-name="${name}"], #potential-list .discovery-card[data-name="${name}"], #potential-list .discovery-card[data-tool-name="${name}"]`,
    )
    .first();
}

async function assertClassification(
  card: ReturnType<typeof discoveryCard>,
  classification: "native" | "inferred",
): Promise<void> {
  const badge = card
    .locator(
      `[data-classification="${classification}"], [data-provenance="${classification}"], .classification-badge.badge-${classification}, .classification-badge.${classification}`,
    )
    .first();
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText(new RegExp(`^${classification}$`, "i"));
  await expect(badge).toHaveClass(new RegExp(`\\bbadge-${classification}\\b`));
  await expect(badge).toHaveAttribute("data-classification", classification);
  await expect(badge).toHaveAttribute(
    "data-tone",
    classification === "native" ? "green" : "yellow",
  );
}

async function dragPrimitive(page: Page, name: string): Promise<void> {
  const card = discoveryCard(page, name);
  await expect(card).toBeVisible();
  const handle = card
    .locator('[data-drag-handle], .drag-handle, [draggable="true"]')
    .first();
  const draggable = await card.getAttribute("draggable");
  expect((await handle.count()) > 0 || draggable === "true").toBe(true);
  const source = (await handle.count()) > 0 ? handle : card;
  const target = page.locator(".dropzone-callout").first();
  await target.scrollIntoViewIfNeeded();
  await source.dragTo(target);
}

async function generatedCard(page: Page, name: string) {
  const card = page
    .locator("#generated-list .generated-tool")
    .filter({ hasText: name })
    .first();
  await expect(card).toBeVisible();
  return card;
}

async function clickPageAction(
  page: Page,
  card: ReturnType<typeof generatedCard> extends Promise<infer T> ? T : never,
  action: RegExp,
): Promise<void> {
  const button = card.getByRole("button", { name: action }).first();
  await expect(button).toBeVisible();
  await button.click();
}

test.beforeAll(async () => {
  if (process.env.HOSTED_STUDIO_URL) return;
  hostedServer = spawn(process.execPath, ["scripts/serve-hosted.mjs"], {
    cwd: repositoryRoot,
    env: { ...process.env, HOST: managedHost, PORT: managedPort },
    stdio: ["ignore", "pipe", "pipe"],
  });
  hostedServer.stdout?.on("data", rememberOutput);
  hostedServer.stderr?.on("data", rememberOutput);
  hostedServer.on("error", (error) => {
    hostedServerError = error;
  });
  try {
    await waitForHostedServer(hostedBaseUrl, hostedServer);
  } catch (error) {
    await stopHostedServer();
    throw error;
  }
});

test.afterAll(async () => {
  await stopHostedServer();
});

test.describe("hosted WebMCP Studio builder", () => {
  test.describe.configure({ mode: "serial", timeout: 60_000 });

  test("exposes invokable Studio WebMCP controls on the top-level page", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    await installSyntheticNativeHost(context);
    const page = await context.newPage();
    try {
      await page.goto(`${hostedBaseUrl}/`, { waitUntil: "domcontentloaded" });
      for (const name of [
        "discover_site_tools",
        "inspect_tool",
        "compose_workflow",
        "generate_tool",
        "list_generated_tools",
        "execute_workflow",
      ])
        await waitForModelContextTool(page, name);
      await waitForModelContextTool(page, "search_products");

      const discovered = await invokeModelContextTool(
        page,
        "discover_site_tools",
        { target: "commerce" },
      );
      expect(discovered).toMatchObject({
        target: { id: "commerce" },
        tools: expect.arrayContaining([
          expect.objectContaining({ name: "search_products" }),
          expect.objectContaining({ name: "add_to_cart" }),
        ]),
      });

      const inspected = await invokeModelContextTool(page, "inspect_tool", {
        name: "search_products",
      });
      expect(inspected).toMatchObject({
        found: true,
        provenance: "native",
        tool: { name: "search_products" },
      });

      const primitiveNames = [
        "search_products",
        "filter_products",
        "get_product",
        "add_to_cart",
      ];
      const composed = await invokeModelContextTool(page, "compose_workflow", {
        primitiveNames,
      });
      expect(composed).toMatchObject({ valid: true, primitiveNames });

      const generated = await invokeModelContextTool(page, "generate_tool", {
        name: "agent_buy_best_product",
        description: "Find the best matching product and add it to the cart.",
        primitiveNames,
      });
      expect(generated).toMatchObject({
        success: true,
        native: true,
        name: "agent_buy_best_product",
      });

      const listed = await invokeModelContextTool(
        page,
        "list_generated_tools",
        {},
      );
      expect(listed).toMatchObject({
        tools: [expect.objectContaining({ name: "agent_buy_best_product" })],
      });

      const executed = await invokeModelContextTool(page, "execute_workflow", {
        name: "agent_buy_best_product",
        input: { requirements: "keyboard", max_price: 200, quantity: 1 },
      });
      expect(executed).toMatchObject({
        success: true,
        toolName: "agent_buy_best_product",
        stateChanged: true,
      });

      const target = await targetFrameFor(page, "/targets/commerce.html");
      await expect(target.locator("#cart-count")).toHaveText("1");
      await expect(target.locator("#details-name")).toContainText(/keyboard/i);
      await expect
        .poll(() => hostExecuteToolCalls(page))
        .toEqual(
          expect.arrayContaining([
            "discover_site_tools",
            "inspect_tool",
            "compose_workflow",
            "generate_tool",
            "list_generated_tools",
            "execute_workflow",
          ]),
        );
    } finally {
      await context.close();
    }
  });

  test("discovers, composes, injects, and tests a generated page tool without an extension", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    await installSyntheticNativeHost(context);
    const page = await context.newPage();
    try {
      await page.goto(`${hostedBaseUrl}/`, { waitUntil: "domcontentloaded" });
      await expect(page).toHaveTitle(/WebMCP Studio/i);
      await expect.poll(() => context.serviceWorkers()).toHaveLength(0);
      await expect(page.locator(".pipeline")).toHaveCount(0);
      await expect(page.getByText(/OpenAI WebMCP Hackathon/i)).toHaveCount(0);
      await expect(
        page.getByText(/focused builder|one useful tool out/i),
      ).toHaveCount(0);
      await expect(page.locator("#execution-trace, #trace-status")).toHaveCount(
        0,
      );

      for (const name of [
        "discover_site_tools",
        "inspect_tool",
        "compose_workflow",
        "generate_tool",
        "list_generated_tools",
        "execute_workflow",
      ])
        await waitForModelContextTool(page, name);
      await expect(page.locator("#native-status")).toContainText(
        /WebMCP live/i,
      );

      await discoverSite(page, `${hostedBaseUrl}/targets/commerce.html`);
      const primitiveNames = [
        "search_products",
        "filter_products",
        "get_product",
        "add_to_cart",
      ];
      const discoveredNames = [...primitiveNames, "view_cart"];
      await expect(page.locator("#discovery-list .discovery-card")).toHaveCount(
        discoveredNames.length,
      );
      for (const name of discoveredNames) {
        const card = discoveryCard(page, name);
        await assertClassification(card, "native");
      }
      const target = await targetFrameFor(page, "/targets/commerce.html");
      await expect(page.locator("#target-site-name")).toContainText(
        "Northstar Supply",
      );

      // The selected page's native primitives are mirrored onto Studio's own
      // WebMCP context so an agent can invoke them without reaching into the
      // iframe directly.
      await waitForModelContextTool(page, "search_products");
      const directResult = await invokeModelContextTool(
        page,
        "search_products",
        {
          query: "keyboard",
        },
      );
      expect(directResult).toMatchObject({
        ok: true,
        query: "keyboard",
        stateChanged: true,
      });
      await expect(target.locator("#status")).toContainText(/Found 1 product/i);
      await expect(target.locator("#result-count")).toHaveText(
        /1 (?:match|product)/i,
      );

      for (const name of primitiveNames) {
        await dragPrimitive(page, name);
        await expect(page.locator("#compose-flow .flow-discovery")).toHaveCount(
          primitiveNames.indexOf(name) + 1,
        );
      }
      await expect(
        page.locator("#compose-flow .flow-discovery strong"),
      ).toHaveText(primitiveNames);

      const nameInput = page.locator("#tool-name");
      await nameInput.fill("buy_best_product");
      await expect.poll(() => nameInput.inputValue()).toBe("buy_best_product");
      await page.locator("#generate-button").click();
      const generated = await generatedCard(page, "buy_best_product");
      await waitForModelContextTool(page, "buy_best_product");
      await expect(generated).toContainText("awaiting page publication");

      await clickPageAction(page, generated, /inject into page/i);
      await waitForModelContextTool(target, "buy_best_product");
      expect(
        await inspectModelContextTool(target, "buy_best_product"),
      ).toMatchObject({
        contextAvailable: true,
        toolFound: true,
        hasExecute: true,
      });
      await expect(generated).toContainText("injected · native");

      await clickPageAction(page, generated, /^test webmcp$/i);
      await expect(page.locator("#composer-message")).toContainText(
        /test passed/i,
      );

      await expect(target.locator("#details")).toBeVisible({ timeout: 20_000 });
      await expect(target.locator("#details-name")).toContainText(/keyboard/i);
      await expect(target.locator("#cart-count")).toHaveText("1");
      await expect
        .poll(() => hostInvocations(target))
        .toContain("buy_best_product");
      await expect
        .poll(() => hostExecuteToolCalls(target))
        .toContain("buy_best_product");
    } finally {
      await context.close();
    }
  });

  test("uses fetched evidence for external discovery and shows the external preview boundary", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    try {
      await page.goto(`${hostedBaseUrl}/`, { waitUntil: "domcontentloaded" });
      const input = page.locator("#site-url");
      await expect(input).toBeVisible();
      await input.fill("https://example.com/booking/catalog");
      await page.locator("#discover-button").click();
      // URL words alone must not create a canned catalog/travel inventory.
      await expect(page.locator("#site-status")).not.toContainText(
        /Inspecting .*external tools remain potential-only/i,
        { timeout: 20_000 },
      );
      await expect(page.locator("#potential-list .discovery-card")).toHaveCount(
        0,
        { timeout: 20_000 },
      );
      await expect(page.locator("#site-status")).toContainText(
        /inferred potential tools|did not expose|inspection unavailable|external/i,
      );
      await expect(page.locator("#target-frame")).toBeVisible();
      await expect(page.locator("#target-preview-label")).toHaveText(
        "external preview",
      );
    } finally {
      await context.close();
    }
  });

  test("drags inferred external tools into a potential workflow proposal", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    await page.route("**/api/analyze-external", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          status: "inspected",
          url: "https://example.com/catalog",
          title: "Example Catalog",
          tools: [
            {
              name: "search_content",
              description: "Potentially search the visible catalog.",
              inputSchema: {
                type: "object",
                properties: { query: { type: "string" } },
                required: ["query"],
                additionalProperties: false,
              },
              annotations: { readOnlyHint: true },
              source: "dom",
              confidence: 0.76,
              evidence: [
                {
                  type: "dom",
                  selector: "#search-form",
                  note: "Observed a search-like field.",
                },
              ],
            },
            {
              name: "view_cart",
              description: "Potentially open the visible cart.",
              inputSchema: {
                type: "object",
                properties: {},
                additionalProperties: false,
              },
              annotations: { readOnlyHint: true },
              source: "dom",
              confidence: 0.7,
              evidence: [
                {
                  type: "dom",
                  selector: "#cart-link",
                  note: "Observed a cart link.",
                },
              ],
            },
          ],
          frame: {
            status: "blocked",
            reason: "The site only allows framing by its own origin.",
          },
          note: "Fetched page evidence produced potential tools.",
          previewHtml:
            '<html><body><h1>Example Catalog</h1><form id="search-form"><input name="query" type="search"></form></body></html>',
        }),
      });
    });
    try {
      await page.goto(`${hostedBaseUrl}/`, { waitUntil: "domcontentloaded" });
      await page.locator("#site-url").fill("https://example.com/catalog");
      await page.locator("#discover-button").click();

      await expect(page.locator("#potential-list .discovery-card")).toHaveCount(
        2,
      );
      const inferred = discoveryCard(page, "search_content");
      await assertClassification(inferred, "inferred");
      await expect(inferred).toHaveAttribute("draggable", "true");
      await expect(inferred.locator("[data-drag-handle]")).toBeVisible();

      await dragPrimitive(page, "search_content");
      await expect(page.locator("#compose-flow .flow-discovery")).toHaveCount(
        1,
      );
      await expect(
        page.locator("#compose-flow .flow-discovery[data-name=search_content]"),
      ).toHaveAttribute("data-provenance", "inferred");
      await expect(page.locator("#composer-message")).toContainText(
        /Added search_content to the workflow/i,
      );
      await expect(page.locator("#inject-button")).toBeDisabled();
    } finally {
      await context.close();
    }
  });

  test("saves and executes a custom tool composed from inferred external tools", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    await installSyntheticNativeHost(context);
    const page = await context.newPage();
    await mockExternalInspection(page, inferredCommerceTools());
    try {
      await page.goto(`${hostedBaseUrl}/`, { waitUntil: "domcontentloaded" });
      await page.locator("#site-url").fill("https://example.com/catalog");
      await page.locator("#discover-button").click();

      const tools = inferredCommerceTools();
      await expect(page.locator("#potential-list .discovery-card")).toHaveCount(
        tools.length,
      );
      for (const tool of tools) {
        await assertClassification(discoveryCard(page, tool.name), "inferred");
        await dragPrimitive(page, tool.name);
      }
      await expect(page.locator("#compose-flow .flow-discovery")).toHaveCount(
        tools.length,
      );
      await expect(
        page.locator("#compose-flow .flow-discovery[data-provenance=inferred]"),
      ).toHaveCount(tools.length);

      await page.locator("#tool-name").fill("buy_inferred_product");
      await expect(page.locator("#generate-button")).toBeEnabled();
      await page.locator("#generate-button").click();

      const generated = await generatedCard(page, "buy_inferred_product");
      await expect(page.locator("#composer-message")).toContainText(
        /Saved buy_inferred_product for this session/i,
      );
      await expect(generated).toContainText("2 steps");
      await expect(page.locator("#generated-count")).toContainText("1 ready");
      await waitForModelContextTool(page, "buy_inferred_product");
      const listed = await invokeModelContextTool(
        page,
        "list_generated_tools",
        {},
      );
      expect(listed).toMatchObject({
        tools: [expect.objectContaining({ name: "buy_inferred_product" })],
      });

      const snapshot = page.frameLocator("#target-frame");
      await expect(page.locator("#target-preview-label")).toHaveText(
        "interactive snapshot",
      );
      await expect(snapshot.locator("#cart-count")).toHaveText("0");

      await waitForModelContextTool(page, "execute_workflow");
      const executed = await invokeModelContextTool(page, "execute_workflow", {
        name: "buy_inferred_product",
        input: { query: "keyboard", quantity: 1 },
      });
      expect(executed).toMatchObject({
        success: true,
        toolName: "buy_inferred_product",
        stateChanged: true,
      });
      await expect(snapshot.locator("#cart-count")).toHaveText("1");
      await expect
        .poll(() => hostExecuteToolCalls(page))
        .toContain("execute_workflow");
      await expect(
        snapshot.locator("#webmcp-studio-preview-status"),
      ).toHaveText(
        /Inferred preview ran add_to_cart on this safe page snapshot/i,
      );
      await expect(snapshot.locator("#add-button")).toHaveAttribute(
        "data-webmcp-studio-preview-tool",
        "add_to_cart",
      );
    } finally {
      await context.close();
    }
  });

  test("runs an inferred tool preview and visibly updates the external snapshot", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    await installSyntheticNativeHost(context);
    const page = await context.newPage();
    await mockExternalInspection(page, inferredCommerceTools());
    try {
      await page.goto(`${hostedBaseUrl}/`, { waitUntil: "domcontentloaded" });
      await page.locator("#site-url").fill("https://example.com/catalog");
      await page.locator("#discover-button").click();
      await expect(page.locator("#target-preview-label")).toHaveText(
        "interactive snapshot",
      );

      const snapshot = page.frameLocator("#target-frame");
      await expect(snapshot.locator("#cart-count")).toHaveText("0");
      await expect(
        snapshot.locator("#webmcp-studio-preview-status"),
      ).toHaveCount(0);

      for (const tool of inferredCommerceTools())
        await dragPrimitive(page, tool.name);
      await page.locator("#tool-name").fill("buy_inferred_preview");
      await page.locator("#generate-button").click();
      const generated = await generatedCard(page, "buy_inferred_preview");

      await waitForModelContextTool(page, "buy_inferred_preview");
      const agentResult = await invokeModelContextTool(
        page,
        "buy_inferred_preview",
        { query: "keyboard", quantity: 1 },
      );
      expect(agentResult).toMatchObject({
        success: true,
        stateChanged: true,
      });
      await expect(snapshot.locator("#cart-count")).toHaveText("1");
      await expect(
        snapshot.locator("#webmcp-studio-preview-status"),
      ).toContainText(/Inferred preview ran/i);

      await clickPageAction(page, generated, /run preview/i);

      await expect(page.locator("#composer-message")).toContainText(
        /test passed/i,
      );
      await expect(
        snapshot.locator("#webmcp-studio-preview-status"),
      ).toContainText(/Inferred preview ran/i);
      await expect(
        snapshot.locator('[data-webmcp-studio-preview-tool="add_to_cart"]'),
      ).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("keeps external page injection clearly unavailable for inferred tools", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    await installSyntheticNativeHost(context);
    const page = await context.newPage();
    await mockExternalInspection(page, inferredCommerceTools());
    try {
      await page.goto(`${hostedBaseUrl}/`, { waitUntil: "domcontentloaded" });
      await page.locator("#site-url").fill("https://example.com/catalog");
      await page.locator("#discover-button").click();
      for (const tool of inferredCommerceTools())
        await dragPrimitive(page, tool.name);
      await page.locator("#tool-name").fill("external_proposal");
      await page.locator("#generate-button").click();
      const generated = await generatedCard(page, "external_proposal");

      await expect(page.locator("#inject-button")).toBeDisabled();
      await expect(
        generated.getByRole("button", { name: /Inject needs extension/i }),
      ).toBeDisabled();
      await expect(page.locator("#injection-help")).toContainText(
        /external|potential|extension|preview/i,
      );
      await expect(page.locator("#target-frame")).toHaveAttribute(
        "sandbox",
        "allow-scripts",
      );
      await expect(page.locator("#target-preview-label")).toHaveText(
        "interactive snapshot",
      );
    } finally {
      await context.close();
    }
  });

  test("keeps long discovery and potential tool lists within their containers", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    const longTools = Array.from({ length: 8 }, (_, index) =>
      inferredExternalTool(
        `catalog_action_${String(index + 1).padStart(2, "0")}`,
        `Potential catalog action ${index + 1}.`,
        {
          type: "object",
          properties: { query: { type: "string" } },
          additionalProperties: false,
        },
        "#search-form",
      ),
    );
    await mockExternalInspection(page, longTools);
    try {
      await page.goto(`${hostedBaseUrl}/`, { waitUntil: "domcontentloaded" });
      await page.locator("#site-url").fill("https://example.com/catalog");
      await page.locator("#discover-button").click();
      await expect(page.locator("#potential-list .discovery-card")).toHaveCount(
        longTools.length,
      );
      expectToolListNotClipped(await measureToolList(page, "#potential-list"));

      await discoverSite(page, `${hostedBaseUrl}/targets/commerce.html`);
      await expect(page.locator("#discovery-list .discovery-card")).toHaveCount(
        5,
      );
      expectToolListNotClipped(await measureToolList(page, "#discovery-list"));
    } finally {
      await context.close();
    }
  });

  test("uses the explicit preview action when native WebMCP is unavailable", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    try {
      await page.goto(`${hostedBaseUrl}/`, { waitUntil: "domcontentloaded" });
      await discoverSite(page, `${hostedBaseUrl}/targets/travel.html`);
      const primitiveNames = [
        "search_options",
        "filter_options",
        "get_details",
        "select_option",
      ];
      const discoveredNames = [...primitiveNames, "view_itinerary"];
      await expect(page.locator("#discovery-list .discovery-card")).toHaveCount(
        discoveredNames.length,
      );
      for (const name of discoveredNames)
        await assertClassification(discoveryCard(page, name), "native");
      for (const name of primitiveNames) {
        await dragPrimitive(page, name);
      }
      await expect(page.locator("#compose-flow .flow-discovery")).toHaveCount(
        primitiveNames.length,
      );
      await page.locator("#tool-name").fill("find_best_route");
      await page.locator("#generate-button").click();
      const generated = await generatedCard(page, "find_best_route");
      await clickPageAction(page, generated, /run preview/i);

      await expect(page.locator("#composer-message")).toContainText(
        /test passed/i,
      );
      await expect(generated).toContainText("generated · ready");
      await expect(generated).not.toContainText("page preview handler");
      const target = await targetFrameFor(page, "/targets/travel.html");
      await expect(target.locator("#details")).toBeVisible({ timeout: 20_000 });
      await expect(target.locator("#details-route")).toContainText(
        /Singapore.*Tokyo/,
      );
      await expect(target.locator("#trip-status")).toContainText("selected");
    } finally {
      await context.close();
    }
  });
});
