import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBridgeMessage } from "../../core/bridge-protocol";
import { MainWorldWebMcpRuntime } from "../../extension/main-world/runtime";
import type {
  Capability,
  ExpectedOutcome,
  SemanticLocator,
} from "../../core/types";
import type { WebMcpToolRegistration } from "../../extension/main-world/runtime";

const TOKEN = "test-token-123456";
const locator: SemanticLocator = {
  framePath: [],
  shadowPath: [],
  stableAttributes: [],
  fallbacks: [],
};
const expected: ExpectedOutcome = { event: "click" };

function capability(overrides: Partial<Capability> = {}): Capability {
  return {
    id: "search-capability",
    name: "search_products",
    description: "Search products.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
    },
    effect: "read",
    confidence: 0.9,
    source: {
      type: "inferred",
      url: "https://example.test",
      framePath: [],
      shadowPath: [],
    },
    locator,
    executor: { kind: "read", target: locator, expected },
    ...overrides,
  };
}

function setModelContext(value: unknown): void {
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value,
    writable: true,
  });
}

function message(data: unknown): MessageEvent<unknown> {
  return new MessageEvent("message", { data, source: window });
}

function initMessage() {
  return createBridgeMessage(TOKEN, { type: "init", token: TOKEN });
}

function completedResult() {
  return {
    success: true as const,
    status: "completed" as const,
    urlBefore: "https://example.test",
    urlAfter: "https://example.test",
    navigationOccurred: false,
    stateChanged: true,
    result: { matched: "search" },
    warnings: [],
  };
}

describe("MAIN-world WebMCP runtime", () => {
  beforeEach(() => {
    delete (document as Document & { modelContext?: unknown }).modelContext;
  });

  it("reports an unavailable document model context without throwing", async () => {
    const runtime = new MainWorldWebMcpRuntime({
      window,
      document,
      token: TOKEN,
    });
    const status = await runtime.syncCapabilities([capability()]);

    expect(status.available).toBe(false);
    expect(status.registered).toEqual([]);
  });

  it("registers through document.modelContext and bridges tool execution", async () => {
    const tools = new Map<string, WebMcpToolRegistration>();
    const context = {
      provideTool(tool: WebMcpToolRegistration) {
        tools.set(tool.name, tool);
      },
      unregisterTool(name: string) {
        tools.delete(name);
      },
      getTools() {
        return [];
      },
    };
    setModelContext(context);

    const posts: unknown[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((data) => {
      posts.push(data);
    });
    const runtime = new MainWorldWebMcpRuntime({ window, document }).start();

    await runtime.handleMessage(message(initMessage()));
    const sync = createBridgeMessage(TOKEN, {
      type: "sync-tools",
      capabilities: [capability()],
      enabled: true,
    });
    await runtime.handleMessage(message(sync));

    expect([...tools.keys()]).toEqual(["search_products"]);
    expect(runtime.getStatusSnapshot().apiMethods).toContain("provideTool");
    expect(runtime.getStatusSnapshot().registered).toEqual(["search_products"]);

    const registered = tools.get("search_products");
    expect(registered).toBeDefined();
    const execution = registered!.execute({ query: "keyboard" });
    const invoke = posts.find(
      (value): value is { payload: { type: string; requestId: string } } =>
        typeof value === "object" &&
        value !== null &&
        "payload" in value &&
        (value as { payload?: { type?: unknown } }).payload?.type === "invoke",
    );
    expect(invoke?.payload.requestId).toBeTypeOf("string");

    await runtime.handleMessage(
      message({
        channel: "webmcp-studio",
        version: 1,
        direction: "from-main",
        token: TOKEN,
        messageId: "response-1",
        payload: {
          type: "invoke-result",
          requestId: invoke!.payload.requestId,
          result: completedResult(),
        },
      }),
    );

    await expect(execution).resolves.toEqual(completedResult());
    runtime.stop();
  });

  it("updates changed descriptors and unregisters stale tools", async () => {
    const tools = new Map<string, WebMcpToolRegistration>();
    const unregistered: string[] = [];
    const updated: string[] = [];
    const context = {
      provideTool(tool: WebMcpToolRegistration) {
        tools.set(tool.name, tool);
      },
      updateTool(name: string, tool: WebMcpToolRegistration) {
        updated.push(name);
        tools.set(name, tool);
      },
      unregisterTool(name: string) {
        unregistered.push(name);
        tools.delete(name);
      },
      getTools() {
        return [];
      },
    };
    setModelContext(context);
    const runtime = new MainWorldWebMcpRuntime({
      window,
      document,
      token: TOKEN,
    });

    await runtime.syncCapabilities([capability()]);
    await runtime.syncCapabilities([
      capability({ description: "Search all available products." }),
    ]);
    expect(updated).toEqual(["search_products"]);
    expect(tools.get("search_products")?.description).toBe(
      "Search all available products.",
    );

    await runtime.syncCapabilities([]);
    expect(unregistered).toEqual(["search_products"]);
    expect(runtime.getStatusSnapshot().registered).toEqual([]);
  });

  it("deduplicates a native tool discovered from the model context", async () => {
    const context = {
      provideTool: vi.fn(),
      getTools() {
        return [{ name: "search_products", description: "Native search." }];
      },
    };
    setModelContext(context);
    const runtime = new MainWorldWebMcpRuntime({ window, document });

    const status = await runtime.syncCapabilities([capability()]);

    expect(context.provideTool).not.toHaveBeenCalled();
    expect(status.nativeTools).toEqual([
      { name: "search_products", description: "Native search." },
    ]);
    expect(status.registered).toEqual([]);
  });

  it("surfaces registration rejection and ignores a wrong bridge token", async () => {
    const context = {
      provideTool() {
        throw new Error("Permissions Policy denied model context registration");
      },
      getTools() {
        return [];
      },
    };
    setModelContext(context);
    const posts: unknown[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((data) => {
      posts.push(data);
    });
    const runtime = new MainWorldWebMcpRuntime({
      window,
      document,
      token: TOKEN,
    });

    await runtime.handleMessage(
      message(
        createBridgeMessage("wrong-token", {
          type: "init",
          token: "wrong-token",
        }),
      ),
    );
    expect(posts).toEqual([]);

    await runtime.handleMessage(message(initMessage()));
    const status = await runtime.syncCapabilities([capability()]);
    expect(status.rejected).toEqual([
      {
        name: "search_products",
        message: "Permissions Policy denied model context registration",
      },
    ]);
  });
});
