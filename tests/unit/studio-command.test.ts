import { describe, expect, it } from "vitest";
import { createCapabilityGraph } from "../../core/graph";
import {
  ProjectCommandStore,
  ProjectValidationError,
  createProject,
  discoveriesFromGraph,
  parseProject,
  serializeProject,
  validateProjectResult,
  validateRunnable,
} from "../../core/project";
import type {
  Capability,
  CapabilityGraph,
  JSONSchema,
  JsonValue,
  SemanticLocator,
} from "../../core/types";
import type {
  ControlEdge,
  DiscoveredAction,
  ProjectDocument,
  ToolDefinition,
  Workflow,
  WorkflowNode,
} from "../../core/project";

const page = {
  url: "https://shop.test/catalog",
  title: "Catalog",
  origin: "https://shop.test",
  hostname: "shop.test",
};

const emptySchema: JSONSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

function locator(name: string): SemanticLocator {
  return {
    framePath: [],
    shadowPath: [],
    role: "button",
    accessibleName: name,
    stableAttributes: [{ name: "data-testid", value: name }],
    fallbacks: [],
  };
}

function capability(overrides: Partial<Capability> = {}): Capability {
  const target = locator("Search");
  return {
    id: "search-products",
    name: "search_products",
    description: "Search the catalog",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    effect: "interact",
    confidence: 0.92,
    source: {
      type: "inferred",
      url: page.url,
      framePath: [],
      shadowPath: [],
      nodeSignature: "search-form",
    },
    locator: target,
    executor: {
      kind: "action",
      action: "click",
      target,
      expected: { event: "click", textIncludes: "Results" },
    },
    ...overrides,
  };
}

function graph(
  capabilities: readonly Capability[] = [capability()],
): CapabilityGraph {
  return createCapabilityGraph({
    page,
    capabilities,
    generatedAt: 123,
  });
}

function domNode(id: string, capabilityId: string): WorkflowNode {
  return {
    id,
    type: "dom",
    label: `Run ${capabilityId}`,
    position: { x: 0, y: 0 },
    config: { capabilityId, args: {} },
  };
}

function waitNode(id: string): WorkflowNode {
  return {
    id,
    type: "wait",
    label: "Wait for results",
    position: { x: 260, y: 0 },
    config: { textIncludes: "Results", timeoutMs: 100, pollMs: 10 },
  };
}

function returnNode(id: string, value: JsonValue = null): WorkflowNode {
  return {
    id,
    type: "return",
    label: "Return result",
    position: { x: 520, y: 0 },
    config: { value: { kind: "literal", value } },
  };
}

function capabilityWorkflow(capabilityId: string, prefix: string): Workflow {
  const dom = domNode(`${prefix}-dom`, capabilityId);
  const result = returnNode(`${prefix}-return`);
  return {
    entryNodeId: dom.id,
    nodes: [dom, result],
    edges: [{ from: dom.id, to: result.id, when: "always" }],
  };
}

function connectableWorkflow(capabilityId: string, prefix: string): Workflow {
  const dom = domNode(`${prefix}-dom`, capabilityId);
  const wait = waitNode(`${prefix}-wait`);
  const result = returnNode(`${prefix}-return`);
  return {
    entryNodeId: dom.id,
    nodes: [dom, wait, result],
    edges: [{ from: dom.id, to: wait.id, when: "always" }],
  };
}

function conditionalWorkflow(capabilityId: string, prefix: string): Workflow {
  const dom = domNode(`${prefix}-dom`, capabilityId);
  const condition: WorkflowNode = {
    id: `${prefix}-condition`,
    type: "condition",
    label: "Has results",
    position: { x: 260, y: 0 },
    config: {
      left: { kind: "literal", value: true },
      operator: "truthy",
    },
  };
  const trueResult = returnNode(`${prefix}-true`, "found");
  const falseResult = returnNode(`${prefix}-false`, "empty");
  return {
    entryNodeId: dom.id,
    nodes: [dom, condition, trueResult, falseResult],
    edges: [
      { from: dom.id, to: condition.id, when: "always" },
      { from: condition.id, to: trueResult.id, when: "true" },
      { from: condition.id, to: falseResult.id, when: "false" },
    ],
  };
}

function tool(name: string, workflow: Workflow): ToolDefinition {
  return {
    id: `tool-${name}`,
    name,
    description: `${name} tool`,
    inputSchema: emptySchema,
    access: "public",
    enabled: true,
    workflow,
  };
}

function projectWithTools(tools: readonly ToolDefinition[]): ProjectDocument {
  const project = createProject("shop.test", "Search the catalog");
  project.tools = [...tools];
  project.editor.toolOrder = tools.map((item) => item.id);
  const first = tools[0];
  if (first) project.editor.selectedToolId = first.id;
  return project;
}

function blockedDiscovery(): DiscoveredAction {
  return {
    id: "discovery-blocked",
    name: "delete_account",
    description: "Delete the account",
    inputSchema: emptySchema,
    effect: "mutate",
    confidence: 0.3,
    access: "authenticated",
    status: "blocked",
    blockedReason: "Requires an explicit human approval",
    evidence: [{ type: "dom", url: page.url, observedAt: 123 }],
  };
}

describe("Studio project commands", () => {
  it("creates the canonical empty project from a domain and goal", () => {
    const project = createProject(
      " https://shop.test/catalog/ ",
      " Find products ",
    );

    expect(project.schemaVersion).toBe(1);
    expect(project.project.name).toBe("shop.test");
    expect(project.project.revision).toBe(0);
    expect(project.site).toEqual({
      domain: "shop.test",
      goal: "Find products",
      origin: "https://shop.test",
      origins: ["https://shop.test"],
      sessionMode: "public",
    });
    expect(project.discoveredActions).toEqual([]);
    expect(project.tools).toEqual([]);
    expect(project.editor).toEqual({
      toolOrder: [],
      nodePositions: {},
      viewport: { x: 0, y: 0, zoom: 1 },
    });
  });

  it("increments revisions and rejects stale edits atomically", () => {
    const store = new ProjectCommandStore(createProject("shop.test"));

    const first = store.apply(
      {
        type: "set-site",
        domain: "shop.test/checkout",
        outcome: "Complete checkout",
        sessionMode: "authenticated",
      },
      0,
    );

    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected the initial edit to succeed");
    expect(first.project.project.revision).toBe(1);
    expect(first.change).toMatchObject({
      action: "set_site",
      revision: 1,
      source: "human",
    });

    const beforeStaleEdit = store.get();
    const stale = store.apply(
      { type: "set-site", domain: "other.test" },
      0,
      "agent",
    );

    expect(stale).toMatchObject({
      ok: false,
      code: "revision_conflict",
      currentRevision: 1,
    });
    expect(store.get()).toEqual(beforeStaleEdit);
    expect(store.getChanges()).toHaveLength(1);
  });

  it("undoes the last draft edit with a new revision and preserves conflict safety", () => {
    const store = new ProjectCommandStore(createProject("shop.test"));
    const created = store.apply(
      {
        type: "create-tool",
        tool: {
          name: "search_products",
          workflow: capabilityWorkflow("search-products", "undo"),
        },
      },
      0,
    );

    expect(created.ok).toBe(true);
    expect(store.getHistoryDepth()).toBe(1);

    const staleUndo = store.undo(0);
    expect(staleUndo).toMatchObject({
      ok: false,
      code: "revision_conflict",
      currentRevision: 1,
    });
    expect(store.getHistoryDepth()).toBe(1);

    const undone = store.undo(1);
    expect(undone.ok).toBe(true);
    if (!undone.ok) throw new Error("expected undo to succeed");
    expect(undone.project.project.revision).toBe(2);
    expect(undone.project.tools).toEqual([]);
    expect(undone.change).toMatchObject({ action: "undo", revision: 2 });
    expect(store.getHistoryDepth()).toBe(0);

    const emptyUndo = store.undo(2);
    expect(emptyUndo).toMatchObject({
      ok: false,
      code: "invalid_command",
      currentRevision: 2,
    });
  });

  it("round-trips exports and rejects invalid or oversized imports", () => {
    const source = new ProjectCommandStore(createProject("shop.test"));
    const created = source.apply(
      {
        type: "create-tool",
        tool: {
          name: "search_products",
          workflow: capabilityWorkflow("search-products", "round-trip"),
        },
      },
      0,
    );
    expect(created.ok).toBe(true);
    if (!created.ok)
      throw new Error("expected the project fixture to be valid");

    const exported = serializeProject(created.project);
    expect(parseProject(exported)).toEqual(created.project);
    expect(() => parseProject("{not-json")).toThrow(ProjectValidationError);

    const wrongVersion = JSON.parse(exported) as Record<string, unknown>;
    wrongVersion.schemaVersion = 99;
    expect(() => parseProject(JSON.stringify(wrongVersion))).toThrow(
      /schemaVersion.*must be 1/,
    );
    expect(() => parseProject(exported, { maxBytes: 10 })).toThrow(
      /size limit/,
    );

    const imported = new ProjectCommandStore(createProject("other.test"));
    const rejected = imported.replace(
      wrongVersion as unknown as ProjectDocument,
      "agent",
    );
    expect(rejected).toMatchObject({
      ok: false,
      code: "validation_failed",
      currentRevision: 0,
    });
    expect(imported.get().site.domain).toBe("other.test");
    expect(imported.getChanges()).toEqual([]);
  });

  it("retains discoveries, creates suggested tools, and gives each tool owned nodes", () => {
    const discovered = discoveriesFromGraph(graph());
    const action = discovered.actions[0];
    const suggested = discovered.suggestedTools[0];
    if (!action || !suggested) throw new Error("expected a discovery fixture");

    expect(action).toMatchObject({
      id: "discovery-search-products",
      name: "search_products",
      status: "observed",
      capability: { id: "search-products" },
    });
    expect(suggested.workflow.nodes).toHaveLength(2);

    const store = new ProjectCommandStore(createProject("shop.test"));
    const applied = store.apply(
      { type: "apply-discovery", actions: [action, blockedDiscovery()] },
      0,
      "agent",
    );
    expect(applied.ok).toBe(true);
    if (!applied.ok)
      throw new Error("expected discovery application to succeed");
    expect(applied.project.discoveredActions.map((item) => item.id)).toEqual([
      action.id,
      "discovery-blocked",
    ]);
    expect(applied.project.tools).toHaveLength(1);
    expect(applied.project.tools[0]?.name).toBe("search_products");

    const primary = applied.project.tools[0];
    if (!primary) throw new Error("expected the suggested tool to be stored");
    const primaryDom = primary.workflow.nodes.find(
      (node) => node.type === "dom",
    );
    if (!primaryDom || primaryDom.type !== "dom")
      throw new Error("expected a DOM node in the suggested tool");
    expect(primaryDom.config.capabilityId).toBe(action.capability?.id);

    const second = store.apply(
      {
        type: "create-tool",
        tool: {
          name: "search_products_alt",
          workflow: capabilityWorkflow(
            action.capability?.id ?? "",
            "secondary",
          ),
        },
      },
      1,
    );
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected the second tool to succeed");
    const secondary = second.project.tools.find(
      (item) => item.name === "search_products_alt",
    );
    if (!secondary) throw new Error("expected the second tool to be stored");
    const secondaryDom = secondary.workflow.nodes.find(
      (node) => node.type === "dom",
    );
    if (!secondaryDom || secondaryDom.type !== "dom")
      throw new Error("expected a DOM node in the second tool");

    expect(secondaryDom.config.capabilityId).toBe(
      primaryDom.config.capabilityId,
    );
    expect(secondaryDom.id).not.toBe(primaryDom.id);

    const updated = store.apply(
      {
        type: "update-node",
        toolId: secondary.id,
        nodeId: secondaryDom.id,
        patch: { label: "Edited only in the second tool" },
      },
      2,
    );
    expect(updated.ok).toBe(true);
    expect(store.getTool(primary.id)?.workflow.nodes[0]?.label).toBe(
      primaryDom.label,
    );
    expect(store.getTool(secondary.id)?.workflow.nodes[0]?.label).toBe(
      "Edited only in the second tool",
    );
  });
});

describe("Studio workflow connection validation", () => {
  it("accepts a valid sequential connection and rejects missing or branch-invalid edges", () => {
    const connectable = tool(
      "connectable_tool",
      connectableWorkflow("search-products", "connect"),
    );
    const store = new ProjectCommandStore(projectWithTools([connectable]));
    const wait = connectable.workflow.nodes.find(
      (node) => node.type === "wait",
    );
    const result = connectable.workflow.nodes.find(
      (node) => node.type === "return",
    );
    if (!wait || !result)
      throw new Error("expected connectable workflow nodes");

    const connected = store.apply(
      {
        type: "connect",
        toolId: connectable.id,
        edge: { from: wait.id, to: result.id, when: "always" },
      },
      0,
    );
    expect(connected.ok).toBe(true);
    expect(
      connected.ok && connected.project.tools[0]?.workflow.edges,
    ).toContainEqual({
      from: wait.id,
      to: result.id,
      when: "always",
    });

    const missingNode = store.apply(
      {
        type: "connect",
        toolId: connectable.id,
        edge: { from: wait.id, to: "missing-node", when: "always" },
      },
      1,
    );
    expect(missingNode).toMatchObject({
      ok: false,
      code: "validation_failed",
      currentRevision: 1,
    });
    if (missingNode.ok)
      throw new Error("expected a missing node to be rejected");
    expect(missingNode.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining(".to"),
          message: expect.stringContaining("missing node"),
        }),
      ]),
    );

    const branchOnSequential = store.apply(
      {
        type: "connect",
        toolId: connectable.id,
        edge: { from: wait.id, to: result.id, when: "true" },
      },
      1,
    );
    expect(branchOnSequential).toMatchObject({
      ok: false,
      code: "validation_failed",
      currentRevision: 1,
    });
    expect(store.getRevision()).toBe(1);
  });

  it("requires exactly one true and one false edge for runnable conditions", () => {
    const valid = tool(
      "branch_tool",
      conditionalWorkflow("search-products", "valid"),
    );
    const validProject = projectWithTools([valid]);
    expect(() => validateRunnable(validProject)).not.toThrow();

    const invalidWorkflow = conditionalWorkflow("search-products", "invalid");
    const conditionId = "invalid-condition";
    invalidWorkflow.edges = invalidWorkflow.edges.filter(
      (edge) => !(edge.from === conditionId && edge.when === "false"),
    );
    const invalid = validateProjectResult(
      projectWithTools([tool("invalid_branch_tool", invalidWorkflow)]),
      { requireRunnable: true },
    );

    expect(invalid.ok).toBe(false);
    expect(invalid.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining("invalid-condition"),
          message: expect.stringContaining(
            "exactly one true and one false edge",
          ),
        }),
      ]),
    );
  });
});
