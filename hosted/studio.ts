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

interface PendingGeneratedRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: number;
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

interface PendingInvocation {
  resolve: (value: JsonValue) => void;
  reject: (reason: unknown) => void;
  timer: number;
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
    key === "flightId" ||
    key === "optionId" ||
    key === "productIds" ||
    key === "optionIds"
  );
}

function hasProducer(names: readonly string[], index: number): boolean {
  return names
    .slice(0, index)
    .some((name) => /^(search|filter|get_)/.test(name));
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
    const producedByEarlierStep = hasProducer(names, index);
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
  private readonly pending = new Map<string, PendingInvocation>();
  private readonly pendingGenerated = new Map<
    string,
    PendingGeneratedRequest
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
    this.pageWindow.addEventListener("message", this.messageListener);
    this.targetFrame.addEventListener("load", () => {
      this.hideTargetLoading(false);
      this.requestTargetTools();
    });
    this.bindUi();
    void this.registerStudioTools();
    this.updateNativeStatus();
    this.selectTarget("commerce", false);
  }

  stop(): void {
    this.nativeAbort.abort();
    for (const controller of this.registrationControllers.values())
      if (controller !== this.nativeAbort) controller.abort();
    this.pageWindow.removeEventListener("message", this.messageListener);
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
    this.unregisterPageGeneratedTools();
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
    optionalElement<HTMLFormElement>(
      this.documentValue,
      "tool-form",
    )?.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.generateFromForm();
    });
    const discoveryList = optionalElement<HTMLElement>(
      this.documentValue,
      "discovery-list",
    );
    discoveryList?.addEventListener("change", (event) => {
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
    discoveryList?.addEventListener("click", (event) => {
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
    discoveryList?.addEventListener("dragstart", (event) => {
      const target = event.target;
      const card =
        target instanceof Element
          ? target.closest<HTMLElement>(".discovery-card.is-native")
          : null;
      const name = card?.dataset.name;
      if (
        !card ||
        !card.draggable ||
        !name ||
        !this.nativeTargetTools().some((tool) => tool.name === name)
      ) {
        event.preventDefault();
        return;
      }
      this.writeDragPayload(event, { kind: "primitive", name });
    });
    const flow = optionalElement<HTMLElement>(
      this.documentValue,
      "compose-flow",
    );
    const dropzone = flow?.closest<HTMLElement>(".workflow-dropzone") ?? flow;
    dropzone?.addEventListener("dragover", (event) => {
      // DataTransfer payloads can be protected during dragover. Always claim
      // this controlled dropzone, then validate the payload on drop.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    });
    dropzone?.addEventListener("drop", (event) => {
      event.preventDefault();
      const payload = this.dragPayload(event);
      if (!payload) return;
      this.dropPrimitive(payload, event);
    });
    flow?.addEventListener("dragstart", (event) => {
      const target = event.target;
      const row =
        target instanceof Element
          ? target.closest<HTMLElement>("[data-flow-index]")
          : null;
      const index = row?.dataset.flowIndex;
      if (!row || index === undefined) return;
      this.writeDragPayload(event, {
        kind: "workflow",
        name: row.dataset.name ?? "",
        index: Number(index),
      });
    });
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
    optionalElement<HTMLTextAreaElement>(
      this.documentValue,
      "tool-description",
    )?.addEventListener("input", () => this.updateComposerEligibility());
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
        "Use a controlled target for live tools, or any http(s) site for potential-only analysis.";
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
    if (error) input.setAttribute("aria-invalid", "true");
    else input.removeAttribute("aria-invalid");
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
      this.activateExternalTarget(resolution.url);
      if (note)
        note.textContent =
          "Inferred tools are potential-only. Hosted Studio will not inject into an external origin.";
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

  private activateExternalTarget(rawUrl: string): void {
    this.targetReadyResolver?.();
    this.targetReadyResolver = null;
    this.targetGeneration += 1;
    this.unregisterGeneratedTools();
    this.unregisterPageGeneratedTools();
    this.analysisRequested = true;
    this.targetScope = "external";
    this.potentialTools = this.analyzePotentialUrl(rawUrl);
    this.targetTools = [];
    this.targetMode = "preview";
    this.targetIdentity = {
      id: "external",
      name: new URL(rawUrl).hostname,
      url: rawUrl,
    };
    this.selectedNames.clear();
    this.draftNames = [];
    this.generated.clear();
    this.project = createProject(new URL(rawUrl).hostname);
    this.targetFrame.hidden = true;
    this.hideTargetLoading(false);
    this.renderAll();
    this.showSiteMessage(
      `${this.targetIdentity.name}: ${this.potentialTools.length} inferred tool${this.potentialTools.length === 1 ? "" : "s"}. External origins are potential-only here.`,
      false,
    );
  }

  private nativeTargetTools(): TargetToolDescriptor[] {
    return this.targetScope === "controlled"
      ? this.targetTools.filter(
          (tool) => discoveryProvenance(tool) === "native",
        )
      : [];
  }

  private writeDragPayload(
    event: DragEvent,
    payload: { kind: "primitive" | "workflow"; name: string; index?: number },
  ): void {
    if (!event.dataTransfer || !payload.name) return;
    event.dataTransfer.effectAllowed = "move";
    const serialized = JSON.stringify(payload);
    event.dataTransfer.setData("application/x-webmcp-studio", serialized);
    event.dataTransfer.setData("text/plain", serialized);
  }

  private dragPayload(
    event: DragEvent,
  ): { kind: "primitive" | "workflow"; name: string; index?: number } | null {
    const value =
      event.dataTransfer?.getData("application/x-webmcp-studio") ||
      event.dataTransfer?.getData("text/plain");
    if (!value) return null;
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
    payload: { kind: "primitive" | "workflow"; name: string; index?: number },
    event: DragEvent,
  ): void {
    if (!this.nativeTargetTools().some((tool) => tool.name === payload.name)) {
      this.showComposerMessage(
        `${payload.name} is inferred and cannot be composed into a live workflow.`,
        true,
      );
      return;
    }
    const eventTarget = event.target;
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
          event.clientY > bounds.top + bounds.height / 2
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
    if (!this.nativeTargetTools().some((tool) => tool.name === name)) {
      this.showComposerMessage(
        `${name} is inferred and cannot be composed into a live workflow.`,
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
        `Choose live Native primitives only. Unknown or inferred step${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.`,
        true,
      );
      return false;
    }
    this.draftNames = [...names];
    this.selectedNames = new Set(this.draftNames);
    this.renderDiscoveries();
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
    timeoutMs = 15_000,
  ): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const timer = this.pageWindow.setTimeout(() => {
        this.pendingGenerated.delete(requestId);
        reject({
          code: "execution_timeout",
          message: "The target page did not answer the generated-tool request.",
        });
      }, timeoutMs);
      this.pendingGenerated.set(requestId, { resolve, reject, timer });
    });
  }

  private generatedDescriptor(tool: GeneratedTool): TargetToolDescriptor {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: cloneJsonSchema(tool.inputSchema),
      annotations: {
        destructiveHint: tool.primitiveNames.some((primitive) =>
          targetToolIsMutating(
            this.targetTools.find((candidate) => candidate.name === primitive),
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
      this.setPublication(name, {
        status: "failed",
        mode: "unavailable",
        message:
          "External sites are potential-only. Hosted Studio never injects into a third-party origin.",
      });
      this.showComposerMessage(
        "This is a potential tool. Use the optional extension adapter for external-site instrumentation.",
        true,
      );
      return false;
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
    const posted = this.postGeneratedMessage(message);
    if (posted) {
      try {
        const response = await this.waitForGeneratedResponse(requestId);
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
    if (!this.postGeneratedMessage(message))
      throw new Error("The target page test bridge is unavailable.");
    const response = await this.waitForGeneratedResponse(requestId);
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
    if (this.targetScope !== "controlled") {
      this.showComposerMessage(
        "Potential tools cannot be executed by hosted Studio on external sites.",
        true,
      );
      return;
    }
    if (generated.publication.status !== "injected") {
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
    const current = this.generated.get(name);
    if (!current) return;
    this.setPublication(name, {
      ...current.publication,
      status: "testing",
    });
    const input = this.defaultInputForTarget();
    let result: JsonValue | null = null;
    try {
      result = await this.requestPageGeneratedTest(name, input);
    } catch (error) {
      result = await this.invokePageRegistration(name, input);
      if (result === null)
        result = errorResult(name, targetErrorMessage(error));
    }
    const latest = this.generated.get(name);
    if (latest) {
      const succeeded = isRecord(result) && result.success === true;
      this.setPublication(name, {
        ...latest.publication,
        status: succeeded
          ? latest.publication.mode === "unavailable"
            ? "generated"
            : "injected"
          : "failed",
        ...(succeeded
          ? {}
          : {
              message: targetErrorMessage(
                isRecord(result) ? result.error : result,
              ),
            }),
      });
    }
    if (isRecord(result) && result.success === true)
      this.showComposerMessage("Test passed — the target page updated.", false);
    else
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
          "Discover Native WebMCP primitives from a controlled site path, or return clearly labeled Inferred potential tools for an external http(s) site.",
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
                "Optional external URL to analyze as potential-only; it is never made executable by hosted Studio.",
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
              this.activateExternalTarget(resolution.url);
              const potential = this.potentialTools;
              const external = new URL(resolution.url);
              return asJsonValue({
                target: {
                  id: "external",
                  name: external.hostname,
                  url: resolution.url,
                },
                mode: "potential",
                status: "potential",
                provenance: "inferred",
                tools: potential,
                note: "Potential proposals are based on available URL/interface hints and are not executable without the optional extension adapter.",
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
              mode: "potential",
              status: "potential",
              provenance: "inferred",
              tools: potential,
              note: "Potential proposals are based on available URL/interface hints and are not executable without the optional extension adapter.",
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
          "Inspect one controlled target primitive and its typed schema.",
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
              ? "potential"
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
          "Compose an ordered structured workflow from unique Native WebMCP primitive names on the selected controlled target.",
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
          "Validate and register a composed target workflow for this session.",
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
          "Execute one generated workflow against the controlled target.",
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
    if (!this.nativeContext) return false;
    if (this.nativeRegistrations.has(tool.name)) return true;
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
      if (controller.signal.aborted) return false;
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

  private async restoreGeneratedTools(): Promise<void> {
    const storage = this.sessionStorage();
    if (!storage || this.targetTools.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(storage.getItem(this.storageKey()) ?? "null");
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    for (const value of parsed) {
      if (!isRecord(value)) continue;
      const name = stringValue(value.name).trim().toLowerCase();
      const description = stringValue(value.description).trim();
      const requestedPrimitiveNames = value.primitiveNames;
      const primitiveNames = this.readPrimitiveNames(requestedPrimitiveNames);
      const inputSchema = editableSchema(value.inputSchema);
      const workflowValue = value.workflow;
      const workflow = workflowValue as Workflow;
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
      this.registrationControllers.get(name)?.abort();
      this.registrationControllers.delete(name);
      this.nativeRegistrations.delete(name);
      this.nativeRegistrationFailures.delete(name);
      if (this.nativeContext?.unregisterTool) {
        try {
          void Promise.resolve(this.nativeContext.unregisterTool(name)).catch(
            () => undefined,
          );
        } catch {
          // Older hosts may expose registration without explicit removal.
        }
      }
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
    this.unregisterGeneratedTools();
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
    this.selectedNames.clear();
    this.draftNames = [];
    this.generated.clear();
    this.project = createProject(
      id === "commerce" ? "northstar.test" : "skyline.test",
    );
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
      if (this.targetScope !== "controlled") return;
      this.targetScope = "controlled";
      this.targetIdentity = message.target;
      this.targetMode = message.mode;
      this.targetTools = message.tools.map((tool) => ({
        ...tool,
        inputSchema: cloneJsonSchema(tool.inputSchema),
        annotations: { ...tool.annotations },
      }));
      this.updateProjectDiscoveries();
      await this.restoreGeneratedTools();
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
      this.pending.set(requestId, { resolve, reject, timer });
      const frameWindow = this.targetFrame.contentWindow;
      if (!frameWindow) {
        this.pageWindow.clearTimeout(timer);
        this.pending.delete(requestId);
        reject({
          code: "execution_failed",
          message: "The controlled target is not available.",
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
      this.nativeTargetTools().map((tool) => tool.name),
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
      this.nativeTargetTools().map((tool) => tool.name),
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
      const descriptor = this.targetTools.find(
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
        ? `Unknown or inferred primitive(s): ${unknown.join(", ")}.`
        : duplicates.length > 0
          ? `A workflow step can appear only once: ${duplicates.join(", ")}.`
          : null;
    if (!validationMessage) this.commitDraftNames(valid);
    const workflow = hostedWorkflow(valid, this.targetTools);
    const inputSchema = workflowInputSchema(
      this.targetId,
      valid,
      this.targetTools,
    );
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
    const name = stringValue(
      optionalElement<HTMLInputElement>(this.documentValue, "tool-name")?.value,
      "buy_best_product",
    )
      .trim()
      .toLowerCase();
    const description = stringValue(
      optionalElement<HTMLTextAreaElement>(
        this.documentValue,
        "tool-description",
      )?.value,
      "Use the selected page primitives to complete the requested task.",
    ).trim();
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
      this.showComposerMessage(
        stringValue(result.message, "The tool could not be generated."),
        true,
      );
      return;
    }
    this.showComposerMessage(`Saved ${name} for this session.`, false);
    this.renderGenerated();
  }

  private async generateTool(
    args: Record<string, unknown>,
  ): Promise<JsonValue> {
    const name = stringValue(args.name).trim().toLowerCase();
    const description = stringValue(args.description).trim();
    const requestedPrimitiveNames = args.primitiveNames ?? this.draftNames;
    if (this.targetScope !== "controlled")
      return {
        success: false,
        message:
          "External sites are potential-only. Select a same-origin controlled target before generating a live tool.",
      };
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
        message: "Select at least one controlled primitive first.",
      };
    if (unknown.length > 0)
      return {
        success: false,
        message: `Unknown primitive(s): ${unknown.join(", ")}. Discover the target again and choose live primitives.`,
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
      : workflowInputSchema(this.targetId, primitiveNames, this.targetTools);
    if (!inputSchema)
      return {
        success: false,
        message: "The edited input schema must be valid JSON Schema.",
      };
    const workflow = hostedWorkflow(primitiveNames, this.targetTools);
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
              this.targetTools.find((tool) => tool.name === primitive),
            ),
          ),
        },
        execute: (input) => this.executeGenerated(name, input),
      },
      new AbortController(),
    );
    const generated: GeneratedTool = {
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
          "Generated for this session. Publish it to the target page before testing the page-level tool.",
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
              const output = await this.invokeTarget(capabilityId, args);
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
      generated.primitiveNames.some((primitive) =>
        targetToolIsMutating(
          this.targetTools.find((tool) => tool.name === primitive),
        ),
      ) ||
      result.trace.some(
        (entry) =>
          entry.type === "dom" &&
          isRecord(entry.output) &&
          entry.output.stateChanged === true,
      );
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
    return output;
  }

  private defaultInputForTarget(): JsonValue {
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

  private analyzePotentialUrl(rawUrl: string): TargetToolDescriptor[] {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new Error("Only http and https URLs can be analyzed.");
    const fingerprint =
      `${url.hostname}${url.pathname}${url.search}`.toLowerCase();
    const isTravel = /flight|travel|hotel|booking|itinerary|route/.test(
      fingerprint,
    );
    const isCommerce = /shop|store|product|catalog|cart|commerce|price/.test(
      fingerprint,
    );
    const candidates = isTravel
      ? [
          {
            name: "search_options",
            description: "Potentially search routes or stays by trip criteria.",
            inputSchema: {
              type: "object" as const,
              properties: {
                origin: { type: "string" as const },
                destination: { type: "string" as const },
              },
            },
          },
          {
            name: "filter_options",
            description:
              "Potentially filter visible options by price or cabin.",
            inputSchema: {
              type: "object" as const,
              properties: { maxPrice: { type: "number" as const } },
            },
          },
          {
            name: "inspect_option",
            description: "Potentially inspect one route or booking option.",
            inputSchema: {
              type: "object" as const,
              properties: { optionId: { type: "string" as const } },
            },
          },
          {
            name: "select_option",
            description:
              "Potentially select an option for the current itinerary.",
            inputSchema: {
              type: "object" as const,
              properties: { optionId: { type: "string" as const } },
            },
          },
        ]
      : isCommerce
        ? [
            {
              name: "search_products",
              description: "Potentially search a product or catalog listing.",
              inputSchema: {
                type: "object" as const,
                properties: { query: { type: "string" as const } },
              },
            },
            {
              name: "filter_products",
              description:
                "Potentially filter visible products by price or category.",
              inputSchema: {
                type: "object" as const,
                properties: { maxPrice: { type: "number" as const } },
              },
            },
            {
              name: "inspect_product",
              description: "Potentially inspect a product detail view.",
              inputSchema: {
                type: "object" as const,
                properties: { productId: { type: "string" as const } },
              },
            },
            {
              name: "add_to_cart",
              description: "Potentially add a selected product to a cart.",
              inputSchema: {
                type: "object" as const,
                properties: {
                  productId: { type: "string" as const },
                  quantity: { type: "integer" as const, minimum: 1 },
                },
              },
            },
          ]
        : [
            {
              name: "inspect_page",
              description:
                "Potentially inspect the page's visible content and controls.",
              inputSchema: { type: "object" as const, properties: {} },
            },
            {
              name: "search_content",
              description:
                "Potentially search content or results exposed by the page.",
              inputSchema: {
                type: "object" as const,
                properties: { query: { type: "string" as const } },
              },
            },
            {
              name: "select_result",
              description:
                "Potentially select a visible result or action target.",
              inputSchema: {
                type: "object" as const,
                properties: { resultId: { type: "string" as const } },
              },
            },
          ];
    return candidates.map((candidate) => ({
      ...candidate,
      inputSchema: candidate.inputSchema as JSONSchema,
      annotations:
        candidate.name === "add_to_cart" || candidate.name === "select_option"
          ? { destructiveHint: true }
          : { readOnlyHint: true },
      source: "dom" as const,
      confidence: 0.42,
      evidence: [
        {
          type: "manual" as const,
          note: `URL/interface hint from ${url.origin}${url.pathname}; confirm against the live page before use.`,
        },
      ],
    }));
  }

  private renderPotentialTools(): void {
    const list = element<HTMLElement>(this.documentValue, "potential-list");
    list.replaceChildren();
    list.hidden = this.potentialTools.length === 0;
    for (const tool of this.potentialTools) {
      const card = this.documentValue.createElement("article");
      card.className = "discovery-card is-potential";
      card.dataset.name = tool.name;
      card.dataset.classification = "inferred";
      card.dataset.provenance = "inferred";
      const head = this.documentValue.createElement("div");
      head.className = "discovery-card-head";
      const title = this.documentValue.createElement("div");
      title.className = "discovery-card-title";
      const strong = this.documentValue.createElement("strong");
      strong.textContent = tool.name;
      const description = this.documentValue.createElement("small");
      description.textContent = tool.description;
      title.append(strong, description);
      const source = this.documentValue.createElement("span");
      source.className = "source-pill potential";
      source.textContent = "Potential only";
      const classification = this.documentValue.createElement("span");
      classification.className = "classification-badge badge-inferred";
      classification.dataset.classification = "inferred";
      classification.dataset.tone = "yellow";
      classification.textContent = "Inferred";
      head.append(title, classification, source);
      const details = this.documentValue.createElement("div");
      details.className = "discovery-card-details";
      const status = this.documentValue.createElement("span");
      status.className = "evidence-chip";
      status.textContent = "not executable here";
      const confidence = this.documentValue.createElement("span");
      confidence.className = "evidence-chip";
      confidence.textContent = `confidence ${Math.round((tool.confidence ?? 0) * 100)}%`;
      const evidence = this.documentValue.createElement("span");
      evidence.className = "evidence-chip evidence-note";
      evidence.textContent = `evidence ${tool.evidence?.[0]?.note ?? "URL/interface hint"}`;
      const schemaPreview = this.documentValue.createElement("pre");
      schemaPreview.className = "discovery-schema";
      schemaPreview.textContent = text(asJsonValue(tool.inputSchema));
      details.append(status, confidence, evidence, schemaPreview);
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
    this.updateComposerEligibility();
  }

  private renderTargetMeta(): void {
    element<HTMLElement>(this.documentValue, "target-site-name").textContent =
      this.targetIdentity.name;
    const url = (() => {
      try {
        return new URL(this.targetIdentity.url, this.pageWindow.location.href)
          .pathname;
      } catch {
        return this.targetIdentity.url;
      }
    })();
    element<HTMLElement>(this.documentValue, "target-site-url").textContent =
      url;
    const live = element<HTMLElement>(this.documentValue, "target-live-label");
    live.textContent = this.targetMode === "native" ? "native" : "preview";
    live.classList.toggle("is-live", this.targetMode === "native");
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
          : "potential only";
  }

  private renderDiscoveries(): void {
    const list = element<HTMLElement>(this.documentValue, "discovery-list");
    list.replaceChildren();
    const discoveredTools = this.analysisRequested ? this.targetTools : [];
    for (const tool of discoveredTools) {
      const isNative = discoveryProvenance(tool) === "native";
      const card = this.documentValue.createElement("article");
      card.className = `discovery-card ${isNative ? "is-native" : "is-inferred"}`;
      card.dataset.name = tool.name;
      card.dataset.classification = isNative ? "native" : "inferred";
      card.dataset.provenance = isNative ? "native" : "inferred";
      card.draggable = isNative;
      card.classList.toggle("is-selected", this.selectedNames.has(tool.name));
      const head = this.documentValue.createElement("div");
      head.className = "discovery-card-head";
      const checkbox = this.documentValue.createElement("input");
      checkbox.className = "discovery-check";
      checkbox.type = "checkbox";
      checkbox.checked = this.selectedNames.has(tool.name);
      checkbox.dataset.name = tool.name;
      checkbox.disabled = !isNative;
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
      add.disabled = !isNative || this.draftNames.includes(tool.name);
      add.textContent = this.draftNames.includes(tool.name)
        ? "Added to workflow"
        : isNative
          ? "Add to workflow"
          : "Inferred · inspect only";
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
        "Drag a native tool from the discovery library to start.";
      flow.append(placeholder);
    } else {
      for (const [index, name] of this.draftNames.entries()) {
        const row = this.documentValue.createElement("li");
        row.className = "flow-discovery";
        row.draggable = true;
        row.dataset.flowIndex = String(index);
        row.dataset.name = name;
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
        row.append(content, actions);
        flow.append(row);
      }
    }
    element<HTMLElement>(this.documentValue, "flow-count").textContent =
      `${this.draftNames.length} step${this.draftNames.length === 1 ? "" : "s"}`;
    element<HTMLElement>(this.documentValue, "tool-schema").textContent = text(
      asJsonValue(
        workflowInputSchema(this.targetId, this.draftNames, this.targetTools),
      ),
    );
  }

  private renderGenerated(): void {
    const list = element<HTMLElement>(this.documentValue, "generated-list");
    list.replaceChildren();
    for (const tool of this.generated.values()) {
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
      mode.textContent =
        tool.publication.mode === "native"
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
      inject.textContent =
        tool.publication.status === "injected"
          ? "Re-inject"
          : "Inject into page";
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
        : `${injectedCount} injected · ${this.generated.size} ready`;
    const latest =
      Array.from(this.generated.keys()).at(-1) ??
      stringValue(
        element<HTMLInputElement>(this.documentValue, "tool-name").value,
        "buy_best_product",
      );
    element<HTMLElement>(this.documentValue, "agent-tool-name").textContent =
      latest;
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
        ? latestTool.publication.mode === "native"
          ? "Registered on the target page. Test the same WebMCP handler an agent can invoke."
          : "Native WebMCP is unavailable in this browser. Run the controlled preview; it uses the same workflow and visible page effects."
        : "Save a tool first. Its page publication and test actions will appear here.";
    }
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
    const name = optionalElement<HTMLInputElement>(
      this.documentValue,
      "tool-name",
    );
    const description = optionalElement<HTMLTextAreaElement>(
      this.documentValue,
      "tool-description",
    );
    generate.disabled =
      this.draftNames.length === 0 ||
      Boolean(name && toolNameError(name.value)) ||
      Boolean(description && !description.value.trim());
  }

  private showComposerMessage(message: string, error: boolean): void {
    const node = element<HTMLElement>(this.documentValue, "composer-message");
    node.textContent = message;
    node.classList.toggle("error", error);
    node.classList.toggle("success", !error);
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
  if (targetId === "commerce" && names.includes("search_products")) {
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
  if (targetId === "travel" && names.includes("search_options")) {
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
      const outputFromPrevious = (path: string): Binding | null =>
        previousId ? bindingOutput(previousId, path) : null;
      if (primitiveName === "search_products") {
        bindings.query = bindingInput("requirements");
      } else if (primitiveName === "filter_products") {
        bindings.maxPrice = bindingInput(
          names.includes("search_products") ? "max_price" : "maxPrice",
        );
        if (!names.includes("search_products"))
          bindings.category = bindingInput("category");
      } else if (primitiveName === "get_product") {
        const productId =
          previousName === "get_product"
            ? outputFromPrevious("product.id")
            : previousName === "search_products" ||
                previousName === "filter_products"
              ? outputFromPrevious("products[0].id")
              : null;
        if (productId) bindings.productId = productId;
        else bindings.productId = bindingInput("productId");
      } else if (primitiveName === "add_to_cart") {
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
      } else if (primitiveName === "search_options") {
        bindings.origin = bindingInput("origin");
        bindings.destination = bindingInput("destination");
      } else if (primitiveName === "filter_options") {
        const optionIds =
          previousName === "search_options" || previousName === "filter_options"
            ? outputFromPrevious("optionIds")
            : null;
        if (optionIds) bindings.optionIds = optionIds;
        else bindings.optionIds = bindingInput("optionIds");
        bindings.maxPrice = bindingInput(
          names.includes("search_options") ? "max_price" : "maxPrice",
        );
      } else if (primitiveName === "get_details") {
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
        const optionId =
          previousName === "get_details" || previousName === "select_option"
            ? outputFromPrevious("optionId")
            : previousName === "search_options" ||
                previousName === "filter_options"
              ? outputFromPrevious("optionIds[0]")
              : null;
        if (optionId) bindings.optionId = optionId;
        else bindings.optionId = bindingInput("optionId");
      }
      const descriptor = descriptors.find(
        (tool) => tool.name === primitiveName,
      );
      for (const key of Object.keys(
        schemaProperties(descriptor?.inputSchema ?? {}),
      )) {
        if (
          primitiveName === "filter_products" &&
          key === "category" &&
          names.includes("search_products")
        )
          continue;
        if (
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
          ...(Object.keys(bindings).length > 0 ? { args: bindings } : {}),
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
