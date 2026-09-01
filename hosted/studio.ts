import { cloneJsonSchema } from "../core/compiler";
import type { WebMcpToolAnnotations } from "../core/compiler";
import {
  createProject,
  validateProject,
  type DiscoveredAction,
  type ProjectDocument,
} from "../core/project";
import {
  runWorkflow,
  WorkflowRunner,
  validateWorkflow,
  type Binding,
  type Workflow,
  type WorkflowTraceEntry,
} from "../core/workflow";
import type {
  ExecutionFailureCode,
  ExecutionResult,
  JSONSchema,
  JsonValue,
} from "../core/types";
import {
  executeNativeModelTool,
  isJsonSchema,
  nativeModelContextHasTool,
  nativeModelContext,
  registerNativeModelTool,
  toNativeWebMcpTool,
  TARGET_BRIDGE_CHANNEL,
  TARGET_BRIDGE_VERSION,
  isTargetToParentMessage,
  type NativeModelContext,
  type NativeModelContextTool,
  type ParentToTargetMessage,
  type TargetBridgeError,
  type TargetIdentity,
  type TargetRuntimeMode,
  type TargetToParentMessage,
  type TargetToolEvidence,
  type TargetToolDescriptor,
} from "./targets/target-runtime";

type TargetId = "commerce" | "travel";

interface TargetConfig {
  id: TargetId;
  name: string;
  path: string;
}

type DiscoveryProvenance = "native" | "inferred";
type TargetScope = "controlled" | "external";
type GeneratedPublicationStatus =
  "draft" | "generated" | "injecting" | "injected" | "testing" | "failed";
type GeneratedPublicationMode = "native" | "preview" | "unavailable";

interface GeneratedPublication {
  status: GeneratedPublicationStatus;
  mode: GeneratedPublicationMode;
  message?: string;
}

interface PageToolRegistration {
  context: NativeModelContext;
  controller: AbortController;
  tool: NativeModelContextTool;
}

interface NativeRegistrationOwnership {
  controller: AbortController;
  /** True only after this Studio call was accepted by the host. */
  registered: boolean;
}

interface PendingGeneratedRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: number;
  toolName: string;
  generation: number;
  frameWindow: Window;
}

interface GeneratedBridgeError {
  code: string;
  message: string;
}

type GeneratedParentToTargetMessage = {
  channel: typeof TARGET_BRIDGE_CHANNEL;
  version: typeof TARGET_BRIDGE_VERSION;
  direction: "parent-to-target";
} & (
  | {
      type: "register-generated-tool";
      requestId: string;
      toolName: string;
      descriptor: TargetToolDescriptor;
    }
  | {
      type: "test-generated-tool";
      requestId: string;
      toolName: string;
      args: JsonValue;
    }
);

type GeneratedResultToTargetMessage = {
  channel: typeof TARGET_BRIDGE_CHANNEL;
  version: typeof TARGET_BRIDGE_VERSION;
  direction: "parent-to-target";
} & (
  | {
      type: "generated-tool-result";
      requestId: string;
      toolName: string;
      result: JsonValue;
    }
  | {
      type: "generated-tool-error";
      requestId: string;
      toolName: string;
      error: GeneratedBridgeError;
    }
);

type GeneratedTargetToParentMessage = {
  channel: typeof TARGET_BRIDGE_CHANNEL;
  version: typeof TARGET_BRIDGE_VERSION;
  direction: "target-to-parent";
} & (
  | {
      type: "generated-tool-ready";
      requestId: string;
      toolName: string;
      registered: boolean;
      mode: GeneratedPublicationMode;
      error?: GeneratedBridgeError;
    }
  | {
      type: "generated-tool-call";
      requestId: string;
      toolName: string;
      args: JsonValue;
    }
  | {
      type: "generated-tool-test-result";
      requestId: string;
      toolName: string;
      result: JsonValue;
    }
  | {
      type: "generated-tool-test-error";
      requestId: string;
      toolName: string;
      error: GeneratedBridgeError;
    }
);

interface StudioToolRegistration {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  annotations: WebMcpToolAnnotations;
  execute: (args: unknown) => JsonValue | Promise<JsonValue>;
}

interface GeneratedTool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  primitiveNames: string[];
  workflow: Workflow;
  native: boolean;
  publication: GeneratedPublication;
}

interface TraceStep {
  name: string;
  status: "completed" | "failed";
  output?: JsonValue;
  error?: string;
}

interface ExecutionStatusSummary {
  status: "running" | "success" | "error";
  toolName: string;
  completedSteps: number;
  totalSteps: number;
  stateChanged: boolean;
  surface: "interactive snapshot" | "controlled target" | "live target";
  message: string;
}

interface PendingInvocation {
  resolve: (value: JsonValue) => void;
  reject: (reason: unknown) => void;
  timer: number;
  toolName: string;
  generation: number;
  frameWindow: Window;
}

interface PendingExternalPreviewRequest {
  resolve: (value: JsonValue) => void;
  reject: (reason: unknown) => void;
  timer: number;
  toolName: string;
  generation: number;
  frameWindow: Window;
  token: string;
}

type ExternalPreviewStatus =
  "idle" | "checking" | "visible" | "snapshot" | "blocked";

interface ExternalPreviewState {
  status: ExternalPreviewStatus;
  url: string;
  message: string;
  previewHtml?: string;
}

interface ExternalInspectionResponse {
  status: "inspected" | "no_tools" | "blocked" | "error";
  url: string;
  title: string;
  tools: TargetToolDescriptor[];
  frame: {
    status: "allowed" | "blocked" | "unknown";
    reason: string;
  };
  note: string;
  previewHtml?: string;
  error?: string;
}

const EXTERNAL_PREVIEW_CHANNEL = "webmcp-studio-preview";
const EXTERNAL_PREVIEW_VERSION = 1 as const;

type ExternalPreviewToParentMessage = {
  channel: typeof EXTERNAL_PREVIEW_CHANNEL;
  version: typeof EXTERNAL_PREVIEW_VERSION;
  direction: "preview-to-parent";
  token: string;
} & (
  | { type: "ready" }
  | {
      type: "result";
      requestId: string;
      toolName: string;
      result: JsonValue;
    }
  | {
      type: "error";
      requestId: string;
      toolName: string;
      error: { code: string; message: string };
    }
);

type ExternalPreviewCommand = {
  channel: typeof EXTERNAL_PREVIEW_CHANNEL;
  version: typeof EXTERNAL_PREVIEW_VERSION;
  direction: "parent-to-preview";
  token: string;
} & (
  | {
      type: "load";
      html: string;
    }
  | {
      type: "invoke";
      requestId: string;
      toolName: string;
      tool: TargetToolDescriptor;
      args: JsonValue;
    }
);

type StudioDragPayload = {
  kind: "primitive" | "workflow";
  name: string;
  index?: number;
};

interface PointerDragState {
  pointerId: number;
  pointerType: string;
  payload: StudioDragPayload;
  startX: number;
  startY: number;
  card: HTMLElement;
  started: boolean;
}

export interface HostedStudioOptions {
  document?: Document;
  pageWindow?: Window;
}

const TARGETS: Record<TargetId, TargetConfig> = {
  commerce: {
    id: "commerce",
    name: "Northstar Supply",
    path: "/targets/commerce.html",
  },
  travel: {
    id: "travel",
    name: "Skyline Travel",
    path: "/targets/travel.html",
  },
};

const DEFAULT_INPUT = {
  requirements: "keyboard",
  origin: "Singapore",
  destination: "Tokyo",
  max_price: 200,
  quantity: 1,
};

const GENERATED_STORAGE_PREFIX = "webmcp-studio.generated-tools.v2";
const MAX_EXTERNAL_PREVIEW_HTML = 220_000;
const STUDIO_TOOL_NAMES = [
  "discover_site_tools",
  "inspect_tool",
  "compose_workflow",
  "generate_tool",
  "list_generated_tools",
  "execute_workflow",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
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
    ([key, child]) => key !== "__proto__" && isJsonValue(child, next),
  );
}

function asJsonValue(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "object" || ancestors.has(value)) return null;
  const next = new Set(ancestors);
  next.add(value);
  if (Array.isArray(value)) return value.map((item) => asJsonValue(item, next));
  const result: Record<string, JsonValue> = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === "__proto__") continue;
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: asJsonValue(child, next),
      writable: true,
    });
  }
  return result;
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function inputRecord(value: unknown): Record<string, unknown> {
  const parsed = parseArguments(value);
  return isRecord(parsed) ? parsed : {};
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function randomId(prefix: string): string {
  try {
    if (typeof crypto.randomUUID === "function")
      return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    // Older preview browsers may not expose randomUUID.
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function pageOrigin(pageWindow: Window): string | null {
  try {
    const origin = pageWindow.location.origin;
    return origin && origin !== "null" ? origin : null;
  } catch {
    return null;
  }
}

function element<T extends Element>(documentValue: Document, id: string): T {
  const node = documentValue.getElementById(id);
  if (!node) throw new Error(`Hosted Studio markup is missing #${id}.`);
  return node as unknown as T;
}

function optionalElement<T extends Element>(
  documentValue: Document,
  id: string,
): T | null {
  return documentValue.getElementById(id) as T | null;
}

function discoveryProvenance(tool: TargetToolDescriptor): DiscoveryProvenance {
  return tool.source === "webmcp" ? "native" : "inferred";
}

function duplicateNames(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const name of names) {
    if (seen.has(name)) duplicates.add(name);
    seen.add(name);
  }
  return Array.from(duplicates);
}

function toolNameError(value: string): string | null {
  const name = value.trim().toLowerCase();
  if (!name) return "Give the generated tool a name.";
  if (name.length > 48) return "Tool names must be 48 characters or fewer.";
  if (!/^[a-z][a-z0-9_]*$/.test(name))
    return "Use lowercase letters, numbers, and underscores; start with a letter.";
  return null;
}

function toolDescriptionError(value: string): string | null {
  return value.trim() ? null : "A tool description is required.";
}

function isGeneratedTargetMessage(
  value: unknown,
): value is GeneratedTargetToParentMessage {
  if (!isRecord(value)) return false;
  if (
    value.channel !== TARGET_BRIDGE_CHANNEL ||
    value.version !== TARGET_BRIDGE_VERSION ||
    value.direction !== "target-to-parent" ||
    typeof value.type !== "string" ||
    typeof value.requestId !== "string" ||
    typeof value.toolName !== "string"
  )
    return false;
  if (value.type === "generated-tool-ready") {
    return (
      typeof value.registered === "boolean" &&
      (value.mode === "native" ||
        value.mode === "preview" ||
        value.mode === "unavailable")
    );
  }
  if (
    value.type === "generated-tool-call" ||
    value.type === "generated-tool-test-result"
  )
    return isJsonValue(
      value.type === "generated-tool-call" ? value.args : value.result,
    );
  if (value.type === "generated-tool-test-error") {
    return (
      isRecord(value.error) &&
      typeof value.error.code === "string" &&
      typeof value.error.message === "string"
    );
  }
  return false;
}

function text(value: JsonValue): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function targetToolEffect(
  tool: TargetToolDescriptor,
): DiscoveredAction["effect"] {
  return tool.annotations.destructiveHint ? "mutate" : "read";
}

function targetToolIsMutating(tool: TargetToolDescriptor | undefined): boolean {
  return tool?.annotations.destructiveHint === true;
}

function schemaProperties(schema: JSONSchema): Record<string, JSONSchema> {
  return schema.properties ?? {};
}

function isOutputKey(key: string): boolean {
  return (
    key === "productId" ||
    key === "product_id" ||
    key === "flightId" ||
    key === "flight_id" ||
    key === "optionId" ||
    key === "option_id" ||
    key === "productIds" ||
    key === "product_ids" ||
    key === "optionIds" ||
    key === "option_ids" ||
    key === "itemId" ||
    key === "item_id" ||
    key === "sku" ||
    key === "id" ||
    key === "ids"
  );
}

function hasProducer(
  names: readonly string[],
  index: number,
  descriptors: readonly TargetToolDescriptor[],
): boolean {
  return names
    .slice(0, index)
    .some(
      (name) =>
        descriptors.some((tool) => tool.name === name) &&
        /^(search|filter|get_)/.test(name),
    );
}

function descriptorHasInput(
  descriptor: TargetToolDescriptor | undefined,
  key: string,
): boolean {
  return Boolean(descriptor?.inputSchema.properties?.[key]);
}

function descriptorInputKey(
  descriptor: TargetToolDescriptor | undefined,
  keys: readonly string[],
): string | null {
  return (
    keys.find((candidate) => descriptorHasInput(descriptor, candidate)) ?? null
  );
}

function descriptorOutputBinding(
  descriptor: TargetToolDescriptor | undefined,
  keys: readonly string[],
  nodeId: string,
  path: string,
): Binding | null {
  const key = descriptorInputKey(descriptor, keys);
  return key ? bindingOutput(nodeId, path) : null;
}

function buildInputSchema(
  names: readonly string[],
  descriptors: readonly TargetToolDescriptor[],
): JSONSchema {
  const properties: Record<string, JSONSchema> = {};
  const required = new Set<string>();
  names.forEach((name, index) => {
    const descriptor = descriptors.find((tool) => tool.name === name);
    if (!descriptor) return;
    const producedByEarlierStep = hasProducer(names, index, descriptors);
    for (const [key, schema] of Object.entries(
      schemaProperties(descriptor.inputSchema),
    )) {
      if (producedByEarlierStep && isOutputKey(key)) continue;
      if (!properties[key]) properties[key] = cloneJsonSchema(schema);
    }
    for (const key of descriptor.inputSchema.required ?? []) {
      if (!(producedByEarlierStep && isOutputKey(key))) required.add(key);
    }
  });
  return {
    type: "object",
    properties,
    ...(required.size > 0 ? { required: Array.from(required) } : {}),
    additionalProperties: false,
  };
}

function findValue(value: unknown, keys: readonly string[]): string | null {
  if (isRecord(value)) {
    for (const key of keys) {
      if (typeof value[key] === "string" && value[key])
        return value[key] as string;
    }
    for (const child of Object.values(value)) {
      const found = findValue(child, keys);
      if (found) return found;
    }
  } else if (Array.isArray(value)) {
    for (const child of value) {
      const found = findValue(child, keys);
      if (found) return found;
    }
  }
  return null;
}

function readPath(value: unknown, path: string): unknown {
  if (!path || path === "$" || path === ".") return value;
  const parts = path
    .replace(/^\$\.?/, "")
    .split(/[.\[\]]+/)
    .filter(Boolean);
  let current: unknown = value;
  for (const part of parts) {
    if (Array.isArray(current) && /^\d+$/.test(part)) {
      current = current[Number(part)];
    } else if (isRecord(current)) {
      current = current[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function editableSchema(value: unknown): JSONSchema | null {
  const parsed = parseArguments(value);
  return isJsonSchema(parsed) ? cloneJsonSchema(parsed) : null;
}

function externalInspectionFromJson(
  value: unknown,
): ExternalInspectionResponse | null {
  if (!isRecord(value)) return null;
  const status = value.status;
  if (
    status !== "inspected" &&
    status !== "no_tools" &&
    status !== "blocked" &&
    status !== "error"
  )
    return null;
  const frameValue = isRecord(value.frame) ? value.frame : {};
  const frameStatus = frameValue.status;
  if (
    frameStatus !== "allowed" &&
    frameStatus !== "blocked" &&
    frameStatus !== "unknown"
  )
    return null;
  const tools = Array.isArray(value.tools)
    ? value.tools.flatMap((candidate): TargetToolDescriptor[] => {
        if (!isRecord(candidate)) return [];
        const name = stringValue(candidate.name).trim();
        const description = stringValue(candidate.description).trim();
        const inputSchema = editableSchema(candidate.inputSchema);
        if (!name || !description || !inputSchema) return [];
        const source =
          candidate.source === "webmcp" ||
          candidate.source === "dom" ||
          candidate.source === "manual"
            ? candidate.source
            : "dom";
        const evidence = Array.isArray(candidate.evidence)
          ? candidate.evidence.flatMap((item): TargetToolEvidence[] => {
              if (!isRecord(item)) return [];
              const note = stringValue(item.note).trim();
              if (!note) return [];
              const type: TargetToolEvidence["type"] =
                item.type === "dom" || item.type === "action"
                  ? item.type
                  : "manual";
              return [
                {
                  type,
                  note,
                  ...(stringValue(item.selector)
                    ? { selector: stringValue(item.selector) }
                    : {}),
                },
              ];
            })
          : [];
        return [
          {
            name,
            description,
            inputSchema,
            annotations: isRecord(candidate.annotations)
              ? (candidate.annotations as WebMcpToolAnnotations)
              : {},
            source,
            ...(typeof candidate.confidence === "number" &&
            Number.isFinite(candidate.confidence)
              ? { confidence: candidate.confidence }
              : {}),
            ...(evidence.length > 0 ? { evidence } : {}),
          },
        ];
      })
    : [];
  const url = stringValue(value.url).trim();
  const note = stringValue(value.note).trim();
  const reason = stringValue(frameValue.reason).trim();
  if (!url || !note || !reason) return null;
  const previewHtml = stringValue(value.previewHtml).trim();
  return {
    status,
    url,
    title: stringValue(value.title).trim(),
    tools,
    frame: { status: frameStatus, reason },
    note,
    ...(previewHtml.length > 0 &&
    previewHtml.length <= MAX_EXTERNAL_PREVIEW_HTML
      ? { previewHtml }
      : {}),
    ...(stringValue(value.error).trim()
      ? { error: stringValue(value.error).trim() }
      : {}),
  };
}

function isExternalPreviewMessage(
  value: unknown,
): value is ExternalPreviewToParentMessage {
  if (!isRecord(value)) return false;
  if (
    value.channel !== EXTERNAL_PREVIEW_CHANNEL ||
    value.version !== EXTERNAL_PREVIEW_VERSION ||
    value.direction !== "preview-to-parent" ||
    typeof value.token !== "string" ||
    typeof value.type !== "string"
  )
    return false;
  if (value.type === "ready") return true;
  if (
    value.type === "result" &&
    typeof value.requestId === "string" &&
    typeof value.toolName === "string"
  )
    return isJsonValue(value.result);
  return (
    value.type === "error" &&
    typeof value.requestId === "string" &&
    typeof value.toolName === "string" &&
    isRecord(value.error) &&
    typeof value.error.code === "string" &&
    typeof value.error.message === "string"
  );
}

function materializeSchemaDefaults(
  value: unknown,
  schema: JSONSchema,
): unknown {
  if (value === undefined && schema.default !== undefined)
    return schema.default;
  if (Array.isArray(value) && schema.items)
    return value.map((item) => materializeSchemaDefaults(item, schema.items!));
  if (!isRecord(value) || !schema.properties) return value;
  const result: Record<string, unknown> = { ...value };
  for (const [key, propertySchema] of Object.entries(schema.properties)) {
    if (Object.prototype.hasOwnProperty.call(result, key))
      result[key] = materializeSchemaDefaults(result[key], propertySchema);
    else {
      const withDefault = materializeSchemaDefaults(undefined, propertySchema);
      if (withDefault !== undefined) result[key] = withDefault;
    }
  }
  return result;
}

function previewDefaultForSchema(key: string, schema: JSONSchema): JsonValue {
  if (schema.default !== undefined) return schema.default;
  if (schema.enum?.length) return schema.enum[0] ?? null;
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === "string") {
    const normalized = key.toLowerCase();
    let value = /(?:origin|from|departure)/.test(normalized)
      ? "Singapore"
      : /(?:destination|to|arrival)/.test(normalized)
        ? "Tokyo"
        : /(?:email)/.test(normalized)
          ? "demo@example.com"
          : /(?:id|sku|slug)/.test(normalized)
            ? "preview-item"
            : "keyboard";
    while (schema.minLength !== undefined && value.length < schema.minLength)
      value += "-demo";
    if (schema.maxLength !== undefined)
      value = value.slice(0, schema.maxLength);
    return value || "x";
  }
  if (type === "number" || type === "integer") {
    const preferred = /(?:price|amount|cost|max|min)/.test(key.toLowerCase())
      ? 200
      : 1;
    const minimum = schema.minimum ?? Number.NEGATIVE_INFINITY;
    const maximum = schema.maximum ?? Number.POSITIVE_INFINITY;
    const value = Math.max(minimum, Math.min(maximum, preferred));
    return type === "integer" ? Math.round(value) : value;
  }
  if (type === "boolean") return true;
  if (type === "array") return [];
  if (type === "object") {
    const result: Record<string, JsonValue> = {};
    for (const property of schema.required ?? []) {
      const propertySchema = schema.properties?.[property];
      if (propertySchema)
        result[property] = previewDefaultForSchema(property, propertySchema);
    }
    return result;
  }
  return null;
}

function previewInputForSchema(schema: JSONSchema): JsonValue {
  const result: Record<string, JsonValue> = {};
  for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
    if (
      (schema.required ?? []).includes(key) ||
      propertySchema.default !== undefined
    )
      result[key] = previewDefaultForSchema(key, propertySchema);
  }
  return result;
}

function errorResult(
  name: string,
  message: string,
  trace: TraceStep[] = [],
): JsonValue {
  return asJsonValue({
    success: false,
    status: "validation_failed",
    toolName: name,
    stateChanged: false,
    navigationOccurred: false,
    warnings: [message],
    trace,
  });
}

function currentPageUrl(pageWindow: Window): string {
  try {
    return pageWindow.location.href;
  } catch {
    return "";
  }
}

function targetErrorMessage(error: unknown): string {
  if (isRecord(error) && typeof error.message === "string" && error.message)
    return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "The target primitive failed.";
}

function targetExecutionCode(error: unknown): ExecutionFailureCode {
  const code =
    isRecord(error) && typeof error.code === "string" ? error.code : "";
  if (code === "invalid_arguments") return "invalid_arguments";
  if (code === "unknown_tool") return "target_not_found";
  if (
    code === "execution_failed" &&
    /timed out/i.test(targetErrorMessage(error))
  )
    return "execution_timeout";
  return "unsupported_control";
}

function workflowTrace(
  workflow: Workflow,
  entries: readonly WorkflowTraceEntry[],
): TraceStep[] {
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  return entries.flatMap((entry): TraceStep[] => {
    if (entry.type !== "dom") return [];
    const node = nodes.get(entry.nodeId);
    const name = node?.type === "dom" ? node.config.capabilityId : entry.nodeId;
    return [
      {
        name,
        status: entry.status === "completed" ? "completed" : "failed",
        ...(entry.output === undefined ? {} : { output: entry.output }),
        ...(entry.error === undefined ? {} : { error: entry.error }),
      },
    ];
  });
}

export class HostedStudio {
  private readonly documentValue: Document;
  private readonly pageWindow: Window;
  private readonly targetFrame: HTMLIFrameElement;
  private readonly nativeContext: NativeModelContext | null;
  private readonly nativeAbort = new AbortController();
  private readonly nativeRegistrations = new Set<string>();
  private readonly registrationControllers = new Map<string, AbortController>();
  private readonly nativeRegistrationFailures = new Map<string, string>();
  /** Native primitive registrations mirrored from the selected controlled target. */
  private readonly targetNativeRegistrations = new Map<
    string,
    NativeRegistrationOwnership
  >();
  private readonly pending = new Map<string, PendingInvocation>();
  private readonly pendingGenerated = new Map<
    string,
    PendingGeneratedRequest
  >();
  private readonly pendingExternalPreview = new Map<
    string,
    PendingExternalPreviewRequest
  >();
  private readonly pageRegistrations = new Map<string, PageToolRegistration>();
  private readonly generated = new Map<string, GeneratedTool>();
  private readonly workflowRunner = new WorkflowRunner();
  private readonly messageListener: (event: MessageEvent<unknown>) => void;
  private project: ProjectDocument;
  private targetId: TargetId = "commerce";
  private targetScope: TargetScope = "controlled";
  private targetMode: TargetRuntimeMode = "preview";
  private targetIdentity: TargetIdentity = {
    id: "commerce",
    name: TARGETS.commerce.name,
    url: TARGETS.commerce.path,
  };
  private targetTools: TargetToolDescriptor[] = [];
  private potentialTools: TargetToolDescriptor[] = [];
  private analysisRequested = false;
  private selectedNames = new Set<string>();
  private draftNames: string[] = [];
  private targetReadyResolver: (() => void) | null = null;
  private targetReadyPromise: Promise<void> = Promise.resolve();
  private targetGeneration = 0;
  private started = false;
  private stopped = false;
  private externalPreview: ExternalPreviewState = {
    status: "idle",
    url: "",
    message: "",
  };
  private externalPreviewTimer: number | null = null;
  private externalPreviewToken = "";
  private externalPreviewReady = false;
  private externalPreviewReadyResolver: (() => void) | null = null;
  private externalPreviewReadyPromise: Promise<void> = Promise.resolve();
  private activeDrag: StudioDragPayload | null = null;
  private pointerDrag: PointerDragState | null = null;
  private pointerDropRow: HTMLElement | null = null;
  private executionStatus: ExecutionStatusSummary | null = null;

  constructor(options: HostedStudioOptions = {}) {
    this.documentValue = options.document ?? document;
    this.pageWindow =
      options.pageWindow ?? this.documentValue.defaultView ?? window;
    this.ensureSiteInput();
    this.targetFrame = this.ensureTargetFrame();
    this.nativeContext = nativeModelContext(this.documentValue);
    this.project = createProject("commerce");
    this.messageListener = (event) => {
      void this.handleTargetMessage(event);
    };
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.pageWindow.addEventListener("message", this.messageListener);
    this.targetFrame.addEventListener("load", () =>
      this.handleTargetFrameLoad(),
    );
    this.bindUi();
    void this.registerStudioTools();
    this.updateNativeStatus();
    this.selectTarget("commerce", false);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.started = false;
    this.targetGeneration += 1;
    this.cancelPointerDrag();
    this.clearExternalPreviewTimer();
    this.resetExternalPreviewBridge();
    this.nativeAbort.abort();
    for (const controller of this.registrationControllers.values())
      if (controller !== this.nativeAbort) controller.abort();
    this.pageWindow.removeEventListener("message", this.messageListener);
    this.cancelPendingRequests(
      "stale_request",
      "Hosted Studio stopped before the target answered.",
    );
    for (const pending of this.pending.values()) {
      this.pageWindow.clearTimeout(pending.timer);
      pending.reject(new Error("Hosted Studio stopped."));
    }
    this.pending.clear();
    for (const pending of this.pendingGenerated.values()) {
      this.pageWindow.clearTimeout(pending.timer);
      pending.reject(new Error("Hosted Studio stopped."));
    }
    this.pendingGenerated.clear();
    this.unregisterTargetNativeTools();
    this.unregisterPageGeneratedTools();
    this.unregisterGeneratedTools();
    this.unregisterAllNativeTools();
    this.targetReadyResolver?.();
    this.targetReadyResolver = null;
  }

  private bindUi(): void {
    optionalElement<HTMLFormElement>(
      this.documentValue,
      "site-form",
    )?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.discoverFromSiteInput();
    });
    const toolForm = optionalElement<HTMLFormElement>(
      this.documentValue,
      "tool-form",
    );
    if (toolForm) toolForm.noValidate = true;
    toolForm?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.generateFromForm();
    });
    const discoveryLists = [
      optionalElement<HTMLElement>(this.documentValue, "discovery-list"),
      optionalElement<HTMLElement>(this.documentValue, "potential-list"),
    ].filter((list): list is HTMLElement => list !== null);
    for (const discoveryList of discoveryLists) {
      discoveryList.addEventListener("change", (event) => {
        const input = event.target;
        if (
          !(input instanceof HTMLInputElement) ||
          input.dataset.name === undefined
        )
          return;
        const name = input.dataset.name;
        if (input.checked && !this.draftNames.includes(name)) {
          this.addPrimitiveToDraft(name);
          return;
        }
        if (!input.checked && this.draftNames.includes(name)) {
          this.commitDraftNames(
            this.draftNames.filter((candidate) => candidate !== name),
            `Removed ${name} from the workflow.`,
          );
          return;
        }
        this.updateComposerEligibility();
      });
      discoveryList.addEventListener("click", (event) => {
        const button = event.target;
        if (!(button instanceof HTMLButtonElement)) return;
        const action = button.dataset.action;
        const name = button.dataset.name;
        if (action === "add-to-workflow" && name) {
          this.addPrimitiveToDraft(name);
          return;
        }
        if (action === "select-primitive" && name) {
          this.addPrimitiveToDraft(name);
        }
      });
      discoveryList.addEventListener("dragstart", (event) => {
        const target = event.target;
        const source =
          target instanceof Element
            ? target.closest<HTMLElement>(
                ".discovery-card[data-name][data-draggable='true']",
              )
            : null;
        const name = source?.dataset.name;
        const tool = name
          ? this.workflowToolDescriptors().find(
              (candidate) => candidate.name === name,
            )
          : undefined;
        if (
          !source ||
          !name ||
          !tool ||
          (target instanceof Element &&
            target.closest("button, input, textarea, select, a") &&
            !target.closest("[data-drag-handle]"))
        ) {
          event.preventDefault();
          return;
        }
        this.cancelPointerDrag();
        this.writeDragPayload(event, { kind: "primitive", name });
      });
      discoveryList.addEventListener("dragend", () => this.clearDragSession());
      discoveryList.addEventListener("pointerdown", (event) =>
        this.handlePointerDown(event),
      );
    }
    this.documentValue.addEventListener("pointermove", (event) =>
      this.handlePointerMove(event),
    );
    this.documentValue.addEventListener("pointerup", (event) =>
      this.handlePointerUp(event),
    );
    this.documentValue.addEventListener("pointercancel", () =>
      this.cancelPointerDrag(),
    );
    this.documentValue.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.cancelPointerDrag();
    });
    const flow = optionalElement<HTMLElement>(
      this.documentValue,
      "compose-flow",
    );
    const dropzone = flow?.closest<HTMLElement>(".workflow-dropzone") ?? flow;
    flow?.addEventListener("pointerdown", (event) =>
      this.handlePointerDown(event),
    );
    dropzone?.addEventListener("dragenter", () => {
      dropzone.classList.add("is-drag-over");
    });
    dropzone?.addEventListener("dragover", (event) => {
      // DataTransfer payloads can be protected during dragover. Always claim
      // this controlled dropzone, then validate the payload on drop.
      event.preventDefault();
      dropzone.classList.add("is-drag-over");
      if (event.dataTransfer)
        event.dataTransfer.dropEffect =
          this.activeDrag?.kind === "workflow" ? "move" : "copy";
    });
    dropzone?.addEventListener("dragleave", (event) => {
      if (
        event.relatedTarget instanceof Node &&
        dropzone.contains(event.relatedTarget)
      )
        return;
      dropzone.classList.remove("is-drag-over");
    });
    dropzone?.addEventListener("drop", (event) => {
      event.preventDefault();
      dropzone.classList.remove("is-drag-over");
      const payload = this.dragPayload(event);
      if (payload) this.dropPrimitive(payload, event);
      this.clearDragSession();
    });
    flow?.addEventListener("dragstart", (event) => {
      const target = event.target;
      const row =
        target instanceof Element
          ? target.closest<HTMLElement>("[data-flow-index]")
          : null;
      const index = row?.dataset.flowIndex;
      if (!row || index === undefined) return;
      const payload: StudioDragPayload = {
        kind: "workflow",
        name: row.dataset.name ?? "",
        index: Number(index),
      };
      this.writeDragPayload(event, payload);
    });
    flow?.addEventListener("dragend", () => this.clearDragSession());
    flow?.addEventListener("click", (event) => {
      const button = event.target;
      if (!(button instanceof HTMLButtonElement)) return;
      const name = button.dataset.name;
      const index = Number(button.dataset.flowIndex);
      if (!name || !Number.isInteger(index)) return;
      if (button.dataset.action === "remove-step") {
        this.commitDraftNames(
          this.draftNames.filter((candidate) => candidate !== name),
          `Removed ${name} from the workflow.`,
        );
      } else if (button.dataset.action === "move-step-up" && index > 0) {
        const next = [...this.draftNames];
        [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
        this.commitDraftNames(next, `Moved ${name} earlier in the workflow.`);
      } else if (
        button.dataset.action === "move-step-down" &&
        index < this.draftNames.length - 1
      ) {
        const next = [...this.draftNames];
        [next[index], next[index + 1]] = [next[index + 1]!, next[index]!];
        this.commitDraftNames(next, `Moved ${name} later in the workflow.`);
      }
    });
    optionalElement<HTMLElement>(
      this.documentValue,
      "generated-list",
    )?.addEventListener("click", (event) => {
      const button = event.target;
      if (!(button instanceof HTMLButtonElement)) return;
      const name = button.dataset.toolName;
      if (!name) return;
      if (button.dataset.action === "inject-generated")
        void this.injectGeneratedTool(name);
      else void this.testGeneratedTool(name);
    });
    optionalElement<HTMLButtonElement>(
      this.documentValue,
      "inject-button",
    )?.addEventListener("click", () => {
      const name = this.generatedToolNameFromUi();
      if (name) void this.injectGeneratedTool(name);
    });
    optionalElement<HTMLButtonElement>(
      this.documentValue,
      "test-generated-tool",
    )?.addEventListener("click", () => {
      const name = this.generatedToolNameFromUi();
      if (name) void this.testGeneratedTool(name);
    });
    const toolName = optionalElement<HTMLInputElement>(
      this.documentValue,
      "tool-name",
    );
    toolName?.addEventListener("input", () => {
      this.updateToolNameValidity();
      this.updateComposerEligibility();
    });
    this.updateToolNameValidity();
    const toolDescription = optionalElement<HTMLTextAreaElement>(
      this.documentValue,
      "tool-description",
    );
    toolDescription?.addEventListener("input", () => {
      this.updateToolDescriptionValidity();
      this.updateComposerEligibility();
    });
    this.updateToolDescriptionValidity();
  }

  private ensureSiteInput(): void {
    let input = optionalElement<HTMLInputElement>(
      this.documentValue,
      "site-url",
    );
    let form = optionalElement<HTMLFormElement>(
      this.documentValue,
      "site-form",
    );
    if (!input) {
      input = this.documentValue.createElement("input");
      input.id = "site-url";
      input.name = "siteUrl";
      input.type = "text";
      input.setAttribute("autocomplete", "url");
      input.placeholder = "/targets/commerce.html or https://example.com";
      input.setAttribute(
        "aria-label",
        "Site or domain to discover WebMCP tools",
      );
    }
    if (!form) {
      form = this.documentValue.createElement("form");
      form.id = "site-form";
      form.className = "site-discovery-form";
      const label = this.documentValue.createElement("label");
      label.htmlFor = "site-url";
      label.textContent = "Site or domain";
      const button = this.documentValue.createElement("button");
      button.type = "submit";
      button.className = "button button-primary";
      button.textContent = "Analyze";
      form.append(label, input, button);
      const note = this.documentValue.createElement("p");
      note.id = "site-note";
      note.className = "site-note";
      note.textContent =
        "Use any http(s) site to discover inferred tools; Studio can run them in a safe local preview, while live page injection remains same-origin or extension-only.";
      form.append(note);
      const workspaceHeading =
        this.documentValue.querySelector(".workspace-heading");
      if (workspaceHeading) workspaceHeading.append(form);
      else
        (this.documentValue.body ?? this.documentValue.documentElement).prepend(
          form,
        );
    } else if (!form.contains(input)) {
      form.append(input);
    }
    input.value = input.value.trim();
  }

  private ensureTargetFrame(): HTMLIFrameElement {
    const existing = optionalElement<HTMLIFrameElement>(
      this.documentValue,
      "target-frame",
    );
    if (existing) return existing;
    const frame = this.documentValue.createElement("iframe");
    frame.id = "target-frame";
    frame.title = "Live controlled target website";
    frame.hidden = true;
    (this.documentValue.body ?? this.documentValue.documentElement).append(
      frame,
    );
    return frame;
  }

  private generatedToolNameFromUi(): string | null {
    const current = Array.from(this.generated.keys()).at(-1);
    if (current) return current;
    const input = optionalElement<HTMLInputElement>(
      this.documentValue,
      "tool-name",
    );
    const name = input?.value.trim().toLowerCase() ?? "";
    return name || null;
  }

  private updateToolNameValidity(): void {
    const input = optionalElement<HTMLInputElement>(
      this.documentValue,
      "tool-name",
    );
    if (!input) return;
    const error = toolNameError(input.value);
    input.setCustomValidity(error ?? "");
    if (error) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-errormessage", "tool-name-help");
    } else {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-errormessage");
    }
    const help = optionalElement<HTMLElement>(
      this.documentValue,
      "tool-name-help",
    );
    if (help) {
      const message = error ?? "Lowercase letters, numbers, and underscores.";
      if (help.textContent !== message) help.textContent = message;
      help.classList.toggle("is-error", Boolean(error));
      help.setAttribute("aria-live", "polite");
    }
  }

  private updateToolDescriptionValidity(): void {
    const input = optionalElement<HTMLTextAreaElement>(
      this.documentValue,
      "tool-description",
    );
    if (!input) return;
    const error = toolDescriptionError(input.value);
    input.setCustomValidity(error ?? "");
    if (error) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-errormessage", "tool-description-help");
    } else {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-errormessage");
    }
    const help = optionalElement<HTMLElement>(
      this.documentValue,
      "tool-description-help",
    );
    if (help) {
      const message =
        error ?? "Tell agents what this tool does and when to use it.";
      if (help.textContent !== message) help.textContent = message;
      help.classList.toggle("is-error", Boolean(error));
      help.setAttribute("aria-live", "polite");
    }
  }

  private siteInputValue(): string {
    return (
      optionalElement<HTMLInputElement>(
        this.documentValue,
        "site-url",
      )?.value.trim() ?? ""
    );
  }

  private setSiteInputValue(value: string): void {
    const input = optionalElement<HTMLInputElement>(
      this.documentValue,
      "site-url",
    );
    if (input) input.value = value;
  }

  private resolveSiteInput(
    rawValue: string,
  ):
    | { kind: "controlled"; id: TargetId; url: string }
    | { kind: "external"; url: string }
    | { kind: "invalid"; message: string } {
    const value = rawValue.trim();
    if (!value)
      return { kind: "invalid", message: "Enter a site or domain first." };
    if (value === "commerce" || value === "northstar.test")
      return {
        kind: "controlled",
        id: "commerce",
        url: TARGETS.commerce.path,
      };
    if (value === "travel" || value === "skyline.test")
      return {
        kind: "controlled",
        id: "travel",
        url: TARGETS.travel.path,
      };

    let url: URL;
    try {
      const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
        ? value
        : value.startsWith("/")
          ? new URL(value, this.pageWindow.location.href).href
          : `https://${value}`;
      url = new URL(candidate, this.pageWindow.location.href);
    } catch {
      return {
        kind: "invalid",
        message: "Enter a valid http(s) URL or a supported target path.",
      };
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return {
        kind: "invalid",
        message: "Only http and https sites can be discovered.",
      };
    const origin = pageOrigin(this.pageWindow);
    if (origin?.startsWith("https:") && url.protocol !== "https:")
      return {
        kind: "invalid",
        message:
          "Use an https URL when analyzing an external site from Studio.",
      };
    for (const target of Object.values(TARGETS)) {
      if (
        origin &&
        url.origin === origin &&
        url.pathname.replace(/\/$/, "") === target.path
      )
        return { kind: "controlled", id: target.id, url: target.path };
    }
    if (origin && url.origin === origin && url.pathname === "/")
      return { kind: "controlled", id: "commerce", url: TARGETS.commerce.path };
    return { kind: "external", url: url.href };
  }

  private async discoverFromSiteInput(): Promise<void> {
    const resolution = this.resolveSiteInput(this.siteInputValue());
    const note =
      optionalElement<HTMLElement>(this.documentValue, "site-status") ??
      optionalElement<HTMLElement>(this.documentValue, "site-note");
    if (resolution.kind === "invalid") {
      this.showSiteMessage(resolution.message, true);
      return;
    }
    if (resolution.kind === "external") {
      await this.activateExternalTarget(resolution.url);
      return;
    }
    this.setSiteInputValue(resolution.url);
    this.potentialTools = [];
    this.renderPotentialTools();
    if (note)
      note.textContent =
        "Live controlled target selected. Discovering page-native WebMCP primitives…";
    await this.selectTarget(resolution.id);
    this.renderAll();
    this.requestTargetTools();
  }

  private showSiteMessage(message: string, error: boolean): void {
    const note =
      optionalElement<HTMLElement>(this.documentValue, "site-status") ??
      optionalElement<HTMLElement>(this.documentValue, "site-note") ??
      optionalElement<HTMLElement>(this.documentValue, "external-note");
    if (note) {
      note.textContent = message;
      note.classList.toggle("is-error", error);
      note.classList.toggle("is-success", !error);
    }
    this.showComposerMessage(message, error);
  }

  private async activateExternalTarget(rawUrl: string): Promise<void> {
    this.targetReadyResolver?.();
    this.targetReadyResolver = null;
    this.clearExternalPreviewTimer();
    this.resetExternalPreviewBridge();
    this.cancelPendingRequests(
      "stale_request",
      "The target changed before the previous tool request completed.",
    );
    const generation = ++this.targetGeneration;
    this.unregisterGeneratedTools();
    this.unregisterTargetNativeTools();
    this.unregisterPageGeneratedTools();
    this.analysisRequested = true;
    this.targetScope = "external";
    this.potentialTools = [];
    this.targetTools = [];
    this.targetMode = "preview";
    this.externalPreview = {
      status: "checking",
      url: rawUrl,
      message: "Inspecting the returned page and checking its embed policy…",
    };
    this.executionStatus = null;
    this.targetIdentity = {
      id: "external",
      name: new URL(rawUrl).hostname,
      url: rawUrl,
    };
    this.selectedNames.clear();
    this.draftNames = [];
    this.generated.clear();
    this.project = createProject(new URL(rawUrl).hostname);
    this.targetFrame.title = "External site preview";
    this.targetFrame.removeAttribute("srcdoc");
    this.targetFrame.removeAttribute("sandbox");
    this.targetFrame.src = "about:blank";
    this.targetFrame.hidden = true;
    this.hideTargetLoading(true);
    this.externalPreviewTimer = this.pageWindow.setTimeout(() => {
      if (
        generation !== this.targetGeneration ||
        this.externalPreview.status !== "checking"
      )
        return;
      this.externalPreview = {
        status: "blocked",
        url: "",
        message:
          "Studio could not finish inspecting this site. No external page was opened.",
      };
      this.targetFrame.hidden = true;
      this.hideTargetLoading(false);
      this.renderAll();
      this.showSiteMessage(this.externalPreview.message, true);
    }, 12_000);
    this.renderAll();
    this.showSiteMessage(
      `Inspecting ${this.targetIdentity.name}… inferred tools can be composed and run in a safe Studio preview.`,
      false,
    );
    try {
      const inspection = await this.inspectExternalSite(rawUrl);
      if (generation !== this.targetGeneration) return;
      this.potentialTools = inspection.tools;
      const finalUrl = inspection.url || rawUrl;
      this.targetIdentity = {
        id: "external",
        name: inspection.title || new URL(finalUrl).hostname,
        url: finalUrl,
      };
      const blocked = inspection.frame.status === "blocked";
      const previewHtml = inspection.previewHtml?.trim() || "";
      const hasSnapshot = blocked && previewHtml.length > 0;
      this.externalPreview = {
        status: hasSnapshot ? "snapshot" : blocked ? "blocked" : "visible",
        url: finalUrl,
        message: blocked
          ? inspection.frame.reason
          : inspection.frame.reason ||
            "Preview loaded when the external site permits framing.",
        ...(previewHtml ? { previewHtml } : {}),
      };
      this.clearExternalPreviewTimer();
      if (hasSnapshot) {
        this.setExternalPreviewSnapshot(
          previewHtml,
          "Interactive local snapshot ready. Inferred actions run here without contacting the external site.",
        );
      } else {
        this.targetFrame.removeAttribute("srcdoc");
        this.targetFrame.removeAttribute("sandbox");
        this.targetFrame.src = finalUrl;
        this.targetFrame.hidden = blocked;
      }
      this.hideTargetLoading(false);
      this.renderAll();
      const count = this.potentialTools.length;
      const snapshotNote = hasSnapshot
        ? " Showing an interactive local snapshot because the site blocks embedded previews."
        : previewHtml
          ? " Run preview switches to a safe local snapshot so inferred actions can be shown."
          : "";
      this.showSiteMessage(
        `${this.targetIdentity.name}: ${count} inferred potential tool${count === 1 ? "" : "s"}. ${inspection.note}${blocked ? ` ${inspection.frame.reason}` : ""}${snapshotNote}`,
        false,
      );
    } catch (error) {
      if (generation !== this.targetGeneration) return;
      this.clearExternalPreviewTimer();
      this.externalPreview = {
        status: "blocked",
        url: "",
        message:
          "The page could not be inspected, so Studio did not open the external URL.",
      };
      this.targetFrame.removeAttribute("srcdoc");
      this.targetFrame.removeAttribute("sandbox");
      this.targetFrame.src = "about:blank";
      this.targetFrame.hidden = true;
      this.hideTargetLoading(false);
      this.renderAll();
      this.showSiteMessage(
        `${this.targetIdentity.name}: inspection unavailable — ${targetErrorMessage(error)} The preview is display-only when the site permits framing.`,
        true,
      );
    }
  }

  private async inspectExternalSite(
    rawUrl: string,
  ): Promise<ExternalInspectionResponse> {
    let response: Response;
    try {
      response = await this.pageWindow.fetch("/api/analyze-external", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ url: rawUrl }),
      });
    } catch {
      throw new Error(
        "The hosted inspection service could not be reached. Try again on the deployed HTTPS URL.",
      );
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("The hosted inspection service returned invalid JSON.");
    }
    if (!response.ok) {
      const message =
        isRecord(payload) && typeof payload.error === "string"
          ? payload.error
          : `Inspection failed with HTTP ${response.status}.`;
      throw new Error(message);
    }
    const inspection = externalInspectionFromJson(payload);
    if (!inspection)
      throw new Error(
        "The hosted inspection service returned an invalid result.",
      );
    return inspection;
  }

  private resetExternalPreviewBridge(): void {
    this.externalPreviewReadyResolver?.();
    this.externalPreviewReadyResolver = null;
    this.externalPreviewReady = false;
    this.externalPreviewToken = "";
  }

  private setExternalPreviewSnapshot(
    previewHtml: string,
    message = "Interactive local snapshot ready. Inferred actions run here without contacting the external site.",
  ): void {
    const token = randomId("external-preview");
    this.externalPreviewToken = token;
    this.externalPreviewReady = false;
    this.externalPreviewReadyPromise = new Promise<void>((resolve) => {
      this.externalPreviewReadyResolver = resolve;
    });
    this.externalPreview = {
      ...this.externalPreview,
      status: "snapshot",
      message,
      previewHtml,
    };
    this.targetFrame.removeAttribute("src");
    // Keep the snapshot in an opaque-origin frame. The shell contains only
    // Studio's trusted bridge; the fetched, sanitized markup arrives through
    // a tokenized postMessage and cannot load a script or reach the parent.
    this.targetFrame.removeAttribute("srcdoc");
    this.targetFrame.setAttribute("sandbox", "allow-scripts");
    this.targetFrame.src =
      "/assets/external-preview.html?token=" + encodeURIComponent(token);
    this.targetFrame.hidden = false;
  }

  private postExternalPreviewSnapshot(): void {
    if (this.targetScope !== "external" || !this.externalPreviewToken) return;
    const frameWindow = this.targetFrame.contentWindow;
    const html = this.externalPreview.previewHtml?.trim();
    if (!frameWindow || !html) return;
    const message: ExternalPreviewCommand = {
      channel: EXTERNAL_PREVIEW_CHANNEL,
      version: EXTERNAL_PREVIEW_VERSION,
      direction: "parent-to-preview",
      type: "load",
      token: this.externalPreviewToken,
      html,
    };
    try {
      frameWindow.postMessage(message, "*");
    } catch {
      // The ready handshake will be retried if the frame is replaced.
    }
  }

  private async ensureExternalPreviewSnapshot(): Promise<boolean> {
    if (this.targetScope !== "external") return false;
    const previewHtml = this.externalPreview.previewHtml?.trim() || "";
    if (!previewHtml) return false;
    if (
      this.externalPreview.status !== "snapshot" ||
      !this.externalPreviewToken
    ) {
      this.setExternalPreviewSnapshot(previewHtml);
      this.renderAll();
    }
    const token = this.externalPreviewToken;
    const frameWindow = this.targetFrame.contentWindow;
    if (!token || !frameWindow) return false;
    if (!this.externalPreviewReady) {
      await Promise.race([
        this.externalPreviewReadyPromise,
        new Promise<void>((resolve) => {
          this.pageWindow.setTimeout(resolve, 5_000);
        }),
      ]);
    }
    const ready =
      this.targetScope === "external" &&
      token === this.externalPreviewToken &&
      frameWindow === this.targetFrame.contentWindow &&
      this.externalPreviewReady;
    return ready;
  }

  private async invokeExternalPreview(
    name: string,
    args: unknown,
  ): Promise<JsonValue> {
    const descriptor = this.potentialTools.find((tool) => tool.name === name);
    if (!descriptor)
      throw {
        code: "unknown_tool",
        message: `Inferred tool ${name} is not available for this snapshot.`,
      };
    if (!(await this.ensureExternalPreviewSnapshot()))
      throw {
        code: "execution_failed",
        message:
          "The inferred preview snapshot is unavailable. Re-run analysis to load an interactive snapshot.",
      };
    const frameWindow = this.targetFrame.contentWindow;
    const token = this.externalPreviewToken;
    if (!frameWindow || !token)
      throw {
        code: "execution_failed",
        message: "The inferred preview frame is not available.",
      };
    const generation = this.targetGeneration;
    const requestId = randomId("external-preview-call");
    const message: ExternalPreviewCommand = {
      channel: EXTERNAL_PREVIEW_CHANNEL,
      version: EXTERNAL_PREVIEW_VERSION,
      direction: "parent-to-preview",
      type: "invoke",
      token,
      requestId,
      toolName: name,
      tool: descriptor,
      args: asJsonValue(parseArguments(args)),
    };
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = this.pageWindow.setTimeout(() => {
        this.pendingExternalPreview.delete(requestId);
        reject({
          code: "execution_timeout",
          message: `Inferred preview tool ${name} timed out.`,
        });
      }, 15_000);
      this.pendingExternalPreview.set(requestId, {
        resolve,
        reject,
        timer,
        toolName: name,
        generation,
        frameWindow,
        token,
      });
      try {
        // The sandboxed srcdoc intentionally has an opaque origin, so a
        // random session token plus the exact frame window is the authority.
        frameWindow.postMessage(message, "*");
      } catch {
        this.pendingExternalPreview.delete(requestId);
        this.pageWindow.clearTimeout(timer);
        reject({
          code: "execution_failed",
          message: "The inferred preview frame could not receive the action.",
        });
      }
    });
  }

  private handleExternalPreviewMessage(event: MessageEvent<unknown>): boolean {
    if (
      this.targetScope !== "external" ||
      event.source !== this.targetFrame.contentWindow ||
      event.origin !== "null"
    )
      return false;
    const message = isExternalPreviewMessage(event.data) ? event.data : null;
    if (!message || message.token !== this.externalPreviewToken) return false;
    if (message.type === "ready") {
      this.externalPreviewReady = true;
      this.externalPreviewReadyResolver?.();
      this.externalPreviewReadyResolver = null;
      this.postExternalPreviewSnapshot();
      return true;
    }
    const pending = this.pendingExternalPreview.get(message.requestId);
    if (!pending) return true;
    if (
      pending.generation !== this.targetGeneration ||
      pending.frameWindow !== this.targetFrame.contentWindow ||
      pending.token !== message.token ||
      pending.toolName !== message.toolName
    )
      return true;
    this.pendingExternalPreview.delete(message.requestId);
    this.pageWindow.clearTimeout(pending.timer);
    if (message.type === "result") pending.resolve(message.result);
    else pending.reject(message.error);
    return true;
  }

  private nativeTargetTools(): TargetToolDescriptor[] {
    return this.targetScope === "controlled"
      ? this.targetTools.filter(
          (tool) => discoveryProvenance(tool) === "native",
        )
      : [];
  }

  private targetGenerationActive(generation: number): boolean {
    return (
      !this.stopped &&
      generation === this.targetGeneration &&
      this.targetScope === "controlled"
    );
  }

  /**
   * Descriptors that may be assembled on the canvas. External descriptors are
   * inferred proposals at discovery time, but generated workflows can execute
   * them through the Studio-owned snapshot adapter. Only page publication is
   * restricted by the external target boundary.
   */
  private workflowToolDescriptors(): TargetToolDescriptor[] {
    return this.targetScope === "external"
      ? this.potentialTools
      : this.targetTools;
  }

  private workflowDropzone(): HTMLElement | null {
    const flow = optionalElement<HTMLElement>(
      this.documentValue,
      "compose-flow",
    );
    return flow?.closest<HTMLElement>(".workflow-dropzone") ?? flow;
  }

  private clearExternalPreviewTimer(): void {
    if (this.externalPreviewTimer !== null) {
      this.pageWindow.clearTimeout(this.externalPreviewTimer);
      this.externalPreviewTimer = null;
    }
  }

  private clearPointerDropMarker(): void {
    this.pointerDropRow?.classList.remove("is-drop-target");
    this.pointerDropRow = null;
    this.workflowDropzone()?.classList.remove("is-drag-over");
  }

  private cancelPointerDrag(): void {
    const state = this.pointerDrag;
    if (!state) return;
    state.card.classList.remove("is-dragging");
    try {
      if (state.card.hasPointerCapture(state.pointerId))
        state.card.releasePointerCapture(state.pointerId);
    } catch {
      // Pointer capture can already be released by the browser on cancel.
    }
    this.pointerDrag = null;
    this.clearPointerDropMarker();
    this.documentValue.body?.classList.remove("is-pointer-dragging");
  }

  private clearDragSession(): void {
    this.activeDrag = null;
    this.cancelPointerDrag();
    this.workflowDropzone()?.classList.remove("is-drag-over");
  }

  private handlePointerDown(event: PointerEvent): void {
    if (
      this.pointerDrag ||
      (event.pointerType === "mouse" && event.button !== 0)
    )
      return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest("button, input, textarea, select, a")) return;
    const handle = target.closest<HTMLElement>("[data-drag-handle]");
    const card = target.closest<HTMLElement>(
      ".discovery-card[data-name][data-draggable='true']",
    );
    const row = handle?.closest<HTMLElement>(".flow-discovery");
    const cardName = card?.dataset.name;
    const rowName = row?.dataset.name;
    const rowIndex = row?.dataset.flowIndex;
    const sourceElement = card ?? row;
    const cardTool = cardName
      ? this.workflowToolDescriptors().find((tool) => tool.name === cardName)
      : undefined;
    const payload = cardName
      ? { kind: "primitive" as const, name: cardName }
      : rowName && rowIndex !== undefined
        ? {
            kind: "workflow" as const,
            name: rowName,
            index: Number(rowIndex),
          }
        : null;
    if (
      !handle ||
      !sourceElement ||
      !payload ||
      (payload.kind === "primitive" &&
        (!cardTool ||
          (target.closest("button, input, textarea, select, a") !== null &&
            target.closest("[data-drag-handle]") === null))) ||
      (payload.kind === "workflow" &&
        (!Number.isInteger(payload.index) ||
          this.draftNames[payload.index] !== payload.name))
    )
      return;
    this.pointerDrag = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      payload,
      startX: event.clientX,
      startY: event.clientY,
      card: sourceElement,
      started: false,
    };
  }

  private handlePointerMove(event: PointerEvent): void {
    const state = this.pointerDrag;
    if (!state || event.pointerId !== state.pointerId) return;
    const distance = Math.hypot(
      event.clientX - state.startX,
      event.clientY - state.startY,
    );
    if (!state.started) {
      if (distance < 8) return;
      state.started = true;
      this.activeDrag = state.payload;
      state.card.classList.add("is-dragging");
      this.documentValue.body?.classList.add("is-pointer-dragging");
      try {
        state.card.setPointerCapture(state.pointerId);
      } catch {
        // Some browsers only allow capture from the original handle node.
      }
    }
    event.preventDefault();
    const dropzone = this.workflowDropzone();
    const target = this.documentValue.elementFromPoint(
      event.clientX,
      event.clientY,
    );
    if (!dropzone || !target || !dropzone.contains(target)) {
      this.clearPointerDropMarker();
      return;
    }
    dropzone.classList.add("is-drag-over");
    this.pointerDropRow?.classList.remove("is-drop-target");
    this.pointerDropRow = target.closest<HTMLElement>("[data-flow-index]");
    this.pointerDropRow?.classList.add("is-drop-target");
  }

  private handlePointerUp(event: PointerEvent): void {
    const state = this.pointerDrag;
    if (!state || event.pointerId !== state.pointerId) return;
    if (state.started) {
      const target = this.documentValue.elementFromPoint(
        event.clientX,
        event.clientY,
      );
      const dropzone = this.workflowDropzone();
      if (target && dropzone?.contains(target)) {
        this.dropPrimitive(state.payload, { target, clientY: event.clientY });
      }
      event.preventDefault();
    }
    this.clearDragSession();
  }

  private writeDragPayload(event: DragEvent, payload: StudioDragPayload): void {
    this.activeDrag = payload;
    if (!event.dataTransfer || !payload.name) return;
    event.dataTransfer.effectAllowed =
      payload.kind === "primitive" ? "copy" : "move";
    const serialized = JSON.stringify(payload);
    event.dataTransfer.setData("application/x-webmcp-studio", serialized);
    event.dataTransfer.setData("text/plain", serialized);
  }

  private dragPayload(event: DragEvent): StudioDragPayload | null {
    const value =
      event.dataTransfer?.getData("application/x-webmcp-studio") ||
      event.dataTransfer?.getData("text/plain");
    if (!value) return this.activeDrag;
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!isRecord(parsed)) return null;
      if (parsed.kind !== "primitive" && parsed.kind !== "workflow")
        return null;
      if (typeof parsed.name !== "string" || !parsed.name) return null;
      const index =
        typeof parsed.index === "number" && Number.isInteger(parsed.index)
          ? parsed.index
          : undefined;
      return {
        kind: parsed.kind,
        name: parsed.name,
        ...(index === undefined ? {} : { index }),
      };
    } catch {
      return null;
    }
  }

  private dropPrimitive(
    payload: StudioDragPayload,
    location: { target: EventTarget | null; clientY: number },
  ): void {
    if (
      payload.kind === "primitive" &&
      !this.workflowToolDescriptors().some((tool) => tool.name === payload.name)
    ) {
      this.showComposerMessage(
        `${payload.name} is no longer available in the discovery library.`,
        true,
      );
      return;
    }
    const eventTarget = location.target;
    const targetRow =
      eventTarget instanceof Element
        ? eventTarget.closest<HTMLElement>("[data-flow-index]")
        : null;
    let insertion = this.draftNames.length;
    if (targetRow) {
      const targetIndex = Number(targetRow.dataset.flowIndex);
      if (Number.isInteger(targetIndex)) {
        const bounds = targetRow.getBoundingClientRect();
        insertion =
          location.clientY > bounds.top + bounds.height / 2
            ? targetIndex + 1
            : targetIndex;
      }
    }
    if (payload.kind === "workflow") {
      const sourceIndex = this.draftNames.indexOf(payload.name);
      if (sourceIndex < 0) {
        this.showComposerMessage(
          "That workflow step is no longer available. Start the drag again.",
          true,
        );
        return;
      }
      const next = this.draftNames.filter((_, index) => index !== sourceIndex);
      if (insertion > sourceIndex) insertion -= 1;
      insertion = Math.max(0, Math.min(insertion, next.length));
      next.splice(insertion, 0, payload.name);
      this.commitDraftNames(next, `Reordered ${payload.name}.`);
      return;
    }
    if (this.draftNames.includes(payload.name)) {
      this.showComposerMessage(
        `${payload.name} is already in the workflow. Reorder it from the canvas.`,
        true,
      );
      return;
    }
    const next = [...this.draftNames];
    next.splice(Math.max(0, Math.min(insertion, next.length)), 0, payload.name);
    this.commitDraftNames(next, `Added ${payload.name} to the workflow.`);
  }

  private addPrimitiveToDraft(name: string): void {
    if (!this.workflowToolDescriptors().some((tool) => tool.name === name)) {
      this.showComposerMessage(
        `${name} is no longer available in the discovery library.`,
        true,
      );
      return;
    }
    if (this.draftNames.includes(name)) {
      this.showComposerMessage(
        `${name} is already in the workflow. Reorder it from the canvas.`,
        true,
      );
      return;
    }
    this.commitDraftNames(
      [...this.draftNames, name],
      `Added ${name} to the workflow.`,
    );
  }

  private commitDraftNames(
    names: readonly string[],
    message?: string,
  ): boolean {
    const duplicates = duplicateNames(names);
    const unknown = this.unknownPrimitiveNames(names);
    if (duplicates.length > 0) {
      this.showComposerMessage(
        `A workflow step can appear only once: ${duplicates.join(", ")}.`,
        true,
      );
      return false;
    }
    if (unknown.length > 0) {
      this.showComposerMessage(
        `Choose tools from the discovery library. Unknown step${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
        true,
      );
      return false;
    }
    this.draftNames = [...names];
    this.selectedNames = new Set(this.draftNames);
    this.renderDiscoveries();
    this.renderPotentialTools();
    this.renderComposer();
    this.updateComposerEligibility();
    if (message) this.showComposerMessage(message, false);
    return true;
  }

  private postGeneratedMessage(
    message: GeneratedParentToTargetMessage | GeneratedResultToTargetMessage,
  ): boolean {
    const frameWindow = this.targetFrame.contentWindow;
    const origin = pageOrigin(this.pageWindow);
    if (!frameWindow || !origin) return false;
    try {
      frameWindow.postMessage(message, origin);
      return true;
    } catch {
      return false;
    }
  }

  private waitForGeneratedResponse(
    requestId: string,
    toolName: string,
    generation = this.targetGeneration,
    frameWindow = this.targetFrame.contentWindow,
    timeoutMs = 15_000,
  ): Promise<unknown> {
    if (!frameWindow)
      return Promise.reject({
        code: "execution_failed",
        message: "The controlled target is not available.",
      });
    return new Promise<unknown>((resolve, reject) => {
      const timer = this.pageWindow.setTimeout(() => {
        this.pendingGenerated.delete(requestId);
        reject({
          code: "execution_timeout",
          message: "The target page did not answer the generated-tool request.",
        });
      }, timeoutMs);
      this.pendingGenerated.set(requestId, {
        resolve,
        reject,
        timer,
        toolName,
        generation,
        frameWindow,
      });
    });
  }

  private cancelPendingRequests(code: string, message: string): void {
    const error = { code, message };
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      this.pageWindow.clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const [requestId, pending] of this.pendingGenerated) {
      this.pendingGenerated.delete(requestId);
      this.pageWindow.clearTimeout(pending.timer);
      pending.reject(error);
    }
    for (const [requestId, pending] of this.pendingExternalPreview) {
      this.pendingExternalPreview.delete(requestId);
      this.pageWindow.clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  private generatedDescriptor(tool: GeneratedTool): TargetToolDescriptor {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: cloneJsonSchema(tool.inputSchema),
      annotations: {
        destructiveHint: tool.primitiveNames.some((primitive) =>
          targetToolIsMutating(
            this.workflowToolDescriptors().find(
              (candidate) => candidate.name === primitive,
            ),
          ),
        ),
      },
      source: "webmcp",
      confidence: 1,
      evidence: [
        {
          type: "action",
          note: `Generated from ${tool.primitiveNames.join(" → ")}.`,
        },
      ],
    };
  }

  private setPublication(
    name: string,
    publication: GeneratedPublication,
  ): void {
    const tool = this.generated.get(name);
    if (!tool) return;
    this.generated.set(name, {
      ...tool,
      publication: {
        ...publication,
        ...(publication.message ? { message: publication.message } : {}),
      },
    });
    this.persistGeneratedTools();
    this.renderGenerated();
    this.updateNativeStatus();
  }

  private async registerGeneratedOnPage(
    generated: GeneratedTool,
  ): Promise<boolean> {
    let targetDocument: Document | null = null;
    try {
      targetDocument = this.targetFrame.contentDocument;
    } catch {
      targetDocument = null;
    }
    const context = targetDocument ? nativeModelContext(targetDocument) : null;
    if (!context) return false;
    this.pageRegistrations.get(generated.name)?.controller.abort();
    const previous = this.pageRegistrations.get(generated.name);
    if (previous?.context.unregisterTool) {
      try {
        await Promise.resolve(previous.context.unregisterTool(generated.name));
      } catch {
        // A host may support abort-only registration cleanup.
      }
    }
    const controller = new AbortController();
    const tool = toNativeWebMcpTool(
      this.generatedDescriptor(generated),
      (input: unknown): Promise<JsonValue> =>
        this.executeGenerated(generated.name, input),
    );
    try {
      const registration = await registerNativeModelTool(context, tool, {
        signal: controller.signal,
      });
      if (!registration.registered || controller.signal.aborted) return false;
      this.pageRegistrations.set(generated.name, {
        context,
        controller,
        tool,
      });
      return true;
    } catch {
      controller.abort();
      return false;
    }
  }

  private unregisterPageGeneratedTools(): void {
    for (const [name, registration] of this.pageRegistrations) {
      registration.controller.abort();
      if (registration.context.unregisterTool) {
        try {
          void Promise.resolve(registration.context.unregisterTool(name)).catch(
            () => undefined,
          );
        } catch {
          // Older hosts may expose registration without explicit removal.
        }
      }
    }
    this.pageRegistrations.clear();
  }

  private async injectGeneratedTool(name: string): Promise<boolean> {
    const generated = this.generated.get(name);
    if (!generated) {
      this.showComposerMessage(
        "Generate a tool before publishing it to the target page.",
        true,
      );
      return false;
    }
    if (this.targetScope !== "controlled") {
      const studioRuntimeMessage = generated.native
        ? "The custom tool is registered on Studio's WebMCP context."
        : "The custom tool is available in Studio preview; native WebMCP is unavailable in this browser.";
      const targetUrl = this.targetIdentity.url || this.externalPreview.url;
      let opened = false;
      try {
        opened = Boolean(
          targetUrl &&
          this.pageWindow.open(targetUrl, "_blank", "noopener,noreferrer"),
        );
      } catch {
        opened = false;
      }
      const message = opened
        ? `${studioRuntimeMessage} Opened the live target in a new tab. Click the optional extension adapter (WebMCP Studio extension) there to inspect and inject the tool. Run preview remains available here on the interactive snapshot.`
        : `${studioRuntimeMessage} Allow pop-ups to open the live target, then click the optional extension adapter (WebMCP Studio extension) there to inspect and inject the tool. Run preview remains available here on the interactive snapshot.`;
      this.setPublication(name, {
        ...generated.publication,
        status: "generated",
        mode: "preview",
        message,
      });
      this.showComposerMessage(message, !opened);
      return opened;
    }
    this.setPublication(name, { status: "injecting", mode: "unavailable" });
    const requestId = randomId("generated-register");
    const descriptor = this.generatedDescriptor(generated);
    const message: GeneratedParentToTargetMessage = {
      channel: TARGET_BRIDGE_CHANNEL,
      version: TARGET_BRIDGE_VERSION,
      direction: "parent-to-target",
      type: "register-generated-tool",
      requestId,
      toolName: generated.name,
      descriptor,
    };
    const generation = this.targetGeneration;
    const frameWindow = this.targetFrame.contentWindow;
    const posted = this.postGeneratedMessage(message);
    if (posted) {
      try {
        const response = await this.waitForGeneratedResponse(
          requestId,
          generated.name,
          generation,
          frameWindow,
        );
        if (
          isGeneratedTargetMessage(response) &&
          response.type === "generated-tool-ready"
        ) {
          if (response.registered) {
            const mode = response.mode;
            this.setPublication(name, {
              status: "injected",
              mode,
              message:
                mode === "preview"
                  ? "The target accepted the generated handler, but native WebMCP is unavailable. Test it as a preview."
                  : "The generated tool is registered on the target page's native WebMCP context.",
            });
            return true;
          }
          const reason =
            response.error?.message ?? "The target rejected registration.";
          this.setPublication(name, {
            status: "failed",
            mode: response.mode,
            message: reason,
          });
          this.showComposerMessage(reason, true);
          return false;
        }
      } catch (error) {
        const messageText = targetErrorMessage(error);
        this.setPublication(name, {
          status: "failed",
          mode: "unavailable",
          message: messageText,
        });
        this.showComposerMessage(messageText, true);
        return false;
      }
    } else {
      // Keep a same-origin direct registration fallback for a target page that
      // exposes modelContext but cannot answer the Studio bridge.
      const direct = await this.registerGeneratedOnPage(generated);
      if (direct) {
        this.setPublication(name, {
          status: "injected",
          mode: "native",
          message: "Registered on the target page's native WebMCP context.",
        });
        return true;
      }
    }
    const messageText =
      "The target page could not accept the generated tool. You can retry after reloading it, or run a preview in this Studio session.";
    this.setPublication(name, {
      status: "failed",
      mode: "unavailable",
      message: messageText,
    });
    this.showComposerMessage(messageText, true);
    return false;
  }

  private async invokePageRegistration(
    name: string,
    input: JsonValue,
  ): Promise<JsonValue | null> {
    const registration = this.pageRegistrations.get(name);
    if (!registration) return null;
    try {
      if (registration.context.executeTool) {
        return asJsonValue(
          await executeNativeModelTool(
            registration.context,
            name,
            registration.tool,
            input,
          ),
        );
      }
      return asJsonValue(await registration.tool.execute(input));
    } catch (error) {
      return asJsonValue({
        success: false,
        status: "execution_failed",
        toolName: name,
        stateChanged: false,
        navigationOccurred: false,
        warnings: [targetErrorMessage(error)],
        error: { code: "execution_failed", message: targetErrorMessage(error) },
        trace: [],
      });
    }
  }

  /**
   * Exercise a generated tool through Studio's own WebMCP host when the
   * browser exposes its imperative test surface. The fallback is the exact
   * registered handler, which keeps the button useful in preview-only
   * browsers without pretending that native WebMCP is available.
   */
  private async invokeStudioGenerated(
    name: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    const generated = this.generated.get(name);
    if (!generated) throw new Error(`Generated tool ${name} is not available.`);
    const fallbackTool = toNativeWebMcpTool(
      this.generatedDescriptor(generated),
      (value: unknown): Promise<JsonValue> =>
        this.executeGenerated(name, value),
    );
    if (generated.native && this.nativeContext?.executeTool)
      return executeNativeModelTool(
        this.nativeContext,
        name,
        fallbackTool,
        input,
      );
    return this.executeGenerated(name, input);
  }

  private async requestPageGeneratedTest(
    name: string,
    input: JsonValue,
  ): Promise<JsonValue> {
    const requestId = randomId("generated-test");
    const message: GeneratedParentToTargetMessage = {
      channel: TARGET_BRIDGE_CHANNEL,
      version: TARGET_BRIDGE_VERSION,
      direction: "parent-to-target",
      type: "test-generated-tool",
      requestId,
      toolName: name,
      args: input,
    };
    const generation = this.targetGeneration;
    const frameWindow = this.targetFrame.contentWindow;
    if (!this.postGeneratedMessage(message))
      throw new Error("The target page test bridge is unavailable.");
    const response = await this.waitForGeneratedResponse(
      requestId,
      name,
      generation,
      frameWindow,
    );
    if (!isGeneratedTargetMessage(response))
      throw new Error(
        "The target page returned an invalid generated-tool response.",
      );
    if (response.type === "generated-tool-test-result") return response.result;
    if (response.type === "generated-tool-test-error") throw response.error;
    throw new Error(
      "The target page returned an unexpected generated-tool response.",
    );
  }

  private async testGeneratedTool(name: string): Promise<void> {
    const generated = this.generated.get(name);
    if (!generated) {
      this.showComposerMessage("Generate a tool before testing it.", true);
      return;
    }
    const externalPreview = this.targetScope === "external";
    const controlledPreview =
      this.targetScope === "controlled" && this.targetMode === "preview";
    if (externalPreview && !(await this.ensureExternalPreviewSnapshot())) {
      this.showComposerMessage(
        "Run preview is unavailable because this site did not provide an interactive snapshot. Re-run analysis and try again.",
        true,
      );
      return;
    }
    if (!controlledPreview && generated.publication.status !== "injected") {
      if (!externalPreview) {
        const injected = await this.injectGeneratedTool(name);
        if (!injected) {
          this.showComposerMessage(
            generated.publication.message ??
              "Inject the generated tool into the target page before testing it.",
            true,
          );
          return;
        }
      }
    }
    const current = this.generated.get(name);
    if (!current) return;
    this.executionStatus = {
      status: "running",
      toolName: name,
      completedSteps: 0,
      totalSteps: generated.primitiveNames.length,
      stateChanged: false,
      surface: externalPreview
        ? "interactive snapshot"
        : controlledPreview
          ? "controlled target"
          : "live target",
      message: `Running ${name}…`,
    };
    this.renderExecutionStatus();
    this.setPublication(name, {
      ...current.publication,
      status: "testing",
    });
    const input = this.defaultInputForTarget(generated);
    let result: JsonValue | null = null;
    try {
      if (controlledPreview || externalPreview) {
        // Preview targets execute the same structured workflow as a published
        // page tool. External targets use the Studio-owned snapshot adapter;
        // no third-party origin is contacted.
        result = externalPreview
          ? await this.invokeStudioGenerated(name, input)
          : await this.executeGenerated(name, input);
      } else {
        result = await this.requestPageGeneratedTest(name, input);
      }
    } catch (error) {
      if (!controlledPreview)
        result = await this.invokePageRegistration(name, input);
      if (result === null)
        result = errorResult(name, targetErrorMessage(error));
    }
    const previewRun = controlledPreview || externalPreview;
    const latest = this.generated.get(name);
    if (latest) {
      const succeeded = isRecord(result) && result.success === true;
      this.setPublication(name, {
        ...latest.publication,
        status: succeeded ? (previewRun ? "generated" : "injected") : "failed",
        ...(succeeded && previewRun
          ? {
              message: externalPreview
                ? `${generated.native ? "Run preview passed against the Studio-owned snapshot; the custom tool remains registered on Studio's WebMCP context." : "Run preview passed against the Studio-owned snapshot; native Studio WebMCP is unavailable in this browser."} Live third-party injection needs the optional extension adapter.`
                : "Preview ran against the controlled target. Inject the tool when native page WebMCP is available.",
            }
          : {}),
        ...(succeeded
          ? {}
          : {
              message: targetErrorMessage(
                isRecord(result) ? result.error : result,
              ),
            }),
      });
    }
    this.recordExecutionStatus(
      name,
      result,
      generated.primitiveNames.length,
      previewRun,
    );
    if (isRecord(result) && result.success === true) {
      this.showComposerMessage(
        previewRun
          ? externalPreview
            ? "Test passed — Run preview updated the interactive external snapshot."
            : "Test passed — Run preview updated the controlled target."
          : "Test passed — the target page updated.",
        false,
      );
    } else
      this.showComposerMessage(
        targetErrorMessage(isRecord(result) ? result.error : result),
        true,
      );
  }

  private async registerStudioTools(): Promise<void> {
    const tools: StudioToolRegistration[] = [
      {
        name: "discover_site_tools",
        description:
          "Discover native WebMCP primitives from a controlled site path, or return clearly labeled inferred tools from an external http(s) page for composition and safe Studio preview.",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", enum: ["commerce", "travel"] },
            site: {
              type: "string",
              description:
                "A same-origin /targets/commerce.html or /targets/travel.html path, or an external http(s) URL.",
            },
            url: {
              type: "string",
              format: "uri",
              description:
                "Optional external URL to analyze for inferred tools. The hosted Studio can preview them against a sanitized local snapshot, but cannot inject into the third-party origin.",
            },
          },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: async (args) => {
          const input = inputRecord(args);
          const requestedSite =
            stringValue(input.site).trim() || stringValue(input.url).trim();
          if (requestedSite) {
            const resolution = this.resolveSiteInput(requestedSite);
            if (resolution.kind === "invalid")
              return asJsonValue({
                success: false,
                status: "invalid_arguments",
                message: resolution.message,
              });
            if (resolution.kind === "external") {
              await this.activateExternalTarget(resolution.url);
              const potential = this.potentialTools;
              const external = new URL(resolution.url);
              return asJsonValue({
                target: {
                  id: "external",
                  name: external.hostname,
                  url: resolution.url,
                },
                mode: "preview",
                status: "preview",
                provenance: "inferred",
                execution: "studio_snapshot",
                canCompose: true,
                canGenerate: true,
                canExecute: true,
                livePageInjection: false,
                tools: potential,
                note: "Inferred tools are based on fetched page source and interface evidence. They are ready to compose, generate, and execute against the Studio-owned snapshot. Live third-party page injection needs the optional extension adapter.",
              });
            }
            await this.selectTarget(resolution.id);
          }
          const requested = stringValue(input.target);
          if (
            !requestedSite &&
            (requested === "commerce" || requested === "travel")
          )
            await this.selectTarget(requested);
          if (this.targetScope === "external") {
            const externalUrl = this.targetIdentity.url;
            const potential = this.potentialTools;
            return asJsonValue({
              target: {
                id: "external",
                name: new URL(externalUrl).hostname,
                url: externalUrl,
              },
              mode: "preview",
              status: "preview",
              provenance: "inferred",
              execution: "studio_snapshot",
              canCompose: true,
              canGenerate: true,
              canExecute: true,
              livePageInjection: false,
              tools: potential,
              note: "Inferred tools are based on fetched page source and interface evidence. They are ready to compose, generate, and execute against the Studio-owned snapshot. Live third-party page injection needs the optional extension adapter.",
            });
          }
          return asJsonValue({
            target: this.targetIdentity,
            mode: this.targetMode,
            tools: this.targetTools,
            provenance: this.targetTools.map(discoveryProvenance),
            status: this.targetMode === "native" ? "live" : "preview",
          });
        },
      },
      {
        name: "inspect_tool",
        description:
          "Inspect one discovered native or inferred WebMCP capability and its typed schema.",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string", minLength: 1 } },
          required: ["name"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: (args) => {
          const name = stringValue(inputRecord(args).name);
          const tool =
            this.targetTools.find((candidate) => candidate.name === name) ??
            this.potentialTools.find((candidate) => candidate.name === name);
          const status =
            this.targetScope === "external"
              ? "preview"
              : this.targetMode === "native"
                ? "live"
                : "preview";
          return asJsonValue(
            tool
              ? {
                  found: true,
                  status: this.targetTools.includes(tool)
                    ? status
                    : "potential",
                  provenance: discoveryProvenance(tool),
                  tool,
                }
              : { found: false, name },
          );
        },
      },
      {
        name: "compose_workflow",
        description:
          "Compose an ordered structured workflow from unique discovered native or inferred WebMCP tool names. Inferred workflows remain executable in Studio preview.",
        inputSchema: {
          type: "object",
          properties: {
            primitiveNames: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
            },
          },
          required: ["primitiveNames"],
          additionalProperties: false,
        },
        annotations: {},
        execute: (args) => {
          const names = inputRecord(args).primitiveNames;
          return asJsonValue(this.composeWorkflow(names));
        },
      },
      {
        name: "generate_tool",
        description:
          "Validate, save, and register a composed workflow on Studio's WebMCP context when available. Native and inferred primitives are accepted; inferred workflows execute in the interactive Studio preview.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", pattern: "^[a-z][a-z0-9_]*$" },
            description: { type: "string", minLength: 1 },
            primitiveNames: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
            },
            inputSchema: {
              type: "object",
              description:
                "Optional edited JSON Schema for the generated tool input.",
            },
          },
          required: ["name", "description", "primitiveNames"],
          additionalProperties: false,
        },
        annotations: { destructiveHint: true },
        execute: async (args) =>
          asJsonValue(await this.generateTool(inputRecord(args))),
      },
      {
        name: "list_generated_tools",
        description: "List generated tools registered by this Studio session.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: () =>
          asJsonValue({
            target: this.targetIdentity,
            tools: Array.from(this.generated.values()),
          }),
      },
      {
        name: "execute_workflow",
        description:
          "Execute one generated workflow against the controlled target, or against the Studio-owned snapshot for inferred external tools.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1 },
            input: { type: "object", additionalProperties: true },
          },
          required: ["name"],
          additionalProperties: false,
        },
        annotations: { destructiveHint: true },
        execute: async (args) => {
          const input = inputRecord(args);
          return this.executeGenerated(
            stringValue(input.name),
            input.input ?? {},
          );
        },
      },
    ];
    for (const tool of tools) await this.registerNativeTool(tool);
    this.updateNativeStatus();
  }

  private async registerNativeTool(
    tool: StudioToolRegistration,
    controller: AbortController = this.nativeAbort,
  ): Promise<boolean> {
    if (!this.nativeContext || this.stopped || controller.signal.aborted)
      return false;
    if (this.nativeRegistrations.has(tool.name)) return true;
    if (await nativeModelContextHasTool(this.nativeContext, tool.name)) {
      this.nativeRegistrationFailures.set(
        tool.name,
        `The native WebMCP host already exposes ${tool.name}; Studio left it untouched.`,
      );
      return false;
    }
    try {
      const registration = await registerNativeModelTool(
        this.nativeContext,
        tool,
        { signal: controller.signal },
      );
      if (!registration.registered) {
        this.nativeRegistrationFailures.set(
          tool.name,
          registration.error instanceof Error
            ? registration.error.message
            : "The native WebMCP host rejected the tool.",
        );
        return false;
      }
      if (controller.signal.aborted || this.stopped) {
        this.requestNativeUnregister(tool.name);
        return false;
      }
      this.nativeRegistrations.add(tool.name);
      this.registrationControllers.set(tool.name, controller);
      this.nativeRegistrationFailures.delete(tool.name);
      return true;
    } catch (error) {
      this.nativeRegistrationFailures.set(
        tool.name,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }

  private requestNativeUnregister(name: string): void {
    if (!this.nativeContext?.unregisterTool) return;
    try {
      void Promise.resolve(this.nativeContext.unregisterTool(name)).catch(
        () => undefined,
      );
    } catch {
      // AbortSignal cleanup remains the fallback for hosts without reliable
      // explicit removal.
    }
  }

  private unregisterOwnedNativeTool(
    name: string,
    controller?: AbortController,
  ): void {
    const registeredController = this.registrationControllers.get(name);
    if (
      !this.nativeRegistrations.has(name) ||
      !registeredController ||
      (controller !== undefined && registeredController !== controller)
    )
      return;
    registeredController.abort();
    this.registrationControllers.delete(name);
    this.nativeRegistrations.delete(name);
    this.nativeRegistrationFailures.delete(name);
    this.requestNativeUnregister(name);
  }

  private unregisterAllNativeTools(): void {
    for (const [name, controller] of this.registrationControllers)
      this.unregisterOwnedNativeTool(name, controller);
    this.registrationControllers.clear();
    this.nativeRegistrations.clear();
  }

  /**
   * Mirror the selected controlled page's native primitives onto Studio's
   * own modelContext. This gives an agent looking at the Studio document a
   * direct, typed entry point while keeping execution inside the same-origin
   * target bridge.
   */
  private async registerTargetNativeTools(generation: number): Promise<void> {
    if (!this.nativeContext || !this.targetGenerationActive(generation)) return;

    for (const descriptor of this.nativeTargetTools()) {
      if (!this.targetGenerationActive(generation)) return;
      if (
        STUDIO_TOOL_NAMES.includes(
          descriptor.name as (typeof STUDIO_TOOL_NAMES)[number],
        ) ||
        this.nativeRegistrations.has(descriptor.name) ||
        this.generated.has(descriptor.name)
      )
        continue;

      const controller = new AbortController();
      const ownership: NativeRegistrationOwnership = {
        controller,
        registered: false,
      };
      this.targetNativeRegistrations.set(descriptor.name, ownership);
      const registered = await this.registerNativeTool(
        {
          name: descriptor.name,
          description: descriptor.description,
          inputSchema: cloneJsonSchema(descriptor.inputSchema),
          annotations: { ...descriptor.annotations },
          execute: (input) => this.invokeTarget(descriptor.name, input),
        },
        controller,
      );

      ownership.registered = registered;
      if (this.targetNativeRegistrations.get(descriptor.name) !== ownership)
        continue;
      if (
        !registered ||
        controller.signal.aborted ||
        !this.targetGenerationActive(generation)
      ) {
        this.unregisterTargetNativeRegistration(descriptor.name, ownership);
      }
    }
    if (this.targetGenerationActive(generation)) this.updateNativeStatus();
  }

  private unregisterTargetNativeRegistration(
    name: string,
    ownership: NativeRegistrationOwnership,
  ): void {
    if (this.targetNativeRegistrations.get(name) !== ownership) return;
    this.targetNativeRegistrations.delete(name);
    ownership.controller.abort();
    if (ownership.registered)
      this.unregisterOwnedNativeTool(name, ownership.controller);
    else if (this.registrationControllers.get(name) === ownership.controller)
      this.registrationControllers.delete(name);
  }

  private unregisterTargetNativeTools(): void {
    for (const [name, ownership] of this.targetNativeRegistrations)
      this.unregisterTargetNativeRegistration(name, ownership);
    this.targetNativeRegistrations.clear();
  }

  private storageKey(targetId = this.targetId): string {
    return `${GENERATED_STORAGE_PREFIX}.${targetId}`;
  }

  private sessionStorage(): Storage | null {
    try {
      return this.pageWindow.sessionStorage;
    } catch {
      return null;
    }
  }

  private persistGeneratedTools(): void {
    // External workflows are backed by a URL-specific fetched snapshot and
    // are intentionally session-memory only. Do not store them under the
    // previously selected controlled target's key, where they could be
    // restored as if they were live page workflows after navigation.
    if (this.targetScope === "external") return;
    const storage = this.sessionStorage();
    if (!storage) return;
    try {
      storage.setItem(
        this.storageKey(),
        JSON.stringify(
          Array.from(this.generated.values()).map((tool) => ({
            ...tool,
            native: false,
          })),
        ),
      );
    } catch {
      // Session storage is an optional convenience, not the source of truth.
    }
  }

  private async restoreGeneratedTools(
    generation: number = this.targetGeneration,
  ): Promise<void> {
    const storage = this.sessionStorage();
    if (
      !storage ||
      this.targetTools.length === 0 ||
      !this.targetGenerationActive(generation)
    )
      return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(storage.getItem(this.storageKey()) ?? "null");
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    for (const value of parsed) {
      if (!this.targetGenerationActive(generation)) return;
      if (!isRecord(value)) continue;
      const name = stringValue(value.name).trim().toLowerCase();
      const description = stringValue(value.description).trim();
      const requestedPrimitiveNames = value.primitiveNames;
      const primitiveNames = this.readPrimitiveNames(requestedPrimitiveNames);
      const inputSchema = editableSchema(value.inputSchema);
      const workflowValue = value.workflow;
      const workflow =
        isRecord(workflowValue) && Array.isArray(workflowValue.nodes)
          ? normalizeHostedWorkflow(workflowValue as unknown as Workflow)
          : (workflowValue as Workflow);
      if (
        !/^[a-z][a-z0-9_]*$/.test(name) ||
        !description ||
        !Array.isArray(requestedPrimitiveNames) ||
        primitiveNames.length !== requestedPrimitiveNames.length ||
        primitiveNames.length === 0 ||
        !inputSchema ||
        !isRecord(workflowValue) ||
        !validateWorkflow(workflow, { requireRunnable: true }).valid ||
        this.generated.has(name) ||
        this.nativeRegistrations.has(name) ||
        this.validateGeneratedDefinition(
          name,
          description,
          inputSchema,
          primitiveNames,
          workflow,
        )
      )
        continue;
      const controller = new AbortController();
      const native = await this.registerNativeTool(
        {
          name,
          description,
          inputSchema,
          annotations: {
            destructiveHint: primitiveNames.some((primitive) =>
              targetToolIsMutating(
                this.targetTools.find((tool) => tool.name === primitive),
              ),
            ),
          },
          execute: (input) => this.executeGenerated(name, input),
        },
        controller,
      );
      if (!this.targetGenerationActive(generation)) {
        if (native) this.unregisterOwnedNativeTool(name, controller);
        return;
      }
      this.generated.set(name, {
        name,
        description,
        inputSchema,
        primitiveNames,
        workflow,
        native,
        publication: {
          status: "generated",
          mode: "unavailable",
          message:
            "Re-inject this session tool into the target page to use it there.",
        },
      });
    }
    if (this.generated.size > 0) {
      this.draftNames = [
        ...(this.generated.values().next().value as GeneratedTool)
          .primitiveNames,
      ];
      this.renderGenerated();
      this.updateNativeStatus();
    }
  }

  private unregisterGeneratedTools(): void {
    for (const name of this.generated.keys()) {
      this.unregisterOwnedNativeTool(name);
    }
  }

  private selectTarget(id: TargetId, shouldAnalyze = true): Promise<void> {
    this.analysisRequested = shouldAnalyze;
    if (id === this.targetId && this.targetTools.length > 0) {
      this.renderAll();
      return Promise.resolve();
    }
    this.targetReadyResolver?.();
    this.targetReadyResolver = null;
    this.clearExternalPreviewTimer();
    this.resetExternalPreviewBridge();
    this.cancelPendingRequests(
      "stale_request",
      "The target changed before the previous tool request completed.",
    );
    this.unregisterGeneratedTools();
    this.unregisterTargetNativeTools();
    this.unregisterPageGeneratedTools();
    this.targetId = id;
    this.targetScope = "controlled";
    const generation = ++this.targetGeneration;
    this.targetReadyPromise = new Promise<void>((resolve) => {
      this.targetReadyResolver = resolve;
      this.pageWindow.setTimeout(() => {
        if (this.targetGeneration !== generation) return;
        this.targetReadyResolver = null;
        resolve();
      }, 15_000);
    });
    const config = TARGETS[id];
    this.targetIdentity = { id, name: config.name, url: config.path };
    this.targetTools = [];
    this.targetMode = "preview";
    this.externalPreview = { status: "idle", url: "", message: "" };
    this.executionStatus = null;
    this.selectedNames.clear();
    this.draftNames = [];
    this.generated.clear();
    this.project = createProject(
      id === "commerce" ? "northstar.test" : "skyline.test",
    );
    this.targetFrame.removeAttribute("srcdoc");
    this.targetFrame.removeAttribute("sandbox");
    this.targetFrame.src = config.path;
    this.targetFrame.hidden = false;
    this.hideTargetLoading(true);
    this.renderAll();
    return this.targetReadyPromise;
  }

  private requestTargetTools(): void {
    const message: ParentToTargetMessage = {
      channel: TARGET_BRIDGE_CHANNEL,
      version: TARGET_BRIDGE_VERSION,
      direction: "parent-to-target",
      type: "request-tools",
    };
    const origin = pageOrigin(this.pageWindow);
    if (origin) this.targetFrame.contentWindow?.postMessage(message, origin);
  }

  private async handleTargetMessage(
    event: MessageEvent<unknown>,
  ): Promise<void> {
    if (this.handleExternalPreviewMessage(event)) return;
    const generatedMessage = isGeneratedTargetMessage(event.data)
      ? event.data
      : null;
    if (event.source !== this.targetFrame.contentWindow) return;
    const expectedOrigin = pageOrigin(this.pageWindow);
    if (!expectedOrigin || event.origin !== expectedOrigin) return;
    if (generatedMessage) {
      await this.handleGeneratedTargetMessage(generatedMessage);
      return;
    }
    if (!isTargetToParentMessage(event.data)) return;
    const message = event.data;
    if (message.type === "target-ready") {
      if (message.target.id !== this.targetId) return;
      const generation = this.targetGeneration;
      if (!this.targetGenerationActive(generation)) return;
      this.targetScope = "controlled";
      this.targetIdentity = message.target;
      this.targetMode = message.mode;
      this.targetTools = message.tools.map((tool) => ({
        ...tool,
        inputSchema: cloneJsonSchema(tool.inputSchema),
        annotations: { ...tool.annotations },
      }));
      this.updateProjectDiscoveries();
      await this.registerTargetNativeTools(generation);
      if (!this.targetGenerationActive(generation)) return;
      await this.restoreGeneratedTools(generation);
      if (!this.targetGenerationActive(generation)) return;
      this.targetReadyResolver?.();
      this.targetReadyResolver = null;
      this.hideTargetLoading(false);
      this.targetFrame.hidden = false;
      this.renderAll();
      if (this.analysisRequested)
        this.showSiteMessage(
          `${this.targetIdentity.name}: ${this.targetTools.length} Native WebMCP primitive${this.targetTools.length === 1 ? "" : "s"} discovered${this.targetMode === "native" ? " and live" : " · preview only"}.`,
          false,
        );
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if (
      pending.generation !== this.targetGeneration ||
      pending.frameWindow !== this.targetFrame.contentWindow ||
      pending.toolName !== message.toolName
    )
      return;
    this.pending.delete(message.requestId);
    this.pageWindow.clearTimeout(pending.timer);
    if (message.type === "tool-result") pending.resolve(message.result);
    else if (message.type === "tool-error") pending.reject(message.error);
  }

  private async handleGeneratedTargetMessage(
    message: GeneratedTargetToParentMessage,
  ): Promise<void> {
    if (message.type === "generated-tool-call") {
      const generated = this.generated.get(message.toolName);
      if (!generated) {
        this.postGeneratedMessage({
          channel: TARGET_BRIDGE_CHANNEL,
          version: TARGET_BRIDGE_VERSION,
          direction: "parent-to-target",
          type: "generated-tool-error",
          requestId: message.requestId,
          toolName: message.toolName,
          error: {
            code: "unknown_tool",
            message: `Generated tool ${message.toolName} is not available.`,
          },
        });
        return;
      }
      try {
        const result = await this.executeGenerated(
          generated.name,
          message.args,
        );
        this.postGeneratedMessage({
          channel: TARGET_BRIDGE_CHANNEL,
          version: TARGET_BRIDGE_VERSION,
          direction: "parent-to-target",
          type: "generated-tool-result",
          requestId: message.requestId,
          toolName: message.toolName,
          result,
        });
      } catch (error) {
        this.postGeneratedMessage({
          channel: TARGET_BRIDGE_CHANNEL,
          version: TARGET_BRIDGE_VERSION,
          direction: "parent-to-target",
          type: "generated-tool-error",
          requestId: message.requestId,
          toolName: message.toolName,
          error: {
            code: "execution_failed",
            message: targetErrorMessage(error),
          },
        });
      }
      return;
    }
    const pending = this.pendingGenerated.get(message.requestId);
    if (!pending) return;
    if (
      pending.generation !== this.targetGeneration ||
      pending.frameWindow !== this.targetFrame.contentWindow ||
      pending.toolName !== message.toolName
    )
      return;
    this.pendingGenerated.delete(message.requestId);
    this.pageWindow.clearTimeout(pending.timer);
    if (message.type === "generated-tool-test-error") {
      pending.reject(message.error);
      return;
    }
    if (message.type === "generated-tool-ready" && !message.registered) {
      pending.reject(
        message.error ?? {
          code: "registration_rejected",
          message: "The target rejected generated-tool registration.",
        },
      );
      return;
    }
    pending.resolve(message);
  }

  private updateProjectDiscoveries(): void {
    const actions: DiscoveredAction[] = this.targetTools.map((tool) => ({
      id: `target-${this.targetId}-${tool.name}`,
      name: tool.name,
      description: tool.description,
      inputSchema: cloneJsonSchema(tool.inputSchema),
      effect: targetToolEffect(tool),
      confidence: tool.confidence ?? 1,
      access: "public",
      status: discoveryProvenance(tool) === "native" ? "observed" : "inferred",
      evidence: (
        tool.evidence ?? [
          { type: "manual" as const, note: "Controlled target descriptor." },
        ]
      ).map((item) => ({
        type: item.type === "dom" ? ("dom" as const) : ("manual" as const),
        url: this.targetIdentity.url,
        observedAt: Date.now(),
        note: item.selector ? `${item.selector}: ${item.note}` : item.note,
      })),
    }));
    this.project = { ...this.project, discoveredActions: actions };
  }

  private invokeTarget(name: string, args: unknown): Promise<JsonValue> {
    const generation = this.targetGeneration;
    const frameWindow = this.targetFrame.contentWindow;
    if (this.stopped || this.targetScope !== "controlled")
      return Promise.reject({
        code: "runtime_stopped",
        message: "The controlled target is no longer active.",
      });
    if (!frameWindow)
      return Promise.reject({
        code: "execution_failed",
        message: "The controlled target is not available.",
      });
    const serialized = asJsonValue(parseArguments(args));
    const requestId = randomId("target-call");
    const message: ParentToTargetMessage = {
      channel: TARGET_BRIDGE_CHANNEL,
      version: TARGET_BRIDGE_VERSION,
      direction: "parent-to-target",
      type: "invoke-tool",
      requestId,
      toolName: name,
      args: serialized,
    };
    return new Promise<JsonValue>((resolve, reject) => {
      const timer = this.pageWindow.setTimeout(() => {
        this.pending.delete(requestId);
        reject({
          code: "execution_failed",
          message: `Target tool ${name} timed out.`,
        });
      }, 15_000);
      this.pending.set(requestId, {
        resolve,
        reject,
        timer,
        toolName: name,
        generation,
        frameWindow,
      });
      if (
        this.stopped ||
        this.targetScope !== "controlled" ||
        generation !== this.targetGeneration ||
        frameWindow !== this.targetFrame.contentWindow
      ) {
        this.pageWindow.clearTimeout(timer);
        this.pending.delete(requestId);
        reject({
          code: "stale_request",
          message: "The target changed before the tool request was sent.",
        });
        return;
      }
      const origin = pageOrigin(this.pageWindow);
      if (!origin) {
        this.pageWindow.clearTimeout(timer);
        this.pending.delete(requestId);
        reject({
          code: "execution_failed",
          message:
            "The Studio origin is opaque; the target bridge is unavailable.",
        });
        return;
      }
      frameWindow.postMessage(message, origin);
    });
  }

  private readPrimitiveNames(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const available = new Set(
      this.workflowToolDescriptors().map((tool) => tool.name),
    );
    return Array.from(
      new Set(
        value.filter(
          (name): name is string =>
            typeof name === "string" && available.has(name),
        ),
      ),
    );
  }

  private unknownPrimitiveNames(value: unknown): string[] {
    if (!Array.isArray(value)) return ["<invalid primitiveNames>"];
    const available = new Set(
      this.workflowToolDescriptors().map((tool) => tool.name),
    );
    return Array.from(
      new Set(
        value.filter(
          (name): name is string =>
            typeof name !== "string" || !available.has(name),
        ),
      ),
    ).map((name) => (typeof name === "string" ? name : "<non-string>"));
  }

  private validateGeneratedDefinition(
    name: string,
    description: string,
    inputSchema: JSONSchema,
    primitiveNames: readonly string[],
    workflow: Workflow,
  ): string | null {
    const workflowCheck = validateWorkflow(workflow, { requireRunnable: true });
    if (!workflowCheck.valid)
      return workflowCheck.issues.map((issue) => issue.message).join(" ");
    const primitiveNodes = workflow.nodes.filter((node) => node.type === "dom");
    const workflowPrimitiveNames = primitiveNodes.map(
      (node) => node.config.capabilityId,
    );
    if (
      primitiveNodes.length !== primitiveNames.length ||
      workflowPrimitiveNames.some(
        (primitive, index) => primitive !== primitiveNames[index],
      )
    )
      return "The workflow steps do not match the selected primitives.";
    if (this.unknownPrimitiveNames(primitiveNames).length > 0)
      return "The workflow contains a primitive that is not available on this target.";
    const inputProperties = schemaProperties(inputSchema);
    const nodeIndex = new Map(
      workflow.nodes.map((node, index) => [node.id, index]),
    );
    for (const [index, node] of primitiveNodes.entries()) {
      const descriptor = this.workflowToolDescriptors().find(
        (tool) => tool.name === node.config.capabilityId,
      );
      const args = node.config.args ?? {};
      for (const key of Object.keys(args)) {
        if (!schemaProperties(descriptor?.inputSchema ?? {})[key])
          return `The workflow passes an unknown ${node.config.capabilityId} argument: ${key}.`;
        const binding = args[key];
        if (binding?.kind === "input") {
          const [inputKey] = binding.path.split(/[.[]/, 1);
          if (!inputKey || !inputProperties[inputKey])
            return `The generated input schema does not declare ${inputKey}.`;
        }
        if (
          binding?.kind === "output" &&
          (nodeIndex.get(binding.nodeId) === undefined ||
            nodeIndex.get(binding.nodeId)! >= nodeIndex.get(node.id)!)
        )
          return `The ${node.config.capabilityId} step references an output that is not available yet.`;
      }
      for (const required of descriptor?.inputSchema.required ?? [])
        if (!args[required])
          return `The ${node.config.capabilityId} step does not bind required input ${required}.`;
      if (index < 0) return "The workflow has no executable primitive steps.";
    }

    const toolId = `generated-${name}`;
    const candidate = {
      ...this.project,
      tools: [
        {
          id: toolId,
          name,
          description,
          inputSchema,
          access: "public" as const,
          enabled: true,
          workflow,
        },
      ],
      editor: {
        ...this.project.editor,
        toolOrder: [toolId],
        selectedToolId: toolId,
      },
    };
    try {
      validateProject(candidate, { requireRunnable: true });
    } catch (error) {
      return error instanceof Error
        ? error.message
        : "The generated tool definition is invalid.";
    }
    return null;
  }

  private composeWorkflow(names: unknown): JsonValue {
    const requested = Array.isArray(names) ? names : [];
    const unknown = this.unknownPrimitiveNames(names);
    const requestedStrings = requested.filter(
      (name): name is string => typeof name === "string",
    );
    const duplicates = duplicateNames(requestedStrings);
    const valid = this.readPrimitiveNames(names);
    const validationMessage =
      unknown.length > 0
        ? `Unknown primitive(s): ${unknown.join(", ")}.`
        : duplicates.length > 0
          ? `A workflow step can appear only once: ${duplicates.join(", ")}.`
          : null;
    if (!validationMessage) this.commitDraftNames(valid);
    const descriptors = this.workflowToolDescriptors();
    const workflow = hostedWorkflow(valid, descriptors);
    const inputSchema = workflowInputSchema(this.targetId, valid, descriptors);
    const definitionMessage =
      validationMessage ??
      this.validateGeneratedDefinition(
        "draft_workflow",
        "Draft workflow",
        inputSchema,
        valid,
        workflow,
      );
    return asJsonValue({
      valid: valid.length > 0 && !definitionMessage,
      primitiveNames: valid,
      inputSchema,
      workflow,
      target: this.targetIdentity.id,
      ...(definitionMessage ? { error: definitionMessage } : {}),
    });
  }

  private async generateFromForm(): Promise<void> {
    const nameInput = optionalElement<HTMLInputElement>(
      this.documentValue,
      "tool-name",
    );
    const descriptionInput = optionalElement<HTMLTextAreaElement>(
      this.documentValue,
      "tool-description",
    );
    const name = stringValue(nameInput?.value).trim().toLowerCase();
    const description = stringValue(descriptionInput?.value).trim();
    this.updateToolNameValidity();
    this.updateToolDescriptionValidity();
    const nameError = toolNameError(name);
    if (nameError) {
      this.showSaveError(nameError, nameInput);
      return;
    }
    const descriptionError = toolDescriptionError(description);
    if (descriptionError) {
      this.showSaveError(descriptionError, descriptionInput);
      return;
    }
    const schemaText = optionalElement<HTMLElement>(
      this.documentValue,
      "tool-schema",
    )?.textContent;
    const result = await this.generateTool({
      name,
      description,
      primitiveNames: this.draftNames,
      inputSchema: schemaText ?? "",
    });
    if (isRecord(result) && result.success === false) {
      this.showSaveError(
        stringValue(result.message, "The tool could not be generated."),
      );
      return;
    }
    const registeredOnStudio = isRecord(result) && result.native === true;
    this.showComposerMessage(
      registeredOnStudio
        ? `Saved ${name} for this session and registered it on Studio WebMCP. Run preview is ready.`
        : `Saved ${name} for this session. Run preview is ready; Studio WebMCP registration is unavailable in this browser.`,
      false,
    );
    this.renderGenerated();
  }

  private async generateTool(
    args: Record<string, unknown>,
  ): Promise<JsonValue> {
    const name = stringValue(args.name).trim().toLowerCase();
    const description = stringValue(args.description).trim();
    const requestedPrimitiveNames = args.primitiveNames ?? this.draftNames;
    const descriptors = this.workflowToolDescriptors();
    const requestedNames = Array.isArray(requestedPrimitiveNames)
      ? requestedPrimitiveNames.filter(
          (value): value is string => typeof value === "string",
        )
      : [];
    const duplicates = duplicateNames(requestedNames);
    const unknown = this.unknownPrimitiveNames(requestedPrimitiveNames);
    const primitiveNames = this.readPrimitiveNames(requestedPrimitiveNames);
    const nameError = toolNameError(name);
    if (nameError)
      return {
        success: false,
        message: nameError,
      };
    if (!description)
      return { success: false, message: "A tool description is required." };
    if (primitiveNames.length === 0)
      return {
        success: false,
        message: "Select at least one discovered tool first.",
      };
    if (unknown.length > 0)
      return {
        success: false,
        message: `Unknown primitive(s): ${unknown.join(", ")}. Discover the target again and choose tools from the library.`,
      };
    if (duplicates.length > 0)
      return {
        success: false,
        message: `A workflow step can appear only once: ${duplicates.join(", ")}.`,
      };
    if (this.generated.has(name) || this.nativeRegistrations.has(name))
      return {
        success: false,
        message: `A tool named ${name} is already registered in this session.`,
      };
    const hasSchemaOverride = args.inputSchema !== undefined;
    const inputSchema = hasSchemaOverride
      ? editableSchema(args.inputSchema)
      : workflowInputSchema(this.targetId, primitiveNames, descriptors);
    if (!inputSchema)
      return {
        success: false,
        message: "The edited input schema must be valid JSON Schema.",
      };
    const workflow = hostedWorkflow(primitiveNames, descriptors);
    const definitionError = this.validateGeneratedDefinition(
      name,
      description,
      inputSchema,
      primitiveNames,
      workflow,
    );
    if (definitionError)
      return {
        success: false,
        message: definitionError,
      };
    const native = await this.registerNativeTool(
      {
        name,
        description,
        inputSchema,
        annotations: {
          destructiveHint: primitiveNames.some((primitive) =>
            targetToolIsMutating(
              descriptors.find((tool) => tool.name === primitive),
            ),
          ),
        },
        execute: (input) => this.executeGenerated(name, input),
      },
      new AbortController(),
    );
    const studioRuntimeMessage = native
      ? "The custom tool is registered on Studio's WebMCP context."
      : "Studio's native WebMCP context is unavailable; Run preview remains executable.";
    const generated: GeneratedTool = {
      name,
      description,
      inputSchema,
      primitiveNames,
      workflow,
      native,
      publication: {
        status: "generated",
        mode: this.targetScope === "external" ? "preview" : "unavailable",
        message:
          this.targetScope === "external"
            ? `Generated from inferred page evidence. ${studioRuntimeMessage} Run preview executes it against the interactive sanitized snapshot. Live injection into a third-party page needs the optional extension adapter.`
            : `${studioRuntimeMessage} Inject it into the selected same-origin target to expose the page-level tool.`,
      },
    };
    this.generated.set(name, generated);
    this.persistGeneratedTools();
    this.draftNames = [...primitiveNames];
    this.renderGenerated();
    this.updateNativeStatus();
    return asJsonValue({
      success: true,
      name,
      description,
      primitiveNames,
      inputSchema,
      workflow,
      native,
      publication: generated.publication,
    });
  }

  private async executeGenerated(
    name: string,
    rawInput: unknown,
  ): Promise<JsonValue> {
    const generated = this.generated.get(name);
    if (!generated)
      return errorResult(name, `Generated tool ${name} is not available.`);
    const input = materializeSchemaDefaults(
      parseArguments(rawInput),
      generated.inputSchema,
    );
    const result = await this.workflowRunner.run(
      {
        id: `generated-${name}`,
        name,
        description: generated.description,
        inputSchema: generated.inputSchema,
        access: "public",
        enabled: true,
        workflow: generated.workflow,
      },
      input,
      {
        revision: this.project.project.revision,
        runtime: {
          executeCapability: async (
            capabilityId,
            args,
          ): Promise<ExecutionResult> => {
            const url = currentPageUrl(this.pageWindow);
            try {
              const output =
                this.targetScope === "external"
                  ? await this.invokeExternalPreview(capabilityId, args)
                  : await this.invokeTarget(capabilityId, args);
              if (
                isRecord(output) &&
                (output.ok === false || output.success === false)
              ) {
                const message =
                  stringValue(output.message) ||
                  stringValue(output.error) ||
                  "The target primitive reported a failure.";
                return {
                  success: false,
                  status: "unsupported_control",
                  urlBefore: url,
                  urlAfter: currentPageUrl(this.pageWindow),
                  navigationOccurred: false,
                  stateChanged: false,
                  warnings: [message],
                  error: { code: "unsupported_control", message },
                };
              }
              return {
                success: true,
                status: "completed",
                urlBefore: url,
                urlAfter: currentPageUrl(this.pageWindow),
                navigationOccurred: false,
                stateChanged: isRecord(output) && output.stateChanged === true,
                result: output,
                warnings: [],
              };
            } catch (error) {
              const message = targetErrorMessage(error);
              const code = targetExecutionCode(error);
              return {
                success: false,
                status: code,
                urlBefore: url,
                urlAfter: currentPageUrl(this.pageWindow),
                navigationOccurred: false,
                stateChanged: false,
                warnings: [message],
                error: { code, message },
              };
            }
          },
        },
      },
    );
    const trace = workflowTrace(generated.workflow, result.trace);
    const stateChanged =
      result.success &&
      (generated.primitiveNames.some((primitive) =>
        targetToolIsMutating(
          this.workflowToolDescriptors().find(
            (tool) => tool.name === primitive,
          ),
        ),
      ) ||
        result.trace.some(
          (entry) =>
            entry.type === "dom" &&
            isRecord(entry.output) &&
            entry.output.stateChanged === true,
        ));
    const navigationOccurred = result.trace.some(
      (entry) =>
        entry.type === "dom" &&
        isRecord(entry.output) &&
        entry.output.navigationOccurred === true,
    );
    const response: Record<string, JsonValue> = {
      success: result.success,
      status: result.status,
      toolName: name,
      stateChanged,
      navigationOccurred,
      warnings: result.warnings,
      trace: asJsonValue(trace),
    };
    if (result.result !== undefined) response.result = result.result;
    if (result.failedNodeId) {
      response.failedTool =
        generated.workflow.nodes.find((node) => node.id === result.failedNodeId)
          ?.type === "dom"
          ? (
              generated.workflow.nodes.find(
                (node) => node.id === result.failedNodeId,
              ) as Extract<Workflow["nodes"][number], { type: "dom" }>
            ).config.capabilityId
          : result.failedNodeId;
    }
    if (!result.success) {
      const message = result.warnings.at(-1) ?? "The workflow failed.";
      response.error = { code: result.status, message };
    }
    const output = asJsonValue(response);
    this.recordExecutionStatus(
      name,
      output,
      generated.primitiveNames.length,
      this.targetScope === "external" || this.targetMode === "preview",
    );
    return output;
  }

  private defaultInputForTarget(generated?: GeneratedTool): JsonValue {
    if (this.targetScope === "external" && generated)
      return previewInputForSchema(generated.inputSchema);
    return this.targetId === "commerce"
      ? {
          requirements: DEFAULT_INPUT.requirements,
          max_price: DEFAULT_INPUT.max_price,
          quantity: DEFAULT_INPUT.quantity,
        }
      : {
          origin: DEFAULT_INPUT.origin,
          destination: DEFAULT_INPUT.destination,
          max_price: 500,
        };
  }

  private renderPotentialTools(): void {
    const list = element<HTMLElement>(this.documentValue, "potential-list");
    list.replaceChildren();
    list.hidden = this.potentialTools.length === 0;
    for (const tool of this.potentialTools) {
      const isNative = discoveryProvenance(tool) === "native";
      const card = this.documentValue.createElement("article");
      card.className = `discovery-card is-potential ${
        isNative ? "is-native-declaration" : "is-inferred"
      }`;
      card.dataset.name = tool.name;
      card.dataset.classification = isNative ? "native" : "inferred";
      card.dataset.provenance = isNative ? "native" : "inferred";
      card.dataset.source = tool.source ?? "unknown";
      card.dataset.draggable = "true";
      card.draggable = true;
      const head = this.documentValue.createElement("div");
      head.className = "discovery-card-head";
      const handle = this.documentValue.createElement("span");
      handle.className = "tool-drag-handle";
      handle.dataset.dragHandle = "true";
      handle.draggable = true;
      handle.setAttribute("aria-hidden", "true");
      handle.title = isNative
        ? "Drag this declared tool to the workflow"
        : "Drag this inferred tool to the workflow as a proposal";
      handle.textContent = "⠿";
      const title = this.documentValue.createElement("div");
      title.className = "discovery-card-title";
      const strong = this.documentValue.createElement("strong");
      strong.textContent = tool.name;
      const description = this.documentValue.createElement("small");
      description.textContent = tool.description;
      title.append(strong, description);
      const source = this.documentValue.createElement("span");
      source.className = "source-pill potential";
      source.textContent = isNative
        ? "Declaration · verify live"
        : "Inferred proposal";
      const classification = this.documentValue.createElement("span");
      classification.className = `classification-badge badge-${
        isNative ? "native" : "inferred"
      }`;
      classification.dataset.classification = isNative ? "native" : "inferred";
      classification.dataset.tone = isNative ? "green" : "yellow";
      classification.textContent = isNative ? "Native" : "Inferred";
      head.append(handle, title, classification, source);
      const details = this.documentValue.createElement("div");
      details.className = "discovery-card-details";
      const status = this.documentValue.createElement("span");
      status.className = "evidence-chip";
      status.textContent = "runs in Studio snapshot preview";
      const confidence = this.documentValue.createElement("span");
      confidence.className = "evidence-chip";
      confidence.textContent = `confidence ${Math.round((tool.confidence ?? 0) * 100)}%`;
      const evidence = this.documentValue.createElement("span");
      evidence.className = "evidence-chip evidence-note";
      evidence.textContent = `evidence ${tool.evidence?.[0]?.note ?? "fetched page evidence"}`;
      const schemaPreview = this.documentValue.createElement("pre");
      schemaPreview.className = "discovery-schema";
      schemaPreview.textContent = text(asJsonValue(tool.inputSchema));
      const add = this.documentValue.createElement("button");
      add.type = "button";
      add.className = "button button-quiet add-primitive";
      add.dataset.action = "add-to-workflow";
      add.dataset.name = tool.name;
      add.disabled = this.draftNames.includes(tool.name);
      add.setAttribute("aria-label", `Add ${tool.name} to workflow`);
      add.textContent = this.draftNames.includes(tool.name)
        ? "Added to workflow"
        : "Add to workflow";
      details.append(status, confidence, evidence, schemaPreview, add);
      card.append(head, details);
      list.append(card);
    }
  }

  private renderAll(): void {
    this.renderTargetMeta();
    this.renderDiscoveries();
    this.renderPotentialTools();
    this.renderComposer();
    this.renderGenerated();
    this.renderExecutionStatus();
    this.renderTargetFallback();
    this.updateComposerEligibility();
  }

  private recordExecutionStatus(
    name: string,
    result: JsonValue | null,
    totalSteps: number,
    previewRun: boolean,
  ): void {
    const successful = isRecord(result) && result.success === true;
    const trace =
      isRecord(result) && Array.isArray(result.trace) ? result.trace : [];
    const completedSteps = trace.filter(
      (entry) => isRecord(entry) && entry.status === "completed",
    ).length;
    const stateChanged = isRecord(result) && result.stateChanged === true;
    const surface = previewRun
      ? this.targetScope === "external"
        ? "interactive snapshot"
        : "controlled target"
      : "live target";
    const stepCount = Math.max(totalSteps, trace.length);
    this.executionStatus = {
      status: successful ? "success" : "error",
      toolName: name,
      completedSteps,
      totalSteps: stepCount,
      stateChanged,
      surface,
      message: successful
        ? `${previewRun ? "Preview" : "WebMCP test"} executed ${name}: ${completedSteps}/${stepCount} steps complete · ${stateChanged ? "target state changed" : "completed without a detected state change"} in the ${surface}.`
        : `${previewRun ? "Preview" : "WebMCP test"} could not complete ${name}: ${completedSteps}/${stepCount} steps complete. Read the error below and retry after fixing the workflow or target state.`,
    };
    this.renderExecutionStatus();
  }

  private renderExecutionStatus(): void {
    const node = optionalElement<HTMLElement>(
      this.documentValue,
      "target-execution-status",
    );
    if (!node) return;
    const summary = this.executionStatus;
    node.hidden = !summary;
    node.className = `preview-execution-status${summary ? ` is-${summary.status}` : ""}`;
    node.textContent = summary?.message ?? "";
  }

  private renderTargetMeta(): void {
    element<HTMLElement>(this.documentValue, "target-site-name").textContent =
      this.targetIdentity.name;
    const url =
      this.targetScope === "external"
        ? this.targetIdentity.url
        : (() => {
            try {
              return new URL(
                this.targetIdentity.url,
                this.pageWindow.location.href,
              ).pathname;
            } catch {
              return this.targetIdentity.url;
            }
          })();
    element<HTMLElement>(this.documentValue, "target-site-url").textContent =
      url;
    const live = element<HTMLElement>(this.documentValue, "target-live-label");
    live.textContent =
      this.targetScope === "external"
        ? "external"
        : this.targetMode === "native"
          ? "native"
          : "preview";
    live.classList.toggle(
      "is-live",
      this.targetScope === "controlled" && this.targetMode === "native",
    );
    const dot = optionalElement<HTMLElement>(
      this.documentValue,
      "target-site-dot",
    );
    dot?.classList.toggle(
      "is-live",
      this.targetScope === "controlled" && this.targetTools.length > 0,
    );
    const targetLabel = optionalElement<HTMLElement>(
      this.documentValue,
      "target-preview-label",
    );
    if (targetLabel)
      targetLabel.textContent =
        this.targetScope === "controlled"
          ? "controlled target"
          : this.externalPreview.status === "snapshot"
            ? "interactive snapshot"
            : "external preview";
    this.targetFrame.title =
      this.targetScope === "controlled"
        ? "Live controlled target website"
        : this.externalPreview.status === "snapshot"
          ? "Interactive external site snapshot"
          : "External site preview";
  }

  private renderTargetFallback(): void {
    const fallback = optionalElement<HTMLElement>(
      this.documentValue,
      "target-frame-fallback",
    );
    if (!fallback) return;
    const blocked =
      this.targetScope === "external" &&
      this.externalPreview.status === "blocked";
    fallback.hidden = !blocked;
    if (!blocked) return;
    const title = optionalElement<HTMLElement>(
      this.documentValue,
      "target-frame-fallback-title",
    );
    const copy = optionalElement<HTMLElement>(
      this.documentValue,
      "target-frame-fallback-copy",
    );
    const link = optionalElement<HTMLAnchorElement>(
      this.documentValue,
      "target-open-link",
    );
    if (title) title.textContent = "This site blocks an embedded preview";
    if (copy)
      copy.textContent =
        this.externalPreview.message ||
        "Open the external site in a new tab to inspect it directly.";
    if (link) {
      link.href = this.externalPreview.url;
      link.hidden = !this.externalPreview.url;
    }
  }

  private handleTargetFrameLoad(): void {
    if (this.targetScope === "external") {
      // Cross-origin pages cannot answer the Studio bridge. The inspection
      // request decides whether the frame is displayable; never probe it.
      if (this.externalPreview.status === "checking") return;
      this.clearExternalPreviewTimer();
      this.hideTargetLoading(false);
      return;
    }
    this.hideTargetLoading(false);
    this.requestTargetTools();
  }

  private renderDiscoveries(): void {
    const list = element<HTMLElement>(this.documentValue, "discovery-list");
    list.replaceChildren();
    const discoveredTools = this.analysisRequested ? this.targetTools : [];
    const legendNote = this.documentValue.querySelector<HTMLElement>(
      ".discovery-legend .legend-item:nth-child(2) span:last-child",
    );
    if (legendNote)
      legendNote.textContent =
        "Proposed from page evidence; composable and runnable in Studio preview";
    const accessNote = optionalElement<HTMLElement>(
      this.documentValue,
      "discovery-list",
    )?.parentElement?.querySelector<HTMLElement>(
      ".library-access-note span:last-child",
    );
    if (accessNote)
      accessNote.textContent =
        this.targetScope === "external"
          ? "Drag inferred tools to the workflow canvas"
          : "Drag native or inferred tools to the workflow canvas";
    for (const tool of discoveredTools) {
      const isNative = discoveryProvenance(tool) === "native";
      const card = this.documentValue.createElement("article");
      card.className = `discovery-card ${isNative ? "is-native" : "is-inferred"}`;
      card.dataset.name = tool.name;
      card.dataset.classification = isNative ? "native" : "inferred";
      card.dataset.provenance = isNative ? "native" : "inferred";
      card.dataset.source = tool.source ?? "unknown";
      card.dataset.draggable = "true";
      // The card is an HTML5 drag source, while the dedicated handle also
      // provides a precise pointer/touch target that leaves controls usable.
      card.draggable = true;
      card.classList.toggle("is-selected", this.selectedNames.has(tool.name));
      const head = this.documentValue.createElement("div");
      head.className = "discovery-card-head";
      const handle = this.documentValue.createElement("span");
      handle.className = "tool-drag-handle";
      handle.dataset.dragHandle = "true";
      handle.draggable = true;
      handle.setAttribute("aria-hidden", "true");
      handle.title = isNative
        ? "Drag this native tool to the workflow"
        : "Drag this inferred tool to the workflow as a proposal";
      handle.textContent = "⠿";
      head.append(handle);
      const checkbox = this.documentValue.createElement("input");
      checkbox.className = "discovery-check";
      checkbox.type = "checkbox";
      checkbox.checked = this.selectedNames.has(tool.name);
      checkbox.dataset.name = tool.name;
      checkbox.disabled = false;
      checkbox.setAttribute("aria-label", `Select ${tool.name}`);
      const title = this.documentValue.createElement("div");
      title.className = "discovery-card-title";
      const strong = this.documentValue.createElement("strong");
      strong.textContent = tool.name;
      const description = this.documentValue.createElement("small");
      description.textContent = tool.description;
      title.append(strong, description);
      const source = this.documentValue.createElement("span");
      source.className = isNative ? "source-pill" : "source-pill potential";
      source.textContent = isNative
        ? this.targetMode === "native"
          ? "Live WebMCP"
          : "Controlled preview"
        : "Inferred proposal";
      const classification = this.documentValue.createElement("span");
      classification.className = `classification-badge badge-${
        isNative ? "native" : "inferred"
      }`;
      classification.dataset.classification = isNative ? "native" : "inferred";
      classification.dataset.tone = isNative ? "green" : "yellow";
      classification.textContent = isNative ? "Native" : "Inferred";
      head.append(checkbox, title, classification, source);
      const details = this.documentValue.createElement("div");
      details.className = "discovery-card-details";
      const effect = this.documentValue.createElement("span");
      effect.className = "evidence-chip";
      effect.textContent = targetToolIsMutating(tool)
        ? "changes target"
        : "read-only";
      const schema = this.documentValue.createElement("span");
      schema.className = "evidence-chip schema-chip";
      schema.textContent = "typed JSON Schema";
      const confidence = this.documentValue.createElement("span");
      confidence.className = "evidence-chip";
      confidence.textContent = `confidence ${Math.round((tool.confidence ?? 1) * 100)}%`;
      const sourceDetail = this.documentValue.createElement("span");
      sourceDetail.className = "evidence-chip";
      sourceDetail.textContent = `source ${tool.source === "webmcp" ? "WebMCP primitive" : (tool.source ?? "controlled action")}`;
      const evidence = this.documentValue.createElement("span");
      evidence.className = "evidence-chip evidence-note";
      const firstEvidence = tool.evidence?.[0];
      evidence.textContent = firstEvidence
        ? `evidence ${firstEvidence.selector ? `${firstEvidence.selector} · ` : ""}${firstEvidence.note}`
        : "evidence controlled target descriptor";
      const schemaPreview = this.documentValue.createElement("pre");
      schemaPreview.className = "discovery-schema";
      schemaPreview.textContent = text(asJsonValue(tool.inputSchema));
      const add = this.documentValue.createElement("button");
      add.type = "button";
      add.className = "button button-quiet add-primitive";
      add.dataset.action = "add-to-workflow";
      add.dataset.name = tool.name;
      add.disabled = this.draftNames.includes(tool.name);
      add.setAttribute("aria-label", `Add ${tool.name} to workflow`);
      add.textContent = this.draftNames.includes(tool.name)
        ? "Added to workflow"
        : isNative
          ? "Add to workflow"
          : "Add to workflow";
      details.append(
        effect,
        schema,
        confidence,
        sourceDetail,
        evidence,
        schemaPreview,
        add,
      );
      card.append(head, details);
      list.append(card);
    }
    element<HTMLElement>(this.documentValue, "discovery-empty").hidden =
      discoveredTools.length > 0 || this.potentialTools.length > 0;
    const emptyTitle = optionalElement<HTMLElement>(
      this.documentValue,
      "discovery-empty-title",
    );
    const emptyCopy = optionalElement<HTMLElement>(
      this.documentValue,
      "discovery-empty-copy",
    );
    if (this.analysisRequested && this.targetScope === "external") {
      if (emptyTitle) emptyTitle.textContent = "No readable tools found";
      if (emptyCopy)
        emptyCopy.textContent =
          "The fetched page did not expose WebMCP or actionable interface evidence.";
    } else if (this.analysisRequested && discoveredTools.length === 0) {
      if (emptyTitle) emptyTitle.textContent = "No native tools found";
      if (emptyCopy)
        emptyCopy.textContent =
          "This page did not return a live WebMCP tool inventory.";
    } else {
      if (emptyTitle) emptyTitle.textContent = "Nothing analyzed yet";
      if (emptyCopy)
        emptyCopy.textContent = "Enter a domain above to see its tools.";
    }
    const discoveryCount =
      this.targetScope === "external"
        ? `${this.potentialTools.length} inferred`
        : `${discoveredTools.length} found`;
    element<HTMLElement>(this.documentValue, "discovery-count").textContent =
      discoveryCount;
  }

  private renderComposer(): void {
    const flow = element<HTMLOListElement>(this.documentValue, "compose-flow");
    flow.replaceChildren();
    if (this.draftNames.length === 0) {
      const placeholder = this.documentValue.createElement("li");
      placeholder.className = "flow-placeholder";
      placeholder.textContent =
        this.targetScope === "external"
          ? "Drag an inferred tool here to add a step."
          : "Drag a discovered tool from the library to start.";
      flow.append(placeholder);
    } else {
      for (const [index, name] of this.draftNames.entries()) {
        const row = this.documentValue.createElement("li");
        const descriptor = this.workflowToolDescriptors().find(
          (tool) => tool.name === name,
        );
        const isNative = descriptor
          ? discoveryProvenance(descriptor) === "native"
          : false;
        row.className = `flow-discovery${isNative ? "" : " is-inferred"}`;
        row.draggable = true;
        row.dataset.flowIndex = String(index);
        row.dataset.name = name;
        row.dataset.classification = isNative ? "native" : "inferred";
        row.dataset.provenance = isNative ? "native" : "inferred";
        row.dataset.source = descriptor?.source ?? "unknown";
        const handle = this.documentValue.createElement("span");
        handle.className = "flow-drag-handle";
        handle.dataset.dragHandle = "true";
        handle.draggable = true;
        handle.setAttribute("aria-hidden", "true");
        handle.title = "Drag to reorder this workflow step";
        handle.textContent = "⠿";
        const content = this.documentValue.createElement("div");
        const strong = this.documentValue.createElement("strong");
        strong.textContent = name;
        const small = this.documentValue.createElement("small");
        small.textContent =
          index === 0 ? "starts the workflow" : "receives the previous result";
        content.append(strong, small);
        const actions = this.documentValue.createElement("div");
        actions.className = "flow-actions";
        const controls: Array<[string, string, boolean]> = [
          ["move-step-up", "Move earlier", index === 0],
          [
            "move-step-down",
            "Move later",
            index === this.draftNames.length - 1,
          ],
          ["remove-step", "Remove from flow", false],
        ];
        for (const [action, label, disabled] of controls) {
          const button = this.documentValue.createElement("button");
          button.type = "button";
          button.dataset.action = action;
          button.dataset.name = name;
          button.dataset.flowIndex = String(index);
          button.disabled = disabled;
          button.title = label;
          button.setAttribute("aria-label", `${label}: ${name}`);
          button.textContent =
            action === "remove-step"
              ? "×"
              : action === "move-step-up"
                ? "↑"
                : "↓";
          actions.append(button);
        }
        row.append(handle, content, actions);
        flow.append(row);
      }
    }
    const callout = optionalElement<HTMLElement>(
      this.documentValue,
      "compose-flow",
    )?.parentElement?.querySelector<HTMLElement>(
      ".dropzone-callout span:last-child",
    );
    if (callout)
      callout.textContent =
        this.targetScope === "external"
          ? "Drop an inferred tool to add a step"
          : "Drop a discovered tool to add a step";
    element<HTMLElement>(this.documentValue, "flow-count").textContent =
      `${this.draftNames.length} step${this.draftNames.length === 1 ? "" : "s"}`;
    const descriptors = this.workflowToolDescriptors();
    element<HTMLElement>(this.documentValue, "tool-schema").textContent = text(
      asJsonValue(
        workflowInputSchema(this.targetId, this.draftNames, descriptors),
      ),
    );
  }

  private renderGenerated(): void {
    const list = element<HTMLElement>(this.documentValue, "generated-list");
    list.replaceChildren();
    for (const tool of this.generated.values()) {
      const external = this.targetScope === "external";
      const card = this.documentValue.createElement("article");
      card.className = "generated-tool";
      card.dataset.name = tool.name;
      const copy = this.documentValue.createElement("div");
      const name = this.documentValue.createElement("strong");
      name.textContent = tool.name;
      const description = this.documentValue.createElement("p");
      description.textContent = tool.description;
      const meta = this.documentValue.createElement("div");
      meta.className = "generated-tool-meta";
      const mode = this.documentValue.createElement("span");
      mode.className = tool.publication.mode === "native" ? "live" : "";
      mode.textContent = external
        ? tool.native
          ? "Studio WebMCP registered · Run preview"
          : "Studio preview · WebMCP unavailable"
        : tool.publication.mode === "native"
          ? "page WebMCP registered"
          : tool.publication.mode === "preview"
            ? "page preview handler"
            : "awaiting page publication";
      const steps = this.documentValue.createElement("span");
      steps.textContent = `${tool.primitiveNames.length} step${tool.primitiveNames.length === 1 ? "" : "s"}`;
      meta.append(mode, steps);
      const publication = this.documentValue.createElement("span");
      publication.className = `publication-status publication-${tool.publication.status}`;
      publication.textContent = this.publicationLabel(tool.publication);
      meta.append(publication);
      copy.append(name, description, meta);
      const actions = this.documentValue.createElement("div");
      actions.className = "generated-card-actions";
      const inject = this.documentValue.createElement("button");
      inject.className = "button button-secondary test-tool-button";
      inject.type = "button";
      inject.dataset.action = "inject-generated";
      inject.dataset.toolName = tool.name;
      inject.disabled =
        tool.publication.status === "injecting" ||
        tool.publication.status === "testing";
      inject.textContent = external
        ? "Open extension adapter"
        : tool.publication.status === "injected"
          ? "Re-inject"
          : "Inject into page";
      if (external)
        inject.title =
          "Open the live target in a tab, then use the optional WebMCP Studio extension to inspect and inject this saved tool. Run preview works here without the extension.";
      const test = this.documentValue.createElement("button");
      test.className = "button button-primary test-tool-button";
      test.type = "button";
      test.dataset.action = "test-generated";
      test.dataset.toolName = tool.name;
      test.disabled =
        tool.publication.status === "injecting" ||
        tool.publication.status === "testing";
      test.textContent =
        tool.publication.mode === "native" ? "Test WebMCP" : "Run preview";
      actions.append(inject, test);
      card.append(copy, actions);
      if (tool.publication.message) {
        const message = this.documentValue.createElement("small");
        message.className = "publication-message";
        message.textContent = tool.publication.message;
        card.append(message);
      }
      list.append(card);
    }
    if (this.generated.size === 0) {
      const empty = this.documentValue.createElement("div");
      empty.className = "empty-panel compact";
      empty.textContent = "Save a workflow to see it here.";
      list.append(empty);
    }
    const injectedCount = Array.from(this.generated.values()).filter(
      (tool) => tool.publication.status === "injected",
    ).length;
    element<HTMLElement>(this.documentValue, "generated-count").textContent =
      this.generated.size === 0
        ? "0 ready"
        : this.targetScope === "external"
          ? `${this.generated.size} ready`
          : `${injectedCount} injected · ${this.generated.size} ready`;
    const latest =
      Array.from(this.generated.keys()).at(-1) ??
      stringValue(
        element<HTMLInputElement>(this.documentValue, "tool-name").value,
      );
    element<HTMLElement>(this.documentValue, "agent-tool-name").textContent =
      latest || "No saved tool";
    const latestTool = latest ? this.generated.get(latest) : undefined;
    const injectButton = optionalElement<HTMLButtonElement>(
      this.documentValue,
      "inject-button",
    );
    const testButton = optionalElement<HTMLButtonElement>(
      this.documentValue,
      "test-generated-tool",
    );
    if (injectButton) {
      injectButton.disabled =
        !latestTool ||
        latestTool.publication.status === "injecting" ||
        latestTool.publication.status === "testing";
      injectButton.textContent =
        this.targetScope === "external"
          ? "Open extension adapter"
          : "Inject into page";
      if (this.targetScope === "external")
        injectButton.title =
          "Open the live target in a tab, then use the optional WebMCP Studio extension to inspect and inject this saved tool. Run preview works here without the extension.";
    }
    if (testButton) {
      testButton.disabled =
        !latestTool ||
        latestTool.publication.status === "injecting" ||
        latestTool.publication.status === "testing";
      testButton.textContent =
        latestTool?.publication.mode === "native"
          ? "Test WebMCP"
          : "Run preview";
    }
    const help = optionalElement<HTMLElement>(
      this.documentValue,
      "injection-help",
    );
    if (help) {
      help.textContent = latestTool
        ? this.targetScope === "external"
          ? `${latestTool.native ? "Registered on Studio's WebMCP context." : "Native Studio WebMCP is unavailable in this browser; preview remains available."} Run preview executes the workflow against the interactive sanitized snapshot. Open the live target and use the optional extension adapter for real third-party injection.`
          : latestTool.publication.mode === "native"
            ? "Registered on the target page. Test the same WebMCP handler an agent can invoke."
            : "Native WebMCP is unavailable in this browser. Run the controlled preview; it uses the same workflow and visible page effects."
        : "Save a tool first. Its page publication and test actions will appear here.";
    }
    const modeTitle = optionalElement<HTMLElement>(
      this.documentValue,
      "publish-mode-title",
    );
    const modeCopy = optionalElement<HTMLElement>(
      this.documentValue,
      "publish-mode-copy",
    );
    if (modeTitle)
      modeTitle.textContent =
        this.targetScope === "external"
          ? latestTool?.native
            ? "Studio WebMCP + live adapter"
            : "Studio preview + live adapter"
          : "Page WebMCP";
    if (modeCopy)
      modeCopy.textContent =
        this.targetScope === "external"
          ? latestTool?.native
            ? "The generated tool is available to the Studio WebMCP agent. Run preview executes it on an interactive sanitized snapshot; open the live target and use the optional extension adapter for injection."
            : "Run preview executes the generated tool on an interactive sanitized snapshot. Open the live target and use the optional extension adapter for real third-party injection."
          : "Inject the saved tool into the selected target.";
  }

  private publicationLabel(publication: GeneratedPublication): string {
    if (publication.status === "injecting") return "publishing…";
    if (publication.status === "testing") return "running…";
    if (publication.status === "failed") return "needs attention";
    if (publication.status === "injected")
      return publication.mode === "native"
        ? "injected · native"
        : "injected · preview";
    if (publication.status === "generated") return "generated · ready";
    return "draft";
  }

  private updateComposerEligibility(): void {
    const generate = element<HTMLButtonElement>(
      this.documentValue,
      "generate-button",
    );
    // Keep Save enabled so the submit handler can explain every validation
    // failure, including an empty workflow or invalid form fields.
    generate.disabled = false;
  }

  private showComposerMessage(message: string, error: boolean): void {
    const node = element<HTMLElement>(this.documentValue, "composer-message");
    node.setAttribute("role", error ? "alert" : "status");
    node.setAttribute("aria-live", error ? "assertive" : "polite");
    node.setAttribute("aria-atomic", "true");
    node.textContent = message;
    node.classList.toggle("error", error);
    node.classList.toggle("success", !error);
  }

  private showSaveError(
    message: string,
    focusTarget: HTMLElement | null = null,
  ): void {
    this.showComposerMessage(this.actionableSaveError(message), true);
    focusTarget?.focus();
  }

  private actionableSaveError(message: string): string {
    const normalized = message.trim() || "The tool could not be saved.";
    let fix = "Review the tool fields and workflow, then try Save tool again.";
    if (
      /generated tool a name|tool names must|lowercase|stable snake_case/i.test(
        normalized,
      )
    ) {
      fix =
        "Enter a unique name using lowercase letters, numbers, and underscores, starting with a letter.";
    } else if (/description/i.test(normalized)) {
      fix = "Enter a short description that tells an agent what the tool does.";
    } else if (
      /select at least one|no executable primitive|empty workflow/i.test(
        normalized,
      )
    ) {
      fix = "Drag at least one discovered tool into the workflow canvas.";
    } else if (
      /unknown primitive|not available on this target/i.test(normalized)
    ) {
      fix =
        "Remove the unavailable step, or analyze the target again and drag a current tool from the discovery library.";
    } else if (
      /workflow step can appear only once|duplicate/i.test(normalized)
    ) {
      fix = "Remove the duplicate step; each discovered tool may appear once.";
    } else if (/already registered/i.test(normalized)) {
      fix = "Choose a different custom tool name that is not already saved.";
    } else if (/edited input schema|json schema/i.test(normalized)) {
      fix =
        "Restore the generated JSON Schema by rebuilding the workflow, then save again.";
    } else if (
      /workflow steps do not match|workflow definition|workflow contains|cycle|disconnected|completion path|references an output|does not bind|required input|unknown .* argument|does not declare|binding|edge/i.test(
        normalized,
      )
    ) {
      fix =
        "Rebuild the workflow from the discovery library, keep steps ordered, and bind every required input.";
    }
    return `${normalized}${/[.!?]$/.test(normalized) ? "" : "."} Fix: ${fix}`;
  }

  private updateNativeStatus(): void {
    const status = element<HTMLElement>(this.documentValue, "native-status");
    const live = Boolean(
      this.nativeContext &&
      STUDIO_TOOL_NAMES.every((name) => this.nativeRegistrations.has(name)),
    );
    status.classList.toggle("status-checking", false);
    status.classList.toggle("status-live", live);
    status.classList.toggle("status-preview", !live);
    status.textContent = live
      ? "WebMCP live · native tools registered"
      : this.nativeContext && this.nativeRegistrationFailures.size > 0
        ? "Preview only · native registration rejected"
        : "Preview only · native WebMCP unavailable";
    const callout = element<HTMLElement>(
      this.documentValue,
      "agent-callout-title",
    );
    callout.textContent = live
      ? "Registered for a WebMCP agent"
      : "Preview ready for a browser agent";
  }

  private hideTargetLoading(loading: boolean): void {
    element<HTMLElement>(this.documentValue, "target-loading").classList.toggle(
      "is-hidden",
      !loading,
    );
  }
}

function workflowInputSchema(
  targetId: TargetId,
  names: readonly string[],
  descriptors: readonly TargetToolDescriptor[],
): JSONSchema {
  const hasNativeSearchProducts = descriptors.some(
    (tool) =>
      tool.name === "search_products" && discoveryProvenance(tool) === "native",
  );
  if (targetId === "commerce" && hasNativeSearchProducts) {
    return {
      type: "object",
      properties: {
        requirements: {
          type: "string",
          minLength: 1,
          maxLength: 80,
          description: "What the shopper is looking for, such as keyboard.",
        },
        max_price: {
          type: "number",
          minimum: 0,
          maximum: 10000,
          description: "Highest acceptable product price in USD.",
        },
        quantity: {
          type: "integer",
          minimum: 1,
          maximum: 10,
          default: 1,
          description: "Number of matching products to add to the cart.",
        },
      },
      required: ["requirements", "max_price"],
      additionalProperties: false,
    };
  }
  const hasNativeSearchOptions = descriptors.some(
    (tool) =>
      tool.name === "search_options" && discoveryProvenance(tool) === "native",
  );
  if (targetId === "travel" && hasNativeSearchOptions) {
    return {
      type: "object",
      properties: {
        origin: { type: "string", minLength: 1, maxLength: 40 },
        destination: { type: "string", minLength: 1, maxLength: 40 },
        max_price: { type: "number", minimum: 0, maximum: 10000 },
      },
      required: ["origin", "destination", "max_price"],
      additionalProperties: false,
    };
  }
  return buildInputSchema(names, descriptors);
}

function bindingInput(path: string): Binding {
  return { kind: "input", path };
}

function bindingOutput(nodeId: string, path: string): Binding {
  return { kind: "output", nodeId, path };
}

function hostedWorkflow(
  names: readonly string[],
  descriptors: readonly TargetToolDescriptor[],
): Workflow {
  const stepNodes = names.map(
    (primitiveName, index): Workflow["nodes"][number] => {
      const stepId = `step-${index + 1}`;
      const previousId = index > 0 ? `step-${index}` : null;
      const previousName = index > 0 ? names[index - 1] : undefined;
      const bindings: Record<string, Binding> = {};
      const descriptor = descriptors.find(
        (tool) => tool.name === primitiveName,
      );
      const isNativeTargetPrimitive = descriptor?.source === "webmcp";
      const outputFromPrevious = (path: string): Binding | null =>
        previousId ? bindingOutput(previousId, path) : null;
      const bindDescriptorInput = (keys: readonly string[]): void => {
        const key = descriptorInputKey(descriptor, keys);
        if (key) bindings[key] = bindingInput(key);
      };
      const bindDescriptorOutput = (
        keys: readonly string[],
        path: string,
      ): void => {
        const binding = previousId
          ? descriptorOutputBinding(descriptor, keys, previousId, path)
          : null;
        const key = descriptorInputKey(descriptor, keys);
        if (binding && key) bindings[key] = binding;
      };
      if (isNativeTargetPrimitive && primitiveName === "search_products") {
        bindings.query = bindingInput("requirements");
      } else if (primitiveName === "search_products") {
        // Inferred schemas usually retain the page's field name (query/q),
        // while the controlled commerce target exposes the friendlier
        // requirements input above.
        bindDescriptorInput([
          "query",
          "q",
          "search",
          "requirements",
          "keyword",
        ]);
      } else if (
        isNativeTargetPrimitive &&
        primitiveName === "filter_products"
      ) {
        bindings.maxPrice = bindingInput(
          names.includes("search_products") ? "max_price" : "maxPrice",
        );
        if (!names.includes("search_products"))
          bindings.category = bindingInput("category");
      } else if (primitiveName === "filter_products") {
        bindDescriptorInput(["maxPrice", "max_price", "price", "max"]);
        bindDescriptorInput(["category", "type", "department"]);
      } else if (isNativeTargetPrimitive && primitiveName === "get_product") {
        const productId =
          previousName === "get_product"
            ? outputFromPrevious("product.id")
            : previousName === "search_products" ||
                previousName === "filter_products"
              ? outputFromPrevious("products[0].id")
              : null;
        if (productId) bindings.productId = productId;
        else bindings.productId = bindingInput("productId");
      } else if (primitiveName === "get_product") {
        const productPath =
          previousName === "get_product"
            ? "product.id"
            : previousName === "search_products" ||
                previousName === "filter_products"
              ? "products[0].id"
              : null;
        if (productPath)
          bindDescriptorOutput(
            ["productId", "product_id", "id", "sku"],
            productPath,
          );
        else bindDescriptorInput(["productId", "product_id", "id", "sku"]);
      } else if (isNativeTargetPrimitive && primitiveName === "add_to_cart") {
        const productId =
          previousName === "get_product"
            ? outputFromPrevious("product.id")
            : previousName === "search_products" ||
                previousName === "filter_products"
              ? outputFromPrevious("products[0].id")
              : null;
        if (productId) bindings.productId = productId;
        else bindings.productId = bindingInput("productId");
        bindings.quantity = bindingInput("quantity");
      } else if (primitiveName === "add_to_cart") {
        const productPath =
          previousName === "get_product"
            ? "product.id"
            : previousName === "search_products" ||
                previousName === "filter_products"
              ? "products[0].id"
              : null;
        if (productPath)
          bindDescriptorOutput(
            ["productId", "product_id", "itemId", "item_id", "id", "sku"],
            productPath,
          );
        else
          bindDescriptorInput([
            "productId",
            "product_id",
            "itemId",
            "item_id",
            "id",
            "sku",
          ]);
        bindDescriptorInput(["quantity", "count"]);
      } else if (
        isNativeTargetPrimitive &&
        primitiveName === "search_options"
      ) {
        bindings.origin = bindingInput("origin");
        bindings.destination = bindingInput("destination");
      } else if (primitiveName === "search_options") {
        bindDescriptorInput(["origin", "from", "departure"]);
        bindDescriptorInput(["destination", "to", "arrival"]);
      } else if (
        isNativeTargetPrimitive &&
        primitiveName === "filter_options"
      ) {
        const optionIds =
          previousName === "search_options" || previousName === "filter_options"
            ? outputFromPrevious("optionIds")
            : null;
        if (optionIds) bindings.optionIds = optionIds;
        else bindings.optionIds = bindingInput("optionIds");
        bindings.maxPrice = bindingInput(
          names.includes("search_options") ? "max_price" : "maxPrice",
        );
      } else if (primitiveName === "filter_options") {
        if (
          previousName === "search_options" ||
          previousName === "filter_options"
        )
          bindDescriptorOutput(["optionIds", "option_ids", "ids"], "optionIds");
        else bindDescriptorInput(["optionIds", "option_ids", "ids"]);
        bindDescriptorInput(["maxPrice", "max_price", "price", "max"]);
      } else if (isNativeTargetPrimitive && primitiveName === "get_details") {
        const optionId =
          previousName === "get_details" || previousName === "select_option"
            ? outputFromPrevious("optionId")
            : previousName === "search_options" ||
                previousName === "filter_options"
              ? outputFromPrevious("optionIds[0]")
              : null;
        if (optionId) bindings.optionId = optionId;
        else bindings.optionId = bindingInput("optionId");
      } else if (primitiveName === "get_details") {
        const optionPath =
          previousName === "get_details" || previousName === "select_option"
            ? "optionId"
            : previousName === "search_options" ||
                previousName === "filter_options"
              ? "optionIds[0]"
              : null;
        if (optionPath)
          bindDescriptorOutput(
            ["optionId", "option_id", "id", "flightId", "flight_id"],
            optionPath,
          );
        else
          bindDescriptorInput([
            "optionId",
            "option_id",
            "id",
            "flightId",
            "flight_id",
          ]);
      } else if (isNativeTargetPrimitive && primitiveName === "select_option") {
        const optionId =
          previousName === "get_details" || previousName === "select_option"
            ? outputFromPrevious("optionId")
            : previousName === "search_options" ||
                previousName === "filter_options"
              ? outputFromPrevious("optionIds[0]")
              : null;
        if (optionId) bindings.optionId = optionId;
        else bindings.optionId = bindingInput("optionId");
      } else if (primitiveName === "select_option") {
        const optionPath =
          previousName === "get_details" || previousName === "select_option"
            ? "optionId"
            : previousName === "search_options" ||
                previousName === "filter_options"
              ? "optionIds[0]"
              : null;
        if (optionPath)
          bindDescriptorOutput(
            ["optionId", "option_id", "id", "flightId", "flight_id"],
            optionPath,
          );
        else
          bindDescriptorInput([
            "optionId",
            "option_id",
            "id",
            "flightId",
            "flight_id",
          ]);
      }
      for (const key of Object.keys(
        schemaProperties(descriptor?.inputSchema ?? {}),
      )) {
        if (
          isNativeTargetPrimitive &&
          primitiveName === "filter_products" &&
          key === "category" &&
          names.includes("search_products")
        )
          continue;
        if (
          isNativeTargetPrimitive &&
          primitiveName === "filter_options" &&
          key === "cabin" &&
          names.includes("search_options")
        )
          continue;
        if (!bindings[key]) bindings[key] = bindingInput(key);
      }
      return {
        id: stepId,
        type: "dom",
        label: primitiveName,
        position: { x: index * 220, y: 0 },
        config: {
          capabilityId: primitiveName,
          // An explicit empty args object is meaningful. Without it the
          // workflow runtime forwards the generated tool input wholesale,
          // which makes zero-input primitives such as view_cart reject
          // unrelated fields like requirements and max_price.
          args: bindings,
        },
      };
    },
  );
  const returnId = "return-result";
  const returnNode: Workflow["nodes"][number] = {
    id: returnId,
    type: "return",
    label: "Return result",
    position: { x: names.length * 220, y: 0 },
    config:
      stepNodes.length > 0
        ? { value: bindingOutput(stepNodes.at(-1)!.id, "$") }
        : { value: { kind: "literal", value: null } },
  };
  const edges = stepNodes.map((node, index) => ({
    from: node.id,
    to: stepNodes[index + 1]?.id ?? returnId,
    when: "always" as const,
  }));
  return {
    entryNodeId: stepNodes[0]?.id ?? returnId,
    nodes: [...stepNodes, returnNode],
    edges,
  };
}

function normalizeHostedWorkflow(workflow: Workflow): Workflow {
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) => {
      if (node.type !== "dom" || node.config.args !== undefined) return node;
      // Workflows saved before zero-input primitives were made explicit omit
      // args on nodes such as view_cart. Restore them with an empty argument
      // object so legacy sessions do not forward the whole tool input.
      return {
        ...node,
        config: { ...node.config, args: {} },
      };
    }),
  };
}

export function bootHostedStudio(
  options: HostedStudioOptions = {},
): HostedStudio {
  const studio = new HostedStudio(options);
  studio.start();
  return studio;
}

if (
  typeof document !== "undefined" &&
  document.getElementById("target-frame")
) {
  bootHostedStudio();
}
