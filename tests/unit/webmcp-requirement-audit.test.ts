import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_CHANNEL, BRIDGE_VERSION } from "../../core/bridge-protocol";
import { createCapabilityGraph } from "../../core/graph";
import type {
  Capability,
  InspectorState,
  JSONSchema,
  SemanticLocator,
} from "../../core/types";
import { createProject } from "../../core/project";
import type {
  DiscoveredAction as ProjectDiscoveredAction,
  ToolDefinition,
} from "../../core/project";
import type { RuntimeControlState } from "../../extension/control-protocol";
import { StudioController } from "../../extension/inspector/studio";
import { ensureModelContext } from "../../extension/main-world/model-context";
import {
  MainWorldWebMcpRuntime,
  type WebMcpToolRegistration,
} from "../../extension/main-world/runtime";

const TOKEN = "webmcp-requirement-audit";

interface CompositionHarness {
  newId(prefix: string): string;
  composedTool(
    name: string,
    actions: ProjectDiscoveredAction[],
  ): ToolDefinition;
}

interface AvailabilityHarness {
  store: { get: () => ReturnType<typeof createProject> };
  state: InspectorState;
  controlState: () => RuntimeControlState | null;
  isDiscoveryAvailable: (action: ProjectDiscoveredAction) => boolean;
}

interface NativeTool extends WebMcpToolRegistration {
  inputSchema: JSONSchema;
}

interface NativeModelContext {
  registerTool: (
    tool: NativeTool,
    options?: { signal?: AbortSignal },
  ) => boolean;
  getTools: () => NativeTool[];
  executeTool: (tool: NativeTool, input: unknown) => Promise<unknown>;
}

function locator(): SemanticLocator {
  return {
    framePath: [],
    shadowPath: [],
    stableAttributes: [],
    fallbacks: [],
  };
}

function capability(
  id: string,
  name: string,
  inputSchema: JSONSchema,
): Capability {
  const target = locator();
  return {
    id,
    name,
    description: `${name} capability`,
    inputSchema,
    effect: "read",
    confidence: 1,
    source: {
      type: "inferred",
      url: "https://shop.test/catalog",
      framePath: [],
      shadowPath: [],
    },
    locator: target,
    executor: { kind: "read", target, expected: { event: "click" } },
  };
}

function action(
  id: string,
  name: string,
  capabilityId: string,
  inputSchema: JSONSchema,
  access: ProjectDiscoveredAction["access"] = "public",
): ProjectDiscoveredAction {
  return {
    id,
    name,
    description: `${name} discovery`,
    inputSchema,
    effect: "read",
    confidence: 1,
    access,
    status: "observed",
    evidence: [
      {
        type: "dom",
        url: "https://shop.test/catalog",
        observedAt: 1,
      },
    ],
    capability: capability(capabilityId, name, inputSchema),
  };
}

function control(
  authentication: RuntimeControlState["authentication"],
): RuntimeControlState {
  return {
    mode: "running",
    authentication,
    sessionId: "runtime:11",
    observationId: "graph-1-1",
    tabId: 11,
    url: "https://shop.test/catalog",
    origin: "https://shop.test",
    runtimeGeneration: "runtime",
    blocker: null,
    registeredPublicTools: 0,
    registeredProtectedTools: 0,
  };
}

function compositionHarness(): CompositionHarness {
  let sequence = 0;
  const harness = Object.create(
    StudioController.prototype,
  ) as unknown as CompositionHarness;
  harness.newId = (prefix) => `${prefix}-${++sequence}`;
  return harness;
}

function removeModelContextProperty(target: object): void {
  const descriptor = Object.getOwnPropertyDescriptor(target, "modelContext");
  if (descriptor?.configurable) {
    Reflect.deleteProperty(target, "modelContext");
  }
}

function completedResult() {
  return {
    success: true as const,
    status: "completed" as const,
    urlBefore: "https://shop.test/catalog",
    urlAfter: "https://shop.test/catalog",
    navigationOccurred: false,
    stateChanged: true,
    result: { completed: true },
    warnings: [],
  };
}

describe("finalized WebMCP requirement audit", () => {
  beforeEach(() => {
    removeModelContextProperty(document);
    removeModelContextProperty(navigator);
  });

  afterEach(() => {
    removeModelContextProperty(document);
    removeModelContextProperty(navigator);
    vi.restoreAllMocks();
  });

  it("preserves every dropped discovery as an ordered executable workflow step", () => {
    const search = action("discovery-search", "search_products", "cap-search", {
      type: "object",
      properties: { q: { type: "string" } },
      required: ["q"],
    });
    const sort = action("discovery-sort", "change_sort", "cap-sort", {
      type: "object",
      properties: { sort: { type: "string" } },
      required: ["sort"],
    });

    const composed = compositionHarness().composedTool("catalog_flow", [
      search,
      sort,
    ]);
    const domNodes = composed.workflow.nodes.filter(
      (
        node,
      ): node is Extract<
        ToolDefinition["workflow"]["nodes"][number],
        { type: "dom" }
      > => node.type === "dom",
    );
    const returnNode = composed.workflow.nodes.find(
      (node) => node.type === "return",
    );

    expect(
      domNodes.map((node) => [node.label, node.config.capabilityId]),
    ).toEqual([
      ["search_products", "cap-search"],
      ["change_sort", "cap-sort"],
    ]);
    expect(composed.workflow.entryNodeId).toBe(domNodes[0]?.id);
    expect(composed.workflow.edges).toEqual([
      { from: domNodes[0]?.id, to: domNodes[1]?.id, when: "always" },
      { from: domNodes[1]?.id, to: returnNode?.id, when: "always" },
    ]);
    expect(composed.inputSchema).toMatchObject({
      type: "object",
      required: ["q", "sort"],
      additionalProperties: false,
    });
    expect(returnNode?.type).toBe("return");
    if (returnNode?.type === "return") {
      expect(returnNode.config.value).toEqual({
        kind: "output",
        nodeId: domNodes[1]?.id,
      });
    }
  });

  it("does not make unavailable protected discoveries draggable", () => {
    const protectedAction = action(
      "discovery-protected",
      "account_search",
      "cap-protected",
      { type: "object", properties: { q: { type: "string" } } },
      "authenticated",
    );
    const harness = Object.create(
      StudioController.prototype,
    ) as unknown as AvailabilityHarness;
    harness.store = { get: () => createProject("shop.test") };
    harness.state = {
      graph: createCapabilityGraph({
        page: {
          url: "https://shop.test/catalog",
          title: "Shop",
          origin: "https://shop.test",
          hostname: "shop.test",
        },
        capabilities: [protectedAction.capability!],
        generatedAt: 1,
      }),
      webmcp: {
        available: true,
        apiMethods: ["registerTool"],
        nativeTools: [],
        registered: [],
        rejected: [],
      },
      lastExecution: null,
      enabled: true,
      runtimeGeneration: "runtime",
      updatedAt: 1,
    };
    harness.controlState = () => control("login_required");

    expect(harness.isDiscoveryAvailable(protectedAction)).toBe(false);

    harness.controlState = () => control("verified");
    expect(harness.isDiscoveryAvailable(protectedAction)).toBe(true);
  });

  it("registers a saved workflow on navigator.modelContext for page inspection and invocation", async () => {
    const registered = new Map<string, NativeTool>();
    const nativeContext: NativeModelContext = {
      registerTool(tool, options = {}) {
        registered.set(tool.name, tool);
        options.signal?.addEventListener(
          "abort",
          () => registered.delete(tool.name),
          { once: true },
        );
        return true;
      },
      getTools: () => [...registered.values()],
      executeTool: async (tool, input) =>
        tool.execute(typeof input === "string" ? JSON.parse(input) : input),
    };
    Object.defineProperty(navigator, "modelContext", {
      configurable: true,
      value: nativeContext,
      writable: true,
    });

    const resolved = ensureModelContext(document);
    expect(resolved).toMatchObject({
      context: nativeContext,
      owned: false,
      source: "navigator",
    });
    expect(
      (document as Document & { modelContext?: unknown }).modelContext,
    ).toBe(nativeContext);

    const posts: unknown[] = [];
    vi.spyOn(window, "postMessage").mockImplementation((data) => {
      posts.push(data);
    });
    const invocations: string[] = [];
    const onInvocation = (event: Event) => {
      const detail = (event as CustomEvent<{ name?: unknown }>).detail;
      if (typeof detail?.name === "string") invocations.push(detail.name);
    };
    window.addEventListener("webmcp-studio:tool-invoked", onInvocation);

    const runtime = new MainWorldWebMcpRuntime({
      window,
      document,
      token: TOKEN,
    });
    const status = await runtime.syncCapabilities([], true, undefined, [
      {
        capabilityId: "workflow:project:catalog-flow",
        name: "catalog_flow",
        description: "Runs the saved catalog flow.",
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" } },
          required: ["q"],
        },
        annotations: {},
        kind: "workflow",
        projectId: "project",
        toolId: "catalog-flow",
      },
    ]);

    expect(status.registered).toEqual(["catalog_flow"]);
    const pageTools = nativeContext.getTools();
    const pageTool = pageTools.find((tool) => tool.name === "catalog_flow");
    expect(pageTool).toBeDefined();
    expect(typeof pageTool?.execute).toBe("function");

    const invocation = nativeContext.executeTool(
      pageTool as NativeTool,
      JSON.stringify({ q: "keyboard" }),
    );
    const request = posts.find(
      (
        value,
      ): value is {
        messageId: string;
        token: string;
        payload: { requestId: string; type: string };
      } =>
        typeof value === "object" &&
        value !== null &&
        "payload" in value &&
        (value as { payload?: { type?: unknown } }).payload?.type === "invoke",
    );
    if (!request) throw new Error("The WebMCP invocation was not bridged.");
    expect(request?.token).toBe(TOKEN);
    expect(request?.payload.requestId).toBeTypeOf("string");
    expect(invocations).toEqual(["catalog_flow"]);

    await runtime.handleBridgeMessage(
      new MessageEvent("message", {
        source: window,
        data: {
          channel: BRIDGE_CHANNEL,
          version: BRIDGE_VERSION,
          direction: "from-main",
          token: TOKEN,
          messageId: request?.messageId,
          payload: {
            type: "invoke-result",
            requestId: request?.payload.requestId,
            result: completedResult(),
          },
        },
      }),
    );

    await expect(invocation).resolves.toEqual(completedResult());
    window.removeEventListener("webmcp-studio:tool-invoked", onInvocation);
    runtime.stop();
  });
});
