import {
  ensureModelContext,
  type ExtensionModelContext,
  type ModelContextTool,
} from "../main-world/model-context";
import type {
  ExtensionMessage,
  ExtensionResponse,
} from "../../core/bridge-protocol";
import {
  ProjectCommandStore,
  createActivationApproval,
  createProject,
  discoveriesFromGraph,
  parseProject,
  serializeProject,
  matchesSiteScope,
  validateProjectResult,
  type ProjectCommand,
  type ProjectDocument,
  type ProjectChange,
  type DiscoveredAction,
  type Binding,
  type TestRunSummary,
  type ToolDefinition,
  type WorkflowNode,
  type WorkflowRunResult,
  type WorkflowEdit,
} from "../../core/project";
import { validateWorkflow } from "../../core/workflow";
import type {
  CapabilityGraph,
  ExecutionResult,
  InspectorState,
  JsonValue,
  JSONSchema,
} from "../../core/types";
import type { ObservedRequestPage } from "../../core/project";
import {
  isRuntimeControlState,
  type RuntimeControlMessage,
  type RuntimeControlState,
} from "../control-protocol";

type ExtensionCommand =
  | Exclude<ExtensionMessage, { type: "polyfill:state-update" }>
  | RuntimeControlMessage;

const PROJECT_STORAGE_KEY = "webmcp-studio:studio-draft";

interface ExtensionStorageArea {
  get: (keys?: string | string[]) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
}

function localStorageArea(): ExtensionStorageArea | null {
  try {
    const candidate = (
      globalThis as typeof globalThis & {
        chrome?: { storage?: { local?: unknown } };
      }
    ).chrome?.storage?.local;
    if (!candidate || typeof candidate !== "object") return null;
    const area = candidate as {
      get?: ExtensionStorageArea["get"];
      set?: ExtensionStorageArea["set"];
    };
    if (typeof area.get !== "function" || typeof area.set !== "function")
      return null;
    return {
      get: (keys) => area.get!.call(candidate, keys),
      set: (items) => area.set!.call(candidate, items),
    };
  } catch {
    return null;
  }
}

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
    ([key, item]) => key !== "__proto__" && isJsonValue(item, next),
  );
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "null";
  } catch {
    return "Unable to serialize this value.";
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function required<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Studio markup is missing ${selector}.`);
  return node;
}

function readTabId(): number | undefined {
  const value = new URLSearchParams(window.location.search).get("tabId");
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function graphFromState(value: InspectorState | null): CapabilityGraph | null {
  return value?.graph ?? null;
}

function isExecutionFailureStatus(value: unknown): boolean {
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
  return (
    isRecord(value) &&
    typeof value.success === "boolean" &&
    (value.status === "completed" || isExecutionFailureStatus(value.status)) &&
    typeof value.urlBefore === "string" &&
    typeof value.urlAfter === "string" &&
    typeof value.navigationOccurred === "boolean" &&
    typeof value.stateChanged === "boolean" &&
    Array.isArray(value.warnings) &&
    value.warnings.every((warning) => typeof warning === "string") &&
    (value.result === undefined || isJsonValue(value.result))
  );
}

function isObservedRequestPage(value: unknown): value is ObservedRequestPage {
  return (
    isRecord(value) &&
    typeof value.sessionId === "string" &&
    typeof value.observationId === "string" &&
    Array.isArray(value.entries) &&
    value.entries.length <= 50 &&
    value.entries.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.id === "string" &&
        typeof entry.url === "string" &&
        !entry.url.includes("?") &&
        !entry.url.includes("#") &&
        typeof entry.origin === "string" &&
        typeof entry.path === "string" &&
        !entry.path.includes("?") &&
        !entry.path.includes("#") &&
        (entry.initiatorType === undefined ||
          typeof entry.initiatorType === "string") &&
        typeof entry.observedAt === "number" &&
        Number.isFinite(entry.observedAt),
    ) &&
    (value.nextCursor === undefined || typeof value.nextCursor === "string") &&
    typeof value.captureStartedAt === "number" &&
    Number.isFinite(value.captureStartedAt) &&
    typeof value.available === "boolean"
  );
}

function safePageIdentity(
  page: CapabilityGraph["page"],
): CapabilityGraph["page"] {
  try {
    const url = new URL(page.url);
    return { ...page, url: `${url.origin}${url.pathname}` };
  } catch {
    return { ...page, url: "" };
  }
}

function commandWithTabId(
  command: ExtensionCommand,
  tabId: number | undefined,
): ExtensionCommand {
  return tabId === undefined ? command : { ...command, tabId };
}

function responseIs(value: unknown): value is ExtensionResponse {
  return isRecord(value) && typeof value.ok === "boolean";
}

function nodeNeedsApproval(
  node: WorkflowNode,
  graph: CapabilityGraph | null,
): boolean {
  if (node.type === "http") return node.config.method !== "GET";
  if (node.type !== "dom") return false;
  if (node.config.requiresApproval === true) return true;
  return graph?.capabilities[node.config.capabilityId]?.effect === "mutate";
}

function toolNeedsApproval(
  tool: ToolDefinition,
  graph: CapabilityGraph | null,
): boolean {
  return tool.workflow.nodes.some((node) => nodeNeedsApproval(node, graph));
}

function makeTestRun(
  run: WorkflowRunResult,
  startedAt: number,
): TestRunSummary {
  return {
    id: run.runId,
    toolId: run.toolId,
    revision: run.revision,
    startedAt,
    finishedAt: Date.now(),
    success: run.success,
    status: run.status,
    ...(run.result === undefined ? {} : { result: run.result }),
    trace: run.trace,
  };
}

export class StudioController {
  private readonly tabId = readTabId();
  private store = new ProjectCommandStore(createProject());
  private state: InspectorState | null = null;
  private selectedNodeId: string | null = null;
  private lastRun: WorkflowRunResult | null = null;
  private requestPage: ObservedRequestPage | null = null;
  private requestError: string | null = null;
  private statusMessage =
    "No project yet. Domain entry only prepares discovery; it does not start an agent.";
  private statusKind: "" | "success" | "error" = "";
  private droppedDiscoveryIds: string[] = [];
  private draggedDiscoveryId: string | null = null;
  private draggedFlowIndex: number | null = null;
  private flowDropIndex: number | null = null;
  private flowDropMarker: HTMLElement | null = null;
  private flowDragFrame: number | null = null;
  private pendingFlowDrag: {
    target: HTMLElement | null;
    clientY: number;
  } | null = null;
  private lastDiscoverySignature: string | null = null;
  private discoveriesLoaded = false;
  private captureInFlight = false;
  private readonly refs = {
    stage: required<HTMLElement>("#studio-stage"),
    status: required<HTMLElement>("#studio-status"),
    domain: required<HTMLInputElement>("#studio-domain"),
    outcome: required<HTMLInputElement>("#studio-outcome"),
    session: required<HTMLSelectElement>("#studio-session"),
    newProject: required<HTMLButtonElement>("#studio-new"),
    importButton: required<HTMLButtonElement>("#studio-import"),
    importFile: required<HTMLInputElement>("#studio-import-file"),
    exportButton: required<HTMLButtonElement>("#studio-export"),
    projectForm: required<HTMLFormElement>("#studio-project-form"),
    addTool: required<HTMLButtonElement>("#studio-add-tool"),
    toolList: required<HTMLElement>("#studio-tool-list"),
    canvasTitle: required<HTMLElement>("#studio-canvas-title"),
    revision: required<HTMLElement>("#studio-revision"),
    flow: required<HTMLElement>("#studio-flow"),
    nodeInspector: required<HTMLElement>("#studio-node-inspector"),
    discover: required<HTMLButtonElement>("#studio-discover"),
    test: required<HTMLButtonElement>("#studio-test"),
    approve: required<HTMLButtonElement>("#studio-approve"),
    tabStatus: required<HTMLElement>("#studio-tab-status"),
    connectionCopy: required<HTMLElement>("#studio-connection-copy"),
    approval: required<HTMLElement>("#studio-approval"),
    activity: required<HTMLElement>("#studio-activity"),
    undo: required<HTMLButtonElement>("#studio-undo"),
    controlSummary: required<HTMLElement>("#studio-control-summary"),
    pause: required<HTMLButtonElement>("#studio-pause"),
    takeover: required<HTMLButtonElement>("#studio-takeover"),
    login: required<HTMLButtonElement>("#studio-login"),
    resume: required<HTMLButtonElement>("#studio-resume"),
    disconnect: required<HTMLButtonElement>("#studio-disconnect"),
    refreshRequests: required<HTMLButtonElement>("#studio-refresh-requests"),
    observedRequests: required<HTMLElement>("#studio-observed-requests"),
    pageTitle: required<HTMLElement>("#studio-page-title"),
    domainDisplay: required<HTMLElement>("#studio-domain-display"),
    pageUrl: required<HTMLElement>("#studio-page-url"),
    availability: required<HTMLElement>("#studio-availability"),
    discoveryCount: required<HTMLElement>("#studio-discovery-count"),
    discoveries: required<HTMLElement>("#studio-discoveries"),
    toolName: required<HTMLInputElement>("#studio-tool-name"),
    composeFlow: required<HTMLElement>("#studio-compose-flow"),
    composeHint: required<HTMLElement>("#studio-compose-hint"),
    saveInject: required<HTMLButtonElement>("#studio-save-inject"),
  };

  start(): this {
    this.refs.projectForm.addEventListener("submit", (event) => {
      event.preventDefault();
      this.setSite();
    });
    this.refs.newProject.addEventListener("click", () => {
      this.store.replace(createProject(), "human");
      this.selectedNodeId = null;
      this.setStatus(
        "New draft ready. Enter a domain when you are ready to prepare discovery.",
      );
      this.render();
    });
    this.refs.importButton.addEventListener("click", () =>
      this.refs.importFile.click(),
    );
    this.refs.importFile.addEventListener(
      "change",
      () => void this.importProject(),
    );
    this.refs.exportButton.addEventListener("click", () =>
      this.exportProject(),
    );
    this.refs.addTool.addEventListener("click", () => this.addTool());
    this.refs.discover.addEventListener(
      "click",
      () => void this.captureDiscoveries(),
    );
    this.refs.test.addEventListener(
      "click",
      () => void this.testSelectedTool(true),
    );
    this.refs.approve.addEventListener(
      "click",
      () => void this.activateSelectedTool(),
    );
    this.refs.undo.addEventListener("click", () => this.undo());
    this.refs.pause.addEventListener(
      "click",
      () => void this.sendControl("pause"),
    );
    this.refs.takeover.addEventListener(
      "click",
      () => void this.sendControl("takeover"),
    );
    this.refs.login.addEventListener(
      "click",
      () => void this.sendControl("login"),
    );
    this.refs.resume.addEventListener("click", () => void this.resumeControl());
    this.refs.disconnect.addEventListener(
      "click",
      () => void this.sendControl("disconnect"),
    );
    this.refs.refreshRequests.addEventListener(
      "click",
      () => void this.refreshObservedRequests(),
    );
    this.refs.saveInject.addEventListener(
      "click",
      () => void this.saveAndInject(),
    );
    this.refs.toolName.addEventListener("input", () =>
      this.updateSaveInjectState(),
    );
    this.refs.composeFlow.addEventListener("dragstart", (event) =>
      this.handleFlowDragStart(event),
    );
    this.refs.composeFlow.addEventListener("dragover", (event) =>
      this.handleFlowDragOver(event),
    );
    this.refs.composeFlow.addEventListener("dragleave", (event) =>
      this.handleFlowDragLeave(event),
    );
    this.refs.composeFlow.addEventListener("drop", (event) =>
      this.handleFlowDrop(event),
    );
    this.refs.composeFlow.addEventListener("dragend", () =>
      this.resetFlowDrag(),
    );
    chrome.runtime.onMessage.addListener((message: unknown, sender) => {
      if (!isRecord(message) || message.type !== "polyfill:state-update")
        return;
      const sourceTabId = sender.tab?.id ?? message.tabId;
      if (this.tabId !== undefined && sourceTabId !== this.tabId) return;
      if (isRecord(message.state)) {
        const nextState = message.state as unknown as InspectorState;
        const currentState = this.state;
        // A state-update notification is asynchronous relative to the command
        // response that caused it. An older notification can therefore arrive
        // after an activation response and briefly hide the active snapshot
        // in the Studio UI. Keep the newest tab state, while still accepting
        // newer deactivation/navigation updates.
        if (
          currentState &&
          (nextState.updatedAt < currentState.updatedAt ||
            (nextState.updatedAt === currentState.updatedAt &&
              currentState.activeProject != null &&
              nextState.activeProject === null))
        )
          return;
        this.state = nextState;
        this.requestPage = null;
        this.requestError = null;
        this.render();
        void this.captureDiscoveries(true);
      }
    });
    void this.load();
    this.installWebMcpTools();
    this.render();
    return this;
  }

  private setStatus(
    message: string,
    kind: "" | "success" | "error" = "",
  ): void {
    this.statusMessage = message;
    this.statusKind = kind;
    this.refs.status.className = `studio-status${kind ? ` ${kind}` : ""}`;
    this.refs.status.textContent = message;
  }

  private async load(): Promise<void> {
    const response = await this.send({ type: "polyfill:get-state" });
    if (response.ok && "state" in response) this.state = response.state;
    try {
      const storage = localStorageArea();
      if (!storage) {
        this.render();
        await this.captureDiscoveries(true);
        return;
      }
      const stored = await storage.get(PROJECT_STORAGE_KEY);
      const value = stored[PROJECT_STORAGE_KEY];
      if (typeof value === "string") {
        this.store.replace(parseProject(value), "system");
      } else if (isRecord(value)) {
        this.store.replace(parseProject(JSON.stringify(value)), "system");
      }
    } catch {
      // A private browsing profile may not expose storage to the inspector.
    }
    this.render();
    await this.captureDiscoveries(true);
  }

  private persist(project: ProjectDocument): void {
    const storage = localStorageArea();
    if (!storage) return;
    void storage
      .set({ [PROJECT_STORAGE_KEY]: serializeProject(project) })
      .catch(() => undefined);
  }

  private async send(command: ExtensionCommand): Promise<ExtensionResponse> {
    try {
      const response: unknown = await chrome.runtime.sendMessage(
        commandWithTabId(command, this.tabId),
      );
      return responseIs(response)
        ? (response as ExtensionResponse)
        : { ok: false, error: "The extension returned an invalid response." };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private controlState(): RuntimeControlState | null {
    const value = (
      this.state as (InspectorState & { control?: unknown }) | null
    )?.control;
    return isRuntimeControlState(value) ? value : null;
  }

  private async sendControl(
    action: RuntimeControlMessage["action"],
    sessionVerified?: boolean,
  ): Promise<void> {
    const response = await this.send({
      type: "polyfill:control",
      action,
      ...(sessionVerified === undefined ? {} : { sessionVerified }),
    });
    if (response.ok && "state" in response) {
      this.state = response.state;
      this.requestPage = null;
      this.requestError = null;
      this.setStatus(
        action === "disconnect"
          ? "Disconnected. Draft state is retained, but live tab control and workflow tools are stopped."
          : action === "resume"
            ? "Agent access explicitly resumed for the current tab."
            : action === "login"
              ? "Human login takeover active. Sign in directly in the selected tab, then resume."
              : action === "takeover"
                ? "Human takeover active. Agent actions and workflow tools are stopped."
                : "Agent actions paused.",
        "success",
      );
    } else {
      this.setStatus(
        response.ok
          ? "The extension returned no control state."
          : response.error,
        "error",
      );
    }
    this.render();
  }

  private async resumeControl(): Promise<void> {
    const control = this.controlState();
    const needsSession =
      control?.authentication === "login_required" ||
      control?.authentication === "expired" ||
      this.store
        .get()
        .tools.some((tool) => tool.enabled && tool.access === "authenticated");
    if (needsSession) {
      const confirmed = window.confirm(
        "Confirm that you have signed in directly in the selected tab and that this is the intended account. Studio cannot independently identify the account.",
      );
      if (!confirmed) {
        this.setStatus(
          "Resume cancelled; the protected session remains blocked.",
          "error",
        );
        this.render();
        return;
      }
    }
    await this.sendControl("resume", needsSession ? true : undefined);
  }

  private async refreshObservedRequests(): Promise<void> {
    const response = await this.send({ type: "polyfill:get-state" });
    if (response.ok && "state" in response) this.state = response.state;
    const control = this.controlState();
    if (!control || control.mode === "disconnected") {
      this.requestPage = null;
      this.requestError =
        control?.blocker?.message ?? "No live discovery session is available.";
      this.render();
      return;
    }
    this.refs.refreshRequests.disabled = true;
    try {
      const result = await this.send({
        type: "polyfill:read-observed-requests",
        sessionId: control.sessionId,
      });
      if (result.ok && "requests" in result) {
        this.requestPage = result.requests;
        this.requestError = null;
      } else
        this.requestError = result.ok
          ? "The extension returned no request evidence."
          : result.error;
    } finally {
      this.refs.refreshRequests.disabled = false;
      this.render();
    }
  }

  private discoveryIdentity(project = this.store.get()): {
    sessionId: string;
    observationId: string;
    graph: CapabilityGraph;
    page: CapabilityGraph["page"];
    inScope: boolean;
  } | null {
    const graph = graphFromState(this.state);
    const runtimeGeneration = this.state?.runtimeGeneration;
    if (!graph || !runtimeGeneration || this.tabId === undefined) return null;
    return {
      sessionId: `${runtimeGeneration}:${this.tabId}`,
      observationId: `graph-${graph.version}-${graph.generatedAt}`,
      graph,
      page: safePageIdentity(graph.page),
      inScope: matchesSiteScope(project, graph.page.url),
    };
  }

  private apply(
    command: ProjectCommand,
    source: "human" | "agent" | "system" = "human",
  ): boolean {
    const result = this.store.apply(command, this.store.getRevision(), source);
    if (!result.ok) {
      this.setStatus(result.error, "error");
      this.render();
      return false;
    }
    this.persist(result.project);
    this.setStatus(
      `${result.change.action.replace(/_/g, " ")} · revision ${result.project.project.revision}`,
      "success",
    );
    this.render();
    return true;
  }

  private setSite(): void {
    const domain = this.refs.domain.value.trim();
    if (!domain) {
      this.setStatus(
        "Enter a website domain before creating a project.",
        "error",
      );
      return;
    }
    const project = this.store.get();
    if (
      !project.site.domain &&
      project.tools.length === 0 &&
      project.discoveredActions.length === 0
    ) {
      const next = createProject(domain, this.refs.outcome.value);
      next.site.sessionMode =
        this.refs.session.value === "authenticated"
          ? "authenticated"
          : "public";
      this.store.replace(next, "human");
      this.persist(this.store.get());
      this.setStatus(
        `Project prepared for ${next.site.domain}. Starting discovery remains a human/agent choice.`,
        "success",
      );
      this.render();
      return;
    }
    this.apply({
      type: "set-site",
      domain,
      outcome: this.refs.outcome.value,
      sessionMode:
        this.refs.session.value === "authenticated"
          ? "authenticated"
          : "public",
    });
  }

  private async importProject(): Promise<void> {
    const file = this.refs.importFile.files?.[0];
    if (!file) return;
    try {
      const project = parseProject(await file.text());
      const result = this.store.replace(project, "human");
      if (!result.ok) {
        this.setStatus(result.error, "error");
        return;
      }
      this.persist(result.project);
      this.selectedNodeId = null;
      this.setStatus(
        "Config imported and validated as a draft. Importing never activates it.",
        "success",
      );
    } catch (error) {
      this.setStatus(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    } finally {
      this.refs.importFile.value = "";
      this.render();
    }
  }

  private exportProject(): void {
    try {
      const body = serializeProject(this.store.get());
      const url = URL.createObjectURL(
        new Blob([body], { type: "application/json" }),
      );
      const anchor = element("a");
      anchor.href = url;
      anchor.download = `${this.store.get().site.domain || "webmcp-studio"}-project.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      this.setStatus(
        "Downloaded the canonical project config. It still needs extension import and human activation.",
        "success",
      );
    } catch (error) {
      this.setStatus(
        error instanceof Error ? error.message : String(error),
        "error",
      );
    }
  }

  private addTool(): void {
    if (!this.store.get().site.domain) {
      this.setStatus("Create a site project before adding tools.", "error");
      return;
    }
    this.apply({
      type: "create-tool",
      tool: { name: "new_tool", description: "A draft website workflow." },
    });
  }

  private selectedTool(): ToolDefinition | null {
    const project = this.store.get();
    const selected = project.editor.selectedToolId ?? project.tools[0]?.id;
    return project.tools.find((tool) => tool.id === selected) ?? null;
  }

  private selectTool(toolId: string): void {
    this.selectedNodeId = null;
    this.apply({ type: "select-tool", toolId });
  }

  private addNode(nodeType: WorkflowNode["type"]): void {
    const tool = this.selectedTool();
    if (!tool) {
      this.setStatus("Select a tool before adding a workflow step.", "error");
      return;
    }
    const returnNode = tool.workflow.nodes.find(
      (node) => node.type === "return",
    );
    const previous = returnNode
      ? tool.workflow.nodes[tool.workflow.nodes.length - 2]
      : undefined;
    const command: ProjectCommand = {
      type: "add-node",
      toolId: tool.id,
      nodeType,
      ...(previous ? { afterNodeId: previous.id } : {}),
    };
    const result = this.store.apply(command, this.store.getRevision(), "human");
    if (!result.ok) this.setStatus(result.error, "error");
    else {
      this.persist(result.project);
      this.setStatus(
        `Added ${nodeType} step · revision ${result.project.project.revision}`,
        "success",
      );
    }
    this.render();
  }

  private saveNode(
    node: WorkflowNode,
    label: string,
    configText: string,
  ): void {
    let config: unknown;
    try {
      config = JSON.parse(configText);
    } catch (error) {
      this.setStatus(
        `Node config is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      return;
    }
    if (!isJsonValue(config)) {
      this.setStatus("Node config must contain JSON values only.", "error");
      return;
    }
    this.apply({
      type: "update-node",
      toolId: this.selectedTool()?.id ?? "",
      nodeId: node.id,
      patch: {
        label: label.trim() || node.type,
        config: config as WorkflowNode["config"],
      },
    });
  }

  private removeNode(node: WorkflowNode): void {
    const tool = this.selectedTool();
    if (!tool) return;
    if (tool.workflow.entryNodeId === node.id) {
      this.setStatus("The entry node cannot be removed.", "error");
      return;
    }
    this.apply({ type: "remove-node", toolId: tool.id, nodeId: node.id });
    this.selectedNodeId = null;
  }

  private undo(): void {
    const result = this.store.undo(this.store.getRevision(), "human");
    if (!result.ok) this.setStatus(result.error, "error");
    else {
      this.persist(result.project);
      this.setStatus(
        `Undid the last draft change · revision ${result.project.project.revision}`,
        "success",
      );
    }
    this.render();
  }

  private async captureDiscoveries(automatic = false): Promise<void> {
    if (this.captureInFlight) return;
    this.captureInFlight = true;
    const response = await this.send({ type: "polyfill:get-state" });
    if (response.ok && "state" in response) this.state = response.state;
    const graph = graphFromState(this.state);
    if (!graph) {
      if (!automatic)
        this.setStatus(
          "No live graph is available for the selected tab.",
          "error",
        );
      this.render();
      this.captureInFlight = false;
      return;
    }
    const signature = `${graph.version}:${graph.generatedAt}:${graph.page.url}`;
    if (automatic && signature === this.lastDiscoverySignature) {
      this.render();
      this.captureInFlight = false;
      return;
    }
    if (!this.store.get().site.domain) {
      const hostname = graph.page.hostname || new URL(graph.page.url).hostname;
      if (hostname) {
        const result = this.store.apply(
          { type: "set-site", domain: hostname },
          this.store.getRevision(),
          "system",
        );
        if (result.ok) this.persist(result.project);
      }
    }
    if (!matchesSiteScope(this.store.get(), graph.page.url)) {
      if (!automatic)
        this.setStatus(
          "The current tab is outside the saved site's scope.",
          "error",
        );
      this.render();
      this.captureInFlight = false;
      return;
    }
    const discovery = discoveriesFromGraph(graph);
    const project = this.store.get();
    const existingToolIds = new Set(project.tools.map((tool) => tool.id));
    const hasNewDiscovery = discovery.actions.some(
      (action) =>
        !project.discoveredActions.some((item) => item.id === action.id),
    );
    if (project.site.sessionMode === "authenticated") {
      for (const action of discovery.actions) action.access = "authenticated";
    }
    const applied = this.store.apply(
      { type: "apply-discovery", actions: discovery.actions },
      this.store.getRevision(),
      "human",
    );
    if (!applied.ok) {
      this.setStatus(applied.error, "error");
      this.render();
      this.captureInFlight = false;
      return;
    }
    this.persist(applied.project);
    // Discovery cards are the authoring primitives in this surface. Keep the
    // command layer's suggested draft tools disabled until the human composes
    // and explicitly injects a named flow.
    if (automatic) {
      for (const action of discovery.actions) {
        const suggested = applied.project.tools.find(
          (tool) =>
            !existingToolIds.has(tool.id) &&
            tool.name === this.normalizedToolName(action.name),
        );
        if (suggested?.enabled) {
          const disabled = this.store.apply(
            {
              type: "update-tool",
              toolId: suggested.id,
              patch: { enabled: false },
            },
            this.store.getRevision(),
            "system",
          );
          if (disabled.ok) this.persist(disabled.project);
        }
      }
    }
    if (!automatic || !this.discoveriesLoaded || hasNewDiscovery) {
      this.setStatus(
        `${automatic ? "Automatically captured" : "Captured"} ${discovery.actions.length} discovery${discovery.actions.length === 1 ? "" : "ies"}.`,
        "success",
      );
    }
    this.discoveriesLoaded = true;
    this.lastDiscoverySignature = signature;
    this.requestPage = null;
    this.requestError = null;
    this.render();
    this.captureInFlight = false;
  }

  private addDiscoveryToFlow(discoveryId: string): void {
    const action = this.store
      .get()
      .discoveredActions.find((candidate) => candidate.id === discoveryId);
    if (!action) {
      this.setStatus("That discovery is no longer available.", "error");
      return;
    }
    if (action.status === "blocked" || !action.capability) {
      this.setStatus(
        `${action.name} is blocked and cannot be added to a tool.`,
        "error",
      );
      return;
    }
    if (!this.isDiscoveryAvailable(action)) {
      this.setStatus(
        `${action.name} is not currently available in the selected tab.`,
        "error",
      );
      return;
    }
    this.droppedDiscoveryIds.push(discoveryId);
    this.setStatus(`${action.name} added to the ordered flow.`, "success");
    this.renderFlowComposer();
  }

  private isDiscoveryAvailable(action: DiscoveredAction): boolean {
    const graph = graphFromState(this.state);
    const control = this.controlState();
    const liveAvailable = Boolean(
      graph &&
      matchesSiteScope(this.store.get(), graph.page.url) &&
      control?.mode !== "disconnected" &&
      control?.mode !== "takeover" &&
      control?.mode !== "paused",
    );
    return Boolean(
      liveAvailable &&
      action.status !== "blocked" &&
      action.capability &&
      (action.access === "public" || control?.authentication === "verified"),
    );
  }

  private removeDiscoveryFromFlow(index: number): void {
    this.droppedDiscoveryIds.splice(index, 1);
    this.renderFlowComposer();
  }

  private moveDiscoveryInFlow(index: number, direction: -1 | 1): void {
    const next = index + direction;
    if (index < 0 || next < 0 || next >= this.droppedDiscoveryIds.length)
      return;
    const item = this.droppedDiscoveryIds[index];
    if (!item) return;
    this.droppedDiscoveryIds.splice(index, 1);
    this.droppedDiscoveryIds.splice(next, 0, item);
    this.renderFlowComposer();
  }

  private flowRowFromTarget(target: EventTarget | null): HTMLElement | null {
    return target instanceof Element
      ? target.closest<HTMLElement>(".flow-discovery")
      : null;
  }

  private handleFlowDragStart(event: DragEvent): void {
    const row = this.flowRowFromTarget(event.target);
    const discoveryId = row?.dataset.discoveryId;
    const flowIndex = Number(row?.dataset.flowIndex);
    if (
      !row ||
      !discoveryId ||
      !Number.isInteger(flowIndex) ||
      flowIndex < 0 ||
      this.droppedDiscoveryIds[flowIndex] !== discoveryId
    )
      return;

    this.draggedDiscoveryId = discoveryId;
    this.draggedFlowIndex = flowIndex;
    row.classList.add("dragging");
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", discoveryId);
    }
  }

  private handleFlowDragOver(event: DragEvent): void {
    event.preventDefault();
    if (!this.draggedDiscoveryId) {
      this.refs.composeFlow.classList.add("drop-target");
      return;
    }
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    if (event.target === this.flowDropMarker) return;
    this.pendingFlowDrag = {
      target: this.flowRowFromTarget(event.target),
      clientY: event.clientY,
    };
    this.scheduleFlowDragFeedback();
  }

  private handleFlowDragLeave(event: DragEvent): void {
    const relatedTarget = event.relatedTarget;
    if (
      relatedTarget instanceof Node &&
      this.refs.composeFlow.contains(relatedTarget)
    )
      return;
    this.pendingFlowDrag = null;
    this.removeFlowDropMarker();
  }

  private handleFlowDrop(event: DragEvent): void {
    const discoveryId =
      this.draggedDiscoveryId ?? event.dataTransfer?.getData("text/plain");
    if (!discoveryId) return;
    event.preventDefault();

    if (!this.draggedDiscoveryId) {
      this.addDiscoveryToFlow(discoveryId);
      return;
    }

    const sourceIndex =
      this.draggedFlowIndex ?? this.droppedDiscoveryIds.indexOf(discoveryId);
    if (sourceIndex < 0) {
      this.resetFlowDrag();
      return;
    }
    const target = this.flowRowFromTarget(event.target);
    const targetIndex =
      target && target !== this.flowDropMarker
        ? this.flowInsertIndex(target, event.clientY)
        : (this.flowDropIndex ??
          Math.max(0, this.droppedDiscoveryIds.length - 1));
    this.moveFlowIndexTo(sourceIndex, targetIndex);
    this.resetFlowDrag();
  }

  private flowInsertIndex(target: HTMLElement | null, clientY: number): number {
    const rows = Array.from(
      this.refs.composeFlow.querySelectorAll<HTMLElement>(".flow-discovery"),
    );
    let insertionIndex = rows.length;
    if (target) {
      const targetIndex = rows.indexOf(target);
      if (targetIndex >= 0) {
        const bounds = target.getBoundingClientRect();
        insertionIndex =
          clientY < bounds.top + bounds.height / 2
            ? targetIndex
            : targetIndex + 1;
      }
    }

    const sourceIndex = this.draggedFlowIndex;
    if (
      sourceIndex !== null &&
      sourceIndex >= 0 &&
      sourceIndex < this.droppedDiscoveryIds.length &&
      insertionIndex > sourceIndex
    )
      insertionIndex -= 1;
    return Math.max(
      0,
      Math.min(
        insertionIndex,
        Math.max(0, this.droppedDiscoveryIds.length - 1),
      ),
    );
  }

  private scheduleFlowDragFeedback(): void {
    if (this.flowDragFrame !== null || !this.pendingFlowDrag) return;
    if (typeof window.requestAnimationFrame !== "function") {
      const pending = this.pendingFlowDrag;
      this.updateFlowDropMarker(
        this.flowInsertIndex(pending.target, pending.clientY),
      );
      return;
    }
    this.flowDragFrame = window.requestAnimationFrame(() => {
      this.flowDragFrame = null;
      const pending = this.pendingFlowDrag;
      if (!pending || !this.draggedDiscoveryId) return;
      this.updateFlowDropMarker(
        this.flowInsertIndex(pending.target, pending.clientY),
      );
    });
  }

  private updateFlowDropMarker(index: number): void {
    if (!this.flowDropMarker)
      this.flowDropMarker = element("div", "flow-drop-marker");
    const rows = Array.from(
      this.refs.composeFlow.querySelectorAll<HTMLElement>(".flow-discovery"),
    ).filter((row) => row.dataset.discoveryId !== this.draggedDiscoveryId);
    const boundedIndex = Math.max(0, Math.min(index, rows.length));
    const anchor = rows[boundedIndex];
    if (anchor) this.refs.composeFlow.insertBefore(this.flowDropMarker, anchor);
    else this.refs.composeFlow.append(this.flowDropMarker);
    this.flowDropIndex = boundedIndex;
    this.refs.composeFlow.classList.add("drop-target");
  }

  private removeFlowDropMarker(): void {
    this.cancelFlowDragFeedback();
    this.pendingFlowDrag = null;
    this.flowDropIndex = null;
    this.flowDropMarker?.remove();
    this.flowDropMarker = null;
    this.refs.composeFlow.classList.remove("drop-target");
    this.refs.composeFlow
      .querySelector<HTMLElement>(".flow-discovery.dragging")
      ?.classList.remove("dragging");
  }

  private cancelFlowDragFeedback(): void {
    if (this.flowDragFrame === null) return;
    if (typeof window.cancelAnimationFrame === "function")
      window.cancelAnimationFrame(this.flowDragFrame);
    this.flowDragFrame = null;
  }

  private resetFlowDrag(): void {
    this.removeFlowDropMarker();
    this.draggedDiscoveryId = null;
    this.draggedFlowIndex = null;
  }

  private moveFlowIndexTo(sourceIndex: number, targetIndex: number): void {
    const item = this.droppedDiscoveryIds[sourceIndex];
    if (!item || sourceIndex === targetIndex) return;
    const next = [...this.droppedDiscoveryIds];
    next.splice(sourceIndex, 1);
    next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, item);
    this.droppedDiscoveryIds = next;
    this.renderFlowComposer();
  }

  private normalizedToolName(value: string): string {
    return value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64);
  }

  private newId(prefix: string): string {
    try {
      if (typeof crypto.randomUUID === "function")
        return `${prefix}-${crypto.randomUUID()}`;
    } catch {
      // Some test DOMs do not expose randomUUID.
    }
    return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  private composedTool(
    name: string,
    actions: DiscoveredAction[],
  ): ToolDefinition {
    const properties: Record<string, JSONSchema> = {};
    const required = new Set<string>();
    for (const action of actions) {
      const schema = action.inputSchema;
      if (schema.properties) Object.assign(properties, schema.properties);
      if (Array.isArray(schema.required))
        for (const field of schema.required)
          if (typeof field === "string") required.add(field);
    }
    const inputSchema: ToolDefinition["inputSchema"] = {
      type: "object",
      properties,
      ...(required.size ? { required: [...required] } : {}),
      additionalProperties: false,
    };
    const nodes: WorkflowNode[] = actions.map((action, index) => {
      const args: Record<string, Binding> = {};
      if (isRecord(action.inputSchema.properties))
        for (const key of Object.keys(action.inputSchema.properties))
          args[key] = { kind: "input", path: key };
      return {
        id: this.newId("dom"),
        type: "dom",
        label: action.name,
        position: { x: index * 260, y: 0 },
        config: {
          capabilityId: action.capability?.id ?? "unconfigured",
          args,
          ...(action.effect === "mutate" ? { requiresApproval: true } : {}),
        },
      };
    });
    const returnNode: WorkflowNode = {
      id: this.newId("return"),
      type: "return",
      label: "Return result",
      position: { x: nodes.length * 260, y: 0 },
      config: {
        value: { kind: "output", nodeId: nodes[nodes.length - 1]?.id ?? "" },
      },
    };
    nodes.push(returnNode);
    const entryNode = nodes[0];
    if (!entryNode) throw new Error("A composed tool needs one discovery.");
    return {
      id: this.newId("tool"),
      name,
      description: `Runs ${actions.map((action) => action.name).join(", ")} in order.`,
      inputSchema,
      access: actions.some((action) => action.access === "authenticated")
        ? "authenticated"
        : "public",
      enabled: true,
      workflow: {
        entryNodeId: entryNode.id,
        nodes,
        edges: nodes.slice(0, -1).map((node, index) => ({
          from: node.id,
          to: nodes[index + 1]?.id ?? returnNode.id,
          when: "always" as const,
        })),
      },
    };
  }

  private async saveAndInject(): Promise<void> {
    const name = this.refs.toolName.value.trim();
    const project = this.store.get();
    const actions = this.droppedDiscoveryIds
      .map((id) => project.discoveredActions.find((action) => action.id === id))
      .filter((action): action is DiscoveredAction => Boolean(action));
    const graph = graphFromState(this.state);
    if (!name) {
      this.setStatus("Give the custom tool a name before saving.", "error");
      this.render();
      return;
    }
    if (!actions.length) {
      this.setStatus(
        "Drop at least one discovery into the ordered flow.",
        "error",
      );
      this.render();
      return;
    }
    if (!graph || this.tabId === undefined) {
      this.setStatus("Save & inject requires the current live tab.", "error");
      this.render();
      return;
    }
    if (!matchesSiteScope(project, graph.page.url)) {
      this.setStatus(
        "The current tab is outside the discovered site scope.",
        "error",
      );
      this.render();
      return;
    }
    const normalized = this.normalizedToolName(name);
    if (!normalized || project.tools.some((tool) => tool.name === normalized)) {
      this.setStatus(
        "Choose a unique tool name using letters, numbers, or underscores.",
        "error",
      );
      this.render();
      return;
    }
    const tool = this.composedTool(normalized, actions);
    const result = this.store.apply(
      { type: "create-tool", tool },
      this.store.getRevision(),
      "human",
    );
    if (!result.ok) {
      this.setStatus(result.error, "error");
      this.render();
      return;
    }
    this.persist(result.project);
    const savedTool = result.project.tools.find(
      (candidate) => candidate.name === normalized,
    );
    if (!savedTool) {
      this.setStatus("The custom tool could not be saved.", "error");
      this.render();
      return;
    }
    const consequential = toolNeedsApproval(savedTool, graph);
    const needsSession = savedTool.access === "authenticated";
    const control = this.controlState();
    if (
      needsSession &&
      (control?.authentication === "login_required" ||
        control?.authentication === "expired")
    ) {
      this.setStatus(
        "Sign in on the selected tab, then use Resume before injecting protected tools.",
        "error",
      );
      this.render();
      return;
    }
    const approval = createActivationApproval(
      result.project,
      this.tabId,
      graph.page.url,
      consequential,
      needsSession && control?.authentication === "verified",
    );
    const response = await this.send({
      type: "polyfill:activate-project",
      project: result.project,
      approval,
    });
    if (response.ok && "state" in response) {
      this.state = response.state;
      this.setStatus(`Saved and injected ${savedTool.name}.`, "success");
    } else {
      // Save & inject is one user action. If activation failed before another
      // draft edit arrived, undo the just-created draft so the same flow/name
      // can be retried without leaving a dead tool occupying the name.
      if (this.store.getRevision() === result.project.project.revision) {
        const rollback = this.store.undo(this.store.getRevision(), "system");
        if (rollback.ok) this.persist(rollback.project);
      }
      this.setStatus(
        response.ok
          ? "The extension returned no activation state."
          : response.error,
        "error",
      );
    }
    this.render();
  }

  private async testSelectedTool(
    humanInitiated: boolean,
  ): Promise<WorkflowRunResult | null> {
    const project = this.store.get();
    const tool = this.selectedTool();
    if (!tool || this.tabId === undefined) {
      this.setStatus(
        "Select a tool and an exact target tab before testing.",
        "error",
      );
      return null;
    }
    const graph = graphFromState(this.state);
    let args: unknown = {};
    const argumentsField =
      document.querySelector<HTMLTextAreaElement>("#arguments");
    if (argumentsField) {
      try {
        args = JSON.parse(argumentsField.value || "{}");
      } catch {
        this.setStatus(
          "The Arguments box must contain valid JSON before testing.",
          "error",
        );
        return null;
      }
    }
    let approval: ReturnType<typeof createActivationApproval> | undefined;
    const needsApproval = toolNeedsApproval(tool, graph);
    const needsSession =
      tool.access === "authenticated" ||
      project.site.sessionMode === "authenticated";
    if (humanInitiated && (needsApproval || needsSession)) {
      const allowConsequential = needsApproval
        ? window.confirm(
            "This workflow can affect the website. Approve consequential actions for this test revision?",
          )
        : false;
      if (needsApproval && !allowConsequential) {
        this.setStatus(
          "Test paused: consequential website actions still need human approval.",
          "error",
        );
        return null;
      }
      const sessionVerified = needsSession
        ? window.confirm(
            "Confirm that the selected tab currently has the intended authorized website session.",
          )
        : false;
      approval = createActivationApproval(
        project,
        this.tabId,
        graph?.page.url ?? window.location.href,
        allowConsequential,
        sessionVerified,
      );
    }
    this.refs.test.disabled = true;
    const startedAt = Date.now();
    const response = await this.send({
      type: "polyfill:test-project",
      project,
      toolId: tool.id,
      args,
      ...(approval ? { approval } : {}),
    });
    this.refs.test.disabled = false;
    if (!response.ok || !("workflow" in response)) {
      this.setStatus(
        response.ok
          ? "The extension returned no workflow result."
          : response.error,
        "error",
      );
      return null;
    }
    const run = response.workflow as WorkflowRunResult;
    this.lastRun = run;
    if (run.revision === this.store.getRevision()) {
      const record = this.store.apply(
        { type: "record-test-run", run: makeTestRun(run, startedAt) },
        this.store.getRevision(),
        humanInitiated ? "human" : "agent",
      );
      if (record.ok) this.persist(record.project);
    }
    this.setStatus(
      run.success
        ? `Test completed at revision ${run.revision}.`
        : `Test stopped with ${run.status}${run.failedNodeId ? ` at ${run.failedNodeId}` : ""}.`,
      run.success ? "success" : "error",
    );
    this.render();
    return run;
  }

  private async activateSelectedTool(): Promise<void> {
    const project = this.store.get();
    const tool = this.selectedTool();
    const graph = graphFromState(this.state);
    if (!tool || this.tabId === undefined || !graph) {
      this.setStatus(
        "Activation requires a selected tool, an exact live tab, and a current page graph.",
        "error",
      );
      return;
    }
    const runnable = validateWorkflow(tool.workflow, { requireRunnable: true });
    if (!runnable.valid) {
      this.setStatus(
        `The selected workflow is not ready: ${runnable.issues.map((issue) => issue.message).join("; ")}`,
        "error",
      );
      return;
    }
    const allowConsequential = toolNeedsApproval(tool, graph)
      ? window.confirm(
          "Approve this exact project snapshot for consequential website actions?",
        )
      : false;
    if (toolNeedsApproval(tool, graph) && !allowConsequential) {
      this.setStatus(
        "Activation cancelled; consequential actions were not approved.",
        "error",
      );
      return;
    }
    const needsSession =
      tool.access === "authenticated" ||
      project.site.sessionMode === "authenticated";
    const sessionVerified = needsSession
      ? window.confirm(
          "Confirm the selected tab has the intended authorized website session.",
        )
      : false;
    const approval = createActivationApproval(
      project,
      this.tabId,
      graph.page.url,
      allowConsequential,
      sessionVerified,
    );
    const response = await this.send({
      type: "polyfill:activate-project",
      project,
      approval,
    });
    if (response.ok && "state" in response) {
      this.state = response.state;
      this.setStatus(
        `Activated ${tool.name} for ${project.site.domain} at revision ${project.project.revision}.`,
        "success",
      );
    } else
      this.setStatus(
        response.ok
          ? "The extension returned no activation state."
          : response.error,
        "error",
      );
    this.render();
  }

  private currentGuide(topic?: string): Record<string, JsonValue> {
    const project = this.store.get();
    const graph = graphFromState(this.state);
    const selected = this.selectedTool();
    const blockers: string[] = [];
    const control = this.controlState();
    let nextStep = "Open Studio from a page to begin automatic discovery.";
    if (project.site.domain) {
      nextStep = "Waiting for the selected tab's automatic discovery.";
      if (!graph)
        blockers.push("No live page graph is available for the selected tab.");
      else if (!matchesSiteScope(project, graph.page.url))
        blockers.push(
          "The selected tab is outside the project's site scope; update the domain or select the intended tab.",
        );
      else if (project.discoveredActions.length === 0)
        nextStep = "Waiting for supported page discoveries.";
      else if (this.state?.activeProject)
        nextStep =
          "Invoke an injected tool from the current page's WebMCP context.";
      else if (this.droppedDiscoveryIds.length > 0)
        nextStep = "Name the custom tool, then choose Save & inject.";
      else
        nextStep =
          "Drag one or more discoveries into the flow to create a tool.";
    }
    if (control?.blocker) blockers.push(control.blocker.message);
    if (
      control?.authentication === "login_required" ||
      control?.authentication === "expired"
    )
      blockers.push(
        "Protected tools are withheld until the human signs in in the selected tab and explicitly resumes.",
      );
    if (!control && this.state)
      blockers.push(
        "Live control state is unavailable; do not assume the selected tab is still connected.",
      );
    if (this.state && !this.state.webmcp.available)
      blockers.push(
        "The page does not expose a native model context; the extension compatibility host is being used or is unavailable.",
      );
    const topics: Record<string, string> = {
      begin:
        "Open Studio from the intended page; the exact selected tab is discovered automatically.",
      discovery:
        "Discovery runs automatically against the explicitly selected local tab. Findings remain reusable actions until you compose and inject a tool.",
      editor:
        "Drag discovered actions into the ordered flow. Each dropped card becomes one sequential page action.",
      testing:
        "Save & inject runs the current named flow against the selected tab. Consequential actions retain human approval checks.",
      transfer:
        "The first MVP injects the named flow directly into the current page; separate config transfer is intentionally hidden.",
      approval:
        "Save & inject binds the exact snapshot to one tab and origin. Draft edits never silently mutate an active snapshot.",
    };
    return {
      overview:
        "WebMCP Studio lets a human and ChatGPT co-author reusable tools for a live website tab.",
      ...(topic && topics[topic] ? { topic, detail: topics[topic] } : {}),
      stage: project.site.domain ? "project" : "empty",
      nextStep,
      blockers,
      supportedNodeTypes: [
        "http",
        "dom",
        "wait",
        "extract",
        "transform",
        "condition",
        "return",
      ],
      revision: project.project.revision,
      activeProject: this.state?.activeProject ?? null,
      control: (control ?? null) as unknown as JsonValue,
    };
  }

  private installWebMcpTools(): void {
    const context = ensureModelContext(document)
      .context as ExtensionModelContext;
    const register = context.registerTool ?? context.provideTool;
    const definitions: Array<ModelContextTool> = [
      {
        name: "get_studio_guide",
        description:
          "Read the WebMCP Studio guide, current project next step, and blockers.",
        inputSchema: {
          type: "object",
          properties: { topic: { type: "string" } },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: async (args) =>
          this.currentGuide(
            isRecord(args) && typeof args.topic === "string"
              ? args.topic
              : undefined,
          ),
      },
      {
        name: "read_project",
        description:
          "Read the authoritative shared Studio draft, validation, activity, and active snapshot state.",
        inputSchema: { type: "object", additionalProperties: false },
        annotations: { readOnlyHint: true },
        execute: async () => {
          const project = this.store.get();
          const validation = validateProjectResult(project);
          const runnable = validateProjectResult(project, {
            requireRunnable: true,
          });
          return {
            project,
            revision: project.project.revision,
            validation,
            runnable,
            activeProject: this.state?.activeProject ?? null,
            changes: this.store.getChanges().slice(-30),
            lastRun: this.lastRun,
          };
        },
      },
      {
        name: "read_tool",
        description:
          "Read one named tool and its owned workflow from the shared Studio draft.",
        inputSchema: {
          type: "object",
          properties: { toolId: { type: "string" }, name: { type: "string" } },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: async (args) => {
          const project = this.store.get();
          const requested = isRecord(args)
            ? (args.toolId ?? args.name)
            : undefined;
          const tool = project.tools.find(
            (candidate) =>
              candidate.id === requested || candidate.name === requested,
          );
          return tool
            ? { tool, revision: project.project.revision }
            : { error: "tool_not_found", revision: project.project.revision };
        },
      },
      {
        name: "define_tool",
        description:
          "Create or replace a visible draft tool definition. This never activates a tool.",
        inputSchema: {
          type: "object",
          properties: {
            toolId: { type: "string" },
            definition: { type: "object" },
            expectedRevision: { type: "integer" },
          },
          required: ["definition", "expectedRevision"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
        execute: async (args) => {
          if (
            !isRecord(args) ||
            !isRecord(args.definition) ||
            typeof args.expectedRevision !== "number"
          )
            return {
              ok: false,
              error: "definition and expectedRevision are required",
            };
          const toolId =
            typeof args.toolId === "string" ? args.toolId : undefined;
          const command: ProjectCommand = toolId
            ? {
                type: "replace-tool",
                toolId,
                tool: args.definition as Partial<ToolDefinition>,
              }
            : {
                type: "create-tool",
                tool: args.definition as Partial<ToolDefinition>,
              };
          const result = this.store.apply(
            command,
            args.expectedRevision,
            "agent",
          );
          if (!result.ok) return result;
          this.persist(result.project);
          this.setStatus(
            `Agent defined ${toolId ? "a tool" : "a draft tool"} at revision ${result.project.project.revision}.`,
            "success",
          );
          this.render();
          return { ok: true, project: result.project, change: result.change };
        },
      },
      {
        name: "edit_workflow",
        description:
          "Apply an atomic list of supported node, binding, and connection edits to a named tool.",
        inputSchema: {
          type: "object",
          properties: {
            toolId: { type: "string" },
            changes: { type: "array" },
            expectedRevision: { type: "integer" },
          },
          required: ["toolId", "changes", "expectedRevision"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
        execute: async (args) => {
          if (
            !isRecord(args) ||
            typeof args.toolId !== "string" ||
            !Array.isArray(args.changes) ||
            typeof args.expectedRevision !== "number"
          )
            return {
              ok: false,
              error: "toolId, changes, and expectedRevision are required",
            };
          const result = this.store.apply(
            {
              type: "edit-workflow",
              toolId: args.toolId,
              changes: args.changes as WorkflowEdit[],
            },
            args.expectedRevision,
            "agent",
          );
          if (!result.ok) return result;
          this.persist(result.project);
          this.setStatus(
            `Agent edited workflow at revision ${result.project.project.revision}.`,
            "success",
          );
          this.render();
          return { ok: true, project: result.project, change: result.change };
        },
      },
      {
        name: "read_discovery_session",
        description:
          "Read the selected-tab discovery connection, scope, findings, and blockers without granting access.",
        inputSchema: {
          type: "object",
          properties: { sessionId: { type: "string" } },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: async (args) => {
          const project = this.store.get();
          const identity = this.discoveryIdentity(project);
          const requestedSession =
            isRecord(args) && typeof args.sessionId === "string"
              ? args.sessionId
              : undefined;
          if (
            requestedSession !== undefined &&
            requestedSession !== identity?.sessionId
          )
            return {
              ok: false,
              error: "session_expired",
              sessionId: identity?.sessionId ?? null,
            };
          return {
            sessionId: identity?.sessionId ?? null,
            observationId: identity?.observationId ?? null,
            domain: project.site.domain,
            scope: project.site,
            connected: identity !== null,
            inScope: identity?.inScope ?? false,
            tabId: this.tabId ?? null,
            page: identity?.page ?? null,
            findings: project.discoveredActions.map((action) => ({
              id: action.id,
              name: action.name,
              status: action.status,
              confidence: action.confidence,
            })),
            blockers: this.currentGuide().blockers,
            control: this.controlState(),
          };
        },
      },
      {
        name: "observe_page",
        description:
          "Read a bounded, sanitized observation of the currently connected page.",
        inputSchema: {
          type: "object",
          properties: { sessionId: { type: "string" } },
          required: ["sessionId"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: async (args) => {
          const requestedSession =
            isRecord(args) && typeof args.sessionId === "string"
              ? args.sessionId
              : undefined;
          if (!requestedSession)
            return { ok: false, error: "session_required" };
          const identity = this.discoveryIdentity();
          if (!identity)
            return {
              ok: false,
              error: "session_expired",
              detail: "No live graph is available for the selected tab.",
            };
          const control = this.controlState();
          if (control && control.mode !== "running")
            return {
              ok: false,
              error: "control_blocked",
              detail:
                control.blocker?.message ??
                "Agent actions are currently blocked.",
              control,
            };
          if (requestedSession !== identity.sessionId)
            return {
              ok: false,
              error: "session_expired",
              sessionId: identity.sessionId,
            };
          if (!identity.inScope)
            return {
              ok: false,
              error: "scope_blocked",
              page: identity.page,
            };
          return {
            ok: true,
            sessionId: identity.sessionId,
            observationId: identity.observationId,
            page: identity.page,
            capabilities: Object.values(identity.graph.capabilities).map(
              (capability) => ({
                id: capability.id,
                name: capability.name,
                description: capability.description,
                effect: capability.effect,
                inputSchema: capability.inputSchema,
              }),
            ),
            blocked: identity.graph.blocked.map((entry) => ({
              id: entry.id,
              name: entry.name,
              reason: entry.reason,
              detail: entry.detail,
            })),
          };
        },
      },
      {
        name: "apply_discovery_result",
        description:
          "Apply sanitized canonical discoveries to the shared draft without activating them.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            config: { type: "object" },
            expectedRevision: { type: "integer" },
          },
          required: ["sessionId", "config", "expectedRevision"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
        execute: async (args) => {
          if (
            !isRecord(args) ||
            typeof args.sessionId !== "string" ||
            !isRecord(args.config) ||
            typeof args.expectedRevision !== "number"
          )
            return {
              ok: false,
              error: "sessionId, config, and expectedRevision are required",
            };
          const identity = this.discoveryIdentity();
          if (!identity || args.sessionId !== identity.sessionId)
            return {
              ok: false,
              error: "session_expired",
              sessionId: identity?.sessionId ?? null,
            };
          const control = this.controlState();
          if (control && control.mode !== "running")
            return {
              ok: false,
              error: "control_blocked",
              detail:
                control.blocker?.message ??
                "Agent actions are currently blocked.",
              control,
            };
          if (!identity.inScope) return { ok: false, error: "scope_blocked" };
          const actions = args.config.actions ?? args.config.discoveredActions;
          if (!Array.isArray(actions))
            return {
              ok: false,
              error: "config.actions must be an array of discovered actions",
            };
          const result = this.store.apply(
            {
              type: "apply-discovery",
              actions: actions as ProjectDocument["discoveredActions"],
            },
            args.expectedRevision,
            "agent",
          );
          if (!result.ok) return result;
          this.persist(result.project);
          this.setStatus(
            `Agent applied discovery results at revision ${result.project.project.revision}.`,
            "success",
          );
          this.render();
          return { ok: true, project: result.project, change: result.change };
        },
      },
      {
        name: "perform_browser_action",
        description:
          "Perform one supported action on the selected live page using a fresh discovery observation; consequential actions require a human confirmation.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            action: {
              type: "object",
              properties: {
                capabilityId: { type: "string" },
                args: {},
              },
              required: ["capabilityId"],
              additionalProperties: false,
            },
            expectedObservation: { type: "string" },
          },
          required: ["sessionId", "action", "expectedObservation"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
        execute: async (args) => {
          if (!isRecord(args) || typeof args.sessionId !== "string")
            return { ok: false, error: "sessionId is required" };
          if (typeof args.expectedObservation !== "string")
            return { ok: false, error: "expectedObservation is required" };
          const action = isRecord(args.action) ? args.action : null;
          if (!action || typeof action.capabilityId !== "string")
            return {
              ok: false,
              error: "action.capabilityId is required",
            };
          const actionArgs = action.args === undefined ? {} : action.args;
          if (!isJsonValue(actionArgs))
            return { ok: false, error: "action.args must be JSON-compatible" };
          const project = this.store.get();
          const identity = this.discoveryIdentity(project);
          if (!identity || args.sessionId !== identity.sessionId)
            return {
              ok: false,
              error: "session_expired",
              sessionId: identity?.sessionId ?? null,
            };
          if (args.expectedObservation !== identity.observationId)
            return {
              ok: false,
              error: "validation_failed",
              observationId: identity.observationId,
            };
          if (!identity.inScope) return { ok: false, error: "scope_blocked" };
          const capability = identity.graph.capabilities[action.capabilityId];
          if (!capability) return { ok: false, error: "target_not_found" };
          const consequential =
            capability.effect === "mutate" || capability.effect === "navigate";
          const needsSession = project.site.sessionMode === "authenticated";
          let approval: ReturnType<typeof createActivationApproval> | undefined;
          if (consequential) {
            const approved = window.confirm(
              "This discovery action can affect the website. Approve it for the current tab and observation?",
            );
            if (!approved) return { ok: false, error: "approval_required" };
          }
          if (needsSession) {
            const sessionVerified = window.confirm(
              "Confirm that the selected tab currently has the intended authorized website session.",
            );
            if (!sessionVerified)
              return { ok: false, error: "session_expired" };
          }
          if (consequential || needsSession) {
            approval = createActivationApproval(
              project,
              this.tabId as number,
              identity.graph.page.url,
              consequential,
              needsSession,
            );
          }
          const response = await this.send({
            type: "polyfill:perform-browser-action",
            sessionId: identity.sessionId,
            capabilityId: action.capabilityId,
            args: actionArgs,
            expectedObservation: identity.observationId,
            project,
            ...(approval ? { approval } : {}),
          });
          if (!response.ok) return response;
          if (!("action" in response) || !isExecutionResult(response.action))
            return {
              ok: false,
              error: "The extension returned an invalid action result.",
            };
          return response.action;
        },
      },
      {
        name: "read_observed_requests",
        description:
          "Read bounded, sanitized same-origin request evidence captured after attaching to the selected tab.",
        inputSchema: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            cursor: { type: "string" },
          },
          required: ["sessionId"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: async (args) => {
          if (!isRecord(args) || typeof args.sessionId !== "string")
            return { ok: false, error: "sessionId is required" };
          const identity = this.discoveryIdentity();
          if (!identity || args.sessionId !== identity.sessionId)
            return {
              ok: false,
              error: "session_expired",
              sessionId: identity?.sessionId ?? null,
            };
          const control = this.controlState();
          if (control && control.mode !== "running")
            return {
              ok: false,
              error: "control_blocked",
              detail:
                control.blocker?.message ??
                "Agent actions are currently blocked.",
              control,
            };
          const response = await this.send({
            type: "polyfill:read-observed-requests",
            sessionId: identity.sessionId,
            ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
          });
          if (!response.ok) return response;
          if (
            !("requests" in response) ||
            !isObservedRequestPage(response.requests)
          )
            return {
              ok: false,
              error: "The extension returned invalid observed-request data.",
            };
          if (response.requests.sessionId !== identity.sessionId)
            return { ok: false, error: "session_expired" };
          return response.requests;
        },
      },
      {
        name: "test_tool",
        description:
          "Test the current selected-tab project revision; consequential actions remain human-approved only.",
        inputSchema: {
          type: "object",
          properties: {
            toolId: { type: "string" },
            inputs: { type: "object" },
            revision: { type: "integer" },
          },
          required: ["toolId", "inputs", "revision"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: false },
        execute: async (args) => {
          if (
            !isRecord(args) ||
            typeof args.toolId !== "string" ||
            typeof args.revision !== "number" ||
            !isJsonValue(args.inputs)
          )
            return {
              ok: false,
              error: "toolId, JSON inputs, and revision are required",
            };
          if (args.revision !== this.store.getRevision())
            return {
              ok: false,
              code: "revision_conflict",
              currentRevision: this.store.getRevision(),
            };
          const project = this.store.get();
          const tool = project.tools.find(
            (candidate) => candidate.id === args.toolId,
          );
          if (!tool) return { ok: false, error: "tool_not_found" };
          const run = await this.runAgentTest(tool, args.inputs);
          return run;
        },
      },
      {
        name: "read_test_run",
        description:
          "Read the sanitized trace and result for a recorded Studio test run.",
        inputSchema: {
          type: "object",
          properties: { runId: { type: "string" } },
          required: ["runId"],
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
        execute: async (args) => {
          const runId =
            isRecord(args) && typeof args.runId === "string" ? args.runId : "";
          return (
            this.store.get().testRuns.find((run) => run.id === runId) ?? {
              error: "test_run_not_found",
            }
          );
        },
      },
    ];
    for (const tool of definitions) {
      try {
        register.call(context, tool);
      } catch {
        // A native host may reject a duplicate Studio registration; the UI remains usable.
      }
    }
    (window as Window & { __webmcpStudio?: StudioController }).__webmcpStudio =
      this;
  }

  private async runAgentTest(
    tool: ToolDefinition,
    inputs: JsonValue,
  ): Promise<WorkflowRunResult> {
    const response = await this.send({
      type: "polyfill:test-project",
      project: this.store.get(),
      toolId: tool.id,
      args: inputs,
    });
    if (!response.ok || !("workflow" in response)) {
      return {
        success: false,
        status: "validation_failed",
        trace: [],
        warnings: [
          response.ok
            ? "The extension returned no workflow result."
            : response.error,
        ],
        runId: `agent-test-${Date.now().toString(36)}`,
        toolId: tool.id,
        revision: this.store.getRevision(),
      };
    }
    const run = response.workflow as WorkflowRunResult;
    this.lastRun = run;
    if (run.revision === this.store.getRevision()) {
      const record = this.store.apply(
        { type: "record-test-run", run: makeTestRun(run, Date.now()) },
        this.store.getRevision(),
        "agent",
      );
      if (record.ok) this.persist(record.project);
    }
    this.setStatus(
      `Agent test ${run.success ? "completed" : "stopped"} at revision ${run.revision}.`,
      run.success ? "success" : "error",
    );
    this.render();
    return run;
  }

  private renderDiscoverySurface(): void {
    const project = this.store.get();
    const graph = graphFromState(this.state);
    const control = this.controlState();
    const actions = project.discoveredActions;
    const liveAvailable = Boolean(
      graph &&
      matchesSiteScope(project, graph.page.url) &&
      control?.mode !== "disconnected" &&
      control?.mode !== "takeover" &&
      control?.mode !== "paused",
    );

    this.refs.pageTitle.textContent =
      graph?.page.title || "Waiting for the selected page";
    this.refs.domainDisplay.textContent =
      graph?.page.hostname ||
      (() => {
        try {
          return graph ? new URL(graph.page.url).hostname : "Detecting…";
        } catch {
          return "Detecting…";
        }
      })();
    this.refs.pageUrl.textContent =
      graph?.page.url || "Attach the extension to a browser tab to begin.";
    this.refs.discoveryCount.textContent = String(actions.length);
    const available = actions.filter((action) =>
      this.isDiscoveryAvailable(action),
    ).length;
    const protectedCount = actions.filter(
      (action) => action.access === "authenticated",
    ).length;
    const publicCount = actions.length - protectedCount;
    const registered = control
      ? ` · ${control.registeredPublicTools} public / ${control.registeredProtectedTools} protected injected`
      : "";
    this.refs.availability.textContent = `${available} available now · ${publicCount} public · ${protectedCount} protected${registered}`;

    if (!graph) {
      this.refs.discoveries.replaceChildren(
        Object.assign(element("div", "empty-state"), {
          textContent: "Waiting for the current tab's graph.",
        }),
      );
    } else if (!actions.length) {
      this.refs.discoveries.replaceChildren(
        Object.assign(element("div", "empty-state"), {
          textContent: "No supported discoveries were found on this page.",
        }),
      );
    } else {
      this.refs.discoveries.replaceChildren(
        ...actions.map((action) => {
          const card = element("article", "discovery-card");
          const unavailable = !this.isDiscoveryAvailable(action);
          card.draggable = !unavailable;
          card.dataset.discoveryId = action.id;
          card.addEventListener("dragstart", (event) => {
            if (!event.dataTransfer) return;
            event.dataTransfer.effectAllowed = "copy";
            event.dataTransfer.setData("text/plain", action.id);
          });
          const heading = element("div", "discovery-card-heading");
          const title = element("strong");
          title.textContent = action.name;
          const badge = element("span", `discovery-access ${action.access}`);
          badge.textContent =
            action.status === "blocked" ? "blocked" : action.access;
          if (unavailable) badge.classList.add("unavailable");
          heading.append(title, badge);
          const description = element("p", "muted-copy");
          description.textContent = action.description;
          const footer = element("div", "discovery-card-footer");
          const effect = element("small");
          effect.textContent = `${action.effect} · ${Math.round(action.confidence * 100)}% confidence`;
          const add = element("button", "text-button");
          add.type = "button";
          add.textContent = "Add to flow";
          add.disabled = unavailable;
          add.addEventListener("click", () =>
            this.addDiscoveryToFlow(action.id),
          );
          footer.append(effect, add);
          card.append(heading, description, footer);
          return card;
        }),
      );
    }

    this.renderFlowComposer();
  }

  private flowActions(project = this.store.get()): DiscoveredAction[] {
    return this.droppedDiscoveryIds
      .map((id) => project.discoveredActions.find((action) => action.id === id))
      .filter((action): action is DiscoveredAction => Boolean(action));
  }

  private updateSaveInjectState(): void {
    const project = this.store.get();
    const graph = graphFromState(this.state);
    const control = this.controlState();
    const liveAvailable = Boolean(
      graph &&
      matchesSiteScope(project, graph.page.url) &&
      control?.mode !== "disconnected" &&
      control?.mode !== "takeover" &&
      control?.mode !== "paused",
    );
    this.refs.saveInject.disabled = !(
      Boolean(this.refs.toolName.value.trim()) &&
      this.flowActions(project).length > 0 &&
      Boolean(graph) &&
      this.tabId !== undefined &&
      liveAvailable
    );
  }

  private renderFlowComposer(): void {
    this.resetFlowDrag();
    const project = this.store.get();
    const flowActions = this.flowActions(project);
    if (!flowActions.length) {
      this.refs.composeFlow.replaceChildren(
        Object.assign(element("div", "drop-placeholder"), {
          textContent: "Drop discoveries here to build the tool.",
        }),
      );
    } else {
      this.refs.composeFlow.replaceChildren(
        ...flowActions.map((action, index) => {
          const row = element("div", "flow-discovery");
          row.draggable = true;
          row.dataset.discoveryId = action.id;
          row.dataset.flowIndex = String(index);
          const number = element("span", "flow-number");
          number.textContent = String(index + 1).padStart(2, "0");
          const details = element("div", "flow-discovery-details");
          const title = element("strong");
          title.textContent = action.name;
          const meta = element("small");
          meta.textContent = `${action.access} · ${action.effect}`;
          details.append(title, meta);
          const controls = element("div", "flow-controls");
          for (const [label, direction] of [
            ["↑", -1],
            ["↓", 1],
          ] as const) {
            const move = element("button", "icon-button");
            move.type = "button";
            move.textContent = label;
            move.title = direction < 0 ? "Move earlier" : "Move later";
            move.disabled =
              direction < 0 ? index === 0 : index === flowActions.length - 1;
            move.addEventListener("click", () =>
              this.moveDiscoveryInFlow(index, direction),
            );
            controls.append(move);
          }
          const remove = element("button", "icon-button");
          remove.type = "button";
          remove.textContent = "×";
          remove.title = "Remove from flow";
          remove.addEventListener("click", () =>
            this.removeDiscoveryFromFlow(index),
          );
          controls.append(remove);
          row.append(number, details, controls);
          return row;
        }),
      );
    }
    this.refs.composeHint.textContent = flowActions.length
      ? `${flowActions.length} sequential step${flowActions.length === 1 ? "" : "s"}. Reorder before saving.`
      : "Each card becomes one sequential page action.";
    this.updateSaveInjectState();
  }

  private render(): void {
    const project = this.store.get();
    const tool = this.selectedTool();
    const graph = graphFromState(this.state);
    this.refs.domain.value = project.site.domain;
    this.refs.outcome.value = project.site.goal ?? "";
    this.refs.session.value = project.site.sessionMode;
    this.refs.exportButton.disabled = !project.site.domain;
    this.refs.status.className = `studio-status${this.statusKind ? ` ${this.statusKind}` : ""}`;
    this.refs.status.textContent = this.statusMessage;
    this.refs.revision.textContent = `revision ${project.project.revision}`;
    this.refs.canvasTitle.textContent = tool?.name ?? "Select a tool";
    this.refs.stage.textContent = this.currentGuide().nextStep as string;
    this.refs.addTool.disabled = !project.site.domain;
    this.refs.discover.disabled = !Boolean(graph);
    this.refs.test.disabled = !Boolean(
      tool && graph && this.tabId !== undefined,
    );
    this.refs.approve.disabled = !Boolean(
      tool && graph && this.tabId !== undefined,
    );
    this.refs.undo.disabled = this.store.getHistoryDepth() === 0;
    this.refs.tabStatus.className = `status-chip ${this.state?.activeProject ? "" : graph ? "" : "muted"}`;
    this.refs.tabStatus.textContent = this.state?.activeProject
      ? "Active"
      : graph
        ? "Connected"
        : "Not paired";
    this.refs.connectionCopy.textContent = graph
      ? `Exact tab ${this.tabId ?? "unknown"} is visible at ${graph.page.url}. Draft edits do not activate until a human approves a snapshot.`
      : "The current inspector tab is the only tab eligible for this project. Pairing and activation remain human actions.";
    this.refs.approval.textContent = this.state?.activeProject
      ? `Active snapshot ${this.state.activeProject.snapshotHash} · ${this.state.activeProject.toolNames.length} registered workflow tool${this.state.activeProject.toolNames.length === 1 ? "" : "s"}.`
      : "Importing a config never activates it.";
    this.renderControlState(project);
    this.renderObservedRequests();
    this.renderTools(project, tool);
    this.renderFlow(tool);
    this.renderNodeInspector(tool);
    this.renderActivity();
    this.renderDiscoverySurface();
  }

  private renderControlState(project: ProjectDocument): void {
    const control = this.controlState();
    if (!control) {
      this.refs.controlSummary.textContent = this.state
        ? "Live control state was not reported by this runtime. Treat the tab as unavailable until it reconnects."
        : "Waiting for the selected tab's live control state.";
      this.refs.pause.disabled = true;
      this.refs.takeover.disabled = true;
      this.refs.login.disabled = true;
      this.refs.resume.disabled = true;
      this.refs.disconnect.disabled = true;
      return;
    }
    const auth =
      control.authentication === "verified"
        ? "human-confirmed protected session"
        : control.authentication === "not_required"
          ? "no protected tools currently require login"
          : control.authentication.replace(/_/g, " ");
    const blocker = control.blocker
      ? ` Blocker: ${control.blocker.message}`
      : "";
    const live = this.state?.graph ? "live page visible" : "no live page graph";
    this.refs.controlSummary.textContent = `${control.mode === "running" ? "Agent access running" : control.mode.replace(/_/g, " ")} · ${live} · ${auth} · ${control.registeredPublicTools} public / ${control.registeredProtectedTools} protected workflow tools available.${blocker}`;
    this.refs.pause.disabled = control.mode !== "running";
    this.refs.takeover.disabled = control.mode === "disconnected";
    this.refs.login.disabled =
      control.mode === "disconnected" ||
      !project.tools.some(
        (tool) => tool.enabled && tool.access === "authenticated",
      );
    this.refs.resume.disabled =
      control.mode === "running" || control.mode === "disconnected";
    this.refs.disconnect.disabled = control.mode === "disconnected";
  }

  private renderObservedRequests(): void {
    if (this.requestError) {
      this.refs.observedRequests.replaceChildren(
        Object.assign(element("div", "empty-state"), {
          textContent: this.requestError,
        }),
      );
      return;
    }
    if (!this.requestPage) {
      this.refs.observedRequests.replaceChildren(
        Object.assign(element("div", "empty-state"), {
          textContent:
            "No request evidence loaded. Capture begins after attachment; earlier requests are not assumed recoverable.",
        }),
      );
      return;
    }
    if (!this.requestPage.available && this.requestPage.entries.length === 0) {
      this.refs.observedRequests.replaceChildren(
        Object.assign(element("div", "empty-state"), {
          textContent:
            "Request capture is unavailable in this browser runtime.",
        }),
      );
      return;
    }
    const heading = element("small", "muted-copy");
    heading.textContent = `${this.requestPage.entries.length} sanitized same-origin request${this.requestPage.entries.length === 1 ? "" : "s"} captured since ${new Date(this.requestPage.captureStartedAt).toLocaleTimeString()}. Query strings and fragments are omitted.`;
    const rows = this.requestPage.entries.map((entry) => {
      const row = element("div", "observed-request");
      const path = element("code");
      path.textContent = entry.path;
      const detail = element("small");
      detail.textContent = `${entry.origin}${entry.initiatorType ? ` · ${entry.initiatorType}` : ""}`;
      row.append(path, detail);
      return row;
    });
    this.refs.observedRequests.replaceChildren(heading, ...rows);
  }

  private renderTools(
    project: ProjectDocument,
    selected: ToolDefinition | null,
  ): void {
    if (project.tools.length === 0) {
      this.refs.toolList.replaceChildren(
        Object.assign(element("div", "empty-state"), {
          textContent: "No tools yet. Capture discoveries or add a draft tool.",
        }),
      );
      return;
    }
    const tools = project.editor.toolOrder
      .map((id) => project.tools.find((tool) => tool.id === id))
      .filter((tool): tool is ToolDefinition => Boolean(tool));
    this.refs.toolList.replaceChildren(
      ...tools.map((tool) => {
        const button = element(
          "button",
          `studio-tool-item${tool.id === selected?.id ? " selected" : ""}`,
        );
        button.type = "button";
        button.addEventListener("click", () => this.selectTool(tool.id));
        const name = element("strong");
        name.textContent = tool.name;
        const detail = element("span");
        detail.textContent = `${tool.workflow.nodes.length} steps · ${tool.enabled ? "enabled" : "disabled"}`;
        button.append(name, detail);
        return button;
      }),
    );
  }

  private renderFlow(tool: ToolDefinition | null): void {
    if (!tool) {
      this.refs.flow.replaceChildren(
        Object.assign(element("div", "empty-state large"), {
          textContent: "A tool's owned workflow will appear here.",
        }),
      );
      return;
    }
    const nodes = tool.workflow.nodes.map((node) => {
      const button = element(
        "button",
        `studio-node${node.id === this.selectedNodeId ? " selected" : ""}`,
      );
      button.type = "button";
      button.addEventListener("click", () => {
        this.selectedNodeId = node.id;
        this.render();
      });
      const type = element("span", "studio-node-type");
      type.textContent = node.type;
      const label = element("strong");
      label.textContent = node.label;
      const outgoing = tool.workflow.edges.filter(
        (edge) => edge.from === node.id,
      );
      const detail = element("small");
      detail.textContent =
        node.type === "condition"
          ? outgoing
              .map((edge) => `${edge.when ?? "always"} → ${edge.to}`)
              .join(" · ") || "needs true / false branches"
          : outgoing[0]
            ? `next → ${outgoing[0].to}`
            : node.type === "return"
              ? "flow result"
              : "needs next step";
      button.append(type, label, detail);
      return button;
    });
    this.refs.flow.replaceChildren(...nodes);
    for (const button of Array.from(
      document.querySelectorAll<HTMLButtonElement>(".palette-button"),
    )) {
      button.onclick = () =>
        this.addNode(button.dataset.nodeType as WorkflowNode["type"]);
    }
  }

  private renderNodeInspector(tool: ToolDefinition | null): void {
    const node =
      tool?.workflow.nodes.find(
        (candidate) => candidate.id === this.selectedNodeId,
      ) ?? null;
    if (!tool || !node) {
      this.refs.nodeInspector.replaceChildren(
        Object.assign(element("div", "empty-state"), {
          textContent: "Select a node to inspect its bindings.",
        }),
      );
      return;
    }
    const fields = element("div", "studio-node-fields");
    const labelField = element("label", "studio-node-field");
    const labelCaption = element("span", "field-label");
    labelCaption.textContent = "Label";
    const label = element("input");
    label.value = node.label;
    labelField.append(labelCaption, label);
    const configField = element("label", "studio-node-field");
    const configCaption = element("span", "field-label");
    configCaption.textContent = "JSON-safe node config";
    const config = element("textarea");
    config.rows = 12;
    config.spellcheck = false;
    config.value = json(node.config);
    const help = element("small");
    help.textContent =
      "Use literal, input, output, or context bindings. Arbitrary JavaScript is not supported.";
    configField.append(configCaption, config, help);
    const actions = element("div", "button-row");
    const save = element("button", "button primary");
    save.type = "button";
    save.textContent = "Save step";
    save.addEventListener("click", () =>
      this.saveNode(node, label.value, config.value),
    );
    const remove = element("button", "button secondary");
    remove.type = "button";
    remove.textContent = "Remove";
    remove.disabled = node.id === tool.workflow.entryNodeId;
    remove.addEventListener("click", () => this.removeNode(node));
    actions.append(save, remove);
    const summary = element("pre", "studio-node-summary");
    summary.textContent = `Node ${node.id}\nType ${node.type}\n\nEdges\n${json(tool.workflow.edges.filter((edge) => edge.from === node.id))}`;
    fields.append(labelField, configField, actions, summary);
    this.refs.nodeInspector.replaceChildren(fields);
  }

  private renderActivity(): void {
    const changes = this.store.getChanges().slice(-25).reverse();
    if (changes.length === 0) {
      this.refs.activity.replaceChildren(
        Object.assign(element("div", "empty-state"), {
          textContent: "No draft changes yet.",
        }),
      );
      return;
    }
    this.refs.activity.replaceChildren(
      ...changes.map((change: ProjectChange) => {
        const item = element("div", "studio-activity-item");
        const heading = element("strong");
        heading.textContent = `${change.action.replace(/_/g, " ")} · r${change.revision}`;
        const detail = element("span");
        detail.textContent = `${change.source} · ${new Date(change.at).toLocaleTimeString()}`;
        item.append(heading, detail);
        return item;
      }),
    );
  }
}

export function initializeStudio(): StudioController {
  return new StudioController().start();
}
