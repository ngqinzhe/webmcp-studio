import {
  executeExecutor,
  validateExecutionArguments,
  type ExecutionOptions,
} from "../execution";
import {
  isDisabledElement,
  isVisibleElement,
  readChecked,
  readControlValue,
} from "../execution/dom";
import { resolveSemanticLocator } from "../locators";
import type { Capability, ExecutionResult, JsonValue } from "../types";
import {
  MAX_TRACE_ENTRIES,
  MAX_TRACE_VALUE_LENGTH,
  MAX_HTTP_REQUEST_BYTES,
  MAX_HTTP_RESPONSE_BYTES,
  MAX_WORKFLOW_ELAPSED_MS,
  MAX_WORKFLOW_STEPS,
  type Binding,
  type ConditionNodeConfig,
  type DiscoveredAction,
  type ExtractNodeConfig,
  type HttpNodeConfig,
  type ProjectDocument,
  type ToolDefinition,
  type TransformNodeConfig,
  type WaitNodeConfig,
  type WorkflowNode,
  type WorkflowRunResult,
  type WorkflowTraceEntry,
} from "../project";
import { isSafeHttpDestination, validateProject } from "../project";

export interface WorkflowRuntime {
  document?: Document;
  urlProvider?: () => string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
  capabilities?: Readonly<Record<string, Capability>>;
  discoveredActions?: readonly DiscoveredAction[];
  executeCapability?: (
    capabilityId: string,
    args: unknown,
  ) => Promise<ExecutionResult>;
  isAllowed?: (kind: "dom" | "http", target: string) => boolean;
  isApproved?: (node: WorkflowNode) => boolean;
  now?: () => number;
  allowPrivateNetwork?: boolean;
  allowedHttpOrigins?: readonly string[];
  maxElapsedMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

export interface WorkflowRunOptions {
  runtime?: WorkflowRuntime;
  runId?: string;
  maxSteps?: number;
  revision?: number;
}

interface BindingContext {
  input: unknown;
  outputs: Map<string, JsonValue>;
  runtime: WorkflowRuntime;
  deadline: number;
}

interface StepOutcome {
  ok: boolean;
  value?: JsonValue;
  status?: WorkflowRunResult["status"];
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
): JsonValue | undefined {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "object" || ancestors.has(value)) return undefined;
  const next = new Set(ancestors);
  next.add(value);
  if (Array.isArray(value)) {
    return value.map((item) => asJsonValue(item, next) ?? null);
  }
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "__proto__") continue;
    const json = asJsonValue(item, next);
    if (json !== undefined) {
      Object.defineProperty(result, key, {
        value: json,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return result;
}

function pathParts(path: string | undefined): string[] {
  if (!path || path === "$" || path === ".") return [];
  return path
    .replace(/^\$\.?/, "")
    .split(/[.\[\]]+/)
    .filter(Boolean);
}

export function readValuePath(value: unknown, path?: string): unknown {
  let current = value;
  for (const part of pathParts(path)) {
    if (Array.isArray(current) && /^\d+$/.test(part))
      current = current[Number(part)];
    else if (isRecord(current)) current = current[part];
    else return undefined;
  }
  return current;
}

export function resolveBinding(
  binding: Binding,
  context: BindingContext,
): StepOutcome {
  if (binding.kind === "literal") return { ok: true, value: binding.value };
  if (binding.kind === "input") {
    const value = readValuePath(context.input, binding.path);
    if (value === undefined) {
      return {
        ok: false,
        status: "invalid_arguments",
        error: "Input binding " + binding.path + " is unavailable.",
      };
    }
    return { ok: true, value: asJsonValue(value) ?? null };
  }
  if (binding.kind === "output") {
    const output = context.outputs.get(binding.nodeId);
    if (output === undefined) {
      return {
        ok: false,
        status: "validation_failed",
        error:
          "Output binding " +
          binding.nodeId +
          " has not executed on this path.",
      };
    }
    return {
      ok: true,
      value: asJsonValue(readValuePath(output, binding.path)) ?? null,
    };
  }
  try {
    const document = context.runtime.document;
    if (binding.path === "url") {
      return {
        ok: true,
        value: context.runtime.urlProvider?.() ?? document?.URL ?? "",
      };
    }
    if (binding.path === "origin") {
      return {
        ok: true,
        value: document?.defaultView?.location?.origin ?? "",
      };
    }
    return { ok: true, value: document?.title ?? "" };
  } catch {
    return { ok: true, value: "" };
  }
}

function sanitize(value: unknown, key = "", depth = 0): JsonValue {
  if (
    depth > 8 ||
    /password|passwd|token|secret|cookie|csrf|authorization|api[-_]?key|credential/i.test(
      key,
    )
  )
    return "[redacted]";
  if (typeof value === "string") {
    return value.length > MAX_TRACE_VALUE_LENGTH
      ? value.slice(0, MAX_TRACE_VALUE_LENGTH) + "…"
      : value;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => sanitize(item, key, depth + 1));
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [childKey, childValue] of Object.entries(value).slice(0, 100))
      result[childKey] = sanitize(childValue, childKey, depth + 1);
    return result;
  }
  return String(value).slice(0, MAX_TRACE_VALUE_LENGTH);
}

function now(runtime: WorkflowRuntime): number {
  return runtime.now?.() ?? Date.now();
}

function randomId(prefix: string): string {
  try {
    if (typeof crypto.randomUUID === "function")
      return prefix + "-" + crypto.randomUUID();
  } catch {
    // Older test hosts may not expose randomUUID.
  }
  return (
    prefix +
    "-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 8)
  );
}

function aborted(runtime: WorkflowRuntime): boolean {
  return runtime.signal?.aborted === true;
}

function allowedHttpUrl(url: string, runtime: WorkflowRuntime): boolean {
  if (
    !isSafeHttpDestination(url, {
      ...(runtime.allowedHttpOrigins === undefined
        ? {}
        : { allowedOrigins: runtime.allowedHttpOrigins }),
      ...(runtime.allowPrivateNetwork === undefined
        ? {}
        : { allowPrivateNetwork: runtime.allowPrivateNetwork }),
    })
  )
    return false;
  try {
    const origin = new URL(url).origin;
    return runtime.isAllowed?.("http", origin) ?? true;
  } catch {
    return false;
  }
}

function remainingMs(context: BindingContext): number {
  return Math.max(0, context.deadline - now(context.runtime));
}

function sideEffectingHttp(method: HttpNodeConfig["method"]): boolean {
  return method !== "GET";
}

async function runHttp(
  config: HttpNodeConfig,
  context: BindingContext,
  node: WorkflowNode,
): Promise<StepOutcome> {
  const url = resolveBinding(config.url, context);
  if (!url.ok || typeof url.value !== "string")
    return {
      ok: false,
      status: "validation_failed",
      error: url.error ?? "HTTP URL binding is invalid.",
    };
  if (!allowedHttpUrl(url.value, context.runtime))
    return {
      ok: false,
      status: "scope_blocked",
      error: "The HTTP destination is outside the approved web scope.",
    };
  if (
    sideEffectingHttp(config.method) &&
    (!context.runtime.isApproved || !context.runtime.isApproved(node))
  )
    return {
      ok: false,
      status: "approval_required",
      error: "A human approval is required before this request.",
    };
  const fetcher =
    context.runtime.fetch ?? (typeof fetch === "function" ? fetch : undefined);
  if (!fetcher)
    return {
      ok: false,
      status: "unsupported_control",
      error: "The runtime does not provide fetch.",
    };
  const maxRequestBytes = Math.min(
    MAX_HTTP_REQUEST_BYTES,
    Math.max(1, context.runtime.maxRequestBytes ?? MAX_HTTP_REQUEST_BYTES),
  );
  const maxResponseBytes = Math.min(
    MAX_HTTP_RESPONSE_BYTES,
    Math.max(1, context.runtime.maxResponseBytes ?? MAX_HTTP_RESPONSE_BYTES),
  );
  const headers: Record<string, string> = {};
  for (const [key, binding] of Object.entries(config.headers ?? {})) {
    const value = resolveBinding(binding, context);
    if (!value.ok) return value;
    if (typeof value.value === "string") headers[key] = value.value;
  }
  let body: BodyInit | undefined;
  if (config.body !== undefined) {
    const value = resolveBinding(config.body, context);
    if (!value.ok) return value;
    body =
      typeof value.value === "string"
        ? value.value
        : JSON.stringify(value.value);
    if (!headers["content-type"]) headers["content-type"] = "application/json";
  }
  if (body !== undefined && String(body).length > maxRequestBytes)
    return {
      ok: false,
      status: "validation_failed",
      error: "The HTTP request body exceeds the runtime size limit.",
    };
  const remaining = remainingMs(context);
  if (remaining <= 0)
    return {
      ok: false,
      status: "execution_timeout",
      error: "The workflow exceeded its elapsed-time limit.",
    };
  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort();
  if (context.runtime.signal?.aborted) controller.abort();
  else context.runtime.signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, remaining);
  try {
    const requestInit: RequestInit = {
      method: config.method,
      headers,
      // Redirects are rejected before a second destination is contacted. A
      // caller that needs another origin must declare it as a separate step.
      redirect: "error",
      signal: controller.signal,
    };
    if (body !== undefined) requestInit.body = body;
    const response = await fetcher(url.value, requestInit);
    if (
      response.redirected ||
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    )
      return {
        ok: false,
        status: "scope_blocked",
        error: "HTTP redirects are not permitted for workflow requests.",
      };
    if (response.url && !allowedHttpUrl(response.url, context.runtime))
      return {
        ok: false,
        status: "scope_blocked",
        error:
          "The HTTP response destination is outside the approved web scope.",
      };
    const contentLength = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxResponseBytes)
      return {
        ok: false,
        status: "validation_failed",
        error: "The HTTP response exceeds the runtime size limit.",
      };
    let raw: unknown;
    if (config.parseAs === "text") {
      const text = await response.text();
      if (text.length > maxResponseBytes)
        return {
          ok: false,
          status: "validation_failed",
          error: "The HTTP response exceeds the runtime size limit.",
        };
      raw = text;
    } else if (typeof response.clone === "function") {
      const text = await response.clone().text();
      if (text.length > maxResponseBytes)
        return {
          ok: false,
          status: "validation_failed",
          error: "The HTTP response exceeds the runtime size limit.",
        };
      raw = await response.json();
    } else {
      // Minimal test adapters may only expose json(); Content-Length remains
      // the enforceable bound at this compatibility boundary.
      raw = await response.json();
    }
    const value = asJsonValue(raw) ?? null;
    if (!response.ok)
      return {
        ok: false,
        status: "permission_blocked",
        value,
        error: "HTTP request returned " + response.status + ".",
      };
    return { ok: true, value };
  } catch (error) {
    if (aborted(context.runtime))
      return {
        ok: false,
        status: "cancelled",
        error: "The HTTP request was cancelled.",
      };
    if (timedOut)
      return {
        ok: false,
        status: sideEffectingHttp(config.method)
          ? "ambiguous_delivery"
          : "execution_timeout",
        error: sideEffectingHttp(config.method)
          ? "The request outcome is unknown; it was not retried."
          : "The HTTP request exceeded the workflow time limit.",
      };
    if (error instanceof Error && /redirect/i.test(error.message))
      return {
        ok: false,
        status: "scope_blocked",
        error: "The HTTP redirect was rejected by the destination policy.",
      };
    return {
      ok: false,
      status: sideEffectingHttp(config.method)
        ? "ambiguous_delivery"
        : "execution_timeout",
      error: sideEffectingHttp(config.method)
        ? "The request outcome is unknown; it was not retried."
        : error instanceof Error
          ? error.message
          : String(error),
    };
  } finally {
    clearTimeout(timeout);
    context.runtime.signal?.removeEventListener("abort", abort);
  }
}

function selectedDocument(runtime: WorkflowRuntime): Document | null {
  return (
    runtime.document ?? (typeof document === "undefined" ? null : document)
  );
}

async function runWait(
  config: WaitNodeConfig,
  context: BindingContext,
): Promise<StepOutcome> {
  const runtime = context.runtime;
  const page = selectedDocument(runtime);
  if (!page)
    return {
      ok: false,
      status: "unsupported_control",
      error: "The runtime has no document to wait on.",
    };
  const timeout = Math.min(
    120_000,
    Math.max(1, config.timeoutMs),
    remainingMs(context),
  );
  const poll = Math.min(5_000, Math.max(1, config.pollMs ?? 100));
  const started = Date.now();
  while (Date.now() - started <= timeout && remainingMs(context) > 0) {
    if (aborted(runtime))
      return {
        ok: false,
        status: "cancelled",
        error: "The wait was cancelled.",
      };
    let matched = false;
    if (config.selector) {
      try {
        matched = page.querySelector(config.selector) !== null;
      } catch {
        return {
          ok: false,
          status: "validation_failed",
          error: "The wait selector is invalid.",
        };
      }
    }
    if (config.textIncludes)
      matched ||= (page.body?.textContent ?? "").includes(config.textIncludes);
    if (matched) return { ok: true, value: { matched: true } };
    await new Promise<void>((resolve) => setTimeout(resolve, poll));
  }
  return {
    ok: false,
    status: "execution_timeout",
    error: "The wait condition was not met within " + timeout + "ms.",
  };
}

function extractElement(
  element: Element,
  config: ExtractNodeConfig,
): JsonValue {
  const result: Record<string, JsonValue> = {
    tagName: element.localName.toLowerCase(),
    text:
      config.includeText === false
        ? ""
        : (element.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, MAX_TRACE_VALUE_LENGTH),
  };
  const kind = element.localName.toLowerCase();
  const sensitive =
    (kind === "input" &&
      /password|token|secret|csrf/i.test(element.getAttribute("name") ?? "")) ||
    element.getAttribute("type")?.toLowerCase() === "password";
  if (sensitive) result.value = "[redacted]";
  else if (kind === "input" || kind === "textarea" || kind === "select")
    result.value = readControlValue(element);
  if (
    kind === "input" &&
    ["checkbox", "radio"].includes(
      element.getAttribute("type")?.toLowerCase() ?? "",
    )
  )
    result.checked = readChecked(element);
  if (config.fields) {
    for (const [key, selector] of Object.entries(config.fields)) {
      try {
        const child = element.querySelector(selector);
        if (child) {
          const { fields: _fields, ...nestedConfig } = config;
          result[key] = extractElement(child, nestedConfig);
        } else result[key] = null;
      } catch {
        result[key] = null;
      }
    }
  }
  return result;
}

async function runExtract(
  config: ExtractNodeConfig,
  runtime: WorkflowRuntime,
): Promise<StepOutcome> {
  const page = selectedDocument(runtime);
  if (!page)
    return {
      ok: false,
      status: "unsupported_control",
      error: "The runtime has no document to extract from.",
    };
  if (config.sensitive)
    return {
      ok: false,
      status: "permission_blocked",
      error: "Sensitive extraction is blocked.",
    };
  let element: Element | null = null;
  if (config.target) {
    const resolution = resolveSemanticLocator(page, config.target);
    if (resolution.status === "ambiguous")
      return {
        ok: false,
        status: "validation_failed",
        error: "The extract target is ambiguous.",
      };
    element = resolution.element ?? null;
  } else if (config.selector) {
    try {
      element = page.querySelector(config.selector);
    } catch {
      return {
        ok: false,
        status: "validation_failed",
        error: "The extract selector is invalid.",
      };
    }
  }
  if (!element)
    return {
      ok: false,
      status: "unsupported_control",
      error: "The extract target was not found.",
    };
  if (!isVisibleElement(element) || isDisabledElement(element))
    return {
      ok: false,
      status: "permission_blocked",
      error: "The extract target is not a visible enabled control.",
    };
  return { ok: true, value: extractElement(element, config) };
}

function runTransform(
  config: TransformNodeConfig,
  context: BindingContext,
): StepOutcome {
  const source = resolveBinding(config.source, context);
  if (!source.ok) return source;
  const value = source.value ?? null;
  switch (config.operation) {
    case "pick":
      return {
        ok: true,
        value: asJsonValue(readValuePath(value, config.path)) ?? null,
      };
    case "project": {
      if (!isRecord(value) || !config.fields)
        return {
          ok: false,
          status: "validation_failed",
          error: "Project requires an object and fields.",
        };
      const projected: Record<string, JsonValue> = {};
      for (const field of config.fields)
        projected[field] = asJsonValue(value[field]) ?? null;
      return { ok: true, value: projected };
    }
    case "filter": {
      if (!Array.isArray(value) || !config.predicate)
        return {
          ok: false,
          status: "validation_failed",
          error: "Filter requires an array and predicate.",
        };
      const predicate = config.predicate;
      return {
        ok: true,
        value: value.filter((item) => {
          const candidate = readValuePath(item, predicate.path);
          if (predicate.equals !== undefined)
            return candidate === predicate.equals;
          return (
            typeof candidate === "string" &&
            candidate.includes(predicate.contains ?? "")
          );
        }),
      };
    }
    case "stringify":
      return { ok: true, value: JSON.stringify(value) };
    case "coalesce":
      return { ok: true, value: value === null ? "" : value };
  }
}

function runCondition(
  config: ConditionNodeConfig,
  context: BindingContext,
): StepOutcome {
  const left = resolveBinding(config.left, context);
  if (!left.ok) return left;
  const right = config.right
    ? resolveBinding(config.right, context)
    : { ok: true as const, value: null };
  if (!right.ok) return right;
  let result = false;
  switch (config.operator) {
    case "equals":
      result = left.value === right.value;
      break;
    case "not_equals":
      result = left.value !== right.value;
      break;
    case "contains":
      result = Array.isArray(left.value)
        ? left.value.includes(right.value ?? null)
        : typeof left.value === "string" &&
          left.value.includes(String(right.value ?? ""));
      break;
    case "exists":
      result = left.value !== null && left.value !== undefined;
      break;
    case "truthy":
      result = Boolean(left.value);
      break;
  }
  return { ok: true, value: result };
}

async function runDom(
  node: Extract<WorkflowNode, { type: "dom" }>,
  context: BindingContext,
): Promise<StepOutcome> {
  if (
    context.runtime.isAllowed &&
    !context.runtime.isAllowed("dom", node.config.capabilityId)
  )
    return {
      ok: false,
      status: "scope_blocked",
      error: "The DOM capability is outside the approved scope.",
    };
  const capability =
    context.runtime.capabilities?.[node.config.capabilityId] ??
    context.runtime.discoveredActions?.find(
      (action) => action.capability?.id === node.config.capabilityId,
    )?.capability;
  const needsApproval =
    node.config.requiresApproval === true ||
    (capability !== undefined && capability.effect !== "read");
  if (
    needsApproval &&
    (!context.runtime.isApproved || !context.runtime.isApproved(node))
  )
    return {
      ok: false,
      status: "approval_required",
      error: "A human approval is required for this DOM action.",
    };
  const args: Record<string, JsonValue> = {};
  if (node.config.args) {
    for (const [key, binding] of Object.entries(node.config.args)) {
      const value = resolveBinding(binding, context);
      if (!value.ok) return value;
      args[key] = value.value ?? null;
    }
  }
  const input: unknown = node.config.args ? args : context.input;
  let result: ExecutionResult;
  if (context.runtime.executeCapability) {
    try {
      result = await context.runtime.executeCapability(
        node.config.capabilityId,
        input,
      );
    } catch {
      return {
        ok: false,
        status: "ambiguous_delivery",
        error: "The DOM action outcome is unknown; it was not retried.",
      };
    }
  } else {
    if (!capability)
      return {
        ok: false,
        status: "unsupported_control",
        error:
          "DOM capability " +
          node.config.capabilityId +
          " is not available in the live graph.",
      };
    result = await executeExecutor(capability.executor, input, {
      document: selectedDocument(context.runtime) ?? undefined,
      urlProvider: context.runtime.urlProvider,
      signal: context.runtime.signal,
    } as ExecutionOptions);
  }
  if (!result.success) {
    const uncertain =
      capability?.effect !== undefined &&
      capability.effect !== "read" &&
      ["execution_timeout", "ambiguous_delivery"].includes(result.status);
    const failure: StepOutcome = {
      ok: false,
      status: uncertain
        ? "ambiguous_delivery"
        : (result.status as WorkflowRunResult["status"]) ||
          "unsupported_control",
      error: uncertain
        ? "The DOM action outcome is unknown; it was not retried."
        : (result.error?.message ??
          "DOM capability " + node.config.capabilityId + " failed."),
    };
    if (result.result !== undefined) failure.value = result.result;
    return failure;
  }
  return {
    ok: true,
    value: asJsonValue(result.result) ?? {
      success: true,
      stateChanged: result.stateChanged,
      navigationOccurred: result.navigationOccurred,
    },
  };
}

function failureResult(
  tool: ToolDefinition,
  status: WorkflowRunResult["status"],
  trace: WorkflowTraceEntry[],
  warnings: string[],
  failedNodeId?: string,
  error?: string,
  runId = "",
  revision = 0,
): WorkflowRunResult {
  return {
    success: false,
    status,
    trace,
    warnings: error ? warnings.concat(error) : warnings,
    runId,
    toolId: tool.id,
    revision,
    ...(failedNodeId ? { failedNodeId } : {}),
  };
}

/** Run one immutable tool snapshot. The caller owns project/session policy. */
export async function runWorkflow(
  tool: ToolDefinition,
  input: unknown,
  options: WorkflowRunOptions = {},
): Promise<WorkflowRunResult> {
  const runtime = options.runtime ?? {};
  const runId = options.runId ?? randomId("run");
  const revision = options.revision ?? 0;
  const maxSteps = Math.min(
    MAX_WORKFLOW_STEPS,
    Math.max(1, options.maxSteps ?? MAX_WORKFLOW_STEPS),
  );
  const maxElapsedMs = Math.min(
    MAX_WORKFLOW_ELAPSED_MS,
    Math.max(1, runtime.maxElapsedMs ?? MAX_WORKFLOW_ELAPSED_MS),
  );
  const deadline = now(runtime) + maxElapsedMs;
  const trace: WorkflowTraceEntry[] = [];
  const warnings: string[] = [];
  const project: ProjectDocument = {
    schemaVersion: 1,
    project: { id: "runtime", name: "runtime", revision: 0 },
    site: {
      domain: "runtime",
      origins: ["https://runtime.invalid"],
      sessionMode: "public",
    },
    discoveredActions: [],
    tools: [tool],
    editor: {
      toolOrder: [tool.id],
      selectedToolId: tool.id,
      nodePositions: {},
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    testRuns: [],
  };
  try {
    validateProject(project, { requireRunnable: true });
  } catch (error) {
    return failureResult(
      tool,
      "validation_failed",
      trace,
      warnings,
      undefined,
      error instanceof Error ? error.message : String(error),
      runId,
      revision,
    );
  }
  const argumentError = validateExecutionArguments(input, tool.inputSchema);
  if (argumentError)
    return failureResult(
      tool,
      "invalid_arguments",
      trace,
      warnings,
      undefined,
      argumentError,
      runId,
      revision,
    );
  try {
    const serializedInput = JSON.stringify(input);
    if (serializedInput && serializedInput.length > MAX_HTTP_REQUEST_BYTES)
      return failureResult(
        tool,
        "invalid_arguments",
        trace,
        warnings,
        undefined,
        "Workflow input exceeds the runtime size limit.",
        runId,
        revision,
      );
  } catch {
    return failureResult(
      tool,
      "invalid_arguments",
      trace,
      warnings,
      undefined,
      "Workflow input is not JSON-compatible.",
      runId,
      revision,
    );
  }
  const nodes = new Map(tool.workflow.nodes.map((node) => [node.id, node]));
  const outputs = new Map<string, JsonValue>();
  const context: BindingContext = { input, outputs, runtime, deadline };
  let currentId: string | undefined = tool.workflow.entryNodeId;
  const visited = new Set<string>();
  for (let step = 0; currentId && step < maxSteps; step += 1) {
    if (remainingMs(context) <= 0)
      return failureResult(
        tool,
        "execution_timeout",
        trace,
        warnings,
        currentId,
        "The workflow exceeded its elapsed-time limit.",
        runId,
        revision,
      );
    if (aborted(runtime))
      return failureResult(
        tool,
        "cancelled",
        trace,
        warnings,
        currentId,
        "The workflow was cancelled.",
        runId,
        revision,
      );
    if (visited.has(currentId))
      return failureResult(
        tool,
        "validation_failed",
        trace,
        warnings,
        currentId,
        "The workflow revisited a node; cycles are not executable.",
        runId,
        revision,
      );
    visited.add(currentId);
    const node = nodes.get(currentId);
    if (!node)
      return failureResult(
        tool,
        "validation_failed",
        trace,
        warnings,
        currentId,
        "The workflow references a missing node.",
        runId,
        revision,
      );
    const startedAt = now(runtime);
    const traceEntry: WorkflowTraceEntry = {
      nodeId: node.id,
      type: node.type,
      status: "completed",
      startedAt,
      finishedAt: startedAt,
    };
    let outcome: StepOutcome;
    try {
      switch (node.type) {
        case "http":
          outcome = await runHttp(node.config, context, node);
          break;
        case "dom":
          outcome = await runDom(node, context);
          break;
        case "wait":
          outcome = await runWait(node.config, context);
          break;
        case "extract":
          outcome = await runExtract(node.config, runtime);
          break;
        case "transform":
          outcome = runTransform(node.config, context);
          break;
        case "condition":
          outcome = runCondition(node.config, context);
          break;
        case "return": {
          if (node.config.fields) {
            const result: Record<string, JsonValue> = {};
            for (const [key, binding] of Object.entries(node.config.fields)) {
              const value = resolveBinding(binding, context);
              if (!value.ok) {
                outcome = value;
                break;
              }
              result[key] = value.value ?? null;
            }
            outcome ??= { ok: true, value: result };
          } else if (node.config.value) {
            outcome = resolveBinding(node.config.value, context);
          } else outcome = { ok: true, value: null };
          break;
        }
      }
    } catch (error) {
      outcome = {
        ok: false,
        status: "unsupported_control",
        error: error instanceof Error ? error.message : String(error),
      };
    }
    traceEntry.finishedAt = now(runtime);
    if (outcome.ok) {
      const output = sanitize(outcome.value ?? null);
      traceEntry.output = output;
      outputs.set(node.id, output);
      trace.push(traceEntry);
      if (node.type === "return") {
        return {
          success: true,
          status: "completed",
          result: output,
          trace: trace.slice(-MAX_TRACE_ENTRIES),
          warnings,
          runId,
          toolId: tool.id,
          revision,
        };
      }
      const edges = tool.workflow.edges.filter((edge) => edge.from === node.id);
      const next =
        node.type === "condition"
          ? edges.find(
              (edge) => edge.when === (output === true ? "true" : "false"),
            )
          : edges.find(
              (edge) => edge.when === "always" || edge.when === undefined,
            );
      currentId = next?.to;
      if (!currentId)
        return failureResult(
          tool,
          "validation_failed",
          trace,
          warnings,
          node.id,
          "The workflow ended without a return node.",
          runId,
          revision,
        );
    } else {
      traceEntry.status = "failed";
      if (outcome.error) traceEntry.error = outcome.error;
      if (outcome.value !== undefined)
        traceEntry.output = sanitize(outcome.value);
      trace.push(traceEntry);
      return failureResult(
        tool,
        outcome.status ?? "unsupported_control",
        trace.slice(-MAX_TRACE_ENTRIES),
        warnings,
        node.id,
        outcome.error,
        runId,
        revision,
      );
    }
  }
  return failureResult(
    tool,
    "execution_timeout",
    trace.slice(-MAX_TRACE_ENTRIES),
    warnings,
    currentId,
    "The workflow exceeded its step limit.",
    runId,
    revision,
  );
}

export class WorkflowRunner {
  private tail: Promise<unknown> = Promise.resolve();

  run(
    tool: ToolDefinition,
    input: unknown,
    options: WorkflowRunOptions = {},
  ): Promise<WorkflowRunResult> {
    const result = this.tail.then(() => runWorkflow(tool, input, options));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function workflowSummary(
  project: ProjectDocument,
  toolId: string,
): Record<string, JsonValue> {
  const tool = project.tools.find((candidate) => candidate.id === toolId);
  if (!tool) return { error: "tool_not_found" };
  return {
    toolId: tool.id,
    name: tool.name,
    revision: project.project.revision,
    nodes: tool.workflow.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      label: node.label,
    })),
  };
}
