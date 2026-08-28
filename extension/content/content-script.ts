import {
  BRIDGE_CHANNEL,
  BRIDGE_VERSION,
  createBridgeMessage,
  isBridgeRequest,
  type BridgeRequest,
  type BridgeResponse,
  type BridgeResponsePayload,
  type ExtensionMessage,
  type ExtensionResponse,
} from "../../core/bridge-protocol";
import {
  scanDocument,
  scanDocumentSubtrees,
} from "../../core/detection/scanner";
import {
  mutationScanRoots,
  nodeAffectedByMutation,
} from "../../core/detection/incremental";
import { createCapabilityGraph } from "../../core/graph/capability-graph";
import { LifecycleController } from "../../core/lifecycle/lifecycle-controller";
import { executeCapability } from "../../core/execution";
import { AdapterRegistry, executeWithAdapters } from "../../sdk";
import { ecommerceProductCardAdapter } from "../../adapters";
import type {
  Capability,
  ExecutionFailureCode,
  ExecutionResult,
  InspectorState,
  WebMcpStatus,
} from "../../core/types";

interface PendingBridgeMessage {
  resolve: (payload: BridgeResponsePayload) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const globalKey = "__webmcpStudioContentRuntime";

function randomToken(): string {
  try {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  } catch {
    // Older isolated worlds may not expose randomUUID.
  }
  return `studio-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function emptyWebMcpStatus(): WebMcpStatus {
  return {
    available: false,
    apiMethods: [],
    nativeTools: [],
    registered: [],
    rejected: [],
  };
}

function safeResultError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isWebMcpStatus(value: unknown): value is WebMcpStatus {
  if (!isRecord(value)) return false;
  return (
    typeof value.available === "boolean" &&
    Array.isArray(value.apiMethods) &&
    value.apiMethods.every((method) => typeof method === "string") &&
    Array.isArray(value.nativeTools) &&
    value.nativeTools.every(
      (tool) => isRecord(tool) && typeof tool.name === "string",
    ) &&
    Array.isArray(value.registered) &&
    value.registered.every((name) => typeof name === "string") &&
    Array.isArray(value.rejected) &&
    value.rejected.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.name === "string" &&
        typeof entry.message === "string",
    )
  );
}

function isExecutionResult(value: unknown): value is ExecutionResult {
  if (!isRecord(value)) return false;
  const failureCodes = new Set<ExecutionFailureCode>([
    "target_not_found",
    "ambiguous_target",
    "validation_failed",
    "no_observable_change",
    "cross_origin_blocked",
    "permission_blocked",
    "webmcp_unavailable",
    "execution_timeout",
    "unsupported_control",
    "invalid_arguments",
    "registration_rejected",
  ]);
  return (
    typeof value.success === "boolean" &&
    (value.status === "completed" ||
      failureCodes.has(value.status as ExecutionFailureCode)) &&
    typeof value.urlBefore === "string" &&
    typeof value.urlAfter === "string" &&
    typeof value.navigationOccurred === "boolean" &&
    typeof value.stateChanged === "boolean" &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === "string")
  );
}

function isBridgeResponsePayload(
  value: unknown,
): value is BridgeResponsePayload {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "error") return typeof value.message === "string";
  if (
    value.type === "ready" ||
    value.type === "status" ||
    value.type === "registration"
  )
    return isWebMcpStatus(value.status);
  return (
    value.type === "invoke-result" &&
    typeof value.requestId === "string" &&
    isExecutionResult(value.result)
  );
}

type ExtensionCommand = Exclude<
  ExtensionMessage,
  { type: "polyfill:state-update" }
>;

export function isExtensionCommand(value: unknown): value is ExtensionCommand {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (
    value.tabId !== undefined &&
    (typeof value.tabId !== "number" ||
      !Number.isInteger(value.tabId) ||
      value.tabId < 0)
  )
    return false;
  switch (value.type) {
    case "polyfill:get-state":
    case "polyfill:rescan":
    case "polyfill:get-graph":
      return true;
    case "polyfill:set-enabled":
      return typeof value.enabled === "boolean";
    case "polyfill:invoke":
      return (
        typeof value.capabilityId === "string" &&
        value.capabilityId.trim().length > 0 &&
        "args" in value
      );
    default:
      return false;
  }
}

function postBridgeResponse(
  token: string,
  messageId: string,
  payload: BridgeResponsePayload,
): void {
  const response: BridgeResponse = {
    channel: BRIDGE_CHANNEL,
    version: BRIDGE_VERSION,
    direction: "from-main",
    token,
    messageId,
    payload,
  };
  try {
    window.postMessage(response, "*");
  } catch {
    // A navigation can tear down the document while an invocation is finishing.
  }
}

class BridgeClient {
  private readonly token: string;
  private readonly pending = new Map<string, PendingBridgeMessage>();
  private readonly onMessage = (event: MessageEvent<unknown>): void => {
    if (
      event.source !== window ||
      !event.data ||
      typeof event.data !== "object"
    )
      return;
    const value = event.data as Partial<BridgeResponse>;
    if (
      value.channel !== BRIDGE_CHANNEL ||
      value.version !== BRIDGE_VERSION ||
      value.direction !== "from-main" ||
      value.token !== this.token ||
      typeof value.messageId !== "string" ||
      !isBridgeResponsePayload(value.payload)
    )
      return;
    const pending = this.pending.get(value.messageId);
    if (!pending) return;
    this.pending.delete(value.messageId);
    clearTimeout(pending.timer);
    pending.resolve(value.payload);
  };

  constructor() {
    this.token = randomToken();
    window.addEventListener("message", this.onMessage);
  }

  tokenValue(): string {
    return this.token;
  }

  dispose(): void {
    window.removeEventListener("message", this.onMessage);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("The WebMCP bridge stopped."));
      this.pending.delete(id);
    }
  }

  request(
    payload: Parameters<typeof createBridgeMessage>[1],
    timeoutMs = 12_000,
  ): Promise<BridgeResponsePayload> {
    let message;
    try {
      message = createBridgeMessage(this.token, payload);
    } catch {
      message = {
        channel: BRIDGE_CHANNEL,
        version: BRIDGE_VERSION,
        direction: "to-main" as const,
        token: this.token,
        messageId: `bridge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
        payload,
      };
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.messageId);
        reject(new Error("The WebMCP bridge timed out."));
      }, timeoutMs);
      this.pending.set(message.messageId, { resolve, reject, timer });
      try {
        window.postMessage(message, "*");
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(message.messageId);
        reject(
          new Error(
            `The browser rejected the bridge message: ${safeResultError(error)}`,
          ),
        );
      }
    });
  }

  async init(): Promise<WebMcpStatus> {
    const response = await this.request({ type: "init", token: this.token });
    if (response.type === "ready" || response.type === "status")
      return response.status;
    if (response.type === "error") throw new Error(response.message);
    throw new Error(
      "The MAIN-world runtime returned an unexpected init response.",
    );
  }

  async sync(
    capabilities: Capability[],
    enabled: boolean,
  ): Promise<WebMcpStatus> {
    const response = await this.request({
      type: "sync-tools",
      capabilities,
      enabled,
    });
    if (response.type === "registration" || response.type === "status")
      return response.status;
    if (response.type === "error") throw new Error(response.message);
    throw new Error(
      "The MAIN-world runtime returned an unexpected registration response.",
    );
  }
}

export class ContentRuntime {
  private readonly bridge = new BridgeClient();
  private readonly adapters = new AdapterRegistry([
    ecommerceProductCardAdapter,
  ]);
  private readonly lifecycle: LifecycleController;
  private graph: InspectorState["graph"] = null;
  private capabilityElements = new Map<string, Element>();
  private blockedElements = new Map<string, Element>();
  private application: ReturnType<AdapterRegistry["apply"]> | null = null;
  private status = emptyWebMcpStatus();
  private enabled = true;
  private lastExecution: InspectorState["lastExecution"] = null;
  private started = false;
  private syncVersion = 0;

  constructor() {
    this.lifecycle = new LifecycleController({
      stabilizerOptions: {
        document,
        window,
        quietWindowMs: 140,
        maxWaitMs: 2_000,
      },
      scan: (context) => {
        const options = {
          includeFrames: true,
          includeShadowDom: true,
        } as const;
        const previous = this.lifecycle.graph;
        const roots = context.fullScan
          ? [document]
          : mutationScanRoots(
              document,
              context.mutations,
              context.affectedSubtrees,
            );
        const result =
          context.fullScan || previous === null
            ? scanDocument(document, options)
            : scanDocumentSubtrees(document, roots, options);
        if (context.fullScan || previous === null) {
          this.capabilityElements = new Map(result.capabilityElements);
          this.blockedElements = new Map(result.blockedElements);
          return createCapabilityGraph({
            page: result.page,
            capabilities: result.capabilities,
            blocked: result.blocked,
            generatedAt: result.generatedAt,
          });
        }

        const affectedCapabilityIds = new Set<string>();
        for (const [id, element] of this.capabilityElements) {
          if (nodeAffectedByMutation(element, context.mutations, roots)) {
            affectedCapabilityIds.add(id);
          }
        }
        const capabilities = new Map(
          Object.entries(previous.capabilities).filter(
            ([id]) => !affectedCapabilityIds.has(id),
          ),
        );
        for (const capability of result.capabilities) {
          capabilities.set(capability.id, capability);
        }

        for (const id of affectedCapabilityIds) {
          this.capabilityElements.delete(id);
        }
        for (const [id, element] of result.capabilityElements) {
          this.capabilityElements.set(id, element);
        }

        const affectedBlockedIds = new Set<string>();
        for (const [id, element] of this.blockedElements) {
          if (nodeAffectedByMutation(element, context.mutations, roots)) {
            affectedBlockedIds.add(id);
          }
        }
        const blocked = previous.blocked.filter(
          ({ id }) => !affectedBlockedIds.has(id),
        );
        for (const blockedCapability of result.blocked) {
          blocked.push(blockedCapability);
        }
        for (const id of affectedBlockedIds) this.blockedElements.delete(id);
        for (const [id, element] of result.blockedElements) {
          this.blockedElements.set(id, element);
        }

        return createCapabilityGraph({
          page: result.page,
          capabilities: capabilities.values(),
          blocked,
          generatedAt: result.generatedAt,
        });
      },
      onGraphChange: async ({ graph }) => {
        // The raw scanner graph is the adapter input. The transformed graph is
        // the canonical graph exposed to the inspector and sent to MAIN; this
        // keeps adapter-origin attribution and adapter-discovered capabilities
        // visible everywhere downstream.
        const application = this.adapters.apply(graph);
        this.application = application;
        this.graph = application.graph;
        await this.syncRegistration();
        this.publishState();
      },
      onError: ({ error }) => {
        this.publishState(`Lifecycle error: ${safeResultError(error)}`);
      },
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    window.addEventListener("message", this.handleBridgeRequest);
    try {
      this.status = await this.bridge.init();
    } catch (error) {
      this.publishState(`WebMCP bridge unavailable: ${safeResultError(error)}`);
    }
    this.lifecycle.start();
  }

  stop(): void {
    this.lifecycle.stop();
    window.removeEventListener("message", this.handleBridgeRequest);
    this.bridge.dispose();
    this.started = false;
  }

  state(): InspectorState {
    return {
      graph: this.graph,
      webmcp: this.status,
      lastExecution: this.lastExecution,
      enabled: this.enabled,
      updatedAt: Date.now(),
    };
  }

  async rescan(): Promise<InspectorState> {
    this.lifecycle.rescan();
    await this.lifecycle.domStabilizer.flush();
    await this.lifecycle.waitForIdle();
    return this.state();
  }

  async setEnabled(enabled: boolean): Promise<InspectorState> {
    this.enabled = enabled;
    await this.syncRegistration();
    this.publishState();
    return this.state();
  }

  async invoke(capabilityId: string, args: unknown): Promise<ExecutionResult> {
    const result = await this.execute(capabilityId, args);
    this.lastExecution = { capabilityId, result };
    this.publishState();
    return result;
  }

  private async execute(
    capabilityId: string,
    args: unknown,
  ): Promise<ExecutionResult> {
    const application = this.application;
    if (!application)
      return this.failure(
        "target_not_found",
        "The capability graph is not ready.",
      );
    if (!this.enabled)
      return this.failure(
        "permission_blocked",
        "Inferred capability registration is disabled in the inspector.",
      );
    try {
      return await executeWithAdapters(
        application,
        capabilityId,
        args,
        (capability, invocationArgs) =>
          executeCapability(capability, invocationArgs, { document }),
      );
    } catch (error) {
      const message = safeResultError(error);
      return this.failure(
        message.includes("capability not found")
          ? "target_not_found"
          : "execution_timeout",
        message,
      );
    }
  }

  private failure(
    code: ExecutionFailureCode,
    message: string,
  ): ExecutionResult {
    const url = location.href;
    return {
      success: false,
      status: code,
      urlBefore: url,
      urlAfter: url,
      navigationOccurred: false,
      stateChanged: false,
      warnings: [],
      error: { code, message },
    };
  }

  private async syncRegistration(): Promise<void> {
    if (!this.application) return;
    const version = ++this.syncVersion;
    try {
      const status = await this.bridge.sync(
        Object.values(this.application.graph.capabilities),
        this.enabled,
      );
      if (version !== this.syncVersion) return;
      this.status = status;
    } catch (error) {
      this.status = {
        ...this.status,
        rejected: [{ name: "bridge", message: safeResultError(error) }],
      };
    }
  }

  private publishState(detail?: string): void {
    if (detail)
      this.status = {
        ...this.status,
        rejected: [
          ...this.status.rejected,
          { name: "runtime", message: detail },
        ],
      };
    try {
      void Promise.resolve(
        chrome.runtime.sendMessage({
          type: "polyfill:state-update",
          state: this.state(),
        } satisfies ExtensionMessage),
      ).catch(() => undefined);
    } catch {
      // The page can outlive the extension service worker during reloads.
    }
  }

  private readonly handleBridgeRequest = (
    event: MessageEvent<unknown>,
  ): void => {
    if (event.source !== window || !isBridgeRequest(event.data)) return;
    const request = event.data as BridgeRequest;
    if (request.token !== this.bridge.tokenValue()) return;
    const payload = request.payload;
    if (payload.type !== "invoke") return;
    void this.execute(payload.capabilityId, payload.args).then((result) => {
      this.lastExecution = { capabilityId: payload.capabilityId, result };
      this.publishState();
      postBridgeResponse(this.bridge.tokenValue(), request.messageId, {
        type: "invoke-result",
        requestId: payload.requestId,
        result,
      });
    });
  };

  async handleExtensionMessage(message: unknown): Promise<ExtensionResponse> {
    if (!isExtensionCommand(message))
      return { ok: false, error: "Invalid extension message." };
    switch (message.type) {
      case "polyfill:get-state":
        return { ok: true, state: this.state() };
      case "polyfill:get-graph":
        return { ok: true, graph: this.graph };
      case "polyfill:rescan":
        await this.rescan();
        return { ok: true, started: true };
      case "polyfill:set-enabled":
        return { ok: true, state: await this.setEnabled(message.enabled) };
      case "polyfill:invoke":
        return {
          ok: true,
          result: await this.invoke(message.capabilityId, message.args),
        };
      default:
        return { ok: false, error: "Unsupported page message." };
    }
  }
}

declare global {
  interface Window {
    __webmcpStudioContentRuntime?: ContentRuntime;
  }
}

if (
  typeof window !== "undefined" &&
  typeof chrome !== "undefined" &&
  chrome.runtime?.onMessage &&
  !window[globalKey as keyof Window]
) {
  const runtime = new ContentRuntime();
  window.__webmcpStudioContentRuntime = runtime;
  void runtime.start();
  chrome.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse) => {
      if (!isExtensionCommand(message)) return false;
      void runtime
        .handleExtensionMessage(message)
        .then(sendResponse)
        .catch((error: unknown) => {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      return true;
    },
  );
}
