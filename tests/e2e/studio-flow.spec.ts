import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
  type Worker,
} from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

interface ModelContextTool {
  name?: unknown;
  description?: unknown;
  inputSchema?: unknown;
  execute?: (args: unknown) => Promise<unknown> | unknown;
}

interface ModelContext {
  getTools?: () => unknown;
  executeTool?: (tool: unknown, input: unknown) => Promise<unknown>;
}

interface StructuredExecutionResult {
  success: boolean;
  status: string;
  stateChanged: boolean;
  navigationOccurred: boolean;
}

interface StudioProject {
  site: { domain: string };
  discoveredActions: Array<{ name: string; status: string }>;
  tools: Array<{ name: string; enabled: boolean }>;
}

interface StudioProjectRead {
  project: StudioProject;
  revision: number;
  activeProject: { toolNames: string[] } | null;
}

declare global {
  interface Window {
    webmcpInvocationLog?: string[];
  }
}

const extensionPath = resolve(process.cwd(), "dist/extension");
const chromiumPath = chromium.executablePath();
const baseUrl = "http://127.0.0.1:4173";

function hasHeadedBrowserEnvironment(): boolean {
  return process.platform !== "linux" || Boolean(process.env.DISPLAY);
}

async function launchExtensionContext(
  profilePath: string,
): Promise<BrowserContext> {
  test.skip(
    !existsSync(extensionPath),
    "Build dist/extension before running E2E.",
  );
  test.skip(!existsSync(chromiumPath), "Playwright Chromium is not installed.");
  test.skip(
    !hasHeadedBrowserEnvironment(),
    "MV3 extension E2E requires a headed Chromium display on Linux.",
  );

  return chromium.launchPersistentContext(profilePath, {
    executablePath: chromiumPath,
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
}

async function serviceWorkerFor(context: BrowserContext): Promise<Worker> {
  const existing = context.serviceWorkers()[0];
  return existing ?? context.waitForEvent("serviceworker");
}

async function targetTabId(
  context: BrowserContext,
  initialWorker: Worker,
  targetUrl: string,
): Promise<number> {
  let resolvedId: number | null = null;
  const readTarget = async (): Promise<number | null> => {
    const workers = context.serviceWorkers();
    // MV3 workers can be suspended and recreated while a test is waiting for
    // the page/extension lifecycle to settle. Resolve the current handle for
    // every poll instead of retaining a worker whose execution context may
    // already have been destroyed.
    const worker = workers[0] ?? initialWorker;
    try {
      return await worker.evaluate(
        ({ exactUrl, urlPrefix }) =>
          chrome.tabs
            .query({})
            .then(
              (tabs) =>
                tabs.find((tab) => tab.url === exactUrl)?.id ??
                tabs.find((tab) => tab.url?.startsWith(urlPrefix))?.id ??
                null,
            ),
        { exactUrl: targetUrl, urlPrefix: baseUrl },
      );
    } catch {
      // A worker can be restarted between serviceWorkers() and evaluate().
      // Let expect.poll retry against the next current worker.
      return null;
    }
  };
  await expect
    .poll(
      async () => {
        resolvedId = await readTarget();
        return resolvedId;
      },
      { timeout: 12_000 },
    )
    .not.toBeNull();
  if (resolvedId === null) throw new Error("The demo tab was not found.");
  return resolvedId;
}

async function pageToolNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const context =
      (navigator as Navigator & { modelContext?: ModelContext }).modelContext ??
      (document as Document & { modelContext?: ModelContext }).modelContext;
    const tools = context?.getTools?.();
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((tool) => {
      if (!tool || typeof tool !== "object") return [];
      const name = (tool as ModelContextTool).name;
      return typeof name === "string" ? [name] : [];
    });
  });
}

async function waitForPageTool(page: Page, name: string): Promise<void> {
  await expect
    .poll(() => pageToolNames(page), { timeout: 12_000 })
    .toContain(name);
}

async function inspectPageTool(
  page: Page,
  name: string,
): Promise<{
  contextAvailable: boolean;
  toolFound: boolean;
  hasExecute: boolean;
  inputSchema: unknown;
}> {
  return page.evaluate((requestedName) => {
    const context =
      (navigator as Navigator & { modelContext?: ModelContext }).modelContext ??
      (document as Document & { modelContext?: ModelContext }).modelContext;
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

/** Invoke exactly as a WebMCP consumer does: discover a tool, then call execute. */
async function invokePageTool(
  page: Page,
  name: string,
  args: Record<string, unknown>,
): Promise<StructuredExecutionResult> {
  return page.evaluate(
    async ({ requestedName, requestedArgs }) => {
      const context =
        (navigator as Navigator & { modelContext?: ModelContext })
          .modelContext ??
        (document as Document & { modelContext?: ModelContext }).modelContext;
      const tools = context?.getTools?.();
      if (!Array.isArray(tools))
        throw new Error("The page has no discoverable WebMCP tools.");
      const tool = tools.find(
        (candidate): candidate is ModelContextTool =>
          Boolean(candidate) &&
          typeof candidate === "object" &&
          (candidate as ModelContextTool).name === requestedName &&
          typeof (candidate as ModelContextTool).execute === "function",
      );
      if (!tool?.execute)
        throw new Error(`WebMCP tool ${requestedName} is not registered.`);
      return (await tool.execute(requestedArgs)) as StructuredExecutionResult;
    },
    { requestedName: name, requestedArgs: args },
  );
}

/** Exercise the compatibility host's imperative model-context entry point. */
async function invokePageToolViaHost(
  page: Page,
  name: string,
  args: Record<string, unknown>,
): Promise<StructuredExecutionResult> {
  return page.evaluate(
    async ({ requestedName, requestedArgs }) => {
      const context =
        (navigator as Navigator & { modelContext?: ModelContext })
          .modelContext ??
        (document as Document & { modelContext?: ModelContext }).modelContext;
      const tools = context?.getTools?.();
      if (!Array.isArray(tools))
        throw new Error("The page has no discoverable WebMCP tools.");
      const tool = tools.find(
        (candidate): candidate is ModelContextTool =>
          Boolean(candidate) &&
          typeof candidate === "object" &&
          (candidate as ModelContextTool).name === requestedName,
      );
      if (!tool) throw new Error(`WebMCP tool ${requestedName} is missing.`);
      if (typeof context?.executeTool === "function")
        return (await context.executeTool(
          tool,
          JSON.stringify(requestedArgs),
        )) as StructuredExecutionResult;
      if (typeof tool.execute === "function")
        return (await tool.execute(requestedArgs)) as StructuredExecutionResult;
      throw new Error(`WebMCP tool ${requestedName} is not executable.`);
    },
    { requestedName: name, requestedArgs: args },
  );
}

async function invokeStudioTool<T>(
  page: Page,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  return page.evaluate(
    async ({ requestedName, requestedArgs }) => {
      const context =
        (navigator as Navigator & { modelContext?: ModelContext })
          .modelContext ??
        (document as Document & { modelContext?: ModelContext }).modelContext;
      const tools = context?.getTools?.();
      if (!Array.isArray(tools))
        throw new Error("The Studio model context is unavailable.");
      const tool = tools.find(
        (candidate): candidate is ModelContextTool =>
          Boolean(candidate) &&
          typeof candidate === "object" &&
          (candidate as ModelContextTool).name === requestedName &&
          typeof (candidate as ModelContextTool).execute === "function",
      );
      if (!tool?.execute)
        throw new Error(`Studio WebMCP tool ${requestedName} is missing.`);
      return (await tool.execute(requestedArgs)) as T;
    },
    { requestedName: name, requestedArgs: args },
  );
}

async function openStudio(
  context: BrowserContext,
  worker: Worker,
  tabId: number,
): Promise<Page> {
  const extensionId = new URL(worker.url()).hostname;
  const inspector = await context.newPage();
  await inspector.goto(
    `chrome-extension://${extensionId}/inspector/index.html?tabId=${String(tabId)}`,
  );
  await expect(inspector.locator("#studio-tab-status")).toHaveText("Connected");
  await expect(inspector.locator("#studio-domain-display")).toHaveText(
    "127.0.0.1",
  );
  await expect
    .poll(() => pageToolNames(inspector), { timeout: 12_000 })
    .toContain("get_studio_guide");
  return inspector;
}

async function waitForDiscoveries(inspector: Page, count = 2): Promise<void> {
  await expect(inspector.locator(".discovery-card")).toHaveCount(count, {
    timeout: 12_000,
  });
  await expect(inspector.locator("#studio-status")).toContainText(
    "Automatically captured",
  );
}

test.describe("WebMCP Studio discovery-first authoring", () => {
  let context: BrowserContext | undefined;

  test.afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  test("creates multiple drag-and-drop flows and invokes them through WebMCP", async ({}, testInfo) => {
    context = await launchExtensionContext(
      testInfo.outputPath(`chromium-profile-${Date.now().toString(36)}`),
    );
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${baseUrl}/compat.html`);
    await waitForPageTool(page, "search_products");
    await waitForPageTool(page, "change_sort");

    const worker = await serviceWorkerFor(context);
    const tabId = await targetTabId(context, worker, page.url());
    const inspector = await openStudio(context, worker, tabId);

    // This surface is intentionally discovery-first; no manual capture or
    // project controls are used anywhere in this test.
    await waitForDiscoveries(inspector);
    await expect(inspector.locator("#studio-domain")).toBeHidden();
    await expect(inspector.locator("#studio-outcome")).toBeHidden();
    await expect(inspector.locator("#studio-discover")).toBeHidden();
    await expect(inspector.locator("#studio-export")).toBeHidden();
    await expect(inspector.locator("#studio-import")).toBeHidden();

    const initialProject = await invokeStudioTool<StudioProjectRead>(
      inspector,
      "read_project",
      {},
    );
    expect(initialProject.project.site.domain).toBe("127.0.0.1");
    expect(
      initialProject.project.discoveredActions.map((action) => action.name),
    ).toEqual(expect.arrayContaining(["search_products", "change_sort"]));

    const searchCard = inspector
      .locator(".discovery-card")
      .filter({ hasText: "search_products" });
    const sortCard = inspector
      .locator(".discovery-card")
      .filter({ hasText: "change_sort" });
    await searchCard.dragTo(inspector.locator("#studio-compose-flow"));
    await sortCard.dragTo(inspector.locator("#studio-compose-flow"));
    await expect(inspector.locator(".flow-discovery")).toHaveCount(2);
    await expect(inspector.locator("#studio-compose-flow")).toContainText(
      "search_products",
    );
    await expect(inspector.locator("#studio-compose-flow")).toContainText(
      "change_sort",
    );

    await inspector.locator(".discovery-card").evaluateAll((cards) => {
      cards.forEach((card, index) => {
        card.setAttribute("data-regression-key", `card-${index}`);
      });
    });
    await inspector.locator(".flow-discovery").evaluateAll((rows) => {
      rows.forEach((row, index) => {
        row.setAttribute("data-regression-key", `row-${index}`);
      });
    });
    await inspector.locator("#studio-tool-name").fill("catalog");
    await expect
      .poll(() =>
        inspector
          .locator(".discovery-card")
          .evaluateAll((cards) =>
            cards.map((card) => card.getAttribute("data-regression-key")),
          ),
      )
      .toEqual(["card-0", "card-1"]);
    await expect
      .poll(() =>
        inspector
          .locator(".flow-discovery")
          .evaluateAll((rows) =>
            rows.map((row) => row.getAttribute("data-regression-key")),
          ),
      )
      .toEqual(["row-0", "row-1"]);

    await inspector
      .locator(".flow-discovery")
      .nth(1)
      .dragTo(inspector.locator(".flow-discovery").first(), {
        targetPosition: { x: 12, y: 4 },
      });
    await expect
      .poll(() => inspector.locator(".flow-discovery strong").allTextContents())
      .toEqual(["change_sort", "search_products"]);
    await inspector
      .locator(".flow-discovery")
      .first()
      .dragTo(inspector.locator(".flow-discovery").nth(1), {
        targetPosition: { x: 12, y: 54 },
      });
    await expect
      .poll(() => inspector.locator(".flow-discovery strong").allTextContents())
      .toEqual(["search_products", "change_sort"]);

    await inspector
      .locator("#studio-tool-name")
      .fill("catalog_search_and_sort");
    await expect(inspector.locator("#studio-save-inject")).toBeEnabled();
    await inspector.locator("#studio-save-inject").click();
    await expect(inspector.locator("#studio-status")).toContainText(
      "Saved and injected catalog_search_and_sort",
      { timeout: 12_000 },
    );
    await expect(inspector.locator("#studio-tab-status")).toHaveText("Active");
    await waitForPageTool(page, "catalog_search_and_sort");

    expect(
      await inspectPageTool(page, "catalog_search_and_sort"),
    ).toMatchObject({
      contextAvailable: true,
      toolFound: true,
      hasExecute: true,
    });
    expect(await page.evaluate(() => window.webmcpInvocationLog ?? [])).toEqual(
      [],
    );

    // The agent path only inspects document.modelContext and calls the
    // registered handler; it does not select or submit the page DOM itself.
    const firstResult = await invokePageTool(page, "catalog_search_and_sort", {
      q: "keyboard",
      sort: "price-low",
    });
    expect(firstResult.success, JSON.stringify(firstResult)).toBe(true);
    expect(firstResult.status).toBe("completed");
    expect(firstResult.stateChanged).toBe(true);
    expect(firstResult.navigationOccurred).toBe(false);
    expect(await page.evaluate(() => window.webmcpInvocationLog ?? [])).toEqual(
      ["catalog_search_and_sort"],
    );
    await expect(page.locator("#compat-status")).toHaveText(
      "Sorted products by price-low.",
    );

    // Reuse the discovered sort action to make a second independent flow and
    // exercise the compatibility host's imperative WebMCP entry point too.
    const firstFlowRow = inspector.locator(".flow-discovery").first();
    await firstFlowRow.locator('[title="Remove from flow"]').click();
    await expect(inspector.locator(".flow-discovery")).toHaveCount(1);
    await inspector.locator("#studio-tool-name").fill("catalog_sort_only");
    await inspector.locator("#studio-save-inject").click();
    await expect(inspector.locator("#studio-status")).toContainText(
      "Saved and injected catalog_sort_only",
      { timeout: 12_000 },
    );
    await waitForPageTool(page, "catalog_sort_only");

    const secondResult = await invokePageToolViaHost(
      page,
      "catalog_sort_only",
      {
        sort: "relevance",
      },
    );
    expect(secondResult.success, JSON.stringify(secondResult)).toBe(true);
    expect(secondResult.status).toBe("completed");
    expect(await page.evaluate(() => window.webmcpInvocationLog ?? [])).toEqual(
      ["catalog_search_and_sort", "catalog_sort_only"],
    );
    await expect(page.locator("#compat-status")).toHaveText(
      "Sorted products by relevance.",
    );

    const activeProject = await invokeStudioTool<StudioProjectRead>(
      inspector,
      "read_project",
      {},
    );
    expect(activeProject.project.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["catalog_search_and_sort", "catalog_sort_only"]),
    );
    expect(activeProject.activeProject?.toolNames).toEqual(
      expect.arrayContaining(["catalog_search_and_sort", "catalog_sort_only"]),
    );
  });

  test("automatically rediscovers the current page after Studio reload", async ({}, testInfo) => {
    context = await launchExtensionContext(
      testInfo.outputPath(`chromium-profile-${Date.now().toString(36)}`),
    );
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${baseUrl}/compat.html`);
    await waitForPageTool(page, "search_products");
    const worker = await serviceWorkerFor(context);
    const tabId = await targetTabId(context, worker, page.url());
    const inspector = await openStudio(context, worker, tabId);

    await waitForDiscoveries(inspector);
    await inspector.reload();
    await expect(inspector.locator("#studio-tab-status")).toHaveText(
      "Connected",
    );
    await waitForDiscoveries(inspector);
    await expect(inspector.locator("#studio-discoveries")).toContainText(
      "search_products",
    );
    await expect(inspector.locator("#studio-discoveries")).toContainText(
      "change_sort",
    );
  });
});
