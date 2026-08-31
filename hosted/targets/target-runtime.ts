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
  | "invalid_descriptor"
  | "unknown_tool"
  | "unknown_request"
  | "duplicate_tool"
  | "duplicate_request"
  | "stale_request"
  | "cross_origin_blocked"
  | "webmcp_unavailable"
  | "registration_rejected"
  | "runtime_stopped"
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

export interface GeneratedToolRegistrationResult {
  toolName: string;
  registered: boolean;
  mode: TargetRuntimeMode;
  error?: TargetBridgeError;
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
    | (GeneratedToolRegistrationResult & {
        direction: "target-to-parent";
        type: "generated-tool-ready";
        /** Correlates the response when a caller supplies one on registration. */
        requestId: string;
      })
    | {
        direction: "target-to-parent";
        type: "generated-tool-call";
        requestId: string;
        toolName: string;
        args: JsonValue;
      }
    | {
        direction: "target-to-parent";
        type: "generated-tool-test-result";
        requestId: string;
        toolName: string;
        result: JsonValue;
      }
    | {
        direction: "target-to-parent";
        type: "generated-tool-test-error";
        requestId: string;
        toolName: string;
        error: TargetBridgeError;
      }
    | {
        direction: "target-to-parent";
        type: "bridge-error";
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
    | {
        direction: "parent-to-target";
        type: "register-generated-tool";
        requestId: string;
        toolName: string;
        descriptor: TargetToolDescriptor;
      }
    | {
        direction: "parent-to-target";
        type: "test-generated-tool";
        requestId: string;
        toolName: string;
        args: JsonValue;
      }
    | {
        direction: "parent-to-target";
        type: "generated-tool-result";
        requestId: string;
        toolName: string;
        result: JsonValue;
      }
    | {
        direction: "parent-to-target";
        type: "generated-tool-error";
        requestId: string;
        toolName: string;
        error: TargetBridgeError;
      }
  );

/** Explicit aliases for callers that name the bridge from the target side. */
export type TargetParentMessage = TargetToParentMessage;
export type ParentTargetMessage = ParentToTargetMessage;

export type NativeToolSchema = JSONSchema | string;

export interface NativeModelContextTool {
  name: string;
  description: string;
  inputSchema: NativeToolSchema;
  annotations: WebMcpToolAnnotations;
  execute: (args: unknown) => JsonValue | Promise<JsonValue>;
}

export interface NativeModelContext {
  /** Current WebMCP registration spelling. */
  registerTool?: (
    tool: NativeModelContextTool,
    options?: { signal?: AbortSignal },
  ) => unknown;
  /** Older WebMCP-capable hosts expose the same registration as provideTool. */
  provideTool?: (tool: NativeModelContextTool) => unknown;
  unregisterTool?: (name: string) => unknown;
  getTools?: () => unknown;
  executeTool?: (tool: unknown, input: unknown) => unknown;
}

export function isNativeModelContext(
  value: unknown,
): value is NativeModelContext {
  return (
    isRecord(value) &&
    (typeof value.registerTool === "function" ||
      typeof value.provideTool === "function")
  );
}

export interface TargetRuntimeOptions {
  target: TargetIdentity;
  document?: Document;
  pageWindow?: Window;
  parentWindow?: Window;
  modelContext?: NativeModelContext | null;
  /** Maximum time a generated page handler waits for Studio to answer. */
  generatedCallTimeoutMs?: number;
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
  try {
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
  } catch {
    return false;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTargetBridgeErrorCode(
  value: unknown,
): value is TargetBridgeErrorCode {
  return (
    value === "invalid_message" ||
    value === "invalid_descriptor" ||
    value === "unknown_tool" ||
    value === "unknown_request" ||
    value === "duplicate_tool" ||
    value === "duplicate_request" ||
    value === "stale_request" ||
    value === "cross_origin_blocked" ||
    value === "webmcp_unavailable" ||
    value === "registration_rejected" ||
    value === "runtime_stopped" ||
    value === "invalid_arguments" ||
    value === "execution_failed" ||
    value === "result_not_serializable"
  );
}

function isTargetBridgeError(value: unknown): value is TargetBridgeError {
  return (
    isRecord(value) &&
    isTargetBridgeErrorCode(value.code) &&
    isNonEmptyString(value.message) &&
    isJsonValue(value)
  );
}

function isTargetIdentity(value: unknown): value is TargetIdentity {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.url) &&
    isJsonValue(value)
  );
}

function isWebMcpToolAnnotations(
  value: unknown,
): value is WebMcpToolAnnotations {
  if (!isRecord(value) || !isJsonValue(value)) return false;
  for (const key of [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ]) {
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      return false;
  }
  return true;
}

const JSON_SCHEMA_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

/** Validate the JSON Schema subset accepted by the hosted bridge. */
export function isJsonSchema(
  value: unknown,
  ancestors = new Set<object>(),
): value is JSONSchema {
  if (!isRecord(value) || ancestors.has(value) || !isJsonValue(value))
    return false;
  const next = new Set(ancestors);
  next.add(value);
  const type = value.type;
  if (
    type !== undefined &&
    !(
      (typeof type === "string" && JSON_SCHEMA_TYPES.has(type)) ||
      (Array.isArray(type) &&
        type.length > 0 &&
        type.every(
          (item) => typeof item === "string" && JSON_SCHEMA_TYPES.has(item),
        ))
    )
  )
    return false;

  if (
    value.enum !== undefined &&
    (!Array.isArray(value.enum) ||
      !value.enum.every(
        (item) =>
          item === null ||
          typeof item === "string" ||
          typeof item === "boolean" ||
          (typeof item === "number" && Number.isFinite(item)),
      ))
  )
    return false;
  if (
    value.required !== undefined &&
    (!Array.isArray(value.required) ||
      new Set(value.required).size !== value.required.length ||
      !value.required.every(
        (item) => typeof item === "string" && item.length > 0,
      ))
  )
    return false;
  if (
    value.properties !== undefined &&
    (!isRecord(value.properties) ||
      !Object.values(value.properties).every((item) =>
        isJsonSchema(item, next),
      ))
  )
    return false;
  if (value.items !== undefined && !isJsonSchema(value.items, next))
    return false;
  if (
    value.additionalProperties !== undefined &&
    typeof value.additionalProperties !== "boolean" &&
    !isJsonSchema(value.additionalProperties, next)
  )
    return false;
  for (const key of ["minimum", "maximum"]) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "number" || !Number.isFinite(value[key]))
    )
      return false;
  }
  for (const key of ["minLength", "maxLength"]) {
    if (
      value[key] !== undefined &&
      (typeof value[key] !== "number" ||
        !Number.isInteger(value[key]) ||
        value[key] < 0)
    )
      return false;
  }
  if (
    value.pattern !== undefined &&
    (typeof value.pattern !== "string" || value.pattern.length > 512)
  )
    return false;
  if (typeof value.pattern === "string") {
    try {
      // Validation only; the pattern is never run against page content here.
      // eslint-disable-next-line no-new
      new RegExp(value.pattern);
    } catch {
      return false;
    }
  }
  if (value.description !== undefined && typeof value.description !== "string")
    return false;
  if (value.title !== undefined && typeof value.title !== "string")
    return false;
  if (value.format !== undefined && typeof value.format !== "string")
    return false;
  if (
    value.default !== undefined &&
    !(
      value.default === null ||
      typeof value.default === "string" ||
      typeof value.default === "boolean" ||
      (typeof value.default === "number" && Number.isFinite(value.default))
    )
  )
    return false;
  return true;
}

function isTargetToolDescriptor(value: unknown): value is TargetToolDescriptor {
  if (!isRecord(value) || !isJsonValue(value)) return false;
  const evidence = value.evidence;
  return (
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.description) &&
    isJsonSchema(value.inputSchema) &&
    isWebMcpToolAnnotations(value.annotations) &&
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
  if (!isBridgeEnvelope(value) || !isRecord(value) || !isJsonValue(value))
    return false;
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
      isNonEmptyString(value.requestId) &&
      isNonEmptyString(value.toolName) &&
      isJsonValue(value.result)
    );
  }
  if (value.type === "tool-error") {
    return (
      isNonEmptyString(value.requestId) &&
      isNonEmptyString(value.toolName) &&
      isTargetBridgeError(value.error)
    );
  }
  if (value.type === "generated-tool-ready") {
    return (
      isNonEmptyString(value.requestId) &&
      isNonEmptyString(value.toolName) &&
      typeof value.registered === "boolean" &&
      (value.mode === "native" || value.mode === "preview") &&
      (value.error === undefined || isTargetBridgeError(value.error))
    );
  }
  if (value.type === "generated-tool-call") {
    return (
      isNonEmptyString(value.requestId) &&
      isNonEmptyString(value.toolName) &&
      isJsonValue(value.args)
    );
  }
  if (value.type === "generated-tool-test-result") {
    return (
      isNonEmptyString(value.requestId) &&
      isNonEmptyString(value.toolName) &&
      isJsonValue(value.result)
    );
  }
  if (value.type === "generated-tool-test-error") {
    return (
      isNonEmptyString(value.requestId) &&
      isNonEmptyString(value.toolName) &&
      isTargetBridgeError(value.error)
    );
  }
  if (value.type === "bridge-error") {
    return (
      isNonEmptyString(value.requestId) &&
      isNonEmptyString(value.toolName) &&
      isTargetBridgeError(value.error)
    );
  }
  return false;
}

export function isParentToTargetMessage(
  value: unknown,
): value is ParentToTargetMessage {
  if (!isBridgeEnvelope(value) || !isRecord(value) || !isJsonValue(value))
    return false;
  if (value.direction !== "parent-to-target") return false;
  if (value.type === "request-tools") return true;
  if (value.type === "invoke-tool") {
    return (
      isNonEmptyString(value.requestId) &&
      isNonEmptyString(value.toolName) &&
      isJsonValue(value.args)
    );
  }
  if (value.type === "register-generated-tool") {
    return (
      isNonEmptyString(value.requestId) &&
      isNonEmptyString(value.toolName) &&
      isTargetToolDescriptor(value.descriptor) &&
      value.descriptor.name.trim() === value.toolName.trim()
    );
  }
  if (value.type === "test-generated-tool") {
    return (
      isNonEmptyString(value.requestId) &&
      isNonEmptyString(value.toolName) &&
      isJsonValue(value.args)
    );
  }
  if (value.type === "generated-tool-result") {
    return (
      isNonEmptyString(value.requestId) &&
      isNonEmptyString(value.toolName) &&
      isJsonValue(value.result)
    );
  }
  if (value.type === "generated-tool-error") {
    return (
      isNonEmptyString(value.requestId) &&
      isNonEmptyString(value.toolName) &&
      isTargetBridgeError(value.error)
    );
  }
  return false;
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
  for (const candidate of [
    documentCandidate,
    navigatorCandidate?.modelContext,
  ]) {
    if (isNativeModelContext(candidate)) return candidate;
  }
  return null;
}

function descriptorOf(
  tool: TargetToolRegistration | TargetToolDescriptor,
): TargetToolDescriptor {
  return {
    name: tool.name.trim(),
    description: tool.description.trim(),
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

function requestIdOf(value: unknown): string {
  if (!isRecord(value)) return "";
  try {
    return typeof value.requestId === "string" ? value.requestId : "";
  } catch {
    return "";
  }
}

function toolNameOf(value: unknown): string {
  if (!isRecord(value)) return "";
  try {
    return typeof value.toolName === "string" ? value.toolName : "";
  } catch {
    return "";
  }
}

function bridgeTypeOf(value: unknown): string {
  if (!isRecord(value)) return "";
  try {
    return typeof value.type === "string" ? value.type : "";
  } catch {
    return "";
  }
}

function nativeToolName(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (!isRecord(value)) return null;
  try {
    return typeof value.name === "string" ? value.name.trim() || null : null;
  } catch {
    return null;
  }
}

function collectNativeToolNames(
  value: unknown,
  names: Set<string>,
  ancestors = new Set<object>(),
): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    const name = nativeToolName(value);
    if (name) names.add(name);
    return;
  }
  if (typeof value !== "object" || ancestors.has(value)) return;
  const next = new Set(ancestors);
  next.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectNativeToolNames(item, names, next);
    return;
  }
  if (!isRecord(value)) return;
  const name = nativeToolName(value);
  if (name) {
    names.add(name);
    return;
  }
  try {
    for (const item of Object.values(value))
      collectNativeToolNames(item, names, next);
  } catch {
    // An inaccessible native inventory cannot prove a duplicate.
  }
}

function acceptedNativeRegistration(value: unknown): boolean {
  if (value === false) return false;
  return !(isRecord(value) && value.registered === false);
}

function nativeAnnotations(
  annotations: WebMcpToolAnnotations,
): WebMcpToolAnnotations {
  const result: WebMcpToolAnnotations = {};
  for (const key of [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ] as const) {
    if (typeof annotations[key] === "boolean") result[key] = annotations[key];
  }
  return result;
}

/** Strip Studio-only evidence fields before crossing into native WebMCP. */
export function toNativeWebMcpTool(
  descriptor: Pick<
    TargetToolDescriptor,
    "name" | "description" | "inputSchema" | "annotations"
  >,
  execute: NativeModelContextTool["execute"],
): NativeModelContextTool {
  return {
    name: descriptor.name.trim(),
    description: descriptor.description.trim(),
    inputSchema: cloneJsonSchema(descriptor.inputSchema),
    annotations: nativeAnnotations(descriptor.annotations),
    execute,
  };
}

export interface NativeRegistrationResult {
  registered: boolean;
  method: "registerTool" | "provideTool" | null;
  schemaEncoding: "object" | "json-string" | null;
  error?: unknown;
}

function schemaObject(value: NativeToolSchema): JSONSchema {
  if (typeof value !== "string") return cloneJsonSchema(value);
  try {
    const parsed = JSON.parse(value) as unknown;
    return isJsonSchema(parsed) ? cloneJsonSchema(parsed) : {};
  } catch {
    return {};
  }
}

/**
 * Register through the native host while accommodating the two WebMCP
 * surfaces observed in supported browsers: registerTool and provideTool.
 * Some hosts accept a JSON Schema object while older hosts accept its JSON
 * string serialization, so the string form is a bounded fallback.
 */
export async function registerNativeModelTool(
  context: NativeModelContext,
  tool: NativeModelContextTool,
  options: { signal?: AbortSignal } = {},
): Promise<NativeRegistrationResult> {
  const methods: Array<
    ["registerTool" | "provideTool", (tool: NativeModelContextTool) => unknown]
  > = [];
  if (typeof context.registerTool === "function")
    methods.push([
      "registerTool",
      (value) => context.registerTool!(value, options),
    ]);
  if (typeof context.provideTool === "function")
    methods.push(["provideTool", (value) => context.provideTool!(value)]);

  if (methods.length === 0) {
    return {
      registered: false,
      method: null,
      schemaEncoding: null,
      error: new Error("The native WebMCP context has no registration method."),
    };
  }

  const objectSchema = schemaObject(tool.inputSchema);
  const serializedSchema = JSON.stringify(objectSchema);
  const nativeTool = {
    name: tool.name.trim(),
    description: tool.description.trim(),
    annotations: nativeAnnotations(tool.annotations),
    execute: tool.execute,
  };
  let lastError: unknown;
  for (const [method, register] of methods) {
    for (const [schemaEncoding, inputSchema] of [
      ["object", objectSchema] as const,
      ["json-string", serializedSchema] as const,
    ]) {
      try {
        const result = register({ ...nativeTool, inputSchema });
        const registrationResult = isPromiseLike(result)
          ? await result
          : result;
        if (acceptedNativeRegistration(registrationResult))
          return { registered: true, method, schemaEncoding };
        lastError = new Error(`${method} returned false.`);
      } catch (error) {
        lastError = error;
      }
    }
  }
  return {
    registered: false,
    method: null,
    schemaEncoding: null,
    ...(lastError === undefined ? {} : { error: lastError }),
  };
}

function nativeToolInValue(
  value: unknown,
  name: string,
  ancestors = new Set<object>(),
): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || ancestors.has(value)) return undefined;
  const next = new Set(ancestors);
  next.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = nativeToolInValue(item, name, next);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (nativeToolName(value) === name) return value;
  for (const item of Object.values(value)) {
    const found = nativeToolInValue(item, name, next);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Invoke a host's imperative WebMCP test surface using its captured shape. */
export async function executeNativeModelTool(
  context: NativeModelContext,
  name: string,
  fallbackTool: NativeModelContextTool,
  args: unknown,
): Promise<JsonValue> {
  if (typeof context.executeTool !== "function")
    throw new Error("The native WebMCP host does not expose executeTool.");
  if (!isJsonValue(args))
    throw new TargetRuntimeError(
      "invalid_arguments",
      "Native WebMCP tool input must be JSON-compatible.",
    );
  let tool: unknown = fallbackTool;
  if (typeof context.getTools === "function") {
    try {
      const inventory = context.getTools();
      const resolved = nativeToolInValue(
        isPromiseLike(inventory) ? await inventory : inventory,
        name,
      );
      if (resolved !== undefined) tool = resolved;
    } catch {
      // The fallback registration object is still a valid host input for
      // compatible executeTool implementations.
    }
  }
  // The supported browser host passes tool input as JSON text to executeTool.
  const result = await Promise.resolve(
    context.executeTool(tool, JSON.stringify(asNativeJson(args))),
  );
  if (!isJsonValue(result))
    throw new TargetRuntimeError(
      "result_not_serializable",
      `Native WebMCP tool ${name} returned a non-JSON result.`,
    );
  return result;
}

function asNativeJson(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(asNativeJson);
  if (isRecord(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "__proto__") continue;
      result[key] = asNativeJson(child);
    }
    return result;
  }
  return null;
}

let fallbackRequestId = 0;

function randomRequestId(prefix: string): string {
  try {
    const cryptoValue = globalThis.crypto;
    if (typeof cryptoValue?.randomUUID === "function")
      return `${prefix}-${cryptoValue.randomUUID()}`;
  } catch {
    // Older browser/test hosts may not expose crypto.randomUUID.
  }
  fallbackRequestId += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackRequestId.toString(36)}`;
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

function parseNativeArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new TargetRuntimeError(
      "invalid_arguments",
      "Native WebMCP tool input must be valid JSON.",
    );
  }
}

export class TargetRuntimeError extends Error {
  readonly code: TargetBridgeErrorCode;

  constructor(code: TargetBridgeErrorCode, message: string) {
    super(message);
    this.name = "TargetRuntimeError";
    this.code = code;
  }
}

interface GeneratedToolState {
  descriptor: TargetToolDescriptor;
  native: boolean;
  abortController: AbortController;
  nativeTool: NativeModelContextTool;
}

interface PendingGeneratedCall {
  requestId: string;
  toolName: string;
  timer: number;
  resolve: (result: JsonValue) => void;
  reject: (error: TargetBridgeError) => void;
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
  private readonly generatedTools = new Map<string, GeneratedToolState>();
  private readonly pendingGeneratedCalls = new Map<
    string,
    PendingGeneratedCall
  >();
  private readonly activeRequestIds = new Set<string>();
  private readonly settledRequestIds = new Set<string>();
  private readonly abortController = new AbortController();
  private readonly generatedCallTimeoutMs: number;
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
    this.generatedCallTimeoutMs = Math.max(
      1,
      options.generatedCallTimeoutMs ?? 15_000,
    );
    this.messageListener = (event) => {
      void this.handleMessage(event);
    };
  }

  get mode(): TargetRuntimeMode {
    return this.runtimeMode;
  }

  addTool(tool: TargetToolRegistration): this {
    const name = tool.name.trim();
    if (!name)
      throw new TargetRuntimeError(
        "invalid_message",
        "A target tool needs a name.",
      );
    if (this.tools.has(name))
      throw new TargetRuntimeError(
        "invalid_message",
        `Target tool ${name} is already registered.`,
      );
    this.tools.set(name, {
      ...tool,
      name,
      description: tool.description.trim(),
      inputSchema: cloneJsonSchema(tool.inputSchema),
      annotations: { ...tool.annotations },
    });
    return this;
  }

  /** Return JSON-safe descriptors for all primitive and generated tools. */
  getToolDescriptors(): TargetToolDescriptor[] {
    return [
      ...Array.from(this.tools.values(), descriptorOf),
      ...Array.from(this.generatedTools.values(), ({ descriptor }) =>
        descriptorOf(descriptor),
      ),
    ];
  }

  /** Return JSON-safe descriptors for tools published by Studio. */
  getGeneratedToolDescriptors(): TargetToolDescriptor[] {
    return Array.from(this.generatedTools.values(), ({ descriptor }) =>
      descriptorOf(descriptor),
    );
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.pageWindow.addEventListener("message", this.messageListener);

    let nativeCount = 0;
    for (const tool of this.tools.values()) {
      if (!this.modelContext) continue;
      try {
        const registration = await registerNativeModelTool(
          this.modelContext,
          toNativeWebMcpTool(tool, (args) => this.invokeLocal(tool.name, args)),
          { signal: this.abortController.signal },
        );
        if (!registration.registered || this.abortController.signal.aborted)
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
    this.postTargetReady();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.abortController.abort();
    this.pageWindow.removeEventListener("message", this.messageListener);
    const nativeContext = this.generatedModelContext();
    for (const [name, generated] of this.generatedTools) {
      generated.abortController.abort();
      if (generated.native && nativeContext?.unregisterTool) {
        try {
          void Promise.resolve(nativeContext.unregisterTool(name)).catch(
            () => undefined,
          );
        } catch {
          // Abort remains the fallback for hosts without reliable removal.
        }
      }
    }
    for (const pending of [...this.pendingGeneratedCalls.values()]) {
      this.settleGeneratedCall(pending.requestId, {
        error: {
          code: "runtime_stopped",
          message: "The target runtime stopped before Studio answered.",
        },
      });
    }
    this.generatedTools.clear();
  }

  async invoke(name: string, args: unknown): Promise<JsonValue> {
    return this.invokeLocal(name, args);
  }

  /**
   * Publish one generated descriptor to this target page.  The returned
   * status distinguishes a native modelContext registration from the
   * preview-only handler retained for explicit bridge tests.
   */
  async registerGeneratedTool(
    descriptor: TargetToolDescriptor,
  ): Promise<GeneratedToolRegistrationResult> {
    const requestedName =
      isRecord(descriptor) && typeof descriptor.name === "string"
        ? descriptor.name.trim()
        : "";
    const nativeContext = this.generatedModelContext();
    const mode = nativeContext ? "native" : "preview";

    if (this.abortController.signal.aborted)
      return this.generatedRegistrationResult(requestedName, false, mode, {
        code: "runtime_stopped",
        message: "The target runtime has stopped and cannot publish tools.",
      });

    if (!isTargetToolDescriptor(descriptor))
      return this.generatedRegistrationResult(requestedName, false, mode, {
        code: "invalid_descriptor",
        message:
          "Generated tools require a JSON-safe name, description, schema, and annotations.",
      });

    const normalized = descriptorOf(descriptor);
    if (
      this.tools.has(normalized.name) ||
      this.generatedTools.has(normalized.name)
    )
      return this.generatedRegistrationResult(normalized.name, false, mode, {
        code: "duplicate_tool",
        message: `A target tool named ${normalized.name} is already registered.`,
      });

    const abortController = new AbortController();
    const nativeTool = toNativeWebMcpTool(normalized, (args) =>
      this.invokeGenerated(normalized.name, args),
    );
    const generated: GeneratedToolState = {
      descriptor: normalized,
      native: false,
      abortController,
      nativeTool,
    };

    // Reserve the name before awaiting host inventory/registration so two
    // concurrent publication requests cannot race into a duplicate.
    this.generatedTools.set(normalized.name, generated);

    if (!nativeContext) {
      return this.generatedRegistrationResult(
        normalized.name,
        true,
        "preview",
        {
          code: "webmcp_unavailable",
          message:
            "The target document has no native document.modelContext; this handler is preview-only.",
        },
      );
    }

    if (
      await this.nativeToolAlreadyRegistered(nativeContext, normalized.name)
    ) {
      this.generatedTools.delete(normalized.name);
      abortController.abort();
      return this.generatedRegistrationResult(
        normalized.name,
        false,
        "native",
        {
          code: "duplicate_tool",
          message: `The target document already exposes a native tool named ${normalized.name}.`,
        },
      );
    }

    try {
      const registration = await registerNativeModelTool(
        nativeContext,
        nativeTool,
        { signal: abortController.signal },
      );
      if (
        !registration.registered ||
        abortController.signal.aborted ||
        this.abortController.signal.aborted
      ) {
        throw new TargetRuntimeError(
          "registration_rejected",
          registration.error instanceof Error
            ? registration.error.message
            : `The native WebMCP host rejected generated tool ${normalized.name}.`,
        );
      }
      generated.native = true;
      return this.generatedRegistrationResult(normalized.name, true, "native");
    } catch (error) {
      this.generatedTools.delete(normalized.name);
      abortController.abort();
      return this.generatedRegistrationResult(
        normalized.name,
        false,
        "preview",
        errorFrom(error, "registration_rejected"),
      );
    }
  }

  /** Invoke a published page handler through the parent Studio bridge. */
  testGeneratedTool(
    toolName: string,
    args: unknown,
    requestId = randomRequestId("generated-test"),
  ): Promise<JsonValue> {
    const generated = this.generatedTools.get(toolName.trim());
    const nativeContext = this.generatedModelContext();
    if (generated?.native && nativeContext?.executeTool) {
      const normalizedRequestId = requestId.trim();
      if (!normalizedRequestId)
        return Promise.reject(
          new TargetRuntimeError(
            "invalid_message",
            "Generated tool tests require a request ID.",
          ),
        );
      const requestError = this.claimRequestId(normalizedRequestId);
      if (requestError)
        return Promise.reject(
          new TargetRuntimeError(requestError.code, requestError.message),
        );
      return Promise.resolve()
        .then(() =>
          executeNativeModelTool(
            nativeContext,
            generated.descriptor.name,
            generated.nativeTool,
            parseNativeArguments(args),
          ),
        )
        .then((result) => {
          if (!isJsonValue(result))
            throw new TargetRuntimeError(
              "result_not_serializable",
              `Native WebMCP tool ${generated.descriptor.name} returned a non-JSON result.`,
            );
          return result;
        })
        .finally(() => this.rememberSettledRequest(normalizedRequestId));
    }
    return this.invokeGenerated(toolName, args, requestId);
  }

  /** Public protocol entry point for parent callers and deterministic tests. */
  handleMessage(event: MessageEvent<unknown>): Promise<void> {
    return this.handleParentMessage(event);
  }

  private generatedModelContext(): NativeModelContext | null {
    if (this.options.modelContext !== undefined) return this.modelContext;
    return nativeModelContext(this.documentValue);
  }

  private generatedRegistrationResult(
    toolName: string,
    registered: boolean,
    mode: TargetRuntimeMode,
    error?: TargetBridgeError,
  ): GeneratedToolRegistrationResult {
    const result: GeneratedToolRegistrationResult = {
      toolName,
      registered,
      mode,
    };
    if (error) result.error = error;
    return result;
  }

  private async nativeToolAlreadyRegistered(
    context: NativeModelContext,
    name: string,
  ): Promise<boolean> {
    if (!context.getTools) return false;
    try {
      const inventory = context.getTools();
      const value = isPromiseLike(inventory) ? await inventory : inventory;
      const names = new Set<string>();
      collectNativeToolNames(value, names);
      return names.has(name);
    } catch {
      return false;
    }
  }

  private postTargetReady(): void {
    this.post({
      channel: TARGET_BRIDGE_CHANNEL,
      version: TARGET_BRIDGE_VERSION,
      direction: "target-to-parent",
      type: "target-ready",
      target: { ...this.options.target, url: this.pageWindow.location.href },
      mode: this.runtimeMode,
      tools: this.getToolDescriptors(),
    });
  }

  private claimRequestId(requestId: string): TargetBridgeError | null {
    if (this.activeRequestIds.has(requestId))
      return {
        code: "duplicate_request",
        message: `Request ${requestId} is already in progress.`,
      };
    if (this.settledRequestIds.has(requestId))
      return {
        code: "stale_request",
        message: `Request ${requestId} has already been settled.`,
      };
    this.activeRequestIds.add(requestId);
    return null;
  }

  private rememberSettledRequest(requestId: string): void {
    this.activeRequestIds.delete(requestId);
    this.settledRequestIds.add(requestId);
    while (this.settledRequestIds.size > 256) {
      const oldest = this.settledRequestIds.values().next().value;
      if (typeof oldest !== "string") break;
      this.settledRequestIds.delete(oldest);
    }
  }

  private requestStateError(requestId: string): TargetBridgeError {
    if (this.activeRequestIds.has(requestId))
      return {
        code: "duplicate_request",
        message: `Request ${requestId} is already in progress.`,
      };
    if (this.settledRequestIds.has(requestId))
      return {
        code: "stale_request",
        message: `Request ${requestId} has already been settled.`,
      };
    return {
      code: "unknown_request",
      message: `Request ${requestId} is not known to this target runtime.`,
    };
  }

  private async invokeGenerated(
    toolName: string,
    args: unknown,
    requestId = randomRequestId("generated-call"),
  ): Promise<JsonValue> {
    const normalizedName = toolName.trim();
    const generated = this.generatedTools.get(normalizedName);
    if (!generated)
      throw new TargetRuntimeError(
        "unknown_tool",
        `Generated tool ${normalizedName || toolName} is not available.`,
      );
    if (
      this.abortController.signal.aborted ||
      generated.abortController.signal.aborted
    )
      throw new TargetRuntimeError(
        "runtime_stopped",
        "The target runtime is stopped.",
      );
    const parsedArgs = parseNativeArguments(args);
    if (!isJsonValue(parsedArgs))
      throw new TargetRuntimeError(
        "invalid_arguments",
        "Generated tool arguments must be JSON-compatible.",
      );
    const validationError = validateExecutionArguments(
      parsedArgs,
      generated.descriptor.inputSchema,
    );
    if (validationError)
      throw new TargetRuntimeError("invalid_arguments", validationError);
    const normalizedRequestId = requestId.trim();
    if (!normalizedRequestId)
      throw new TargetRuntimeError(
        "invalid_message",
        "Generated tool calls require a request ID.",
      );
    const requestError = this.claimRequestId(normalizedRequestId);
    if (requestError)
      throw new TargetRuntimeError(requestError.code, requestError.message);

    return new Promise<JsonValue>((resolve, reject) => {
      const timer = this.pageWindow.setTimeout(() => {
        this.settleGeneratedCall(normalizedRequestId, {
          error: {
            code: "execution_failed",
            message: `Generated tool ${normalizedName} timed out waiting for Studio.`,
          },
        });
      }, this.generatedCallTimeoutMs);
      const pending: PendingGeneratedCall = {
        requestId: normalizedRequestId,
        toolName: normalizedName,
        timer,
        resolve,
        reject,
      };
      this.pendingGeneratedCalls.set(normalizedRequestId, pending);
      const posted = this.post({
        channel: TARGET_BRIDGE_CHANNEL,
        version: TARGET_BRIDGE_VERSION,
        direction: "target-to-parent",
        type: "generated-tool-call",
        requestId: normalizedRequestId,
        toolName: normalizedName,
        args: parsedArgs,
      });
      if (!posted)
        this.settleGeneratedCall(normalizedRequestId, {
          error: {
            code: "execution_failed",
            message:
              "The target could not reach the same-origin Studio parent.",
          },
        });
    });
  }

  private settleGeneratedCall(
    requestId: string,
    outcome: { result: JsonValue } | { error: TargetBridgeError },
  ): boolean {
    const pending = this.pendingGeneratedCalls.get(requestId);
    if (!pending) return false;
    this.pendingGeneratedCalls.delete(requestId);
    this.pageWindow.clearTimeout(pending.timer);
    this.rememberSettledRequest(requestId);
    if ("error" in outcome) pending.reject(outcome.error);
    else pending.resolve(outcome.result);
    return true;
  }

  private settleGeneratedResponse(
    message:
      | Extract<ParentToTargetMessage, { type: "generated-tool-result" }>
      | Extract<ParentToTargetMessage, { type: "generated-tool-error" }>,
  ): void {
    const pending = this.pendingGeneratedCalls.get(message.requestId);
    if (!pending) return;

    const responseToolName = message.toolName.trim();
    if (responseToolName !== pending.toolName) {
      this.settleGeneratedCall(message.requestId, {
        error: {
          code: "invalid_message",
          message:
            `Generated response ${message.requestId} names ${responseToolName}, ` +
            `but the pending call belongs to ${pending.toolName}.`,
        },
      });
      return;
    }

    if (message.type === "generated-tool-result")
      this.settleGeneratedCall(message.requestId, { result: message.result });
    else this.settleGeneratedCall(message.requestId, { error: message.error });
  }

  private async invokeLocal(name: string, args: unknown): Promise<JsonValue> {
    const tool = this.tools.get(name);
    if (!tool)
      throw new TargetRuntimeError(
        "unknown_tool",
        `Target tool ${name} is not available.`,
      );
    const parsedArgs = parseNativeArguments(args);
    const validationError = validateExecutionArguments(
      parsedArgs,
      tool.inputSchema,
    );
    if (validationError)
      throw new TargetRuntimeError("invalid_arguments", validationError);
    try {
      const result = await tool.execute(parsedArgs);
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
    const message = event.data;
    if (message.type === "request-tools") {
      this.post({
        channel: TARGET_BRIDGE_CHANNEL,
        version: TARGET_BRIDGE_VERSION,
        direction: "target-to-parent",
        type: "target-ready",
        target: { ...this.options.target, url: this.pageWindow.location.href },
        mode: this.runtimeMode,
        tools: this.getToolDescriptors(),
      });
      return;
    }

    if (message.type === "register-generated-tool") {
      const requestError = this.claimRequestId(message.requestId);
      if (requestError) {
        this.post({
          channel: TARGET_BRIDGE_CHANNEL,
          version: TARGET_BRIDGE_VERSION,
          direction: "target-to-parent",
          type: "generated-tool-ready",
          requestId: message.requestId,
          toolName: message.toolName,
          registered: false,
          mode: this.generatedModelContext() ? "native" : "preview",
          error: requestError,
        });
        return;
      }
      try {
        const result = await this.registerGeneratedTool(message.descriptor);
        this.post({
          channel: TARGET_BRIDGE_CHANNEL,
          version: TARGET_BRIDGE_VERSION,
          direction: "target-to-parent",
          type: "generated-tool-ready",
          requestId: message.requestId,
          ...result,
        });
      } finally {
        this.rememberSettledRequest(message.requestId);
      }
      return;
    }

    if (message.type === "test-generated-tool") {
      try {
        const result = await this.testGeneratedTool(
          message.toolName,
          message.args,
          message.requestId,
        );
        this.post({
          channel: TARGET_BRIDGE_CHANNEL,
          version: TARGET_BRIDGE_VERSION,
          direction: "target-to-parent",
          type: "generated-tool-test-result",
          requestId: message.requestId,
          toolName: message.toolName,
          result,
        });
      } catch (error) {
        this.post({
          channel: TARGET_BRIDGE_CHANNEL,
          version: TARGET_BRIDGE_VERSION,
          direction: "target-to-parent",
          type: "generated-tool-test-error",
          requestId: message.requestId,
          toolName: message.toolName,
          error: errorFrom(error),
        });
      }
      return;
    }

    if (message.type === "generated-tool-result") {
      this.settleGeneratedResponse(message);
      return;
    }

    if (message.type === "generated-tool-error") {
      this.settleGeneratedResponse(message);
      return;
    }

    const requestError = this.claimRequestId(message.requestId);
    if (requestError) {
      this.post({
        channel: TARGET_BRIDGE_CHANNEL,
        version: TARGET_BRIDGE_VERSION,
        direction: "target-to-parent",
        type: "tool-error",
        requestId: message.requestId,
        toolName: message.toolName,
        error: requestError,
      });
      return;
    }
    try {
      const result = await this.invokeLocal(message.toolName, message.args);
      this.post({
        channel: TARGET_BRIDGE_CHANNEL,
        version: TARGET_BRIDGE_VERSION,
        direction: "target-to-parent",
        type: "tool-result",
        requestId: message.requestId,
        toolName: message.toolName,
        result,
      });
    } catch (error) {
      this.post({
        channel: TARGET_BRIDGE_CHANNEL,
        version: TARGET_BRIDGE_VERSION,
        direction: "target-to-parent",
        type: "tool-error",
        requestId: message.requestId,
        toolName: message.toolName,
        error: errorFrom(error),
      });
    } finally {
      this.rememberSettledRequest(message.requestId);
    }
  }

  private post(message: TargetToParentMessage): boolean {
    const targetOrigin = originOf(this.pageWindow);
    if (!targetOrigin) return false;
    try {
      this.parentWindow.postMessage(message, targetOrigin);
      return true;
    } catch {
      return false;
    }
  }
}
