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
  const input = page.getByLabel(/site or domain/i).first();
  await expect(input).toBeVisible();
  await input.fill(url);
  const discover = page
    .getByRole("button", { name: /discover tools/i })
    .first();
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
      `#discovery-list .discovery-card[data-name="${name}"], #discovery-list .discovery-card[data-tool-name="${name}"]`,
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
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error("Drag bounds are unavailable.");
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { steps: 12 },
  );
  await page.mouse.up();
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

test.describe("hosted WebMCP Studio focused builder", () => {
  test.describe.configure({ mode: "serial", timeout: 60_000 });

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
      await expect(page.locator("#discovery-list .discovery-card")).toHaveCount(
        5,
      );
      for (const name of primitiveNames) {
        const card = discoveryCard(page, name);
        await assertClassification(card, "native");
      }
      const target = await targetFrameFor(page, "/targets/commerce.html");
      await expect(page.locator("#target-site-name")).toContainText(
        "Northstar Supply",
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

      const nameInput = page.getByLabel("Tool name");
      await nameInput.fill("buy_best_product");
      await expect.poll(() => nameInput.inputValue()).toBe("buy_best_product");
      await page.getByRole("button", { name: /generate tool/i }).click();
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
      await expect(page.locator("#trace-status")).toHaveText("completed");
      const completedTrace = page.locator("#execution-trace .trace-completed");
      await expect(completedTrace).toHaveCount(primitiveNames.length);
      await expect(completedTrace.locator(".trace-name")).toHaveText(
        primitiveNames,
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
      await expect
        .poll(() =>
          page.locator("#execution-result").evaluate((node) => {
            try {
              return JSON.parse(node.textContent ?? "").success === true;
            } catch {
              return false;
            }
          }),
        )
        .toBe(true);
    } finally {
      await context.close();
    }
  });

  test("keeps external discovery inferred and potential-only", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    try {
      await page.goto(`${hostedBaseUrl}/`, { waitUntil: "domcontentloaded" });
      const input = page.getByLabel(/site or domain/i).first();
      await expect(input).toBeVisible();
      await input.fill("https://example.com/catalog");
      await page.getByRole("button", { name: /discover tools/i }).click();
      const card = page.locator("#potential-list .discovery-card").first();
      await expect(card).toBeVisible();
      await assertClassification(card, "inferred");
      await expect(
        card.getByRole("button", { name: /inject into page/i }),
      ).toHaveCount(0);
      await expect(page.locator("#external-note")).toContainText(
        /never inject/i,
      );
      await expect(page.locator("#target-frame")).toBeHidden();
      await expect(page.locator("#target-preview-label")).toHaveText(
        "potential only",
      );
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
      for (const name of primitiveNames) {
        await assertClassification(discoveryCard(page, name), "native");
        await dragPrimitive(page, name);
      }
      await expect(page.locator("#compose-flow .flow-discovery")).toHaveCount(
        primitiveNames.length,
      );
      await page.getByLabel("Tool name").fill("find_best_route");
      await page.getByRole("button", { name: /generate tool/i }).click();
      const generated = await generatedCard(page, "find_best_route");
      const inject = generated.getByRole("button", {
        name: /inject into page/i,
      });
      if (await inject.count()) await inject.click();
      await clickPageAction(page, generated, /run preview/i);

      await expect(page.locator("#trace-status")).toHaveText("completed");
      const trace = page.locator("#execution-trace .trace-completed");
      await expect(trace).toHaveCount(primitiveNames.length);
      for (const name of primitiveNames)
        await expect(trace.filter({ hasText: name })).toBeVisible();
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
