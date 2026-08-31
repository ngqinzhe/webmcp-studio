import { describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import {
  compileProjectTools,
  type WebMcpToolDescriptor,
} from "../../core/compiler";
import {
  createActivationApproval,
  ProjectActivationError,
  validateActivation,
} from "../../core/project/activation";
import {
  createProject,
  getToolAvailability,
  parseProject,
  validateProject,
} from "../../core/project";
import type {
  ProjectDocument,
  ToolDefinition,
  Workflow,
  WorkflowNode,
} from "../../core/project";
import type { JSONSchema } from "../../core/types";
import { executeExecutor } from "../../core/execution";
import { runWorkflow } from "../../core/workflow";

const inputSchema: JSONSchema = {
  type: "object",
  additionalProperties: true,
};

function node(
  type: "http" | "dom" | "return",
  id: string,
  config: Record<string, unknown>,
): WorkflowNode {
  return {
    id,
    type,
    label: id,
    position: { x: 0, y: 0 },
    config,
  } as WorkflowNode;
}

function workflow(nodes: WorkflowNode[]): Workflow {
  return {
    entryNodeId: nodes[0]!.id,
    nodes,
    edges: nodes.slice(0, -1).map((current, index) => ({
      from: current.id,
      to: nodes[index + 1]!.id,
      when: "always" as const,
    })),
  };
}

function tool(
  name: string,
  flow: Workflow,
  access: "public" | "authenticated" = "public",
): ToolDefinition {
  return {
    id: `tool-${name}`,
    name,
    description: name,
    inputSchema,
    access,
    enabled: true,
    workflow: flow,
  };
}

function projectWithTools(tools: ToolDefinition[]): ProjectDocument {
  const project = createProject("example.test");
  project.tools = tools;
  project.editor.toolOrder = tools.map((item) => item.id);
  return project;
}

function httpTool(
  method: "GET" | "POST" = "GET",
  url: unknown = { kind: "literal", value: "https://api.example.test/data" },
): ToolDefinition {
  return tool(
    "http_tool",
    workflow([
      node("http", "request", { method, url, parseAs: "text" }),
      node("return", "return", {
        value: { kind: "output", nodeId: "request" },
      }),
    ]),
  );
}

describe("shared core safety contracts", () => {
  it("rejects unsafe literal destinations and secret-bearing config data", () => {
    const cases = [
      {
        label: "private host",
        url: "http://127.0.0.1/admin",
        message: /private or local network/,
      },
      {
        label: "credentials",
        url: "https://user:pass@api.example.test/data",
        message: /credentials/,
      },
      {
        label: "secret query",
        url: "https://api.example.test/data?access_token=sentinel",
        message: /sensitive query/,
      },
    ];
    for (const testCase of cases) {
      const project = projectWithTools([
        httpTool("GET", {
          kind: "literal",
          value: testCase.url,
        }),
      ]);
      expect(() => validateProject(project), testCase.label).toThrow(
        testCase.message,
      );
    }

    const secretBody = projectWithTools([
      tool(
        "secret_body",
        workflow([
          node("http", "request", {
            method: "POST",
            url: { kind: "literal", value: "https://api.example.test/data" },
            body: {
              kind: "literal",
              value: { csrf: "should-not-be-exported" },
            },
          }),
          node("return", "return", {
            value: { kind: "literal", value: null },
          }),
        ]),
      ),
    ]);
    expect(() => validateProject(secretBody)).toThrow(/sensitive values/);
  });

  it("checks dynamically resolved destinations against exact origins and private-network policy", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      url: "https://api.example.test/data",
      redirected: false,
      text: async () => "ok",
      headers: { get: () => null },
    }));
    const dynamic = httpTool("GET", {
      kind: "input",
      path: "url",
    });
    const inputTool = {
      ...dynamic,
      name: "dynamic_http",
      id: "tool-dynamic_http",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      } satisfies JSONSchema,
    };

    const privateResult = await runWorkflow(
      inputTool,
      {
        url: "http://192.168.1.10/data",
      },
      {
        runtime: { fetch: fetchMock as unknown as typeof fetch },
      },
    );
    expect(privateResult.status).toBe("scope_blocked");
    expect(fetchMock).not.toHaveBeenCalled();

    const outsideResult = await runWorkflow(
      inputTool,
      {
        url: "https://evil.example.test/data",
      },
      {
        runtime: {
          fetch: fetchMock as unknown as typeof fetch,
          allowedHttpOrigins: ["https://api.example.test"],
        },
      },
    );
    expect(outsideResult.status).toBe("scope_blocked");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects redirects and bounds HTTP responses", async () => {
    const redirectFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      url: "https://api.example.test/final",
      redirected: true,
      text: async () => "ok",
      headers: { get: () => null },
    }));
    const redirected = await runWorkflow(
      httpTool(),
      {},
      {
        runtime: {
          fetch: redirectFetch as unknown as typeof fetch,
          allowedHttpOrigins: ["https://api.example.test"],
        },
      },
    );
    expect(redirected.status).toBe("scope_blocked");
    expect(redirectFetch).toHaveBeenCalledWith(
      "https://api.example.test/data",
      expect.objectContaining({ redirect: "error" }),
    );

    const oversized = await runWorkflow(
      httpTool(),
      {},
      {
        runtime: {
          fetch: vi.fn(async () => ({
            ok: true,
            status: 200,
            url: "https://api.example.test/data",
            redirected: false,
            text: async () => "1234",
            headers: { get: () => null },
          })) as unknown as typeof fetch,
          maxResponseBytes: 3,
        },
      },
    );
    expect(oversized.status).toBe("validation_failed");
    expect(oversized.warnings.join(" ")).toMatch(/response exceeds/);
  });

  it("validates link navigation destinations before clicking", async () => {
    const dom = new JSDOM(
      `<a id="out" href="https://evil.example.test/">Leave</a>`,
    );
    const result = await executeExecutor(
      {
        kind: "action",
        action: "navigate",
        target: {
          framePath: [],
          shadowPath: [],
          role: "link",
          accessibleName: "Leave",
          stableAttributes: [],
          fallbacks: [],
        },
        expected: { event: "navigation" },
      },
      {},
      {
        document: dom.window.document,
        urlProvider: () => "https://example.test/start",
        allowedNavigationOrigins: ["https://example.test"],
      },
    );
    expect(result.status).toBe("cross_origin_blocked");
    dom.window.close();
  });

  it("requires approval for side-effecting HTTP and preserves ambiguous delivery", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      url: "https://api.example.test/data",
      redirected: false,
      text: async () => "ok",
      headers: { get: () => null },
    }));
    const denied = await runWorkflow(
      httpTool("POST"),
      {},
      {
        runtime: { fetch: fetchMock as unknown as typeof fetch },
      },
    );
    expect(denied.status).toBe("approval_required");
    expect(fetchMock).not.toHaveBeenCalled();

    const throwingFetch = vi.fn(async () => {
      throw new Error("connection closed after send");
    });
    const ambiguous = await runWorkflow(
      httpTool("POST"),
      {},
      {
        runtime: {
          fetch: throwingFetch as unknown as typeof fetch,
          isApproved: () => true,
        },
      },
    );
    expect(ambiguous.status).toBe("ambiguous_delivery");
    expect(ambiguous.warnings.join(" ")).toContain("not retried");
  });

  it("exposes session-aware public/protected availability and compiler filtering", () => {
    const project = projectWithTools([
      tool(
        "public_tool",
        workflow([
          node("return", "return", {
            value: { kind: "literal", value: "public" },
          }),
        ]),
      ),
      tool(
        "protected_tool",
        workflow([
          node("return", "return", {
            value: { kind: "literal", value: "protected" },
          }),
        ]),
        "authenticated",
      ),
      {
        ...tool(
          "disabled_tool",
          workflow([
            node("return", "return", {
              value: { kind: "literal", value: "disabled" },
            }),
          ]),
        ),
        enabled: false,
      },
    ]);
    const unknown = getToolAvailability(project);
    expect(unknown.map((entry) => [entry.toolId, entry.available])).toEqual([
      ["tool-public_tool", true],
      ["tool-protected_tool", false],
      ["tool-disabled_tool", false],
    ]);
    const verified = getToolAvailability(project, {
      status: "authenticated",
      verified: true,
    });
    expect(verified[1]).toMatchObject({ available: true, reason: "available" });

    const publicDescriptors = compileProjectTools(project, {
      session: { status: "unauthenticated", verified: false },
    });
    expect(publicDescriptors.map((entry) => entry.name)).toEqual([
      "public_tool",
    ]);
    const protectedDescriptors = compileProjectTools(project, {
      session: { status: "authenticated", verified: true },
    });
    expect(protectedDescriptors.map((entry) => entry.name)).toEqual([
      "public_tool",
      "protected_tool",
    ]);
    expect(protectedDescriptors[1]).toMatchObject({
      access: "authenticated",
      available: true,
    } satisfies Partial<WebMcpToolDescriptor>);
  });

  it("requires a verified current session for protected activation even in a public project", () => {
    const project = projectWithTools([
      tool(
        "protected_tool",
        workflow([
          node("return", "return", {
            value: { kind: "literal", value: "protected" },
          }),
        ]),
        "authenticated",
      ),
    ]);
    const approval = createActivationApproval(
      project,
      7,
      "https://example.test/page",
      false,
      true,
    );
    expect(() =>
      validateActivation(project, approval, 7, "https://example.test/page", {
        status: "unknown",
        verified: false,
      }),
    ).toThrow(ProjectActivationError);
    expect(
      validateActivation(project, approval, 7, "https://example.test/page", {
        status: "authenticated",
        verified: true,
      }).active.approved,
    ).toBe(true);
  });

  it("rejects imported test traces that contain unredacted sensitive fields", () => {
    const project = projectWithTools([
      tool(
        "safe_tool",
        workflow([
          node("return", "return", {
            value: { kind: "literal", value: null },
          }),
        ]),
      ),
    ]);
    project.testRuns = [
      {
        id: "run-1",
        toolId: "tool-safe_tool",
        revision: 0,
        startedAt: 1,
        finishedAt: 2,
        success: true,
        status: "completed",
        result: { password: "raw-secret" },
        trace: [],
      },
    ];
    expect(() => parseProject(JSON.stringify(project))).toThrow(
      /sensitive values/,
    );
  });
});
