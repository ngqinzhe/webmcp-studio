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
  nativeModelContext,
  TARGET_BRIDGE_CHANNEL,
  TARGET_BRIDGE_VERSION,
  isTargetToParentMessage,
  type NativeModelContext,
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

const DEFAULT_COMMERCE_FLOW = [
  "search_products",
  "filter_products",
  "get_product",
  "add_to_cart",
];

const DEFAULT_TRAVEL_FLOW = [
  "search_options",
  "filter_options",
  "get_details",
  "select_option",
];

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
  if (!isRecord(parsed) || Array.isArray(parsed)) return null;
  const type = parsed.type;
  if (
    type !== undefined &&
    type !== "object" &&
    type !== "string" &&
    type !== "number" &&
    type !== "integer" &&
    type !== "boolean" &&
    type !== "array" &&
    type !== "null"
  )
    return null;
  return cloneJsonSchema(parsed as JSONSchema);
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
  private readonly generated = new Map<string, GeneratedTool>();
  private readonly workflowRunner = new WorkflowRunner();
  private readonly messageListener: (event: MessageEvent<unknown>) => void;
  private project: ProjectDocument;
  private targetId: TargetId = "commerce";
  private targetMode: TargetRuntimeMode = "preview";
  private targetIdentity: TargetIdentity = {
    id: "commerce",
    name: TARGETS.commerce.name,
    url: TARGETS.commerce.path,
  };
  private targetTools: TargetToolDescriptor[] = [];
  private potentialTools: TargetToolDescriptor[] = [];
  private selectedNames = new Set<string>();
  private draftNames: string[] = [];
  private demoRequested = false;
  private targetReadyResolver: (() => void) | null = null;
  private targetReadyPromise: Promise<void> = Promise.resolve();
  private targetGeneration = 0;

  constructor(options: HostedStudioOptions = {}) {
    this.documentValue = options.document ?? document;
    this.pageWindow =
      options.pageWindow ?? this.documentValue.defaultView ?? window;
    this.targetFrame = element<HTMLIFrameElement>(
      this.documentValue,
      "target-frame",
    );
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
    this.selectTarget("commerce");
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
    this.targetReadyResolver?.();
    this.targetReadyResolver = null;
  }

  private bindUi(): void {
    this.documentValue
      .querySelectorAll<HTMLButtonElement>("[data-target]")
      .forEach((button) => {
        button.addEventListener("click", () => {
          const id = button.dataset.target;
          if (id === "commerce" || id === "travel") this.selectTarget(id);
        });
      });
    element<HTMLButtonElement>(
      this.documentValue,
      "demo-button",
    ).addEventListener("click", () => {
      this.demoRequested = true;
      this.documentValue
        .querySelector(".workspace")
        ?.scrollIntoView({ behavior: "smooth" });
      this.applyDefaultDemoFlow();
    });
    element<HTMLButtonElement>(
      this.documentValue,
      "discover-button",
    ).addEventListener("click", () => this.requestTargetTools());
    element<HTMLButtonElement>(
      this.documentValue,
      "compose-button",
    ).addEventListener("click", () =>
      this.composeWorkflow(Array.from(this.selectedNames)),
    );
    element<HTMLFormElement>(this.documentValue, "tool-form").addEventListener(
      "submit",
      (event) => {
        event.preventDefault();
        void this.generateFromForm();
      },
    );
    element<HTMLFormElement>(
      this.documentValue,
      "external-form",
    ).addEventListener("submit", (event) => {
      event.preventDefault();
      this.showExternalDiscovery();
    });
    element<HTMLElement>(this.documentValue, "discovery-list").addEventListener(
      "change",
      (event) => {
        const input = event.target;
        if (
          !(input instanceof HTMLInputElement) ||
          input.dataset.name === undefined
        )
          return;
        if (input.checked) this.selectedNames.add(input.dataset.name);
        else this.selectedNames.delete(input.dataset.name);
        this.updateComposerEligibility();
      },
    );
    element<HTMLElement>(this.documentValue, "generated-list").addEventListener(
      "click",
      (event) => {
        const button = event.target;
        if (!(button instanceof HTMLButtonElement)) return;
        const name = button.dataset.toolName;
        if (!name) return;
        void this.testGeneratedTool(name);
      },
    );
  }

  private async registerStudioTools(): Promise<void> {
    const tools: StudioToolRegistration[] = [
      {
        name: "discover_site_tools",
        description: "Discover the controlled target page's native primitives.",
        inputSchema: {
          type: "object",
          properties: {
            target: { type: "string", enum: ["commerce", "travel"] },
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
          const externalUrl = stringValue(input.url).trim();
          if (externalUrl) {
            const potential = this.analyzePotentialUrl(externalUrl);
            return asJsonValue({
              target: {
                id: "external",
                name: new URL(externalUrl).hostname,
                url: externalUrl,
              },
              mode: "potential",
              status: "potential",
              tools: potential,
              note: "Potential proposals are based on available URL/interface hints and are not executable without the optional extension adapter.",
            });
          }
          const requested = stringValue(input.target);
          if (requested === "commerce" || requested === "travel")
            await this.selectTarget(requested);
          return asJsonValue({
            target: this.targetIdentity,
            mode: this.targetMode,
            tools: this.targetTools,
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
          return asJsonValue(
            tool
              ? {
                  found: true,
                  status: this.targetTools.includes(tool)
                    ? "live"
                    : "potential",
                  tool,
                }
              : { found: false, name },
          );
        },
      },
      {
        name: "compose_workflow",
        description:
          "Compose an ordered workflow from controlled target primitive names.",
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
          const names = this.readPrimitiveNames(
            inputRecord(args).primitiveNames,
          );
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
      const registration = this.nativeContext.registerTool(tool, {
        signal: controller.signal,
      });
      const registrationResult = await Promise.resolve(registration);
      if (registrationResult === false) {
        this.nativeRegistrationFailures.set(
          tool.name,
          "registerTool returned false.",
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

  private selectTarget(id: TargetId): Promise<void> {
    if (id === this.targetId && this.targetTools.length > 0)
      return Promise.resolve();
    this.targetReadyResolver?.();
    this.targetReadyResolver = null;
    this.unregisterGeneratedTools();
    this.targetId = id;
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
    this.hideTargetLoading(true);
    this.renderAll();
    this.documentValue
      .querySelectorAll<HTMLElement>("[data-target]")
      .forEach((button) => {
        button.classList.toggle("is-active", button.dataset.target === id);
      });
    this.setPipeline("discover");
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
    if (!isTargetToParentMessage(event.data)) return;
    if (event.source !== this.targetFrame.contentWindow) return;
    const expectedOrigin = pageOrigin(this.pageWindow);
    if (!expectedOrigin || event.origin !== expectedOrigin) return;
    const message: TargetToParentMessage = event.data;
    if (message.type === "target-ready") {
      if (message.target.id !== this.targetId) return;
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
      this.renderAll();
      if (this.demoRequested) this.applyDefaultDemoFlow();
      return;
    }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);
    this.pageWindow.clearTimeout(pending.timer);
    if (message.type === "tool-result") pending.resolve(message.result);
    else pending.reject(message.error);
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
      status: "observed",
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
    const available = new Set(this.targetTools.map((tool) => tool.name));
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
    const available = new Set(this.targetTools.map((tool) => tool.name));
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

  private composeWorkflow(names: readonly string[]): JsonValue {
    const unknown = this.unknownPrimitiveNames(names);
    const valid = this.readPrimitiveNames(names);
    this.draftNames = [...valid];
    this.renderComposer();
    this.updateComposerEligibility();
    this.setPipeline(valid.length > 0 ? "compose" : "discover");
    const workflow = hostedWorkflow(valid, this.targetTools);
    const inputSchema = workflowInputSchema(
      this.targetId,
      valid,
      this.targetTools,
    );
    const validationMessage =
      unknown.length > 0
        ? `Unknown primitive(s): ${unknown.join(", ")}.`
        : this.validateGeneratedDefinition(
            "draft_workflow",
            "Draft workflow",
            inputSchema,
            valid,
            workflow,
          );
    return asJsonValue({
      valid: valid.length > 0 && !validationMessage,
      primitiveNames: valid,
      inputSchema,
      workflow,
      target: this.targetIdentity.id,
      ...(validationMessage ? { error: validationMessage } : {}),
    });
  }

  private async generateFromForm(): Promise<void> {
    const name = stringValue(
      element<HTMLInputElement>(this.documentValue, "tool-name").value,
    )
      .trim()
      .toLowerCase();
    const description = stringValue(
      element<HTMLTextAreaElement>(this.documentValue, "tool-description")
        .value,
    ).trim();
    const schemaText = element<HTMLElement>(
      this.documentValue,
      "tool-schema",
    ).textContent;
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
    this.showComposerMessage(`Generated ${name} for this session.`, false);
    this.setPipeline("generate");
    this.renderGenerated();
  }

  private async generateTool(
    args: Record<string, unknown>,
  ): Promise<JsonValue> {
    const name = stringValue(args.name).trim().toLowerCase();
    const description = stringValue(args.description).trim();
    const requestedPrimitiveNames = args.primitiveNames ?? this.draftNames;
    const unknown = this.unknownPrimitiveNames(requestedPrimitiveNames);
    const primitiveNames = this.readPrimitiveNames(requestedPrimitiveNames);
    if (!/^[a-z][a-z0-9_]*$/.test(name))
      return {
        success: false,
        message: "Use a lowercase name such as buy_best_product.",
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
    });
  }

  private async executeGenerated(
    name: string,
    rawInput: unknown,
  ): Promise<JsonValue> {
    const generated = this.generated.get(name);
    if (!generated)
      return errorResult(name, `Generated tool ${name} is not available.`);
    const input = parseArguments(rawInput);
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
    this.renderTrace(trace, output);
    if (result.success) this.setPipeline("execute");
    return output;
  }

  private async testGeneratedTool(name: string): Promise<void> {
    this.setPipeline("test");
    const result = await this.executeGenerated(
      name,
      this.defaultInputForTarget(),
    );
    this.renderTraceFromValue(result);
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

  private applyDefaultDemoFlow(): void {
    if (this.targetTools.length === 0) return;
    const preferred =
      this.targetId === "commerce"
        ? DEFAULT_COMMERCE_FLOW
        : DEFAULT_TRAVEL_FLOW;
    this.selectedNames = new Set(
      preferred.filter((name) =>
        this.targetTools.some((tool) => tool.name === name),
      ),
    );
    this.renderDiscoveries();
    this.composeWorkflow(preferred);
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
      source.textContent = "Potential tool";
      head.append(title, source);
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

  private showExternalDiscovery(): void {
    const input = element<HTMLInputElement>(this.documentValue, "external-url");
    const note = element<HTMLElement>(this.documentValue, "external-note");
    try {
      const url = new URL(input.value.trim());
      this.potentialTools = this.analyzePotentialUrl(url.href);
      this.renderPotentialTools();
      note.textContent = `${url.origin} produced ${this.potentialTools.length} potential proposal${this.potentialTools.length === 1 ? "" : "s"} from URL/interface hints. It is not executable here; hosted Studio will not inject into it.`;
    } catch {
      this.potentialTools = [];
      this.renderPotentialTools();
      note.textContent =
        "Enter an http or https URL to inspect it as potential-only.";
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
    element<HTMLElement>(this.documentValue, "target-tool-count").textContent =
      `${this.targetTools.length} primitive${this.targetTools.length === 1 ? "" : "s"}`;
  }

  private renderDiscoveries(): void {
    const list = element<HTMLElement>(this.documentValue, "discovery-list");
    list.replaceChildren();
    for (const tool of this.targetTools) {
      const card = this.documentValue.createElement("article");
      card.className = "discovery-card";
      card.dataset.name = tool.name;
      card.classList.toggle("is-selected", this.selectedNames.has(tool.name));
      const head = this.documentValue.createElement("div");
      head.className = "discovery-card-head";
      const checkbox = this.documentValue.createElement("input");
      checkbox.className = "discovery-check";
      checkbox.type = "checkbox";
      checkbox.checked = this.selectedNames.has(tool.name);
      checkbox.dataset.name = tool.name;
      checkbox.setAttribute("aria-label", `Select ${tool.name}`);
      const title = this.documentValue.createElement("div");
      title.className = "discovery-card-title";
      const strong = this.documentValue.createElement("strong");
      strong.textContent = tool.name;
      const description = this.documentValue.createElement("small");
      description.textContent = tool.description;
      title.append(strong, description);
      const source = this.documentValue.createElement("span");
      source.className = "source-pill";
      source.textContent =
        this.targetMode === "native" ? "Live WebMCP" : "Live controlled bridge";
      head.append(checkbox, title, source);
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
      details.append(
        effect,
        schema,
        confidence,
        sourceDetail,
        evidence,
        schemaPreview,
      );
      card.append(head, details);
      list.append(card);
    }
    element<HTMLElement>(this.documentValue, "discovery-empty").hidden =
      this.targetTools.length > 0;
    element<HTMLElement>(this.documentValue, "discovery-count").textContent =
      `${this.targetTools.length} found`;
  }

  private renderComposer(): void {
    const flow = element<HTMLOListElement>(this.documentValue, "compose-flow");
    flow.replaceChildren();
    if (this.draftNames.length === 0) {
      const placeholder = this.documentValue.createElement("li");
      placeholder.className = "flow-placeholder";
      placeholder.textContent = "Select primitives above to start composing.";
      flow.append(placeholder);
    } else {
      for (const [index, name] of this.draftNames.entries()) {
        const row = this.documentValue.createElement("li");
        row.className = "flow-discovery";
        row.draggable = true;
        const content = this.documentValue.createElement("div");
        const strong = this.documentValue.createElement("strong");
        strong.textContent = name;
        const small = this.documentValue.createElement("small");
        small.textContent =
          index === 0 ? "starts the workflow" : "receives the previous result";
        content.append(strong, small);
        const remove = this.documentValue.createElement("button");
        remove.type = "button";
        remove.textContent = "×";
        remove.title = "Remove from flow";
        remove.addEventListener("click", () => {
          this.draftNames = this.draftNames.filter(
            (candidate) => candidate !== name,
          );
          this.selectedNames.delete(name);
          this.renderDiscoveries();
          this.renderComposer();
          this.updateComposerEligibility();
        });
        row.append(content, remove);
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
      const copy = this.documentValue.createElement("div");
      const name = this.documentValue.createElement("strong");
      name.textContent = tool.name;
      const description = this.documentValue.createElement("p");
      description.textContent = tool.description;
      const meta = this.documentValue.createElement("div");
      meta.className = "generated-tool-meta";
      const mode = this.documentValue.createElement("span");
      mode.className = tool.native ? "live" : "";
      mode.textContent = tool.native
        ? "live WebMCP registration"
        : "preview handler · native API unavailable";
      const steps = this.documentValue.createElement("span");
      steps.textContent = `${tool.primitiveNames.length} step${tool.primitiveNames.length === 1 ? "" : "s"}`;
      meta.append(mode, steps);
      copy.append(name, description, meta);
      const button = this.documentValue.createElement("button");
      button.className = "button button-secondary test-tool-button";
      button.type = "button";
      button.dataset.toolName = tool.name;
      button.textContent = "Test tool";
      card.append(copy, button);
      list.append(card);
    }
    if (this.generated.size === 0) {
      const empty = this.documentValue.createElement("div");
      empty.className = "empty-panel compact";
      empty.textContent = "Nothing generated yet.";
      list.append(empty);
    }
    const liveCount = Array.from(this.generated.values()).filter(
      (tool) => tool.native,
    ).length;
    element<HTMLElement>(this.documentValue, "generated-count").textContent =
      this.nativeContext
        ? `${liveCount} live`
        : `${this.generated.size} ready · preview only`;
    const latest =
      Array.from(this.generated.keys()).at(-1) ??
      stringValue(
        element<HTMLInputElement>(this.documentValue, "tool-name").value,
        "buy_best_product",
      );
    element<HTMLElement>(this.documentValue, "agent-tool-name").textContent =
      latest;
  }

  private renderTrace(trace: readonly TraceStep[], result: JsonValue): void {
    const list = element<HTMLOListElement>(
      this.documentValue,
      "execution-trace",
    );
    list.replaceChildren();
    for (const step of trace) {
      const row = this.documentValue.createElement("li");
      row.className =
        step.status === "completed" ? "trace-completed" : "trace-failed";
      const icon = this.documentValue.createElement("span");
      icon.className = "trace-icon";
      icon.textContent = step.status === "completed" ? "✓" : "×";
      const name = this.documentValue.createElement("span");
      name.className = "trace-name";
      name.textContent = step.name;
      const kind = this.documentValue.createElement("span");
      kind.className = "trace-kind";
      kind.textContent = step.error ?? "completed";
      row.append(icon, name, kind);
      list.append(row);
    }
    if (trace.length === 0) {
      const empty = this.documentValue.createElement("li");
      empty.className = "trace-empty";
      empty.textContent = "No primitive calls were made.";
      list.append(empty);
    }
    const success = isRecord(result) && result.success === true;
    const status = element<HTMLElement>(this.documentValue, "trace-status");
    status.textContent = success ? "completed" : "failed";
    element<HTMLElement>(this.documentValue, "trace-rail-fill").style.width =
      `${trace.length === 0 ? 0 : Math.round((trace.filter((step) => step.status === "completed").length / trace.length) * 100)}%`;
    const resultBox = element<HTMLElement>(
      this.documentValue,
      "execution-result",
    );
    resultBox.hidden = false;
    resultBox.classList.toggle("error", !success);
    resultBox.textContent = text(result);
  }

  private renderTraceFromValue(value: JsonValue): void {
    const trace =
      isRecord(value) && Array.isArray(value.trace)
        ? value.trace.flatMap((entry): TraceStep[] => {
            if (!isRecord(entry) || typeof entry.name !== "string") return [];
            return [
              {
                name: entry.name,
                status: entry.status === "completed" ? "completed" : "failed",
                ...(isJsonValue(entry.output) ? { output: entry.output } : {}),
                ...(typeof entry.error === "string"
                  ? { error: entry.error }
                  : {}),
              },
            ];
          })
        : [];
    this.renderTrace(trace, value);
  }

  private updateComposerEligibility(): void {
    const hasSelection = this.selectedNames.size > 0;
    const compose = element<HTMLButtonElement>(
      this.documentValue,
      "compose-button",
    );
    compose.disabled = !hasSelection;
    const generate = element<HTMLButtonElement>(
      this.documentValue,
      "generate-button",
    );
    generate.disabled = this.draftNames.length === 0;
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

  private setPipeline(
    step: "discover" | "compose" | "generate" | "test" | "execute",
  ): void {
    const order = ["discover", "compose", "generate", "test", "execute"];
    const current = order.indexOf(step);
    this.documentValue
      .querySelectorAll<HTMLElement>("[data-pipeline-step]")
      .forEach((node) => {
        const index = order.indexOf(node.dataset.pipelineStep ?? "");
        node.classList.toggle("is-active", index === current);
        node.classList.toggle("is-complete", index < current);
      });
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
