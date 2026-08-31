import { cloneJsonSchema } from "../../core/compiler";
import type { WebMcpToolAnnotations } from "../../core/compiler";
import { validateExecutionArguments } from "../../core/execution";
import type { JSONSchema, JsonValue } from "../../core/types";

export const TARGET_BRIDGE_CHANNEL = "webmcp-studio-target";
export const TARGET_BRIDGE_VERSION = 1 as const;

export type TargetRuntimeMode = "native" | "preview";

export interface TargetIdentity {
  id: string;
  name: string;
  url: string;
}

export interface TargetToolEvidence {
  type: "dom" | "action" | "manual";
  note: string;
  selector?: string;
}

/** JSON-safe descriptor shared by a target document and its Studio parent. */
export interface TargetToolDescriptor {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  annotations: WebMcpToolAnnotations;
  source?: "webmcp" | "dom" | "manual";
  evidence?: TargetToolEvidence[];
  confidence?: number;
}

export type TargetToolHandler = (
  args: unknown,
) => JsonValue | Promise<JsonValue>;

/** A target-local registration; `execute` never crosses the parent bridge. */
export interface TargetToolRegistration extends TargetToolDescriptor {
  execute: TargetToolHandler;
}

export type TargetBridgeErrorCode =
  | "invalid_message"
  | "unknown_tool"
  | "invalid_arguments"
  | "execution_failed"
  | "result_not_serializable";

export interface TargetBridgeError {
  code: TargetBridgeErrorCode;
  message: string;
}

interface TargetBridgeEnvelope {
  channel: typeof TARGET_BRIDGE_CHANNEL;
  version: typeof TARGET_BRIDGE_VERSION;
}

/** TARGET → PARENT bridge messages. Keep this union as the parent contract. */
export type TargetToParentMessage = TargetBridgeEnvelope &
  (
    | {
        direction: "target-to-parent";
        type: "target-ready";
        target: TargetIdentity;
        mode: TargetRuntimeMode;
        tools: TargetToolDescriptor[];
      }
    | {
        direction: "target-to-parent";
        type: "tool-result";
        requestId: string;
        toolName: string;
        result: JsonValue;
      }
    | {
        direction: "target-to-parent";
        type: "tool-error";
        requestId: string;
        toolName: string;
        error: TargetBridgeError;
      }
  );

/** PARENT → TARGET bridge messages. Only these commands are accepted by targets. */
export type ParentToTargetMessage = TargetBridgeEnvelope &
  (
    | {
        direction: "parent-to-target";
        type: "request-tools";
      }
    | {
        direction: "parent-to-target";
        type: "invoke-tool";
        requestId: string;
        toolName: string;
        args: JsonValue;
      }
  );

/** Explicit aliases for callers that name the bridge from the target side. */
export type TargetParentMessage = TargetToParentMessage;
export type ParentTargetMessage = ParentToTargetMessage;

export interface NativeModelContext {
  registerTool: (
    tool: {
      name: string;
      description: string;
      inputSchema: JSONSchema;
      annotations: WebMcpToolAnnotations;
      execute: (args: unknown) => JsonValue | Promise<JsonValue>;
    },
    options?: { signal?: AbortSignal },
  ) => unknown;
  unregisterTool?: (name: string) => unknown;
  getTools?: () => unknown;
  executeTool?: (tool: unknown, input: unknown) => unknown;
}

export interface TargetRuntimeOptions {
  target: TargetIdentity;
  document?: Document;
  pageWindow?: Window;
  parentWindow?: Window;
  modelContext?: NativeModelContext | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return true;
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const next = new Set(ancestors);
  next.add(value);
  if (Array.isArray(value))
    return value.every((item) => isJsonValue(item, next));
  return Object.entries(value).every(
    ([key, item]) => key !== "__proto__" && isJsonValue(item, next),
  );
}

function isTargetIdentity(value: unknown): value is TargetIdentity {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.url === "string" &&
    value.url.length > 0
  );
}

function isTargetToolDescriptor(value: unknown): value is TargetToolDescriptor {
  const evidence = value && isRecord(value) ? value.evidence : undefined;
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    typeof value.description === "string" &&
    isRecord(value.inputSchema) &&
    isRecord(value.annotations) &&
    (value.source === undefined ||
      value.source === "webmcp" ||
      value.source === "dom" ||
      value.source === "manual") &&
    (value.confidence === undefined ||
      (typeof value.confidence === "number" &&
        Number.isFinite(value.confidence) &&
        value.confidence >= 0 &&
        value.confidence <= 1)) &&
    (evidence === undefined ||
      (Array.isArray(evidence) &&
        evidence.every(
          (item) =>
            isRecord(item) &&
            (item.type === "dom" ||
              item.type === "action" ||
              item.type === "manual") &&
            typeof item.note === "string" &&
            (item.selector === undefined || typeof item.selector === "string"),
        )))
  );
}

function isBridgeEnvelope(value: unknown): value is TargetBridgeEnvelope {
  return (
    isRecord(value) &&
    value.channel === TARGET_BRIDGE_CHANNEL &&
    value.version === TARGET_BRIDGE_VERSION
  );
}

export function isTargetToParentMessage(
  value: unknown,
): value is TargetToParentMessage {
  if (!isBridgeEnvelope(value) || !isRecord(value)) return false;
  if (value.direction !== "target-to-parent") return false;
  if (value.type === "target-ready") {
    return (
      isTargetIdentity(value.target) &&
      (value.mode === "native" || value.mode === "preview") &&
      Array.isArray(value.tools) &&
      value.tools.every(isTargetToolDescriptor)
    );
  }
  if (value.type === "tool-result") {
    return (
      typeof value.requestId === "string" &&
      typeof value.toolName === "string" &&
      isJsonValue(value.result)
    );
  }
  if (value.type === "tool-error") {
    return (
      typeof value.requestId === "string" &&
      typeof value.toolName === "string" &&
      isRecord(value.error) &&
      typeof value.error.code === "string" &&
      typeof value.error.message === "string"
    );
  }
  return false;
}

export function isParentToTargetMessage(
  value: unknown,
): value is ParentToTargetMessage {
  if (!isBridgeEnvelope(value) || !isRecord(value)) return false;
  if (value.direction !== "parent-to-target") return false;
  if (value.type === "request-tools") return true;
  return (
    value.type === "invoke-tool" &&
    typeof value.requestId === "string" &&
    typeof value.toolName === "string" &&
    isJsonValue(value.args)
  );
}

export function nativeModelContext(
  documentValue: Document = document,
): NativeModelContext | null {
  const documentCandidate = (
    documentValue as Document & {
      modelContext?: unknown;
    }
  ).modelContext;
  const navigatorCandidate = documentValue.defaultView?.navigator as
    (Navigator & { modelContext?: unknown }) | undefined;
  const candidate = documentCandidate ?? navigatorCandidate?.modelContext;
  if (!isRecord(candidate) || typeof candidate.registerTool !== "function")
    return null;
  return candidate as unknown as NativeModelContext;
}

function descriptorOf(tool: TargetToolRegistration): TargetToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: cloneJsonSchema(tool.inputSchema),
    annotations: { ...tool.annotations },
    ...(tool.source === undefined ? {} : { source: tool.source }),
    ...(tool.evidence === undefined
      ? {}
      : {
          evidence: tool.evidence.map((item) => ({ ...item })),
        }),
    ...(tool.confidence === undefined ? {} : { confidence: tool.confidence }),
  };
}

function originOf(pageWindow: Window): string | null {
  try {
    const origin = pageWindow.location.origin;
    return origin && origin !== "null" ? origin : null;
  } catch {
    return null;
  }
}

function errorFrom(
  error: unknown,
  fallbackCode: TargetBridgeErrorCode = "execution_failed",
): TargetBridgeError {
  if (error instanceof TargetRuntimeError)
    return { code: error.code, message: error.message };
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
}

export class TargetRuntimeError extends Error {
  readonly code: TargetBridgeErrorCode;

  constructor(code: TargetBridgeErrorCode, message: string) {
    super(message);
    this.name = "TargetRuntimeError";
    this.code = code;
  }
}

/**
 * Owns target-local handlers and exposes only a small, typed parent bridge.
 * Native WebMCP registration is attempted when the browser provides it; the
 * parent bridge remains usable as a clearly labelled preview path otherwise.
 */
export class TargetRuntime {
  private readonly documentValue: Document;
  private readonly pageWindow: Window;
  private readonly parentWindow: Window;
  private readonly modelContext: NativeModelContext | null;
  private readonly tools = new Map<string, TargetToolRegistration>();
  private readonly abortController = new AbortController();
  private readonly messageListener: (event: MessageEvent<unknown>) => void;
  private started = false;
  private runtimeMode: TargetRuntimeMode = "preview";

  constructor(private readonly options: TargetRuntimeOptions) {
    this.documentValue = options.document ?? document;
    this.pageWindow =
      options.pageWindow ?? this.documentValue.defaultView ?? window;
    this.parentWindow = options.parentWindow ?? this.pageWindow.parent;
    this.modelContext =
      options.modelContext === undefined
        ? nativeModelContext(this.documentValue)
        : options.modelContext;
    this.messageListener = (event) => {
      void this.handleParentMessage(event);
    };
  }

  get mode(): TargetRuntimeMode {
    return this.runtimeMode;
  }

  addTool(tool: TargetToolRegistration): this {
    if (!tool.name.trim())
      throw new TargetRuntimeError(
        "invalid_message",
        "A target tool needs a name.",
      );
    if (this.tools.has(tool.name))
      throw new TargetRuntimeError(
        "invalid_message",
        `Target tool ${tool.name} is already registered.`,
      );
    this.tools.set(tool.name, {
      ...tool,
      name: tool.name.trim(),
      description: tool.description.trim(),
      inputSchema: cloneJsonSchema(tool.inputSchema),
      annotations: { ...tool.annotations },
    });
    return this;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.pageWindow.addEventListener("message", this.messageListener);

    let nativeCount = 0;
    for (const tool of this.tools.values()) {
      if (!this.modelContext) continue;
      try {
        const registration = this.modelContext.registerTool(
          {
            ...descriptorOf(tool),
            execute: (args) => this.invokeLocal(tool.name, args),
          },
          { signal: this.abortController.signal },
        );
        const registrationResult = isPromiseLike(registration)
          ? await registration
          : registration;
        if (registrationResult === false || this.abortController.signal.aborted)
          continue;
        nativeCount += 1;
      } catch {
        // A target can still be exercised through the explicit parent bridge.
      }
    }
    if (this.abortController.signal.aborted) return;
    this.runtimeMode =
      this.modelContext && nativeCount === this.tools.size
        ? "native"
        : "preview";
    this.post({
      channel: TARGET_BRIDGE_CHANNEL,
      version: TARGET_BRIDGE_VERSION,
      direction: "target-to-parent",
      type: "target-ready",
      target: { ...this.options.target, url: this.pageWindow.location.href },
      mode: this.runtimeMode,
      tools: Array.from(this.tools.values(), descriptorOf),
    });
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.abortController.abort();
    this.pageWindow.removeEventListener("message", this.messageListener);
  }

  async invoke(name: string, args: unknown): Promise<JsonValue> {
    return this.invokeLocal(name, args);
  }

  private async invokeLocal(name: string, args: unknown): Promise<JsonValue> {
    const tool = this.tools.get(name);
    if (!tool)
      throw new TargetRuntimeError(
        "unknown_tool",
        `Target tool ${name} is not available.`,
      );
    const validationError = validateExecutionArguments(args, tool.inputSchema);
    if (validationError)
      throw new TargetRuntimeError("invalid_arguments", validationError);
    try {
      const result = await tool.execute(args);
      if (!isJsonValue(result))
        throw new TargetRuntimeError(
          "result_not_serializable",
          `Target tool ${name} returned a non-JSON result.`,
        );
      return result;
    } catch (error) {
      if (error instanceof TargetRuntimeError) throw error;
      throw new TargetRuntimeError(
        "execution_failed",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async handleParentMessage(
    event: MessageEvent<unknown>,
  ): Promise<void> {
    if (!isParentToTargetMessage(event.data)) return;
    if (event.source !== this.parentWindow) return;
    const expectedOrigin = originOf(this.pageWindow);
    if (!expectedOrigin || event.origin !== expectedOrigin) return;
    if (event.data.type === "request-tools") {
      this.post({
        channel: TARGET_BRIDGE_CHANNEL,
        version: TARGET_BRIDGE_VERSION,
        direction: "target-to-parent",
        type: "target-ready",
        target: { ...this.options.target, url: this.pageWindow.location.href },
        mode: this.runtimeMode,
        tools: Array.from(this.tools.values(), descriptorOf),
      });
      return;
    }

    try {
      const result = await this.invokeLocal(
        event.data.toolName,
        event.data.args,
      );
      this.post({
        channel: TARGET_BRIDGE_CHANNEL,
        version: TARGET_BRIDGE_VERSION,
        direction: "target-to-parent",
        type: "tool-result",
        requestId: event.data.requestId,
        toolName: event.data.toolName,
        result,
      });
    } catch (error) {
      this.post({
        channel: TARGET_BRIDGE_CHANNEL,
        version: TARGET_BRIDGE_VERSION,
        direction: "target-to-parent",
        type: "tool-error",
        requestId: event.data.requestId,
        toolName: event.data.toolName,
        error: errorFrom(error),
      });
    }
  }

  private post(message: TargetToParentMessage): void {
    const targetOrigin = originOf(this.pageWindow);
    if (targetOrigin) this.parentWindow.postMessage(message, targetOrigin);
  }
}
