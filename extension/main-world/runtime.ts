import {
  BRIDGE_CHANNEL,
  BRIDGE_VERSION,
  createBridgeMessage,
  isBridgeRequest,
} from "../../core/bridge-protocol";
import type {
  BridgeRequest,
  BridgeResponse,
  BridgeResponsePayload,
} from "../../core/bridge-protocol";
import {
  cloneJsonSchema,
  compileCapabilitiesWithDiagnostics,
  descriptorsEqual,
} from "../../core/compiler";
import type {
  WebMcpToolAnnotations,
  WebMcpToolDescriptor,
} from "../../core/compiler";
import { markExtensionToolRegistration } from "./model-context";
import type {
  Capability,
  ExecutionFailureCode,
  ExecutionResult,
  JSONSchema,
  NativeToolSummary,
  WebMcpStatus,
} from "../../core/types";

const MODEL_CONTEXT_METHODS = [
  "provideTool",
  "provideTools",
  "registerTool",
  "registerTools",
  "updateTool",
  "updateTools",
  "unregisterTool",
  "unregisterTools",
  "removeTool",
  "removeTools",
  "clearContext",
  "clearTools",
  "getTools",
  "listTools",
  "getToolDefinitions",
  "executeTool",
] as const;

const SINGLE_REGISTER_METHODS = ["provideTool", "registerTool"] as const;
const BATCH_REGISTER_METHODS = ["provideTools", "registerTools"] as const;
const SINGLE_UPDATE_METHODS = ["updateTool"] as const;
const BATCH_UPDATE_METHODS = ["updateTools"] as const;
const SINGLE_REMOVE_METHODS = ["unregisterTool", "removeTool"] as const;
const BATCH_REMOVE_METHODS = ["unregisterTools", "removeTools"] as const;
const CLEAR_METHODS = ["clearContext", "clearTools"] as const;

type ModelContextMethod = (...args: unknown[]) => unknown;
type ModelContextRecord = Record<string, unknown>;

export interface ModelContextLike extends ModelContextRecord {}

export interface WebMcpToolRegistration {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  annotations: WebMcpToolAnnotations;
  execute: (args: unknown) => Promise<ExecutionResult>;
}

export interface MainWorldRuntimeOptions {
  window?: Window;
  document?: Document;
  token?: string;
  invocationTimeoutMs?: number;
  /** JSDOM emits null for same-window MessageEvent.source. */
  acceptNullMessageSource?: boolean;
}

interface RegisteredTool {
  descriptor: WebMcpToolDescriptor;
  handle?: unknown;
  abortController?: AbortController;
}

interface PendingInvocation {
  requestId: string;
  messageId: string;
  urlBefore: string;
  timer: number;
  resolve: (result: ExecutionResult) => void;
}

interface DocumentWithModelContext extends Document {
  modelContext?: unknown;
}

interface ContextInspection {
  apiMethods: string[];
  nativeTools: NativeToolSummary[];
  toolNames: ReadonlySet<string>;
  nativeInventoryKnown: boolean;
}

interface RemoveResult {
  names: Set<string>;
}

let fallbackId = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function methodAt(
  context: ModelContextLike,
  name: string,
): ModelContextMethod | undefined {
  try {
    const candidate = context[name];
    return typeof candidate === "function"
      ? (candidate as ModelContextMethod)
      : undefined;
  } catch {
    return undefined;
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "The WebMCP host rejected the operation.";
}

function randomId(prefix: string): string {
  try {
    const cryptoValue = globalThis.crypto;
    if (typeof cryptoValue?.randomUUID === "function") {
      return `${prefix}-${cryptoValue.randomUUID()}`;
    }
  } catch {
    // Fall through to a process-local identifier for older test/browser hosts.
  }
  fallbackId += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
}

function isJsonCompatible(
  value: unknown,
  ancestors = new Set<object>(),
): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return value.every((item) => isJsonCompatible(item, nextAncestors));
  }

  const record = value as Record<string, unknown>;
  return Object.keys(record).every((key) =>
    isJsonCompatible(record[key], nextAncestors),
  );
}

function isCapabilityForBridge(value: unknown): value is Capability {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    isRecord(value.inputSchema) &&
    (value.effect === "read" ||
      value.effect === "navigate" ||
      value.effect === "interact" ||
      value.effect === "mutate")
  );
}

function isCapabilityList(value: unknown): value is Capability[] {
  return Array.isArray(value) && value.every(isCapabilityForBridge);
}

function isToolDescriptor(value: unknown): value is WebMcpToolDescriptor {
  return (
    isRecord(value) &&
    typeof value.capabilityId === "string" &&
    value.capabilityId.trim().length > 0 &&
    typeof value.name === "string" &&
    value.name.trim().length > 0 &&
    typeof value.description === "string" &&
    isRecord(value.inputSchema) &&
    isRecord(value.annotations) &&
    (value.kind === undefined ||
      value.kind === "capability" ||
      value.kind === "workflow") &&
    (value.projectId === undefined || typeof value.projectId === "string") &&
    (value.toolId === undefined || typeof value.toolId === "string")
  );
}

function isToolDescriptorList(value: unknown): value is WebMcpToolDescriptor[] {
  return Array.isArray(value) && value.every(isToolDescriptor);
}

function isBridgeResponse(value: unknown): value is BridgeResponse {
  if (!isRecord(value)) return false;
  return (
    value.channel === BRIDGE_CHANNEL &&
    value.version === BRIDGE_VERSION &&
    value.direction === "from-main" &&
    typeof value.token === "string" &&
    typeof value.messageId === "string" &&
    isRecord(value.payload)
  );
}

function isWebMcpStatus(value: unknown): value is WebMcpStatus {
  if (!isRecord(value)) return false;
  if (
    typeof value.available !== "boolean" ||
    !Array.isArray(value.apiMethods) ||
    !value.apiMethods.every((method) => typeof method === "string") ||
    !Array.isArray(value.nativeTools) ||
    !Array.isArray(value.registered) ||
    !value.registered.every((name) => typeof name === "string") ||
    !Array.isArray(value.rejected)
  ) {
    return false;
  }
  return (
    value.nativeTools.every(
      (tool) =>
        isRecord(tool) &&
        typeof tool.name === "string" &&
        normalizeNativeTool(tool) !== null,
    ) &&
    value.rejected.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.name === "string" &&
        typeof entry.message === "string",
    )
  );
}

function isExecutionFailureCode(value: unknown): value is ExecutionFailureCode {
  return (
    value === "target_not_found" ||
    value === "ambiguous_target" ||
    value === "validation_failed" ||
    value === "no_observable_change" ||
    value === "cross_origin_blocked" ||
    value === "permission_blocked" ||
    value === "webmcp_unavailable" ||
    value === "execution_timeout" ||
    value === "unsupported_control" ||
    value === "invalid_arguments" ||
    value === "registration_rejected" ||
    value === "approval_required" ||
    value === "scope_blocked" ||
    value === "session_expired" ||
    value === "cancelled" ||
    value === "ambiguous_delivery"
  );
}

function isExecutionResult(value: unknown): value is ExecutionResult {
  if (!isRecord(value)) return false;
  const status = value.status;
  const validStatus = status === "completed" || isExecutionFailureCode(status);
  return (
    typeof value.success === "boolean" &&
    validStatus &&
    typeof value.urlBefore === "string" &&
    typeof value.urlAfter === "string" &&
    typeof value.navigationOccurred === "boolean" &&
    typeof value.stateChanged === "boolean" &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === "string")
  );
}

function emptyStatus(): WebMcpStatus {
  return {
    available: false,
    apiMethods: [],
    nativeTools: [],
    registered: [],
    rejected: [],
  };
}

function nativeToolName(value: unknown): string | null {
  const name =
    typeof value === "string"
      ? value
      : isRecord(value) && typeof value.name === "string"
        ? value.name
        : "";
  return name.trim() || null;
}

function normalizeNativeTool(value: unknown): NativeToolSummary | null {
  const name = nativeToolName(value);
  if (name === null) return null;
  if (!isRecord(value)) return { name };

  const summary: NativeToolSummary = { name };
  if (typeof value.description === "string") {
    summary.description = value.description;
  }
  if (isRecord(value.inputSchema)) {
    summary.inputSchema = cloneJsonSchema(value.inputSchema as JSONSchema);
  }
  return summary;
}

function collectToolCandidates(value: unknown, output: unknown[]): boolean {
  if (Array.isArray(value)) {
    output.push(...value);
    return value.every((candidate) => nativeToolName(candidate) !== null);
  }
  if (!isRecord(value)) return false;

  if (Array.isArray(value.tools)) {
    return collectToolCandidates(value.tools, output);
  }
  if (nativeToolName(value) !== null) {
    output.push(value);
    return true;
  }

  // Some hosts expose a plain name → definition object rather than an array.
  // Other objects, including Map, must not be mistaken for an empty inventory.
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && Object.getPrototypeOf(prototype) !== null) {
    return false;
  }
  const candidates = Object.values(value);
  for (const candidate of candidates) {
    if (isRecord(candidate) && nativeToolName(candidate) !== null) {
      output.push(candidate);
    }
  }
  return candidates.every(
    (candidate) => isRecord(candidate) && nativeToolName(candidate) !== null,
  );
}

function normalizeNativeTools(
  values: readonly unknown[],
  inferredNames: ReadonlySet<string>,
): NativeToolSummary[] {
  const seen = new Set<string>();
  const result: NativeToolSummary[] = [];
  for (const value of values) {
    const summary = normalizeNativeTool(value);
    if (!summary) continue;
    const normalized = summary.name.trim().toLowerCase();
    const isInferred = [...inferredNames].some(
      (name) => name.trim().toLowerCase() === normalized,
    );
    if (isInferred || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(summary);
  }
  return result;
}

function statusCopy(status: WebMcpStatus): WebMcpStatus {
  return {
    available: status.available,
    apiMethods: [...status.apiMethods],
    nativeTools: status.nativeTools.map((tool) => {
      const copy: NativeToolSummary = { name: tool.name };
      if (tool.description !== undefined) copy.description = tool.description;
      if (tool.inputSchema !== undefined) {
        copy.inputSchema = cloneJsonSchema(tool.inputSchema);
      }
      return copy;
    }),
    registered: [...status.registered],
    rejected: status.rejected.map((entry) => ({ ...entry })),
  };
}

export class MainWorldWebMcpRuntime {
  private readonly pageWindow: Window | null;
  private readonly pageDocument: Document | null;
  private readonly invocationTimeoutMs: number;
  private readonly acceptNullMessageSource: boolean;
  private readonly messageListener: (event: MessageEvent<unknown>) => void;
  private readonly registered = new Map<string, RegisteredTool>();
  private readonly pendingByRequestId = new Map<string, PendingInvocation>();
  private readonly pendingByMessageId = new Map<string, PendingInvocation>();
  private readonly rejected = new Map<string, string>();
  private desired = new Map<string, WebMcpToolDescriptor>();
  private activeContext: ModelContextLike | null = null;
  private nativeInventoryKnown = false;
  private operationTail: Promise<void> = Promise.resolve();
  private started = false;
  private token: string | null;
  private currentStatus: WebMcpStatus = emptyStatus();

  public constructor(options: MainWorldRuntimeOptions = {}) {
    const runtimeWindow =
      options.window ??
      (typeof globalThis.window === "undefined" ? null : globalThis.window);
    this.pageWindow = runtimeWindow;
    this.pageDocument = options.document ?? runtimeWindow?.document ?? null;
    this.invocationTimeoutMs = Math.max(
      1,
      options.invocationTimeoutMs ?? 10_000,
    );
    this.acceptNullMessageSource = options.acceptNullMessageSource ?? true;
    this.token = options.token?.trim() || null;
    this.messageListener = (event) => {
      void this.handleMessage(event);
    };
  }

  public start(): this {
    if (!this.started && this.pageWindow) {
      this.pageWindow.addEventListener("message", this.messageListener);
      this.started = true;
    }
    return this;
  }

  public stop(): void {
    if (this.started && this.pageWindow) {
      this.pageWindow.removeEventListener("message", this.messageListener);
    }
    this.started = false;
    for (const pending of [...this.pendingByRequestId.values()]) {
      this.settlePending(
        pending,
        this.createFailure(
          "webmcp_unavailable",
          "The MAIN-world bridge has stopped before the invocation completed.",
          pending.urlBefore,
        ),
      );
    }
  }

  public getStatusSnapshot(): WebMcpStatus {
    return statusCopy(this.currentStatus);
  }

  public getRegisteredDescriptors(): WebMcpToolDescriptor[] {
    return [...this.registered.values()].map(({ descriptor }) => ({
      ...descriptor,
      inputSchema: cloneJsonSchema(descriptor.inputSchema),
      annotations: { ...descriptor.annotations },
    }));
  }

  /** Public entry point used by tests and by the isolated-world bridge. */
  public syncCapabilities(
    capabilities: readonly Capability[],
    enabled = true,
    nativeTools?: readonly NativeToolSummary[],
    workflowTools?: readonly WebMcpToolDescriptor[],
  ): Promise<WebMcpStatus> {
    return this.enqueue(() =>
      this.synchronize(capabilities, enabled, nativeTools, workflowTools),
    );
  }

  public getStatus(): Promise<WebMcpStatus> {
    return this.enqueue(() => this.inspectStatus());
  }

  public syncTools(
    capabilities: readonly Capability[],
    enabled = true,
    nativeTools?: readonly NativeToolSummary[],
    workflowTools?: readonly WebMcpToolDescriptor[],
  ): Promise<WebMcpStatus> {
    return this.syncCapabilities(
      capabilities,
      enabled,
      nativeTools,
      workflowTools,
    );
  }

  public handleBridgeMessage(event: MessageEvent<unknown>): Promise<void> {
    return this.handleMessage(event);
  }

  /**
   * Handle one typed window message.  Keeping this method public makes the
   * bridge independently testable without requiring a browser event loop.
   */
  public async handleMessage(event: MessageEvent<unknown>): Promise<void> {
    if (!this.isSameWindowMessage(event)) return;

    const value = event.data;
    if (isBridgeResponse(value)) {
      if (!this.token || value.token !== this.token) return;
      this.handleResponse(value);
      return;
    }
    if (!isBridgeRequest(value)) return;

    if (value.payload.type === "init") {
      if (!this.acceptInitToken(value)) return;
      try {
        const status = await this.getStatus();
        this.postResponse(value.messageId, { type: "ready", status });
      } catch (error) {
        this.postResponse(value.messageId, {
          type: "error",
          message: safeErrorMessage(error),
        });
      }
      return;
    }

    if (!this.token || value.token !== this.token) return;

    switch (value.payload.type) {
      case "sync-tools":
        if (
          typeof value.payload.enabled !== "boolean" ||
          !isCapabilityList(value.payload.capabilities) ||
          (value.payload.workflowTools !== undefined &&
            !isToolDescriptorList(value.payload.workflowTools))
        ) {
          this.postResponse(value.messageId, {
            type: "error",
            message: "The bridge supplied an invalid capability graph payload.",
          });
          return;
        }
        try {
          const status = await this.syncCapabilities(
            value.payload.capabilities,
            value.payload.enabled,
            undefined,
            value.payload.workflowTools,
          );
          this.postResponse(value.messageId, { type: "registration", status });
        } catch (error) {
          this.postResponse(value.messageId, {
            type: "error",
            message: safeErrorMessage(error),
          });
        }
        return;
      case "get-status":
        try {
          const status = await this.getStatus();
          this.postResponse(value.messageId, { type: "status", status });
        } catch (error) {
          this.postResponse(value.messageId, {
            type: "error",
            message: safeErrorMessage(error),
          });
        }
        return;
      case "invoke":
        // Invocation requests travel MAIN → isolated.  The MAIN listener sees
        // its own postMessage too, so it deliberately ignores this direction.
        return;
      default:
        return;
    }
  }

  /** Invoke the content-side executor for a registered WebMCP tool. */
  public invokeCapability(
    capabilityId: string,
    args: unknown,
  ): Promise<ExecutionResult> {
    const urlBefore = this.currentUrl();
    const pageWindow = this.pageWindow;
    if (!pageWindow || !this.token) {
      return Promise.resolve(
        this.createFailure(
          "webmcp_unavailable",
          "The MAIN-world bridge is not initialized.",
          urlBefore,
        ),
      );
    }
    let argsAreSafe = false;
    try {
      argsAreSafe = isJsonCompatible(args);
    } catch {
      argsAreSafe = false;
    }
    if (!argsAreSafe) {
      return Promise.resolve(
        this.createFailure(
          "invalid_arguments",
          "Tool arguments must be JSON-compatible before crossing the bridge.",
          urlBefore,
        ),
      );
    }

    const requestId = randomId("invoke");
    let request: BridgeRequest;
    try {
      request = createBridgeMessage(this.token, {
        type: "invoke",
        requestId,
        capabilityId,
        args,
      });
    } catch {
      request = {
        channel: BRIDGE_CHANNEL,
        version: BRIDGE_VERSION,
        direction: "to-main",
        token: this.token,
        messageId: randomId("bridge"),
        payload: { type: "invoke", requestId, capabilityId, args },
      };
    }

    return new Promise<ExecutionResult>((resolve) => {
      const timer = pageWindow.setTimeout(() => {
        const pending = this.pendingByRequestId.get(requestId);
        if (!pending) return;
        this.settlePending(
          pending,
          this.createFailure(
            "execution_timeout",
            "The isolated-world executor did not return before the timeout.",
            pending.urlBefore,
          ),
        );
      }, this.invocationTimeoutMs);

      if (timer === undefined) {
        resolve(
          this.createFailure(
            "execution_timeout",
            "The browser did not provide a timer for bridge invocation.",
            urlBefore,
          ),
        );
        return;
      }

      const pending: PendingInvocation = {
        requestId,
        messageId: request.messageId,
        urlBefore,
        timer,
        resolve,
      };
      this.pendingByRequestId.set(requestId, pending);
      this.pendingByMessageId.set(request.messageId, pending);

      try {
        pageWindow.postMessage(request, "*");
      } catch (error) {
        this.settlePending(
          pending,
          this.createFailure(
            "permission_blocked",
            `The browser rejected the bridge message: ${safeErrorMessage(error)}`,
            urlBefore,
          ),
        );
      }
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private isSameWindowMessage(event: MessageEvent<unknown>): boolean {
    if (!this.pageWindow) return false;
    return (
      event.source === this.pageWindow ||
      (event.source === null && this.acceptNullMessageSource)
    );
  }

  private acceptInitToken(request: BridgeRequest): boolean {
    if (request.payload.type !== "init") return false;
    if (typeof request.payload.token !== "string") return false;
    const token = request.payload.token.trim();
    if (!token || request.token !== token) return false;
    if (this.token && this.token !== token) return false;
    this.token = token;
    return true;
  }

  private postResponse(
    messageId: string,
    payload: BridgeResponsePayload,
  ): void {
    if (!this.pageWindow || !this.token) return;
    const response: BridgeResponse = {
      channel: BRIDGE_CHANNEL,
      version: BRIDGE_VERSION,
      direction: "from-main",
      token: this.token,
      messageId,
      payload,
    };
    try {
      this.pageWindow.postMessage(response, "*");
    } catch {
      // A page can disappear while a response is being sent.  There is no
      // privileged fallback path from MAIN world, so the event is dropped.
    }
  }

  private handleResponse(response: BridgeResponse): void {
    const payload = response.payload;
    switch (payload.type) {
      case "invoke-result": {
        const pending = this.pendingByRequestId.get(payload.requestId);
        if (!pending) return;
        const result = isExecutionResult(payload.result)
          ? payload.result
          : this.createFailure(
              "invalid_arguments",
              "The isolated-world executor returned a malformed result.",
              pending.urlBefore,
            );
        this.settlePending(pending, result);
        return;
      }
      case "ready":
      case "status":
      case "registration":
        if (!isWebMcpStatus(payload.status)) return;
        this.currentStatus = statusCopy(payload.status);
        return;
      case "error": {
        const pending = this.pendingByMessageId.get(response.messageId);
        if (!pending) return;
        this.settlePending(
          pending,
          this.createFailure(
            "permission_blocked",
            `The bridge returned an error: ${payload.message}`,
            pending.urlBefore,
          ),
        );
        return;
      }
      default:
        return;
    }
  }

  private settlePending(
    pending: PendingInvocation,
    result: ExecutionResult,
  ): void {
    if (!this.pendingByRequestId.has(pending.requestId)) return;
    this.pendingByRequestId.delete(pending.requestId);
    this.pendingByMessageId.delete(pending.messageId);
    this.pageWindow?.clearTimeout(pending.timer);
    pending.resolve(result);
  }

  private readModelContext(): ModelContextLike | null {
    if (!this.pageDocument) return null;
    try {
      const candidate = (this.pageDocument as DocumentWithModelContext)
        .modelContext;
      return isRecord(candidate) ? candidate : null;
    } catch {
      return null;
    }
  }

  private selectContext(context: ModelContextLike | null): void {
    if (context === this.activeContext) return;
    this.activeContext = context;
    this.registered.clear();
    this.rejected.clear();
    this.nativeInventoryKnown = false;
  }

  private async inspectContext(
    context: ModelContextLike,
  ): Promise<ContextInspection> {
    const apiMethods = MODEL_CONTEXT_METHODS.filter((name) =>
      Boolean(methodAt(context, name)),
    );
    const candidates: unknown[] = [];
    let nativeInventoryKnown = false;

    for (const methodName of ["getTools", "listTools", "getToolDefinitions"]) {
      const method = methodAt(context, methodName);
      if (!method) continue;
      try {
        const value = await method.call(context);
        if (collectToolCandidates(value, candidates)) {
          nativeInventoryKnown = true;
        }
      } catch {
        // A host may expose a discovery method behind a permission gate.  The
        // registration path remains usable; only native deduplication is less
        // certain for that host.
      }
    }

    for (const propertyName of ["tools", "nativeTools", "registeredTools"]) {
      try {
        const value = context[propertyName];
        if (value === undefined) continue;
        if (collectToolCandidates(value, candidates)) {
          nativeInventoryKnown = true;
        }
      } catch {
        // Treat throwing getters as an unavailable native inventory.
      }
    }

    const toolNames = new Set<string>();
    for (const candidate of candidates) {
      const name = nativeToolName(candidate);
      if (name !== null) toolNames.add(name);
    }
    return {
      apiMethods,
      nativeTools: normalizeNativeTools(
        candidates,
        new Set(this.registered.keys()),
      ),
      toolNames,
      nativeInventoryKnown,
    };
  }

  private reconcileAbortedRegistrations(inspection: ContextInspection): void {
    if (!inspection.nativeInventoryKnown) return;
    for (const [name, registration] of this.registered) {
      if (
        registration.abortController?.signal.aborted &&
        !inspection.toolNames.has(name)
      ) {
        // A previous abort can succeed even when its immediate inventory check
        // fails. Resolve that uncertainty before an unchanged descriptor skips
        // registration, otherwise re-enabling would leave the tool absent.
        this.registered.delete(name);
        this.rejected.delete(name);
      }
    }
  }

  private async inspectStatus(): Promise<WebMcpStatus> {
    const context = this.readModelContext();
    this.selectContext(context);
    if (!context) {
      this.nativeInventoryKnown = false;
      this.currentStatus = this.makeStatus(false, [], []);
      return statusCopy(this.currentStatus);
    }

    const inspection = await this.inspectContext(context);
    this.nativeInventoryKnown = inspection.nativeInventoryKnown;
    this.reconcileAbortedRegistrations(inspection);
    this.currentStatus = this.makeStatus(
      true,
      inspection.apiMethods,
      inspection.nativeTools,
    );
    return statusCopy(this.currentStatus);
  }

  private async synchronize(
    capabilities: readonly Capability[],
    enabled: boolean,
    nativeToolsOverride?: readonly NativeToolSummary[],
    workflowTools?: readonly WebMcpToolDescriptor[],
  ): Promise<WebMcpStatus> {
    const context = this.readModelContext();
    this.selectContext(context);

    const inspection = context
      ? await this.inspectContext(context)
      : {
          apiMethods: [],
          nativeTools: [],
          toolNames: new Set<string>(),
          nativeInventoryKnown: false,
        };
    this.nativeInventoryKnown = inspection.nativeInventoryKnown;
    this.reconcileAbortedRegistrations(inspection);
    const nativeTools = nativeToolsOverride
      ? normalizeNativeTools(
          nativeToolsOverride,
          new Set(this.registered.keys()),
        )
      : inspection.nativeTools;
    const compilation = enabled
      ? compileCapabilitiesWithDiagnostics(capabilities, { nativeTools })
      : { tools: [], skipped: [] };
    const desired = new Map(
      compilation.tools.map((descriptor) => [descriptor.name, descriptor]),
    );
    const nativeNames = new Set(
      nativeTools.map((tool) => tool.name.trim().toLowerCase()),
    );
    const workflowRejected = new Set<string>();
    for (const descriptor of workflowTools ?? []) {
      const name = descriptor.name.trim();
      const normalized = name.toLowerCase();
      if (
        !name ||
        nativeNames.has(normalized) ||
        [...desired.keys()].some(
          (candidate) => candidate.toLowerCase() === normalized,
        )
      ) {
        workflowRejected.add(name || descriptor.capabilityId);
        this.rejected.set(
          name || descriptor.capabilityId,
          nativeNames.has(normalized)
            ? "A native WebMCP tool already owns this name."
            : "Another registered tool already owns this name.",
        );
        continue;
      }
      desired.set(name, {
        ...descriptor,
        name,
        description: descriptor.description.trim() || "Project workflow tool.",
        inputSchema: cloneJsonSchema(descriptor.inputSchema),
        annotations: { ...descriptor.annotations },
      });
    }
    this.desired = desired;
    for (const name of this.rejected.keys()) {
      if (
        !this.desired.has(name) &&
        !this.registered.has(name) &&
        !workflowRejected.has(name)
      ) {
        this.rejected.delete(name);
      }
    }

    if (!context) {
      this.currentStatus = this.makeStatus(false, [], nativeTools);
      return statusCopy(this.currentStatus);
    }

    await this.reconcile(context, this.desired, nativeTools);
    this.currentStatus = this.makeStatus(
      true,
      inspection.apiMethods,
      nativeTools,
    );
    return statusCopy(this.currentStatus);
  }

  private makeStatus(
    available: boolean,
    apiMethods: readonly string[],
    nativeTools: readonly NativeToolSummary[],
  ): WebMcpStatus {
    return {
      available,
      apiMethods: [...apiMethods],
      nativeTools: nativeTools.map((tool) => {
        const copy: NativeToolSummary = { name: tool.name };
        if (tool.description !== undefined) copy.description = tool.description;
        if (tool.inputSchema !== undefined) {
          copy.inputSchema = cloneJsonSchema(tool.inputSchema);
        }
        return copy;
      }),
      registered: [...this.registered.keys()],
      rejected: [...this.rejected.entries()].map(([name, message]) => ({
        name,
        message,
      })),
    };
  }

  private async reconcile(
    context: ModelContextLike,
    desired: ReadonlyMap<string, WebMcpToolDescriptor>,
    nativeTools: readonly NativeToolSummary[],
  ): Promise<void> {
    const stale = [...this.registered.keys()].filter(
      (name) => !desired.has(name),
    );

    if (stale.length > 0) {
      const removeResult = await this.removeRegistered(
        context,
        stale,
        nativeTools,
      );
      if (removeResult === null) {
        for (const name of stale) {
          this.rejected.set(
            name,
            "The host exposes no safe method for unregistering this inferred tool.",
          );
        }
      } else {
        for (const name of removeResult.names) {
          this.registered.delete(name);
          this.rejected.delete(name);
        }
      }
    }

    for (const [name, descriptor] of desired) {
      const existing = this.registered.get(name);
      if (!existing) {
        await this.registerOne(context, descriptor);
        continue;
      }
      if (descriptorsEqual(existing.descriptor, descriptor)) continue;

      const updated = await this.updateOne(context, descriptor);
      if (updated) {
        this.registered.set(name, { ...existing, descriptor });
        this.rejected.delete(name);
        continue;
      }

      const removed = await this.removeRegistered(context, [name], nativeTools);
      if (removed?.names.has(name)) {
        this.registered.delete(name);
        await this.registerOne(context, descriptor);
      } else {
        this.rejected.set(
          name,
          "The host rejected the changed tool and could not replace its old registration.",
        );
      }
    }
  }

  private async registerOne(
    context: ModelContextLike,
    descriptor: WebMcpToolDescriptor,
  ): Promise<boolean> {
    const registration = this.createRegistration(descriptor);
    const single = this.findMethod(context, SINGLE_REGISTER_METHODS);
    const batch = this.findMethod(context, BATCH_REGISTER_METHODS);
    if (!single && !batch) {
      this.rejected.set(
        descriptor.name,
        "The model context exposes no supported tool registration method.",
      );
      return false;
    }

    const abortController =
      single?.name === "registerTool" ? new AbortController() : undefined;
    try {
      const handle = single
        ? await this.callAndGet(
            single,
            context,
            abortController
              ? [registration, { signal: abortController.signal }]
              : [registration],
          )
        : await this.callAndGet(batch!, context, [[registration]]);
      const accepted = handle !== false;
      if (!accepted) {
        abortController?.abort();
        this.rejected.set(
          descriptor.name,
          "The model context returned false while registering the inferred tool.",
        );
        return false;
      }
      const registered: RegisteredTool = { descriptor };
      if (handle !== undefined) registered.handle = handle;
      if (abortController) registered.abortController = abortController;
      this.registered.set(descriptor.name, registered);
      this.rejected.delete(descriptor.name);
      return true;
    } catch (error) {
      abortController?.abort();
      this.rejected.set(descriptor.name, safeErrorMessage(error));
      return false;
    }
  }

  private async updateOne(
    context: ModelContextLike,
    descriptor: WebMcpToolDescriptor,
  ): Promise<boolean> {
    const registration = this.createRegistration(descriptor);
    const single = this.findMethod(context, SINGLE_UPDATE_METHODS);
    const batch = this.findMethod(context, BATCH_UPDATE_METHODS);
    if (!single && !batch) return false;

    try {
      if (single) {
        const args =
          single.fn.length >= 2
            ? [descriptor.name, registration]
            : [registration];
        return this.callAndCheck(single, context, args);
      }
      return this.callAndCheck(batch!, context, [[registration]]);
    } catch {
      return false;
    }
  }

  private async removeRegistered(
    context: ModelContextLike,
    names: readonly string[],
    nativeTools: readonly NativeToolSummary[],
  ): Promise<RemoveResult | null> {
    const removedIndividually = new Set<string>();
    const aborted = new Set<string>();
    let remainingNativeTools = nativeTools;
    for (const name of names) {
      const registration = this.registered.get(name);
      if (!registration) continue;
      if (
        registration.handle !== undefined &&
        (await this.removeByHandle(registration.handle))
      ) {
        removedIndividually.add(name);
      } else if (registration.abortController && this.nativeInventoryKnown) {
        registration.abortController.abort();
        aborted.add(name);
      }
    }
    if (aborted.size > 0) {
      // Current registerTool removes registrations through AbortSignal. Older
      // hosts may silently ignore that option, so verify removal before claiming
      // success. Without readable inventory, retain the registration and use
      // the explicit legacy removal fallbacks below.
      const inspection = await this.inspectContext(context);
      this.nativeInventoryKnown = inspection.nativeInventoryKnown;
      remainingNativeTools = [...inspection.toolNames]
        .filter((name) => !this.registered.has(name))
        .map((name) => ({ name }));
      if (inspection.nativeInventoryKnown) {
        for (const name of aborted) {
          if (!inspection.toolNames.has(name)) removedIndividually.add(name);
        }
      }
    }
    const remaining = names.filter((name) => !removedIndividually.has(name));
    if (remaining.length === 0) return { names: removedIndividually };

    const single = this.findMethod(context, SINGLE_REMOVE_METHODS);
    if (single) {
      const removed = new Set(removedIndividually);
      for (const name of remaining) {
        try {
          if (await this.callAndCheck(single, context, [name])) {
            removed.add(name);
          } else {
            this.rejected.set(
              name,
              "The model context returned false while unregistering the tool.",
            );
          }
        } catch (error) {
          this.rejected.set(name, safeErrorMessage(error));
        }
      }
      return { names: removed };
    }

    const batch = this.findMethod(context, BATCH_REMOVE_METHODS);
    if (batch) {
      try {
        if (await this.callAndCheck(batch, context, [remaining])) {
          return { names: new Set(names) };
        }
      } catch (error) {
        for (const name of remaining)
          this.rejected.set(name, safeErrorMessage(error));
      }
      return { names: removedIndividually };
    }

    const clear = this.findMethod(context, CLEAR_METHODS);
    // Clearing a model context is only safe when the host let us inspect its
    // native inventory and that inventory is empty.  Never clear blindly: it
    // could remove page-provided native tools.
    if (
      clear &&
      remainingNativeTools.length === 0 &&
      this.nativeInventoryKnown
    ) {
      try {
        if (await this.callAndCheck(clear, context, [])) {
          const removed = new Set(this.registered.keys());
          this.registered.clear();
          return { names: removed };
        }
      } catch (error) {
        for (const name of remaining)
          this.rejected.set(name, safeErrorMessage(error));
      }
    }
    return removedIndividually.size > 0 ? { names: removedIndividually } : null;
  }

  private findMethod(
    context: ModelContextLike,
    names: readonly string[],
  ): { name: string; fn: ModelContextMethod } | undefined {
    for (const name of names) {
      const fn = methodAt(context, name);
      if (fn) return { name, fn };
    }
    return undefined;
  }

  private async callAndCheck(
    method: { name: string; fn: ModelContextMethod },
    context: ModelContextLike,
    args: unknown[],
  ): Promise<boolean> {
    const result = await this.callAndGet(method, context, args);
    return result !== false;
  }

  private async callAndGet(
    method: { name: string; fn: ModelContextMethod },
    context: ModelContextLike,
    args: unknown[],
  ): Promise<unknown> {
    return method.fn.apply(context, args);
  }

  private async removeByHandle(handle: unknown): Promise<boolean> {
    if (typeof handle === "function") {
      try {
        const result = await handle();
        return result !== false;
      } catch {
        return false;
      }
    }
    if (!isRecord(handle)) return false;
    for (const methodName of ["unregister", "dispose", "destroy"]) {
      const method = methodAt(handle, methodName);
      if (!method) continue;
      try {
        const result = await method.apply(handle, []);
        return result !== false;
      } catch {
        return false;
      }
    }
    return false;
  }

  private createRegistration(
    descriptor: WebMcpToolDescriptor,
  ): WebMcpToolRegistration {
    const registration = markExtensionToolRegistration({
      name: descriptor.name,
      description: descriptor.description,
      inputSchema: cloneJsonSchema(descriptor.inputSchema),
      annotations: { ...descriptor.annotations },
      execute: (args) => {
        // This intentionally carries only the public tool name. It gives the
        // page (and an E2E fixture) an observable signal that the registered
        // WebMCP handler ran, without exposing invocation arguments or bridge
        // internals to page code.
        try {
          this.pageWindow?.dispatchEvent(
            new CustomEvent("webmcp-studio:tool-invoked", {
              detail: { name: descriptor.name },
            }),
          );
        } catch {
          // A restricted page realm must not prevent the actual invocation.
        }
        return this.invokeCapability(descriptor.capabilityId, args);
      },
    });
    return registration;
  }

  private currentUrl(): string {
    try {
      return this.pageWindow?.location.href ?? "";
    } catch {
      return "";
    }
  }

  private createFailure(
    code: ExecutionFailureCode,
    message: string,
    urlBefore = this.currentUrl(),
  ): ExecutionResult {
    const urlAfter = this.currentUrl();
    return {
      success: false,
      status: code,
      urlBefore,
      urlAfter,
      navigationOccurred: urlBefore !== urlAfter,
      stateChanged: false,
      warnings: [],
      error: { code, message },
    };
  }
}

export { MainWorldWebMcpRuntime as WebMcpMainWorldRuntime };
export { MainWorldWebMcpRuntime as MainWorldRuntime };

export function createMainWorldRuntime(
  options: MainWorldRuntimeOptions = {},
): MainWorldWebMcpRuntime {
  return new MainWorldWebMcpRuntime(options).start();
}

export const installMainWorldRuntime = createMainWorldRuntime;
