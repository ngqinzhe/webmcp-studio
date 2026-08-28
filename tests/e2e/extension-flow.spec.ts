import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

interface DemoTool {
  name: string;
  description?: string;
  execute?: (args: unknown) => Promise<unknown>;
}

interface DemoModelContext {
  getTools?: () => unknown;
}

interface MainRuntimeSnapshot {
  available: boolean;
  registered: string[];
  nativeTools: Array<{ name: string }>;
}

interface StructuredExecutionResult {
  success: boolean;
  status: string;
  stateChanged: boolean;
  navigationOccurred: boolean;
  error?: { code: string; message: string };
}

const extensionPath = resolve(process.cwd(), "dist/extension");
const chromiumPath = chromium.executablePath();
const baseUrl = "http://127.0.0.1:4173";

function hasHeadedBrowserEnvironment(): boolean {
  return process.platform !== "linux" || Boolean(process.env.DISPLAY);
}

async function toolNames(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const context = (document as Document & { modelContext?: DemoModelContext })
      .modelContext;
    const tools = context?.getTools?.();
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((tool) => {
      if (!tool || typeof tool !== "object") return [];
      const name = (tool as { name?: unknown }).name;
      return typeof name === "string" ? [name] : [];
    });
  });
}

async function toolDescription(
  page: Page,
  name: string,
): Promise<string | undefined> {
  return page.evaluate((requestedName) => {
    const context = (document as Document & { modelContext?: DemoModelContext })
      .modelContext;
    const tools = context?.getTools?.();
    if (!Array.isArray(tools)) return undefined;
    const tool = tools.find(
      (candidate): candidate is DemoTool =>
        Boolean(candidate) &&
        typeof candidate === "object" &&
        (candidate as { name?: unknown }).name === requestedName,
    );
    return typeof tool?.description === "string" ? tool.description : undefined;
  }, name);
}

async function mainRuntimeSnapshot(page: Page): Promise<MainRuntimeSnapshot> {
  return page.evaluate(() => {
    const runtime = (
      window as Window & {
        __webmcpStudioMainRuntime?: {
          getStatusSnapshot?: () => MainRuntimeSnapshot;
        };
      }
    ).__webmcpStudioMainRuntime;
    const snapshot = runtime?.getStatusSnapshot?.();
    return snapshot ?? { available: false, registered: [], nativeTools: [] };
  });
}

async function waitForRuntime(page: Page): Promise<void> {
  await expect
    .poll(async () => (await mainRuntimeSnapshot(page)).available, {
      timeout: 12_000,
    })
    .toBe(true);
}

async function waitForTool(page: Page, name: string): Promise<void> {
  await expect.poll(() => toolNames(page), { timeout: 12_000 }).toContain(name);
}

async function waitForMissingTool(page: Page, name: string): Promise<void> {
  await expect
    .poll(() => toolNames(page), { timeout: 12_000 })
    .not.toContain(name);
}

async function invokePageTool(
  page: Page,
  name: string,
  args: Record<string, unknown>,
): Promise<StructuredExecutionResult> {
  return page.evaluate(
    async ({ name: requestedName, args: requestedArgs }) => {
      const context = (
        document as Document & {
          modelContext?: {
            getTools?: () => unknown;
          };
        }
      ).modelContext;
      const tools = context?.getTools?.();
      if (!Array.isArray(tools))
        throw new Error("The demo model context is unavailable.");
      const tool = tools.find(
        (candidate): candidate is DemoTool =>
          Boolean(candidate) &&
          typeof candidate === "object" &&
          (candidate as { name?: unknown }).name === requestedName &&
          typeof (candidate as { execute?: unknown }).execute === "function",
      );
      if (!tool?.execute)
        throw new Error(`Tool ${requestedName} is not registered.`);
      return (await tool.execute(requestedArgs)) as StructuredExecutionResult;
    },
    { name, args },
  );
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

async function serviceWorkerFor(context: BrowserContext) {
  const existing = context.serviceWorkers()[0];
  return existing ?? context.waitForEvent("serviceworker");
}

test.describe("WebMCP Studio extension flow", () => {
  let context: BrowserContext | undefined;

  test.afterEach(async () => {
    await context?.close();
    context = undefined;
  });

  test("relays an inspector invocation through document.modelContext and visible UI", async ({}, testInfo) => {
    context = await launchExtensionContext(
      testInfo.outputPath("chromium-profile"),
    );
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${baseUrl}/search.html`);
    await waitForTool(page, "search_products");

    const serviceWorker = await serviceWorkerFor(context);
    const tabId = await serviceWorker.evaluate(async () => {
      const tabs = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true,
      });
      return tabs[0]?.id ?? null;
    });
    expect(tabId).not.toBeNull();

    const extensionId = new URL(serviceWorker.url()).hostname;
    const inspector = await context.newPage();
    await inspector.goto(
      `chrome-extension://${extensionId}/inspector/index.html?tabId=${String(tabId)}`,
    );
    await expect(inspector.locator("#connection-state")).toHaveText(
      "Live page",
    );
    const searchItem = inspector
      .locator(".capability-item")
      .filter({ hasText: "search_products" });
    await expect(searchItem).toHaveCount(1);
    await searchItem.click();
    await inspector
      .locator("#arguments")
      .fill('{"q":"keyboard","category":"keyboards"}');
    await inspector.locator("#invoke").click();
    await expect(inspector.locator("#execution-result")).toContainText(
      '"success": true',
    );
    await expect(page.locator("#search-status")).toHaveText(
      "Showing results for keyboard (keyboards).",
    );

    const result = await invokePageTool(page, "search_products", {
      q: "headphones",
      category: "audio",
    });
    expect(result.success).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.stateChanged).toBe(true);
    expect(result.navigationOccurred).toBe(false);
    await expect(page.locator("#search-status")).toHaveText(
      "Showing results for headphones (audio).",
    );
  });

  test("registers and invokes contextual ecommerce actions", async ({}, testInfo) => {
    context = await launchExtensionContext(
      testInfo.outputPath("chromium-profile"),
    );
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${baseUrl}/shop.html`);
    await waitForTool(page, "add_to_cart");

    const productCards = page.locator(".product-card");
    await expect(productCards).toHaveCount(2);
    await expect(
      productCards.locator('[data-action="add-to-cart"]'),
    ).toHaveText(["Add to cart", "Add to cart"]);

    const result = await invokePageTool(page, "add_to_cart", {});
    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.stateChanged).toBe(true);
    expect(result.navigationOccurred).toBe(false);
    const addedCard = productCards.filter({ hasText: "Added" });
    await expect(addedCard).toHaveCount(1);
    const selectedProduct = (
      await addedCard.locator("h2").textContent()
    )?.trim();
    expect(selectedProduct).toMatch(/Mechanical Keyboard|Studio Headphones/);
    if (!selectedProduct)
      throw new Error("The contextual add_to_cart tool changed no product.");
    const addButtons = productCards.locator('[data-action="add-to-cart"]');
    await expect(addButtons.filter({ hasText: "Added" })).toHaveCount(1);
    await expect(addButtons.filter({ hasText: "Add to cart" })).toHaveCount(1);
    await expect(page.locator("#cart-count")).toHaveText("1");
    await expect(page.locator("#cart-status")).toHaveText(
      `Added ${selectedProduct} to cart.`,
    );

    const names = await toolNames(page);
    for (const name of names.filter(
      (candidate) =>
        candidate === "add_product" || candidate === "open_product",
    )) {
      const description = await toolDescription(page, name);
      expect(
        description,
        `${name} should identify its product context`,
      ).toMatch(/Mechanical Keyboard|Studio Headphones/);
    }
  });

  test("removes a stale search capability after navigation removes its form", async ({}, testInfo) => {
    context = await launchExtensionContext(
      testInfo.outputPath("chromium-profile"),
    );
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${baseUrl}/stale.html`);
    await waitForTool(page, "search_products");

    await page.locator("#replace-page").click();
    await expect(page).toHaveURL(`${baseUrl}/stale.html?new-state=1`);
    await expect(page.locator("#stale-title")).toHaveText("After navigation");
    await expect(page.locator("#stale-form")).toHaveCount(0);
    await expect(page.locator("#stale-status")).toHaveText(
      "The old form was removed; the graph should unregister it.",
    );
    await waitForMissingTool(page, "search_products");
  });

  test("gracefully degrades without exposing positional weak-semantic tools", async ({}, testInfo) => {
    context = await launchExtensionContext(
      testInfo.outputPath("chromium-profile"),
    );
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${baseUrl}/weak.html`);
    await waitForRuntime(page);

    await expect.poll(() => toolNames(page), { timeout: 12_000 }).toEqual([]);
  });

  test("tracks SPA capability additions and removals", async ({}, testInfo) => {
    context = await launchExtensionContext(
      testInfo.outputPath("chromium-profile"),
    );
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${baseUrl}/spa.html`);
    await waitForMissingTool(page, "change_sort");

    await page.locator("#show-controls").click();
    await waitForTool(page, "change_sort");
    await expect(page.locator("#spa-status")).toHaveText(
      "Basic results loaded.",
    );

    await page.locator("#remove-controls").click();
    await waitForMissingTool(page, "change_sort");
  });

  test("discovers open Shadow DOM and same-origin iframe controls", async ({}, testInfo) => {
    context = await launchExtensionContext(
      testInfo.outputPath("chromium-profile"),
    );
    const page = context.pages()[0] ?? (await context.newPage());

    await page.goto(`${baseUrl}/shadow.html`);
    await waitForTool(page, "search_products");
    const shadowResult = await invokePageTool(page, "search_products", {
      q: "keyboard",
    });
    expect(shadowResult.success).toBe(true);
    await expect(page.locator("#shadow-note")).toHaveText(
      "Shadow search submitted for keyboard.",
    );

    await page.goto(`${baseUrl}/iframe.html`);
    await waitForTool(page, "search_products");
    const frameResult = await invokePageTool(page, "search_products", {
      q: "headphones",
    });
    expect(frameResult.success).toBe(true);
    await expect(
      page.frameLocator("iframe").locator("#frame-status"),
    ).toHaveText("Frame searched for headphones.");
  });

  test("supplements native WebMCP without duplicating an equivalent inferred tool", async ({}, testInfo) => {
    context = await launchExtensionContext(
      testInfo.outputPath("chromium-profile"),
    );
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`${baseUrl}/native.html`);
    await waitForTool(page, "submit_contact_form");

    const names = await toolNames(page);
    expect(names.filter((name) => name === "search_products")).toHaveLength(1);
    expect(names).toContain("submit_contact_form");

    const status = await mainRuntimeSnapshot(page);
    expect(status.nativeTools.map((tool) => tool.name)).toContain(
      "search_products",
    );
    expect(status.registered).not.toContain("search_products");
    expect(status.registered).toContain("submit_contact_form");
  });
});
