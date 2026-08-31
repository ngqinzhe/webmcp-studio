import type {
  Capability,
  CapabilityGraph,
  JSONSchema,
  JsonValue,
  SemanticLocator,
} from "../types";
import {
  cloneProject,
  projectFingerprint,
  validateProject,
  type ProjectValidationIssue,
} from "./validation";
import type {
  Binding,
  CanvasPosition,
  ControlEdge,
  DiscoveredAction,
  EditorState,
  ProjectDocument,
  TestRunSummary,
  ToolDefinition,
  WorkflowNode,
  WorkflowNodeType,
} from "./types";

export interface ProjectChange {
  source: "human" | "agent" | "system";
  action: string;
  revision: number;
  at: number;
}

export interface ProjectCommandSuccess {
  ok: true;
  project: ProjectDocument;
  change: ProjectChange;
}

export interface ProjectCommandFailure {
  ok: false;
  code:
    "revision_conflict" | "invalid_command" | "validation_failed" | "not_found";
  error: string;
  currentRevision: number;
  issues?: ProjectValidationIssue[];
}

export type ProjectCommandResult =
  ProjectCommandSuccess | ProjectCommandFailure;

export type ProjectCommand =
  | {
      type: "set-site";
      domain: string;
      outcome?: string;
      sessionMode?: "public" | "authenticated";
    }
  | { type: "create-tool"; tool?: Partial<ToolDefinition> }
  | { type: "replace-tool"; toolId: string; tool: Partial<ToolDefinition> }
  | { type: "rename-tool"; toolId: string; name: string }
  | {
      type: "update-tool";
      toolId: string;
      patch: Partial<
        Pick<
          ToolDefinition,
          "description" | "inputSchema" | "resultSchema" | "access" | "enabled"
        >
      >;
    }
  | {
      type: "add-node";
      toolId: string;
      nodeType: WorkflowNodeType;
      label?: string;
      afterNodeId?: string;
    }
  | {
      type: "update-node";
      toolId: string;
      nodeId: string;
      patch: Partial<Pick<WorkflowNode, "label" | "position" | "config">>;
    }
  | { type: "remove-node"; toolId: string; nodeId: string }
  | { type: "connect"; toolId: string; edge: ControlEdge }
  | {
      type: "disconnect";
      toolId: string;
      from: string;
      to: string;
      when?: ControlEdge["when"];
    }
  | { type: "select-tool"; toolId?: string }
  | { type: "record-test-run"; run: TestRunSummary }
  | { type: "apply-discovery"; actions: DiscoveredAction[] }
  | { type: "edit-workflow"; toolId: string; changes: WorkflowEdit[] };

export type WorkflowEdit =
  | {
      op: "add_node";
      nodeType: WorkflowNodeType;
      label?: string;
      afterNodeId?: string;
    }
  | {
      op: "update_node";
      nodeId: string;
      patch: Partial<Pick<WorkflowNode, "label" | "position" | "config">>;
    }
  | { op: "remove_node"; nodeId: string }
  | { op: "connect"; edge: ControlEdge }
  | { op: "disconnect"; from: string; to: string; when?: ControlEdge["when"] };

export interface ProjectCommandStoreOptions {
  onChange?: (project: ProjectDocument, change: ProjectChange) => void;
}

function id(prefix: string): string {
  try {
    if (typeof crypto.randomUUID === "function")
      return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    // Test DOMs may not expose randomUUID.
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptySchema(): JSONSchema {
  return { type: "object", properties: {}, additionalProperties: false };
}

function rootLocator(): SemanticLocator {
  return { framePath: [], shadowPath: [], stableAttributes: [], fallbacks: [] };
}

function safeObservedUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function literal(value: JsonValue): Binding {
  return { kind: "literal", value };
}

function makeNode(
  type: WorkflowNodeType,
  label: string,
  position: CanvasPosition,
  capability?: Capability,
): WorkflowNode {
  const base = { id: id(type), type, label, position };
  switch (type) {
    case "dom":
      return {
        ...base,
        type,
        // A newly created tool is a valid draft, but it is intentionally not
        // executable until an observed capability is selected in the node
        // inspector.
        config: { capabilityId: capability?.id ?? "unconfigured", args: {} },
      };
    case "http":
      return {
        ...base,
        type,
        config: {
          method: "GET",
          url: literal("https://example.invalid"),
          parseAs: "json",
        },
      };
    case "wait":
      return {
        ...base,
        type,
        config: { selector: "body", timeoutMs: 10_000, pollMs: 100 },
      };
    case "extract":
      return { ...base, type, config: { selector: "body", includeText: true } };
    case "transform":
      return {
        ...base,
        type,
        config: { source: literal(null), operation: "pick", path: "" },
      };
    case "condition":
      return {
        ...base,
        type,
        config: { left: literal(null), operator: "truthy" },
      };
    case "return":
      return { ...base, type, config: { value: literal(null) } };
  }
}

function makeTool(name: string, capability?: Capability): ToolDefinition {
  const dom = makeNode(
    "dom",
    capability ? `Run ${capability.name}` : "DOM action",
    { x: 0, y: 0 },
    capability,
  );
  const result = makeNode("return", "Return result", { x: 260, y: 0 });
  return {
    id: id("tool"),
    name: normalizeName(name || "new_tool"),
    description: capability?.description ?? "A reusable website capability.",
    inputSchema: capability?.inputSchema ?? emptySchema(),
    access: "public",
    enabled: true,
    workflow: {
      entryNodeId: dom.id,
      nodes: [dom, result],
      edges: [{ from: dom.id, to: result.id, when: "always" }],
    },
  };
}

export function createProject(domain = "", outcome = ""): ProjectDocument {
  const normalized = domain
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\/$/, "");
  let origin: string | undefined;
  try {
    origin = normalized ? new URL(`https://${normalized}`).origin : undefined;
  } catch {
    origin = undefined;
  }
  const initial: ProjectDocument = {
    schemaVersion: 1,
    project: {
      id: id("project"),
      name: normalized || "Untitled site project",
      revision: 0,
    },
    site: {
      domain: normalized,
      ...(origin ? { origin } : {}),
      origins: origin ? [origin] : [],
      sessionMode: "public",
      ...(outcome.trim() ? { goal: outcome.trim() } : {}),
    },
    discoveredActions: [],
    tools: [],
    editor: {
      toolOrder: [],
      nodePositions: {},
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    testRuns: [],
  };
  return initial;
}

export interface DiscoveryImportResult {
  actions: DiscoveredAction[];
  suggestedTools: ToolDefinition[];
}

export function discoveriesFromGraph(
  graph: CapabilityGraph,
): DiscoveryImportResult {
  const actions = Object.values(graph.capabilities).map(
    (capability): DiscoveredAction => {
      const safeCapability: Capability = {
        ...capability,
        source: {
          ...capability.source,
          url: safeObservedUrl(capability.source.url),
        },
      };
      return {
        id: `discovery-${capability.id}`,
        name: capability.name,
        description: capability.description,
        inputSchema: capability.inputSchema,
        effect: capability.effect,
        confidence: capability.confidence,
        access: "public",
        status: "observed",
        evidence: [
          {
            type: "dom",
            url: safeObservedUrl(graph.page.url),
            observedAt: graph.generatedAt,
            locator: capability.locator,
          },
        ],
        capability: safeCapability,
      };
    },
  );
  return {
    actions,
    suggestedTools: actions.map((action) =>
      makeTool(action.name, action.capability),
    ),
  };
}

function updateEditor(
  editor: EditorState,
  tools: readonly ToolDefinition[],
  selectedToolId?: string,
): EditorState {
  const toolOrder = tools.map((tool) => tool.id);
  return {
    ...editor,
    toolOrder,
    ...(selectedToolId ? { selectedToolId } : {}),
  };
}

function findTool(
  project: ProjectDocument,
  toolId: string,
): ToolDefinition | undefined {
  return project.tools.find((tool) => tool.id === toolId);
}

function replaceTool(project: ProjectDocument, updated: ToolDefinition): void {
  const index = project.tools.findIndex((tool) => tool.id === updated.id);
  if (index >= 0) project.tools[index] = updated;
}

function normalizeName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64) || "new_tool"
  );
}

function mutate(project: ProjectDocument, command: ProjectCommand): string {
  switch (command.type) {
    case "set-site": {
      const domain = command.domain
        .trim()
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "")
        .replace(/\/$/, "");
      project.site.domain = domain;
      if (command.outcome !== undefined) {
        const goal = command.outcome.trim();
        if (goal) project.site.goal = goal;
        else delete project.site.goal;
      }
      project.site.sessionMode =
        command.sessionMode ?? project.site.sessionMode;
      try {
        const origin = new URL(
          domain.includes("://") ? domain : `https://${domain}`,
        ).origin;
        project.site.origin = origin;
        project.site.origins = [origin];
      } catch {
        delete project.site.origin;
        project.site.origins = [];
      }
      return "set_site";
    }
    case "create-tool": {
      const supplied = command.tool;
      const tool = makeTool(normalizeName(supplied?.name ?? "new_tool"));
      if (supplied) {
        Object.assign(tool, supplied, {
          id: tool.id,
          name: normalizeName(supplied.name ?? tool.name),
        });
      }
      project.tools.push(tool);
      project.editor = updateEditor(project.editor, project.tools, tool.id);
      return "create_tool";
    }
    case "replace-tool": {
      const tool = findTool(project, command.toolId);
      if (!tool) throw new Error("tool_not_found");
      const supplied = command.tool;
      Object.assign(tool, supplied, {
        id: tool.id,
        ...(typeof supplied.name === "string"
          ? { name: normalizeName(supplied.name) }
          : {}),
      });
      return "replace_tool";
    }
    case "rename-tool": {
      const tool = findTool(project, command.toolId);
      if (!tool) throw new Error("tool_not_found");
      tool.name = normalizeName(command.name);
      return "rename_tool";
    }
    case "update-tool": {
      const tool = findTool(project, command.toolId);
      if (!tool) throw new Error("tool_not_found");
      Object.assign(tool, command.patch);
      return "update_tool";
    }
    case "add-node": {
      const tool = findTool(project, command.toolId);
      if (!tool) throw new Error("tool_not_found");
      const nodes = tool.workflow.nodes;
      const terminalIndex = nodes.findIndex((node) => node.type === "return");
      const afterIndex = command.afterNodeId
        ? nodes.findIndex((node) => node.id === command.afterNodeId)
        : terminalIndex >= 0
          ? terminalIndex - 1
          : nodes.length - 1;
      if (command.afterNodeId && afterIndex < 0)
        throw new Error("node_not_found");
      const position = { x: Math.max(0, afterIndex + 1) * 260, y: 0 };
      const node = makeNode(
        command.nodeType,
        command.label?.trim() || command.nodeType,
        position,
      );
      if (
        command.nodeType === "return" &&
        nodes.some((candidate) => candidate.type === "return")
      )
        throw new Error("return_node_exists");
      nodes.splice(Math.max(0, afterIndex + 1), 0, node);
      const previous = nodes[Math.max(0, afterIndex)];
      if (previous && previous.id !== node.id) {
        const old = tool.workflow.edges.find(
          (edge) =>
            edge.from === previous.id &&
            (edge.when === "always" || edge.when === undefined),
        );
        if (old) {
          old.from = node.id;
          tool.workflow.edges.push({
            from: previous.id,
            to: node.id,
            when: "always",
          });
        } else if (previous.type !== "condition") {
          tool.workflow.edges.push({
            from: previous.id,
            to: node.id,
            when: "always",
          });
        }
      }
      if (node.type !== "return") {
        const next = nodes[nodes.indexOf(node) + 1];
        if (next && node.type !== "condition")
          tool.workflow.edges.push({
            from: node.id,
            to: next.id,
            when: "always",
          });
      }
      return "add_node";
    }
    case "update-node": {
      const tool = findTool(project, command.toolId);
      const node = tool?.workflow.nodes.find(
        (candidate) => candidate.id === command.nodeId,
      );
      if (!tool || !node) throw new Error("node_not_found");
      Object.assign(node, command.patch);
      return "update_node";
    }
    case "remove-node": {
      const tool = findTool(project, command.toolId);
      if (!tool) throw new Error("tool_not_found");
      if (tool.workflow.entryNodeId === command.nodeId)
        throw new Error("entry_node_cannot_be_removed");
      const index = tool.workflow.nodes.findIndex(
        (node) => node.id === command.nodeId,
      );
      if (index < 0) throw new Error("node_not_found");
      tool.workflow.nodes.splice(index, 1);
      tool.workflow.edges = tool.workflow.edges.filter(
        (edge) => edge.from !== command.nodeId && edge.to !== command.nodeId,
      );
      return "remove_node";
    }
    case "connect": {
      const tool = findTool(project, command.toolId);
      if (!tool) throw new Error("tool_not_found");
      tool.workflow.edges.push({ ...command.edge });
      return "connect_nodes";
    }
    case "disconnect": {
      const tool = findTool(project, command.toolId);
      if (!tool) throw new Error("tool_not_found");
      tool.workflow.edges = tool.workflow.edges.filter(
        (edge) =>
          !(
            edge.from === command.from &&
            edge.to === command.to &&
            (command.when === undefined || edge.when === command.when)
          ),
      );
      return "disconnect_nodes";
    }
    case "select-tool": {
      if (command.toolId !== undefined && !findTool(project, command.toolId))
        throw new Error("tool_not_found");
      project.editor = updateEditor(
        project.editor,
        project.tools,
        command.toolId,
      );
      return "select_tool";
    }
    case "record-test-run": {
      const run = command.run;
      if (!run || typeof run !== "object" || !findTool(project, run.toolId))
        throw new Error("tool_not_found");
      if (run.revision !== project.project.revision)
        throw new Error("test_revision_mismatch");
      project.testRuns = [
        ...project.testRuns.filter((candidate) => candidate.id !== run.id),
        run,
      ].slice(-50);
      return "record_test_run";
    }
    case "apply-discovery": {
      const existing = new Set(
        project.discoveredActions.map((action) => action.id),
      );
      for (const action of command.actions)
        if (!existing.has(action.id)) project.discoveredActions.push(action);
      const existingNames = new Set(project.tools.map((tool) => tool.name));
      for (const action of command.actions) {
        if (
          !action.capability ||
          existingNames.has(action.name) ||
          action.status === "blocked"
        )
          continue;
        const tool = makeTool(normalizeName(action.name), action.capability);
        project.tools.push(tool);
        existingNames.add(tool.name);
      }
      project.editor = updateEditor(
        project.editor,
        project.tools,
        project.editor.selectedToolId ?? project.tools[0]?.id,
      );
      return "apply_discovery";
    }
    case "edit-workflow": {
      if (!findTool(project, command.toolId)) throw new Error("tool_not_found");
      for (const change of command.changes) {
        switch (change.op) {
          case "add_node":
            mutate(project, {
              type: "add-node",
              toolId: command.toolId,
              nodeType: change.nodeType,
              ...(change.label === undefined ? {} : { label: change.label }),
              ...(change.afterNodeId === undefined
                ? {}
                : { afterNodeId: change.afterNodeId }),
            });
            break;
          case "update_node":
            mutate(project, {
              type: "update-node",
              toolId: command.toolId,
              nodeId: change.nodeId,
              patch: change.patch,
            });
            break;
          case "remove_node":
            mutate(project, {
              type: "remove-node",
              toolId: command.toolId,
              nodeId: change.nodeId,
            });
            break;
          case "connect":
            mutate(project, {
              type: "connect",
              toolId: command.toolId,
              edge: change.edge,
            });
            break;
          case "disconnect":
            mutate(project, {
              type: "disconnect",
              toolId: command.toolId,
              from: change.from,
              to: change.to,
              ...(change.when === undefined ? {} : { when: change.when }),
            });
            break;
        }
      }
      return "edit_workflow";
    }
  }
}

export class ProjectCommandStore {
  private project: ProjectDocument;
  private readonly history: ProjectDocument[] = [];
  private readonly changes: ProjectChange[] = [];
  private readonly onChange?: ProjectCommandStoreOptions["onChange"];

  constructor(
    project: ProjectDocument = createProject(),
    options: ProjectCommandStoreOptions = {},
  ) {
    this.project = cloneProject(validateProject(project));
    this.onChange = options.onChange;
  }

  get(): ProjectDocument {
    return cloneProject(this.project);
  }
  getRevision(): number {
    return this.project.project.revision;
  }
  getChanges(): readonly ProjectChange[] {
    return [...this.changes];
  }
  getHistoryDepth(): number {
    return this.history.length;
  }
  getFingerprint(): string {
    return projectFingerprint(this.project);
  }
  getTool(toolId?: string): ToolDefinition | null {
    return (
      cloneProject(this.project).tools.find((tool) => tool.id === toolId) ??
      null
    );
  }

  apply(
    command: ProjectCommand,
    expectedRevision: number,
    source: ProjectChange["source"] = "human",
  ): ProjectCommandResult {
    if (
      !Number.isInteger(expectedRevision) ||
      expectedRevision !== this.project.project.revision
    )
      return {
        ok: false,
        code: "revision_conflict",
        error: `Draft revision ${this.project.project.revision} is newer than the requested revision. Read the project before editing again.`,
        currentRevision: this.project.project.revision,
      };
    const next = cloneProject(this.project);
    let action: string;
    try {
      action = mutate(next, command);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        code: reason.endsWith("_not_found") ? "not_found" : "invalid_command",
        error: reason,
        currentRevision: this.project.project.revision,
      };
    }
    next.project.revision += 1;
    const validation = (() => {
      try {
        return {
          value: validateProject(next),
          issues: [] as ProjectValidationIssue[],
        };
      } catch (error) {
        return {
          value: undefined,
          issues:
            error instanceof Error && "issues" in error
              ? (error as { issues: ProjectValidationIssue[] }).issues
              : [{ path: "project", message: String(error) }],
        };
      }
    })();
    if (!validation.value)
      return {
        ok: false,
        code: "validation_failed",
        error: validation.issues
          .map((item) => `${item.path}: ${item.message}`)
          .join("; "),
        currentRevision: this.project.project.revision,
        issues: validation.issues,
      };
    this.history.push(this.project);
    this.project = next;
    const change: ProjectChange = {
      source,
      action,
      revision: next.project.revision,
      at: Date.now(),
    };
    this.changes.push(change);
    this.onChange?.(this.get(), change);
    return { ok: true, project: this.get(), change };
  }

  undo(
    expectedRevision: number,
    source: ProjectChange["source"] = "human",
  ): ProjectCommandResult {
    if (expectedRevision !== this.project.project.revision)
      return {
        ok: false,
        code: "revision_conflict",
        error: "The draft changed before undo was requested.",
        currentRevision: this.project.project.revision,
      };
    const previous = this.history.pop();
    if (!previous)
      return {
        ok: false,
        code: "invalid_command",
        error: "There is no draft change to undo.",
        currentRevision: this.project.project.revision,
      };
    const restored = cloneProject(previous);
    restored.project.revision = this.project.project.revision + 1;
    this.project = validateProject(restored);
    const change: ProjectChange = {
      source,
      action: "undo",
      revision: this.project.project.revision,
      at: Date.now(),
    };
    this.changes.push(change);
    this.onChange?.(this.get(), change);
    return { ok: true, project: this.get(), change };
  }

  replace(
    project: ProjectDocument,
    source: ProjectChange["source"] = "human",
  ): ProjectCommandResult {
    let validated: ProjectDocument;
    try {
      validated = cloneProject(validateProject(project));
    } catch (error) {
      const issues =
        error instanceof Error && "issues" in error
          ? (error as { issues: ProjectValidationIssue[] }).issues
          : [];
      return {
        ok: false,
        code: "validation_failed",
        error: error instanceof Error ? error.message : String(error),
        currentRevision: this.project.project.revision,
        issues,
      };
    }
    this.history.push(this.project);
    validated.project.revision = this.project.project.revision + 1;
    this.project = validateProject(validated);
    const change: ProjectChange = {
      source,
      action: "import_project",
      revision: this.project.project.revision,
      at: Date.now(),
    };
    this.changes.push(change);
    this.onChange?.(this.get(), change);
    return { ok: true, project: this.get(), change };
  }
}

export const ProjectStore = ProjectCommandStore;
