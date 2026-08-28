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

  it.each(["array", "wrapper", "dictionary"])(
    "replaces, disables, and re-enables registrations using AbortSignal (%s)",
    async (inventoryShape) => {
      const nativeTool = { name: "native_status", description: "Page status." };
      const tools = new Map<string, { name: string; description: string }>([
        [nativeTool.name, nativeTool],
      ]);
      const signals: (AbortSignal | undefined)[] = [];
      setModelContext({
        registerTool(
          tool: WebMcpToolRegistration,
          { signal }: { signal?: AbortSignal } = {},
        ) {
          if (tools.has(tool.name)) throw new Error("Duplicate registration");
          tools.set(tool.name, tool);
          signals.push(signal);
          signal?.addEventListener("abort", () => tools.delete(tool.name), {
            once: true,
          });
        },
        getTools: () => {
          if (inventoryShape === "wrapper")
            return { tools: [...tools.values()] };
          if (inventoryShape === "dictionary") return Object.fromEntries(tools);
          return [...tools.values()];
        },
      });
      const runtime = new MainWorldWebMcpRuntime({ window, document });

      const initial = await runtime.syncCapabilities([capability()]);
      expect(initial.registered).toEqual(["search_products"]);

      await runtime.syncCapabilities([
        capability({ description: "Updated search description." }),
      ]);
      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
      expect(tools.get("search_products")?.description).toBe(
        "Updated search description.",
      );

      const disabled = await runtime.syncCapabilities([capability()], false);
      expect(signals[1]?.aborted).toBe(true);
      expect(disabled.registered).toEqual([]);
      expect(disabled.rejected).toEqual([]);
      expect([...tools.values()]).toEqual([nativeTool]);

      const enabled = await runtime.syncCapabilities([capability()], true);
      expect(enabled.registered).toEqual(["search_products"]);
      expect(signals[2]?.aborted).toBe(false);
      expect(tools.get(nativeTool.name)).toBe(nativeTool);
    },
  );

  it.each([false, true])(
    "handles ignored registration signals with explicit removal available: %s",
    async (hasExplicitRemoval) => {
      const tools = new Map<string, WebMcpToolRegistration>();
      const unregisterTool = vi.fn((name: string) => tools.delete(name));
      setModelContext({
        registerTool(tool: WebMcpToolRegistration) {
          tools.set(tool.name, tool);
        },
        getTools: () => [...tools.values()],
        ...(hasExplicitRemoval ? { unregisterTool } : {}),
      });
      const runtime = new MainWorldWebMcpRuntime({ window, document });
      await runtime.syncCapabilities([capability()]);

      const disabled = await runtime.syncCapabilities([capability()], false);
      if (hasExplicitRemoval) {
        expect(unregisterTool).toHaveBeenCalledWith("search_products");
        expect(disabled.registered).toEqual([]);
        expect(tools.size).toBe(0);
      } else {
        expect(disabled.registered).toEqual(["search_products"]);
        expect(disabled.rejected).toEqual([
          {
            name: "search_products",
            message:
              "The host exposes no safe method for unregistering this inferred tool.",
          },
        ]);
        expect(tools.has("search_products")).toBe(true);
      }
    },
  );

  it("does not abort a registration when its removal cannot be verified", async () => {
    let registrationSignal: AbortSignal | undefined;
    setModelContext({
      registerTool(
        _tool: WebMcpToolRegistration,
        { signal }: { signal?: AbortSignal } = {},
      ) {
        registrationSignal = signal;
      },
      getTools() {
        throw new Error("Inventory access denied");
      },
    });
    const runtime = new MainWorldWebMcpRuntime({ window, document });
    await runtime.syncCapabilities([capability()]);

    const disabled = await runtime.syncCapabilities([capability()], false);

    expect(registrationSignal?.aborted).toBe(false);
    expect(disabled.registered).toEqual(["search_products"]);
    expect(disabled.rejected).toHaveLength(1);
  });

  it("recovers when inventory verification fails after a successful abort", async () => {
    const tools = new Map<string, WebMcpToolRegistration>();
    const signals: AbortSignal[] = [];
    let denyNextInventoryRead = false;
    const clearContext = vi.fn(() => tools.clear());
    setModelContext({
      clearContext,
      registerTool(
        tool: WebMcpToolRegistration,
        { signal }: { signal: AbortSignal },
      ) {
        if (tools.has(tool.name)) throw new Error("Duplicate registration");
        tools.set(tool.name, tool);
        signals.push(signal);
        signal.addEventListener(
          "abort",
          () => {
            tools.delete(tool.name);
            denyNextInventoryRead = true;
          },
          { once: true },
        );
      },
      getTools() {
        if (denyNextInventoryRead) {
          denyNextInventoryRead = false;
          throw new Error("Inventory temporarily unavailable");
        }
        return [...tools.values()];
      },
    });
    const runtime = new MainWorldWebMcpRuntime({ window, document });
    await runtime.syncCapabilities([capability()]);

    const disabled = await runtime.syncCapabilities([capability()], false);
    expect(signals[0]?.aborted).toBe(true);
    expect(tools.size).toBe(0);
    expect(disabled.rejected).toHaveLength(1);
    expect(clearContext).not.toHaveBeenCalled();

    const enabled = await runtime.syncCapabilities([capability()], true);

    expect(enabled.registered).toEqual(["search_products"]);
    expect(enabled.rejected).toEqual([]);
    expect(tools.has("search_products")).toBe(true);
    expect(signals).toHaveLength(2);
    expect(signals[1]?.aborted).toBe(false);
  });

  it.each([
    ["Map", (tools: Map<string, WebMcpToolRegistration>) => tools],
    ["undefined", () => undefined],
    ["null", () => null],
    ["unrecognized object", () => ({ status: "unavailable" })],
    ["unrecognized array entry", () => [null]],
  ])(
    "does not treat an unsupported %s inventory as verified absence",
    async (_label, inventory) => {
      const tools = new Map<string, WebMcpToolRegistration>();
      let registrationSignal: AbortSignal | undefined;
      const registerTool = vi.fn(
        (tool: WebMcpToolRegistration, { signal }: { signal: AbortSignal }) => {
          if (tools.has(tool.name)) throw new Error("Duplicate registration");
          tools.set(tool.name, tool);
          registrationSignal = signal;
        },
      );
      setModelContext({ registerTool, getTools: () => inventory(tools) });
      const runtime = new MainWorldWebMcpRuntime({ window, document });
      await runtime.syncCapabilities([capability()]);

      const disabled = await runtime.syncCapabilities([capability()], false);

      expect(registrationSignal?.aborted).toBe(false);
      expect(disabled.registered).toEqual(["search_products"]);
      expect(disabled.rejected).toHaveLength(1);
      expect(tools.has("search_products")).toBe(true);

      await runtime.syncCapabilities([capability()], true);
      expect(registerTool).toHaveBeenCalledTimes(1);
    },
  );

  it("checks exact inventory names when verifying an ignored abort", async () => {
    const tools = new Map<string, WebMcpToolRegistration>();
    const clearContext = vi.fn(() => tools.clear());
    setModelContext({
      clearContext,
      registerTool(tool: WebMcpToolRegistration) {
        tools.set(tool.name, tool);
      },
      getTools: () => [...tools.values()].reverse(),
    });
    const runtime = new MainWorldWebMcpRuntime({ window, document });
    await runtime.syncCapabilities([capability()]);
    tools.set("SEARCH_PRODUCTS", {
      ...tools.get("search_products")!,
      name: "SEARCH_PRODUCTS",
    });

    const disabled = await runtime.syncCapabilities([capability()], false);

    expect(disabled.registered).toEqual(["search_products"]);
    expect(disabled.rejected).toHaveLength(1);
    expect([...tools.keys()]).toEqual(["search_products", "SEARCH_PRODUCTS"]);
    expect(clearContext).not.toHaveBeenCalled();
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
