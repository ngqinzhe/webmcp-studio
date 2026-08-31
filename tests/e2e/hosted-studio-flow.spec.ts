import { spawn, type ChildProcess } from "node:child_process";
import { expect, test } from "@playwright/test";

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

function rememberOutput(chunk: unknown): void {
  hostedServerOutput += String(chunk);
  hostedServerOutput = hostedServerOutput.slice(-4_000);
}

function serverFailureDetails(): string {
  const output = hostedServerOutput.trim();
  return hostedServerError?.message || output || "no server output";
}

async function waitForHostedServer(
  url: string,
  child: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  let lastFailure = "not reachable yet";

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `serve-hosted.mjs exited before listening: ${serverFailureDetails()}`,
      );
    }

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

test.beforeAll(async () => {
  // A deployment URL can be supplied for a smoke run. Local E2E runs own the
  // hosted process because playwright.config.ts intentionally remains focused
  // on the extension-era demo server.
  if (process.env.HOSTED_STUDIO_URL) return;

  hostedServer = spawn(process.execPath, ["scripts/serve-hosted.mjs"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOST: managedHost,
      PORT: managedPort,
    },
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

test.describe("hosted WebMCP Studio", () => {
  test.describe.configure({ mode: "serial", timeout: 45_000 });

  test("runs the fresh no-extension buy_best_product demo", async ({
    browser,
  }) => {
    // browser.newContext creates an isolated session with no extension,
    // cookies, or state carried over from another test.
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    // Test-only WebMCP host. Production never installs this object; the
    // fixture lets the E2E exercise the real registerTool/getTools boundary.
    await context.addInitScript(() => {
      const registered = new Map<string, Record<string, unknown>>();
      const modelContext = {
        registerTool(
          tool: Record<string, unknown>,
          options: { signal?: AbortSignal } = {},
        ) {
          const name = typeof tool.name === "string" ? tool.name : "";
          if (!name) return Promise.reject(new Error("Tool name is required."));
          registered.set(name, tool);
          options.signal?.addEventListener(
            "abort",
            () => registered.delete(name),
            { once: true },
          );
          return Promise.resolve();
        },
        getTools() {
          return Array.from(registered.values());
        },
        async executeTool(tool: Record<string, unknown>, input: unknown) {
          const execute = tool.execute;
          if (typeof execute !== "function")
            throw new Error("Tool is not executable.");
          const args = typeof input === "string" ? JSON.parse(input) : input;
          return await (execute as (value: unknown) => unknown)(args);
        },
      };
      Object.defineProperty(document, "modelContext", {
        configurable: true,
        value: modelContext,
      });
    });
    const page = await context.newPage();

    try {
      await page.goto(`${hostedBaseUrl}/`, { waitUntil: "domcontentloaded" });
      await expect(page).toHaveTitle(/WebMCP Studio/i);

      await page
        .getByRole("button", { name: "Try the 60-second demo" })
        .click();

      const discoveryCards = page.locator("#discovery-list .discovery-card");
      await expect(discoveryCards.first()).toBeVisible({ timeout: 20_000 });
      await expect(page.locator("#discovery-count")).toContainText("found");
      await expect(page.locator("#native-status")).toContainText(
        "WebMCP live",
        { timeout: 10_000 },
      );

      const availableNames = await page
        .locator("#discovery-list input.discovery-check")
        .evaluateAll((inputs) =>
          inputs.flatMap((input) => {
            const name = input.getAttribute("data-name");
            return name ? [name] : [];
          }),
        );
      const detailName = availableNames.includes("get_product_details")
        ? "get_product_details"
        : "get_product";
      const primitiveNames = [
        "search_products",
        "filter_products",
        detailName,
        "add_to_cart",
      ];
      for (const name of [
        "search_products",
        "filter_products",
        detailName,
        "add_to_cart",
      ]) {
        await expect(
          page.locator(
            `#discovery-list input.discovery-check[data-name="${name}"]`,
          ),
        ).toHaveCount(1);
      }

      // The demo preselects a useful default, but this explicitly exercises
      // the judge-facing choice step before composing the workflow.
      const checkboxes = page.locator("#discovery-list input.discovery-check");
      for (let index = 0; index < (await checkboxes.count()); index += 1) {
        const checkbox = checkboxes.nth(index);
        if (await checkbox.isChecked()) await checkbox.uncheck();
      }
      for (const name of primitiveNames) {
        await page
          .locator(`#discovery-list input.discovery-check[data-name="${name}"]`)
          .check();
      }

      const composeButton = page.getByRole("button", {
        name: "Compose workflow",
      });
      await expect(composeButton).toBeEnabled();
      await composeButton.click();
      await expect(page.locator("#compose-flow .flow-discovery")).toHaveCount(
        primitiveNames.length,
      );
      for (const name of primitiveNames) {
        await expect(page.locator("#compose-flow")).toContainText(name);
      }

      await page.getByLabel("Tool name").fill("buy_best_product");
      const generateButton = page.getByRole("button", {
        name: /Generate tool/,
      });
      await expect(generateButton).toBeEnabled();
      await generateButton.click();

      const generatedTool = page
        .locator("#generated-list .generated-tool")
        .filter({ hasText: "buy_best_product" });
      await expect(generatedTool).toBeVisible();
      const agentResult = await page.evaluate(async () => {
        const context = (
          document as Document & {
            modelContext?: {
              getTools?: () => unknown;
              executeTool?: (tool: unknown, input: unknown) => Promise<unknown>;
            };
          }
        ).modelContext;
        const tools = context?.getTools?.();
        if (!Array.isArray(tools)) throw new Error("No native WebMCP tools.");
        const tool = tools.find(
          (candidate) =>
            candidate &&
            typeof candidate === "object" &&
            (candidate as { name?: unknown }).name === "buy_best_product",
        );
        if (!tool || !context?.executeTool)
          throw new Error("Generated WebMCP tool was not registered.");
        return await context.executeTool(
          tool,
          JSON.stringify({
            requirements: "keyboard",
            max_price: 200,
            quantity: 1,
          }),
        );
      });
      expect(agentResult).toMatchObject({
        success: true,
        toolName: "buy_best_product",
        stateChanged: true,
      });

      await expect(page.locator("#trace-status")).toHaveText("completed");
      const completedTrace = page.locator("#execution-trace .trace-completed");
      await expect(completedTrace).toHaveCount(primitiveNames.length);
      for (const name of primitiveNames) {
        await expect(completedTrace.filter({ hasText: name })).toBeVisible();
      }

      const target = page.frameLocator("#target-frame");
      await expect(target.locator("#details")).toBeVisible({ timeout: 20_000 });
      await expect(target.locator("#details-name")).toContainText(/keyboard/i);
      await expect(target.locator("#cart-count")).toHaveText("1");

      await expect(page.locator("#execution-result")).toContainText(
        '"success":true',
      );
    } finally {
      await context.close();
    }
  });

  test("runs the controlled travel target without an extension", async ({
    browser,
  }) => {
    const context = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();

    try {
      await page.goto(`${hostedBaseUrl}/`, { waitUntil: "domcontentloaded" });
      await page.getByRole("button", { name: "Travel" }).click();
      await expect(page.locator("#target-site-name")).toHaveText(
        "Skyline Travel",
      );
      const discoveryCards = page.locator("#discovery-list .discovery-card");
      await expect(discoveryCards.first()).toBeVisible({ timeout: 20_000 });

      const primitiveNames = [
        "search_options",
        "filter_options",
        "get_details",
        "select_option",
      ];
      for (const name of primitiveNames) {
        await expect(
          page.locator(
            `#discovery-list input.discovery-check[data-name="${name}"]`,
          ),
        ).toHaveCount(1);
      }
      const checkboxes = page.locator("#discovery-list input.discovery-check");
      for (let index = 0; index < (await checkboxes.count()); index += 1) {
        const checkbox = checkboxes.nth(index);
        if (await checkbox.isChecked()) await checkbox.uncheck();
      }
      for (const name of primitiveNames)
        await page
          .locator(`#discovery-list input.discovery-check[data-name="${name}"]`)
          .check();

      await page.getByRole("button", { name: "Compose workflow" }).click();
      await expect(page.locator("#compose-flow .flow-discovery")).toHaveCount(
        primitiveNames.length,
      );
      await page.getByLabel("Tool name").fill("find_best_route");
      await page.getByRole("button", { name: /Generate tool/ }).click();
      const generatedTool = page
        .locator("#generated-list .generated-tool")
        .filter({ hasText: "find_best_route" });
      await expect(generatedTool).toBeVisible();
      await generatedTool.getByRole("button", { name: "Test tool" }).click();

      await expect(page.locator("#trace-status")).toHaveText("completed");
      await expect(
        page.locator("#execution-trace .trace-completed"),
      ).toHaveCount(primitiveNames.length);
      const target = page.frameLocator("#target-frame");
      await expect(target.locator("#details")).toBeVisible({ timeout: 20_000 });
      await expect(target.locator("#details-route")).toContainText(
        /Singapore.*Tokyo/,
      );
      await expect(target.locator("#trip-status")).toContainText("selected");
      await expect(page.locator("#execution-result")).toContainText(
        '"success":true',
      );
    } finally {
      await context.close();
    }
  });
});
