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
import { runWorkflow } from "../../core/workflow";
import { compileProjectTools, workflowCapabilityId } from "../../core/compiler";
import type { WebMcpToolDescriptor } from "../../core/compiler";
import {
  ProjectActivationError,
  cloneProject,
  isPrivateNetworkHostname,
  matchesSiteScope,
  projectFingerprint,
  validateProject,
  validateActivation,
} from "../../core/project";
import { AdapterRegistry, executeWithAdapters } from "../../sdk";
import { ecommerceProductCardAdapter } from "../../adapters";
import type {
  Capability,
  ExecutionError,
  ExecutionFailureCode,
  ExecutionResult,
  InspectorState,
  WebMcpStatus,
} from "../../core/types";
import type {
  ActivationApproval,
  ActiveProjectState,
  ObservedRequest,
  ObservedRequestPage,
  ProjectDocument,
  ToolDefinition,
  WorkflowNode,
  WorkflowRunResult,
  WorkflowRunStatus,
} from "../../core/project";
import {
  isRuntimeControlMessage,
  type RuntimeAuthenticationState,
  type RuntimeBlocker,
  type RuntimeControlAction,
  type RuntimeControlMessage,
  type RuntimeControlMode,
  type RuntimeControlState,
} from "../control-protocol";

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
    "approval_required",
    "scope_blocked",
    "session_expired",
    "cancelled",
    "ambiguous_delivery",
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

type ExtensionCommand =
  | Exclude<ExtensionMessage, { type: "polyfill:state-update" }>
  | RuntimeControlMessage;

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
    case "polyfill:get-project":
    case "polyfill:deactivate-project":
      return true;
    case "polyfill:control":
      return isRuntimeControlMessage(value);
    case "polyfill:set-enabled":
      return typeof value.enabled === "boolean";
    case "polyfill:invoke":
      return (
        typeof value.capabilityId === "string" &&
        value.capabilityId.trim().length > 0 &&
        "args" in value
      );
    case "polyfill:test-project":
      return (
        "project" in value &&
        typeof value.toolId === "string" &&
        value.toolId.trim().length > 0 &&
        "args" in value
      );
    case "polyfill:perform-browser-action":
      return (
        typeof value.sessionId === "string" &&
        value.sessionId.trim().length > 0 &&
        typeof value.capabilityId === "string" &&
        value.capabilityId.trim().length > 0 &&
        typeof value.expectedObservation === "string" &&
        value.expectedObservation.trim().length > 0 &&
        "args" in value
      );
    case "polyfill:read-observed-requests":
      return (
        typeof value.sessionId === "string" &&
        value.sessionId.trim().length > 0 &&
        (value.cursor === undefined || typeof value.cursor === "string")
      );
    case "polyfill:activate-project":
      return "project" in value && "approval" in value;
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
    workflowTools: WebMcpToolDescriptor[] = [],
  ): Promise<WebMcpStatus> {
    const response = await this.request({
      type: "sync-tools",
      capabilities,
      enabled,
      ...(workflowTools.length > 0 ? { workflowTools } : {}),
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
  private readonly runtimeGeneration = randomToken();
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
  /** Imported and human-approved config. It is intentionally separate from
   * the Studio draft, which never crosses into this runtime implicitly. */
  private activeProject: ProjectDocument | null = null;
  private activeApproval: ActivationApproval | null = null;
  private activeProjectState: ActiveProjectState | null = null;
  private lastTargetTabId: number | undefined;
  private started = false;
  // Content-runtime callers can request registration changes concurrently
  // (graph rescans, activation, and control transitions). Serialize them so
  // an older sync cannot return a stale status to the operation that requested
  // a newly approved workflow.
  private registrationTail: Promise<WebMcpStatus> = Promise.resolve(
    this.status,
  );
  private captureStartedAt = 0;
  private requestObserver: PerformanceObserver | null = null;
  private requestSequence = 0;
  private observedRequests: ObservedRequest[] = [];
  private controlMode: RuntimeControlMode = "running";
  private authentication: RuntimeAuthenticationState = "unknown";
  private blocker: RuntimeBlocker | null = null;

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
        this.reconcileLiveConnection();
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
    window.addEventListener("pagehide", this.handlePagehide, { once: true });
    try {
      this.status = await this.bridge.init();
    } catch (error) {
      this.publishState(`WebMCP bridge unavailable: ${safeResultError(error)}`);
    }
    this.startRequestCapture();
    this.lifecycle.start();
  }

  stop(): void {
    this.requestObserver?.disconnect();
    this.requestObserver = null;
    this.lifecycle.stop();
    window.removeEventListener("message", this.handleBridgeRequest);
    window.removeEventListener("pagehide", this.handlePagehide);
    this.bridge.dispose();
    this.started = false;
  }

  state(): InspectorState {
    const snapshot = {
      graph: this.graph,
      webmcp: this.status,
      lastExecution: this.lastExecution,
      enabled: this.enabled,
      runtimeGeneration: this.runtimeGeneration,
      activeProject: this.activeProjectState
        ? {
            ...this.activeProjectState,
            toolNames: [...this.activeProjectState.toolNames],
          }
        : null,
      control: this.controlState(),
      updatedAt: Date.now(),
    };
    return snapshot as InspectorState;
  }

  private controlState(): RuntimeControlState {
    return {
      mode: this.controlMode,
      authentication: this.authenticationForState(),
      sessionId: this.sessionId(),
      observationId: this.observationId(),
      tabId: this.lastTargetTabId ?? null,
      url: this.currentUrl(),
      origin: this.currentOrigin(),
      runtimeGeneration: this.runtimeGeneration,
      blocker: this.blocker,
      registeredPublicTools: this.registeredToolCount("public"),
      registeredProtectedTools: this.registeredToolCount("authenticated"),
    };
  }

  private authenticationForState(): RuntimeAuthenticationState {
    if (
      !this.activeProject ||
      this.activeProject.tools.every((tool) => tool.access === "public")
    )
      return "not_required";
    return this.authentication;
  }

  private registeredToolCount(access: "public" | "authenticated"): number {
    const project = this.activeProject;
    if (!project || this.controlMode !== "running") return 0;
    return project.tools.filter(
      (tool) =>
        tool.enabled &&
        tool.access === access &&
        this.eligibleWorkflowTool(tool, project),
    ).length;
  }

  private eligibleWorkflowTool(
    tool: ToolDefinition,
    project: ProjectDocument,
  ): boolean {
    if (this.controlMode !== "running" || !tool.enabled) return false;
    if (tool.access === "authenticated" && this.authentication !== "verified")
      return false;
    if (!matchesSiteScope(project, this.currentUrl())) return false;
    return tool.workflow.nodes.every(
      (node) =>
        node.type !== "dom" ||
        this.capability(node.config.capabilityId) !== undefined,
    );
  }

  private eligibleWorkflowTools(project: ProjectDocument): ToolDefinition[] {
    return project.tools.filter((tool) =>
      this.eligibleWorkflowTool(tool, project),
    );
  }

  private setBlocker(blocker: RuntimeBlocker | null): void {
    this.blocker = blocker;
  }

  private invalidateLiveConnection(
    code: RuntimeBlocker["code"],
    message: string,
  ): void {
    this.controlMode = "disconnected";
    this.setBlocker({ code, message });
    this.activeProject = null;
    this.activeApproval = null;
    this.activeProjectState = null;
  }

  private reconcileLiveConnection(): void {
    if (!this.activeProject || !this.activeApproval) return;
    const url = this.currentUrl();
    if (!matchesSiteScope(this.activeProject, url)) {
      this.invalidateLiveConnection(
        "out_of_scope",
        "The page moved outside the approved project scope; activation was stopped.",
      );
      return;
    }
    if (this.currentOrigin() !== this.activeApproval.origin) {
      this.invalidateLiveConnection(
        "document_changed",
        "The page origin changed; the approved snapshot is no longer live.",
      );
    }
  }

  private readonly handlePagehide = (): void => {
    this.invalidateLiveConnection(
      "document_changed",
      "The page document is being replaced; live website control stopped.",
    );
    void this.syncRegistration();
    this.publishState();
  };

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

  private controlFailure(message: string): ExecutionResult {
    return this.failure("cancelled", message);
  }

  private async control(
    action: RuntimeControlAction,
    sessionVerified?: boolean,
  ): Promise<InspectorState> {
    if (action === "pause") {
      this.controlMode = "paused";
      this.setBlocker({
        code: "paused",
        message: "Agent actions are paused by the human.",
      });
    } else if (action === "takeover") {
      this.controlMode = "takeover";
      this.setBlocker({
        code: "human_takeover",
        message: "Human takeover is active; agent actions are stopped.",
      });
    } else if (action === "login") {
      this.controlMode = "takeover";
      this.authentication = "login_required";
      this.setBlocker({
        code: "login_required",
        message:
          "Sign in directly in the selected tab, then explicitly resume.",
      });
    } else if (action === "resume") {
      if (this.controlMode === "disconnected") {
        this.publishState();
        return this.state();
      }
      const requiresSession =
        this.activeProject?.tools.some(
          (tool) => tool.enabled && tool.access === "authenticated",
        ) ?? false;
      if (requiresSession && sessionVerified !== true) {
        this.authentication = "login_required";
        this.setBlocker({
          code: "login_required",
          message:
            "Resume requires human confirmation that the intended website session is signed in.",
        });
        this.publishState();
        return this.state();
      }
      if (requiresSession) {
        this.authentication = "verified";
        if (this.activeApproval) this.activeApproval.sessionVerified = true;
      } else {
        this.authentication = "not_required";
      }
      this.controlMode = "running";
      this.setBlocker(null);
      if (this.started) await this.rescan();
    } else if (action === "disconnect") {
      this.controlMode = "disconnected";
      this.setBlocker({
        code: "disconnected",
        message:
          "Disconnected from the selected tab; no agent actions or workflow tools are available.",
      });
      this.activeProject = null;
      this.activeApproval = null;
      this.activeProjectState = null;
    }
    await this.syncRegistration();
    this.publishState();
    return this.state();
  }

  async handleControlMessage(
    message: RuntimeControlMessage,
  ): Promise<ExtensionResponse> {
    if (message.tabId !== undefined && message.tabId !== this.lastTargetTabId)
      return {
        ok: false,
        error: "The control command targets a different tab.",
      };
    return {
      ok: true,
      state: await this.control(message.action, message.sessionVerified),
    };
  }

  private startRequestCapture(): void {
    this.captureStartedAt = Date.now();
    this.observedRequests = [];
    this.requestSequence = 0;
    if (typeof PerformanceObserver === "undefined") return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries())
          this.recordObservedRequest(entry);
      });
      observer.observe({ entryTypes: ["resource"] });
      this.requestObserver = observer;
    } catch {
      this.requestObserver = null;
    }
  }

  private recordObservedRequest(entry: PerformanceEntry): void {
    if (this.observedRequests.length >= 100 || !entry.name) return;
    try {
      const current = new URL(this.currentUrl());
      const requested = new URL(entry.name, current.href);
      // Resource timing does not expose a safe, reliable request method. Keep
      // only same-origin paths and omit query/hash values that can contain
      // tokens, identifiers, or other private request state.
      if (requested.origin !== current.origin) return;
      const observed: ObservedRequest = {
        id: `request-${++this.requestSequence}`,
        url: `${requested.origin}${requested.pathname}`,
        origin: requested.origin,
        path: requested.pathname,
        ...(typeof (entry as PerformanceResourceTiming).initiatorType ===
        "string"
          ? {
              initiatorType: (entry as PerformanceResourceTiming).initiatorType,
            }
          : {}),
        observedAt: Date.now(),
      };
      this.observedRequests.push(observed);
    } catch {
      // A navigation can invalidate the entry while it is being normalized.
    }
  }

  private sessionId(): string {
    return `${this.runtimeGeneration}:${this.lastTargetTabId ?? "unbound"}`;
  }

  private observationId(): string {
    return this.graph
      ? `graph-${this.graph.version}-${this.graph.generatedAt}`
      : `runtime-${this.runtimeGeneration}`;
  }

  private currentOrigin(): string {
    try {
      return new URL(this.currentUrl()).origin;
    } catch {
      return "";
    }
  }

  private parseBrowserActionApproval(value: unknown): {
    snapshotHash: string;
    approvedAt: number;
    tabId: number;
    origin: string;
    allowConsequential: boolean;
    sessionVerified?: boolean;
  } | null {
    if (!isRecord(value)) return null;
    if (
      typeof value.snapshotHash !== "string" ||
      typeof value.approvedAt !== "number" ||
      !Number.isFinite(value.approvedAt) ||
      typeof value.tabId !== "number" ||
      !Number.isSafeInteger(value.tabId) ||
      value.tabId < 0 ||
      typeof value.origin !== "string" ||
      typeof value.allowConsequential !== "boolean" ||
      (value.sessionVerified !== undefined &&
        typeof value.sessionVerified !== "boolean")
    )
      return null;
    return {
      snapshotHash: value.snapshotHash,
      approvedAt: value.approvedAt,
      tabId: value.tabId,
      origin: value.origin,
      allowConsequential: value.allowConsequential,
      ...(value.sessionVerified === undefined
        ? {}
        : { sessionVerified: value.sessionVerified }),
    };
  }

  private async performBrowserAction(
    sessionId: string,
    capabilityId: string,
    args: unknown,
    expectedObservation: string,
    approvalValue: unknown,
    projectValue: unknown,
  ): Promise<ExecutionResult> {
    if (this.controlMode !== "running")
      return this.controlFailure(
        this.blocker?.message ?? "Agent actions are currently blocked.",
      );
    if (sessionId !== this.sessionId())
      return this.failure(
        "session_expired",
        "The discovery session is no longer bound to this exact tab.",
      );
    if (expectedObservation !== this.observationId())
      return this.failure(
        "validation_failed",
        "The page observation is stale; observe the selected tab again before acting.",
      );
    const capability = this.capability(capabilityId);
    if (!capability)
      return this.failure(
        "target_not_found",
        "The requested capability is not present in the current page graph.",
      );
    let project: ProjectDocument;
    try {
      project = validateProject(projectValue);
    } catch {
      return this.failure(
        "scope_blocked",
        "Discovery actions require a validated project scope.",
      );
    }
    if (
      !matchesSiteScope(project, this.currentUrl()) ||
      !matchesSiteScope(project, capability.source.url)
    )
      return this.failure(
        "scope_blocked",
        "The requested capability is outside the current project scope.",
      );
    const consequential =
      capability.effect === "mutate" || capability.effect === "navigate";
    const needsSession =
      project.site.sessionMode === "authenticated" ||
      project.discoveredActions.some(
        (action) =>
          action.capability?.id === capabilityId &&
          action.access === "authenticated",
      );
    if (consequential) {
      const approval = this.parseBrowserActionApproval(approvalValue);
      if (
        !approval ||
        !approval.allowConsequential ||
        approval.tabId !== this.lastTargetTabId ||
        approval.origin !== this.currentOrigin() ||
        approval.snapshotHash !== projectFingerprint(project)
      )
        return this.failure(
          "approval_required",
          "A human must approve this consequential discovery action for the current tab and origin.",
        );
    }
    if (needsSession) {
      const approval = this.parseBrowserActionApproval(approvalValue);
      if (
        !approval ||
        approval.tabId !== this.lastTargetTabId ||
        approval.origin !== this.currentOrigin() ||
        approval.snapshotHash !== projectFingerprint(project) ||
        approval.sessionVerified !== true
      )
        return this.failure(
          "session_expired",
          "The protected website session is not currently verified.",
        );
    }
    const result = await this.execute(capabilityId, args);
    this.lastExecution = { capabilityId, result };
    this.publishState();
    return result;
  }

  private readObservedRequests(
    sessionId: string,
    cursor?: string,
  ): ObservedRequestPage | { ok: false; error: string } {
    if (sessionId !== this.sessionId())
      return {
        ok: false,
        error: "The discovery session is no longer bound to this exact tab.",
      };
    const start = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(start) || start < 0)
      return { ok: false, error: "The request cursor is invalid." };
    const entries = this.observedRequests.slice(start, start + 50);
    const next = start + entries.length;
    return {
      sessionId: this.sessionId(),
      observationId: this.observationId(),
      entries,
      ...(next < this.observedRequests.length
        ? { nextCursor: String(next) }
        : {}),
      captureStartedAt: this.captureStartedAt,
      available: this.requestObserver !== null,
    };
  }

  async invoke(capabilityId: string, args: unknown): Promise<ExecutionResult> {
    const result = await this.executeInvocation(capabilityId, args);
    this.lastExecution = { capabilityId, result };
    this.publishState();
    return result;
  }

  private async executeInvocation(
    capabilityId: string,
    args: unknown,
  ): Promise<ExecutionResult> {
    const workflow = this.workflowForCapability(capabilityId);
    return workflow
      ? this.executeWorkflow(workflow, args)
      : this.execute(capabilityId, args);
  }

  private async execute(
    capabilityId: string,
    args: unknown,
    allowDisabled = false,
  ): Promise<ExecutionResult> {
    if (this.controlMode !== "running")
      return this.controlFailure(
        this.blocker?.message ?? "Agent actions are currently blocked.",
      );
    const application = this.application;
    if (!application)
      return this.failure(
        "target_not_found",
        "The capability graph is not ready.",
      );
    if (!this.enabled && !allowDisabled)
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

  private workflowForCapability(capabilityId: string): ToolDefinition | null {
    const project = this.activeProject;
    if (!project) return null;
    for (const tool of project.tools) {
      if (workflowCapabilityId(project.project.id, tool.id) === capabilityId)
        return tool;
    }
    return null;
  }

  private currentUrl(): string {
    try {
      return location.href;
    } catch {
      return document.URL ?? "";
    }
  }

  private capability(capabilityId: string): Capability | undefined {
    return this.application?.graph.capabilities[capabilityId];
  }

  private workflowScopeAllows(kind: "dom" | "http", target: string): boolean {
    return this.workflowScopeAllowsFor(this.activeProject, kind, target);
  }

  private workflowScopeAllowsFor(
    project: ProjectDocument | null,
    kind: "dom" | "http",
    target: string,
  ): boolean {
    if (!project) return false;
    if (kind === "dom") {
      const capability = this.capability(target);
      return Boolean(
        capability &&
        matchesSiteScope(project, this.currentUrl()) &&
        matchesSiteScope(project, capability.source.url),
      );
    }
    try {
      const parsed = new URL(target);
      if (
        (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
        parsed.username ||
        parsed.password ||
        isPrivateNetworkHostname(parsed.hostname)
      )
        return false;
      // A workflow may use a subdomain only when it was explicitly listed as
      // an approved request origin. This prevents a broad domain match from
      // turning a captured request into an SSRF primitive.
      if (
        project.site.origins.length > 0 &&
        !project.site.origins.includes(parsed.origin)
      )
        return false;
      return matchesSiteScope(project, parsed.href);
    } catch {
      return false;
    }
  }

  private scopedFetch(project: ProjectDocument): typeof fetch | undefined {
    if (typeof globalThis.fetch !== "function") return undefined;
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (!this.workflowScopeAllowsFor(project, "http", requestUrl))
        throw new Error(
          "The HTTP destination is outside the approved web scope.",
        );
      const response = await globalThis.fetch(input, {
        ...init,
        // Do not silently follow a redirect into a new origin. The final
        // response is checked as well because a browser may expose redirects
        // differently for cross-origin requests.
        redirect: "manual",
      });
      if (
        response.type === "opaqueredirect" ||
        (response.status >= 300 && response.status < 400) ||
        (response.url &&
          !this.workflowScopeAllowsFor(project, "http", response.url))
      )
        throw new Error("The HTTP redirect left the approved web scope.");
      return response;
    };
  }

  private requiresConsequentialApproval(node: WorkflowNode): boolean {
    if (node.type === "http") return node.config.method !== "GET";
    if (node.type !== "dom") return false;
    if (node.config.requiresApproval === true) return true;
    return this.capability(node.config.capabilityId)?.effect === "mutate";
  }

  private activeInvocationAllowed(
    tool: ToolDefinition,
  ): ExecutionResult | null {
    if (this.controlMode !== "running")
      return this.controlFailure(
        this.blocker?.message ?? "Agent actions are currently blocked.",
      );
    const project = this.activeProject;
    const active = this.activeProjectState;
    const approval = this.activeApproval;
    const url = this.currentUrl();
    if (!project || !active || !approval) {
      return this.failure(
        "approval_required",
        "This workflow is not activated on the selected tab.",
      );
    }
    if (active.runtimeGeneration !== this.runtimeGeneration) {
      return this.failure(
        "session_expired",
        "The page document changed; activate the current tab again.",
      );
    }
    let origin = "";
    try {
      origin = new URL(url).origin;
    } catch {
      // Fail closed for non-HTTP or malformed page URLs.
    }
    if (
      (this.lastTargetTabId !== undefined &&
        approval.tabId !== this.lastTargetTabId) ||
      approval.origin !== origin ||
      !matchesSiteScope(project, url)
    ) {
      return this.failure(
        "scope_blocked",
        "The selected tab or page is outside the approved project scope.",
      );
    }
    if (tool.access === "authenticated" && approval.sessionVerified !== true) {
      return this.failure(
        "session_expired",
        "The protected website session is not currently verified.",
      );
    }
    if (projectFingerprint(project) !== approval.snapshotHash) {
      return this.failure(
        "approval_required",
        "The approved snapshot no longer matches this workflow.",
      );
    }
    return null;
  }

  private async executeWorkflow(
    tool: ToolDefinition,
    args: unknown,
  ): Promise<ExecutionResult> {
    const blocked = this.activeInvocationAllowed(tool);
    if (blocked) return blocked;
    const project = this.activeProject;
    if (!project)
      return this.failure("approval_required", "No active project.");
    const startedUrl = this.currentUrl();
    const run = await this.runProjectWorkflow(
      project,
      tool,
      args,
      this.activeApproval,
    );
    return this.workflowToExecutionResult(run, startedUrl);
  }

  private async runProjectWorkflow(
    project: ProjectDocument,
    tool: ToolDefinition,
    args: unknown,
    approval: ActivationApproval | null,
  ): Promise<WorkflowRunResult> {
    let run: WorkflowRunResult;
    const scopedFetch = this.scopedFetch(project);
    try {
      run = await runWorkflow(tool, args, {
        revision: project.project.revision,
        runtime: {
          document,
          urlProvider: () => this.currentUrl(),
          ...(scopedFetch ? { fetch: scopedFetch } : {}),
          capabilities: this.application?.graph.capabilities ?? {},
          discoveredActions: project.discoveredActions,
          executeCapability: (capabilityId, invocationArgs) =>
            this.execute(capabilityId, invocationArgs, true),
          isAllowed: (kind, target) =>
            this.workflowScopeAllowsFor(project, kind, target),
          isApproved: (node) => {
            if (!this.requiresConsequentialApproval(node)) return true;
            return approval?.allowConsequential === true;
          },
        },
      });
    } catch (error) {
      return this.workflowFailure(
        project,
        tool,
        "execution_timeout",
        error instanceof Error ? error.message : String(error),
      );
    }
    return run;
  }

  private workflowToExecutionResult(
    run: WorkflowRunResult,
    startedUrl: string,
  ): ExecutionResult {
    const urlAfter = this.currentUrl();
    const result: ExecutionResult = {
      success: run.success,
      status: run.status === "completed" ? "completed" : run.status,
      urlBefore: startedUrl,
      urlAfter,
      navigationOccurred: startedUrl !== urlAfter,
      stateChanged: run.trace.some(
        (entry) => entry.status === "completed" && entry.type !== "condition",
      ),
      warnings: [...run.warnings],
      ...(run.result === undefined ? {} : { result: run.result }),
      ...(run.success
        ? {}
        : {
            error: {
              code: run.status as ExecutionError["code"],
              message: run.failedNodeId
                ? `${run.status} at workflow node ${run.failedNodeId}.`
                : run.status,
              details: { runId: run.runId, revision: run.revision },
            },
          }),
    };
    return result;
  }

  private failure(
    code: ExecutionFailureCode,
    message: string,
  ): ExecutionResult {
    const url = this.currentUrl();
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

  private projectHasLiveCapabilities(project: ProjectDocument): boolean {
    for (const tool of project.tools) {
      if (!tool.enabled) continue;
      for (const node of tool.workflow.nodes) {
        if (node.type !== "dom") continue;
        if (!this.capability(node.config.capabilityId)) return false;
      }
    }
    return true;
  }

  private parseTestApproval(
    project: ProjectDocument,
    value: unknown,
    tabId: number,
  ): ActivationApproval | null {
    if (!isRecord(value)) return null;
    if (
      value.snapshotHash !== projectFingerprint(project) ||
      value.tabId !== tabId ||
      typeof value.approvedAt !== "number" ||
      !Number.isFinite(value.approvedAt) ||
      typeof value.origin !== "string" ||
      typeof value.allowConsequential !== "boolean" ||
      (value.sessionVerified !== undefined &&
        typeof value.sessionVerified !== "boolean")
    )
      return null;
    let origin = "";
    try {
      origin = new URL(this.currentUrl()).origin;
    } catch {
      return null;
    }
    if (value.origin !== origin) return null;
    return value as unknown as ActivationApproval;
  }

  private workflowFailure(
    project: ProjectDocument,
    tool: ToolDefinition,
    status: WorkflowRunStatus,
    message: string,
  ): WorkflowRunResult {
    return {
      success: false,
      status,
      trace: [],
      warnings: [message],
      runId: `test-${randomToken()}`,
      toolId: tool.id,
      revision: project.project.revision,
    };
  }

  private async activateProject(
    projectValue: unknown,
    approvalValue: unknown,
    tabId: number | undefined,
  ): Promise<InspectorState> {
    const targetTabId = tabId ?? -1;
    this.lastTargetTabId = tabId;
    const previous = {
      project: this.activeProject,
      approval: this.activeApproval,
      state: this.activeProjectState,
    };
    try {
      const activated = validateActivation(
        projectValue,
        approvalValue,
        targetTabId,
        this.currentUrl(),
      );
      if (!this.projectHasLiveCapabilities(activated.project)) {
        throw new ProjectActivationError(
          "invalid_project",
          "Every DOM workflow step must reference a capability in the current page graph.",
        );
      }
      if (
        activated.project.tools.some(
          (tool) => tool.enabled && tool.access === "authenticated",
        ) &&
        activated.approval.sessionVerified !== true
      ) {
        throw new ProjectActivationError(
          "invalid_project",
          "Protected workflow tools require explicit human session verification before activation.",
        );
      }
      this.activeProject = activated.project;
      this.activeApproval = activated.approval;
      this.controlMode = "running";
      this.authentication = activated.approval.sessionVerified
        ? "verified"
        : activated.project.tools.some(
              (tool) => tool.access === "authenticated",
            )
          ? "login_required"
          : "not_required";
      this.blocker = null;
      this.activeProjectState = {
        ...activated.active,
        toolNames: this.eligibleWorkflowTools(activated.project).map(
          (tool) => tool.name,
        ),
        runtimeGeneration: this.runtimeGeneration,
      };
      const status = await this.syncRegistration();
      const names = this.activeProjectState.toolNames;
      const rejected = names.find((name) =>
        status.rejected.some((entry) => entry.name === name),
      );
      const missing = names.find((name) => !status.registered.includes(name));
      if (rejected || missing) {
        throw new ProjectActivationError(
          "invalid_project",
          `The approved workflow could not be registered${rejected ? `: ${rejected}` : `: ${missing}`}.`,
        );
      }
      this.publishState();
      return this.state();
    } catch (error) {
      this.activeProject = previous.project;
      this.activeApproval = previous.approval;
      this.activeProjectState = previous.state;
      await this.syncRegistration();
      if (error instanceof ProjectActivationError) {
        throw new Error(`Activation ${error.code}: ${error.message}`);
      }
      throw error;
    }
  }

  private async deactivateProject(): Promise<InspectorState> {
    this.activeProject = null;
    this.activeApproval = null;
    this.activeProjectState = null;
    await this.syncRegistration();
    this.publishState();
    return this.state();
  }

  private async testProject(
    projectValue: unknown,
    toolId: string,
    args: unknown,
    approvalValue: unknown,
    tabId: number | undefined,
  ): Promise<WorkflowRunResult> {
    const targetTabId = tabId ?? -1;
    const project = cloneProject(
      validateProject(projectValue, { requireRunnable: true }),
    );
    const tool = project.tools.find((candidate) => candidate.id === toolId);
    if (!tool)
      return this.workflowFailure(
        project,
        project.tools[0] ?? ({ id: toolId } as ToolDefinition),
        "validation_failed",
        "The selected tool is not present in the project.",
      );
    if (this.controlMode !== "running")
      return this.workflowFailure(
        project,
        tool,
        "cancelled",
        this.blocker?.message ?? "Agent actions are currently blocked.",
      );
    if (!matchesSiteScope(project, this.currentUrl()))
      return this.workflowFailure(
        project,
        tool,
        "scope_blocked",
        "The connected tab is outside the project site scope.",
      );
    const approval = this.parseTestApproval(
      project,
      approvalValue,
      targetTabId,
    );
    if (tool.access === "authenticated" && approval?.sessionVerified !== true)
      return this.workflowFailure(
        project,
        tool,
        "session_expired",
        "The protected website session must be verified by a human before testing.",
      );
    const startedUrl = this.currentUrl();
    const result = await this.runProjectWorkflow(project, tool, args, approval);
    this.lastExecution = {
      capabilityId: workflowCapabilityId(project.project.id, tool.id),
      result: this.workflowToExecutionResult(result, startedUrl),
    };
    this.publishState();
    return { ...result, trace: result.trace.map((entry) => ({ ...entry })) };
  }

  private syncRegistration(): Promise<WebMcpStatus> {
    const operation = this.registrationTail.then(
      () => this.syncRegistrationNow(),
      () => this.syncRegistrationNow(),
    );
    this.registrationTail = operation.then(
      () => this.status,
      () => this.status,
    );
    return operation;
  }

  private async syncRegistrationNow(): Promise<WebMcpStatus> {
    if (this.activeProject && this.activeProjectState) {
      this.activeProjectState = {
        ...this.activeProjectState,
        toolNames: this.eligibleWorkflowTools(this.activeProject).map(
          (tool) => tool.name,
        ),
      };
    }
    try {
      const status = await this.bridge.sync(
        this.application
          ? Object.values(this.application.graph.capabilities)
          : [],
        this.enabled,
        this.activeProject
          ? compileProjectTools(this.activeProject).filter((descriptor) => {
              const tool = this.activeProject?.tools.find(
                (candidate) => candidate.id === descriptor.toolId,
              );
              return Boolean(
                tool &&
                this.eligibleWorkflowTool(
                  tool,
                  this.activeProject as ProjectDocument,
                ),
              );
            })
          : [],
      );
      this.status = status;
      return status;
    } catch (error) {
      this.status = {
        ...this.status,
        rejected: [{ name: "bridge", message: safeResultError(error) }],
      };
      return this.status;
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
    void this.executeInvocation(payload.capabilityId, payload.args)
      .catch((error: unknown) =>
        this.failure(
          "execution_timeout",
          `The workflow executor failed before returning a result: ${safeResultError(error)}`,
        ),
      )
      .then((result) => {
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
    if (message.tabId !== undefined) this.lastTargetTabId = message.tabId;
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
      case "polyfill:control":
        return this.handleControlMessage(message);
      case "polyfill:invoke":
        return {
          ok: true,
          result: await this.invoke(message.capabilityId, message.args),
        };
      case "polyfill:activate-project":
        return {
          ok: true,
          state: await this.activateProject(
            message.project,
            message.approval,
            message.tabId,
          ),
        };
      case "polyfill:deactivate-project":
        return { ok: true, state: await this.deactivateProject() };
      case "polyfill:get-project":
        return {
          ok: true,
          project: this.activeProject ? cloneProject(this.activeProject) : null,
        };
      case "polyfill:test-project":
        return {
          ok: true,
          workflow: await this.testProject(
            message.project,
            message.toolId,
            message.args,
            message.approval,
            message.tabId,
          ),
        };
      case "polyfill:perform-browser-action":
        return {
          ok: true,
          action: await this.performBrowserAction(
            message.sessionId,
            message.capabilityId,
            message.args,
            message.expectedObservation,
            message.approval,
            message.project,
          ),
        };
      case "polyfill:read-observed-requests": {
        const requests = this.readObservedRequests(
          message.sessionId,
          message.cursor,
        );
        if (!("sessionId" in requests)) return requests;
        return { ok: true, requests };
      }
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
