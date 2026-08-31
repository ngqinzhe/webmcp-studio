import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { runWorkflow } from "../../core/workflow/interpreter";
import { MAX_TRACE_VALUE_LENGTH } from "../../core/project";
import type {
  Binding,
  ConditionNodeConfig,
  DomNodeConfig,
  ExtractNodeConfig,
  HttpNodeConfig,
  ProjectDocument,
  ReturnNodeConfig,
  TransformNodeConfig,
  WaitNodeConfig,
  Workflow,
  WorkflowNode,
  WorkflowNodeType,
} from "../../core/project";
import {
  type JsonValue,
  type ExecutionResult,
  type JSONSchema,
} from "../../core/types";

type NodeConfigByType = {
  http: HttpNodeConfig;
  dom: DomNodeConfig;
  wait: WaitNodeConfig;
  extract: ExtractNodeConfig;
  transform: TransformNodeConfig;
  condition: ConditionNodeConfig;
  return: ReturnNodeConfig;
};

const permissiveInputSchema: JSONSchema = {
  type: "object",
  additionalProperties: true,
};

function literal(value: JsonValue): Binding {
  return { kind: "literal", value };
}

function input(path: string): Binding {
  return { kind: "input", path };
}

function output(nodeId: string, path?: string): Binding {
  return path === undefined
    ? { kind: "output", nodeId }
    : { kind: "output", nodeId, path };
}

function context(path: "url" | "origin" | "title"): Binding {
  return { kind: "context", path };
}

function node<T extends WorkflowNodeType>(
  type: T,
  id: string,
  config: NodeConfigByType[T],
): Extract<WorkflowNode, { type: T }> {
  return {
    id,
    type,
    label: id,
    position: { x: 0, y: 0 },
    config,
  } as Extract<WorkflowNode, { type: T }>;
}

function sequential(nodes: WorkflowNode[]): Workflow {
  const entry = nodes[0];
  if (!entry) throw new Error("A workflow needs an entry node.");

  return {
    entryNodeId: entry.id,
    nodes,
    edges: nodes.slice(0, -1).map((current, index) => {
      const next = nodes[index + 1];
      if (!next) throw new Error("A sequential workflow edge needs a target.");
      return { from: current.id, to: next.id, when: "always" };
    }),
  };
}

function tool(
  workflow: Workflow,
  overrides: Partial<
    Pick<ProjectDocument["tools"][number], "id" | "name" | "inputSchema">
  > = {},
): ProjectDocument["tools"][number] {
  return {
    id: "workflow-tool",
    name: "workflow_tool",
    description: "A workflow interpreter test tool.",
    inputSchema: permissiveInputSchema,
    access: "public",
    enabled: true,
    workflow,
    ...overrides,
  };
}

function successfulExecution(result: JsonValue): ExecutionResult {
  return {
    success: true,
    status: "completed",
    urlBefore: "https://example.test/workflow",
    urlAfter: "https://example.test/workflow",
    navigationOccurred: false,
    stateChanged: true,
    result,
    warnings: [],
  };
}

describe("canonical project workflow interpreter", () => {
  it("runs all seven node types through one sequential workflow", async () => {
    const dom = new JSDOM(
      `<main><div id="ready">Ready</div><article id="card">Ready card</article></main>`,
      { url: "https://example.test/workflow" },
    );
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { id: 7 } }),
      text: async () => "unused",
    }));
    const executeCapability = vi.fn(
      async (_capabilityId: string, _args: unknown): Promise<ExecutionResult> =>
        successfulExecution({ accepted: true }),
    );

    const workflow = sequential([
      node("http", "http", {
        method: "GET",
        url: literal("https://api.example.test/items"),
      }),
      node("dom", "dom", {
        capabilityId: "mark_ready",
        args: { payload: output("http", "data.id") },
      }),
      node("wait", "wait", {
        selector: "#ready",
        timeoutMs: 20,
        pollMs: 1,
      }),
      node("extract", "extract", {
        selector: "#card",
        includeText: true,
      }),
      node("transform", "transform", {
        source: output("extract"),
        operation: "pick",
        path: "text",
      }),
      node("condition", "condition", {
        left: output("transform"),
        operator: "equals",
        right: literal("Ready card"),
      }),
      node("return", "return", {
        fields: {
          httpId: output("http", "data.id"),
          domAccepted: output("dom", "accepted"),
          extracted: output("extract", "text"),
          transformed: output("transform"),
          pageUrl: context("url"),
        },
      }),
    ]);
    workflow.edges = [
      { from: "http", to: "dom", when: "always" },
      { from: "dom", to: "wait", when: "always" },
      { from: "wait", to: "extract", when: "always" },
      { from: "extract", to: "transform", when: "always" },
      { from: "transform", to: "condition", when: "always" },
      { from: "condition", to: "return", when: "true" },
      {
        from: "condition",
        to: "return",
        when: "false",
      },
    ];

    try {
      const result = await runWorkflow(
        tool(workflow, { id: "pipeline", name: "run_pipeline" }),
        {},
        {
          runId: "pipeline-run",
          runtime: {
            document: dom.window.document,
            urlProvider: () => "https://example.test/workflow",
            fetch: fetchMock as unknown as typeof fetch,
            executeCapability,
          },
        },
      );

      expect(result).toMatchObject({
        success: true,
        status: "completed",
        runId: "pipeline-run",
        toolId: "pipeline",
        revision: 0,
        warnings: [],
      });
      expect(result.result).toEqual({
        httpId: 7,
        domAccepted: true,
        extracted: "Ready card",
        transformed: "Ready card",
        pageUrl: "https://example.test/workflow",
      });
      expect(
        result.trace.map(({ nodeId, type, status }) => ({
          nodeId,
          type,
          status,
        })),
      ).toEqual([
        { nodeId: "http", type: "http", status: "completed" },
        { nodeId: "dom", type: "dom", status: "completed" },
        { nodeId: "wait", type: "wait", status: "completed" },
        { nodeId: "extract", type: "extract", status: "completed" },
        { nodeId: "transform", type: "transform", status: "completed" },
        { nodeId: "condition", type: "condition", status: "completed" },
        { nodeId: "return", type: "return", status: "completed" },
      ]);
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.example.test/items",
        expect.objectContaining({ method: "GET" }),
      );
      expect(executeCapability).toHaveBeenCalledWith("mark_ready", {
        payload: 7,
      });
    } finally {
      dom.window.close();
    }
  });

  it.each([
    { flag: true, branch: "true-return", value: "true branch" },
    { flag: false, branch: "false-return", value: "false branch" },
  ])("takes the $branch condition branch", async ({ flag, branch, value }) => {
    const workflow: Workflow = {
      entryNodeId: "condition",
      nodes: [
        node("condition", "condition", {
          left: input("flag"),
          operator: "truthy",
        }),
        node("return", "true-return", { value: literal("true branch") }),
        node("return", "false-return", { value: literal("false branch") }),
      ],
      edges: [
        { from: "condition", to: "true-return", when: "true" },
        { from: "condition", to: "false-return", when: "false" },
      ],
    };
    const branchInputSchema: JSONSchema = {
      type: "object",
      properties: { flag: { type: "boolean" } },
      required: ["flag"],
      additionalProperties: false,
    };

    const result = await runWorkflow(
      tool(workflow, {
        id: `branch-${flag}`,
        name: `branch_${flag}`,
        inputSchema: branchInputSchema,
      }),
      { flag },
      { runId: `branch-${flag}-run` },
    );

    expect(result.success).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.result).toBe(value);
    expect(result.trace.map((entry) => entry.nodeId)).toEqual([
      "condition",
      branch,
    ]);
    expect(result.trace[0]?.output).toBe(flag);
  });

  it("rejects invalid input before executing a valid workflow", async () => {
    const inputSchema: JSONSchema = {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    };
    const workflow = sequential([
      node("return", "return", { value: input("query") }),
    ]);

    const result = await runWorkflow(
      tool(workflow, {
        id: "invalid-input",
        name: "invalid_input",
        inputSchema,
      }),
      {},
      { runId: "invalid-input-run" },
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe("invalid_arguments");
    expect(result.trace).toEqual([]);
    expect(result.warnings).toContain("$input.query is required.");
  });

  it("reports unresolved bindings and rejects output ownership violations", async () => {
    const unresolvedWorkflow = sequential([
      node("return", "return", { value: input("missing") }),
    ]);
    const unresolved = await runWorkflow(
      tool(unresolvedWorkflow, {
        id: "unresolved-binding",
        name: "unresolved_binding",
      }),
      {},
      { runId: "unresolved-binding-run" },
    );

    expect(unresolved.success).toBe(false);
    expect(unresolved.status).toBe("invalid_arguments");
    expect(unresolved.failedNodeId).toBe("return");
    expect(unresolved.trace).toMatchObject([
      {
        nodeId: "return",
        status: "failed",
        error: "Input binding missing is unavailable.",
      },
    ]);

    const invalidOwnershipWorkflow = sequential([
      node("return", "return", { value: output("missing-node") }),
    ]);
    const invalidOwnership = await runWorkflow(
      tool(invalidOwnershipWorkflow, {
        id: "invalid-ownership",
        name: "invalid_ownership",
      }),
      {},
      { runId: "invalid-ownership-run" },
    );

    expect(invalidOwnership.success).toBe(false);
    expect(invalidOwnership.status).toBe("validation_failed");
    expect(invalidOwnership.trace).toEqual([]);
    expect(invalidOwnership.warnings.join(" ")).toContain(
      "references a node outside this workflow",
    );
  });

  it("cancels an in-flight HTTP node and records a failed trace entry", async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("abort sentinel"));
          });
        }),
    );
    const workflow = sequential([
      node("http", "http", {
        method: "GET",
        url: literal("https://api.example.test/slow"),
      }),
      node("return", "return", { value: literal("never reached") }),
    ]);

    const pending = runWorkflow(
      tool(workflow, { id: "cancelled", name: "cancelled_tool" }),
      {},
      {
        runId: "cancelled-run",
        runtime: {
          fetch: fetchMock as unknown as typeof fetch,
          signal: controller.signal,
        },
      },
    );
    controller.abort();
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.status).toBe("cancelled");
    expect(result.failedNodeId).toBe("http");
    expect(result.trace).toMatchObject([
      {
        nodeId: "http",
        type: "http",
        status: "failed",
        error: "The HTTP request was cancelled.",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("abort sentinel");
  });

  it("returns an execution timeout when the workflow reaches its step limit", async () => {
    const workflow = sequential([
      node("transform", "transform", {
        source: literal("step one"),
        operation: "stringify",
      }),
      node("return", "return", { value: output("transform") }),
    ]);

    const result = await runWorkflow(
      tool(workflow, { id: "step-timeout", name: "step_timeout" }),
      {},
      { runId: "step-timeout-run", maxSteps: 1 },
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe("execution_timeout");
    expect(result.failedNodeId).toBe("return");
    expect(result.trace).toMatchObject([
      { nodeId: "transform", type: "transform", status: "completed" },
    ]);
    expect(result.warnings.join(" ")).toContain(
      "The workflow exceeded its step limit.",
    );
  });

  it("redacts sensitive trace fields and truncates oversized values", async () => {
    const password = "trace-password-sentinel";
    const token = "trace-token-sentinel";
    const longValue = "x".repeat(MAX_TRACE_VALUE_LENGTH + 25);
    const workflow = sequential([
      node("return", "return", {
        fields: {
          payload: input("payload"),
          longValue: input("longValue"),
        },
      }),
    ]);

    const result = await runWorkflow(
      tool(workflow, { id: "sanitized", name: "sanitized_tool" }),
      {
        payload: {
          password,
          nested: { token },
          message: "public trace value",
        },
        longValue,
      },
      { runId: "sanitized-run" },
    );
    const expected = {
      payload: {
        password: "[redacted]",
        nested: { token: "[redacted]" },
        message: "public trace value",
      },
      longValue: `${"x".repeat(MAX_TRACE_VALUE_LENGTH)}…`,
    };

    expect(result.success).toBe(true);
    expect(result.result).toEqual(expected);
    expect(result.trace[0]?.output).toEqual(expected);
    expect(JSON.stringify(result)).not.toContain(password);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(JSON.stringify(result)).not.toContain(longValue);
  });
});
