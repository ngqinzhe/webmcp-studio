import { describe, expect, it } from "vitest";
import {
  ContentRuntime,
  isExtensionCommand,
} from "../../../extension/content/content-script";
import { createProject } from "../../../core/project";
import type {
  Capability,
  CapabilityGraph,
  InspectorState,
} from "../../../core/types";
import type { ObservedRequest } from "../../../core/project";

function pageGraph(effect: Capability["effect"] = "read"): CapabilityGraph {
  const url = window.location.href;
  const parsed = new URL(url);
  const locator = {
    framePath: [],
    shadowPath: [],
    stableAttributes: [],
    fallbacks: [],
  };
  const capability = {
    id: "fixture-capability",
    name: "fixture_capability",
    description: "A bounded fixture capability.",
    inputSchema: { type: "object", additionalProperties: false },
    effect,
    confidence: 1,
    source: {
      type: "inferred",
      url,
      framePath: [],
      shadowPath: [],
    },
    locator,
    executor: {
      kind: "read",
      target: locator,
      expected: {},
    },
  } as unknown as Capability;
  return {
    version: 1,
    page: {
      url,
      title: "Fixture",
      origin: parsed.origin,
      hostname: parsed.hostname,
    },
    generatedAt: 7,
    capabilities: { [capability.id]: capability },
    blocked: [],
  };
}

function responseAction(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || !("action" in value))
    throw new Error("Expected an action response.");
  return (value as { action: Record<string, unknown> }).action;
}

function stubBridge(runtime: ContentRuntime): void {
  const internals = runtime as unknown as {
    bridge: { sync: () => Promise<unknown> };
  };
  internals.bridge.sync = async () => ({
    available: false,
    apiMethods: [],
    nativeTools: [],
    registered: [],
    rejected: [],
  });
}

describe("content-script extension message validation", () => {
  it("accepts the narrow commands used by the inspector", () => {
    expect(isExtensionCommand({ type: "polyfill:get-state", tabId: 4 })).toBe(
      true,
    );
    expect(isExtensionCommand({ type: "polyfill:rescan" })).toBe(true);
    expect(isExtensionCommand({ type: "polyfill:get-graph" })).toBe(true);
    expect(
      isExtensionCommand({ type: "polyfill:set-enabled", enabled: false }),
    ).toBe(true);
    expect(
      isExtensionCommand({
        type: "polyfill:invoke",
        capabilityId: "cap_1",
        args: { query: "keyboard" },
      }),
    ).toBe(true);
    expect(
      isExtensionCommand({
        type: "polyfill:perform-browser-action",
        sessionId: "runtime:4",
        capabilityId: "cap_1",
        args: {},
        expectedObservation: "graph-1-1",
      }),
    ).toBe(true);
    expect(
      isExtensionCommand({
        type: "polyfill:read-observed-requests",
        sessionId: "runtime:4",
        cursor: "0",
      }),
    ).toBe(true);
    expect(
      isExtensionCommand({ type: "polyfill:control", action: "pause" }),
    ).toBe(true);
    expect(
      isExtensionCommand({
        type: "polyfill:control",
        action: "resume",
        sessionVerified: true,
        tabId: 4,
      }),
    ).toBe(true);
  });

  it("rejects malformed or unrelated page messages", () => {
    expect(isExtensionCommand(null)).toBe(false);
    expect(
      isExtensionCommand({ type: "polyfill:set-enabled", enabled: "false" }),
    ).toBe(false);
    expect(
      isExtensionCommand({
        type: "polyfill:invoke",
        capabilityId: "",
        args: {},
      }),
    ).toBe(false);
    expect(
      isExtensionCommand({ type: "polyfill:invoke", capabilityId: "cap_1" }),
    ).toBe(false);
    expect(
      isExtensionCommand({
        type: "polyfill:perform-browser-action",
        sessionId: "runtime:4",
        capabilityId: "cap_1",
        args: {},
      }),
    ).toBe(false);
    expect(
      isExtensionCommand({
        type: "polyfill:read-observed-requests",
        sessionId: "",
      }),
    ).toBe(false);
    expect(
      isExtensionCommand({ type: "polyfill:get-state", tabId: null }),
    ).toBe(false);
    expect(
      isExtensionCommand({ type: "polyfill:state-update", state: {} }),
    ).toBe(false);
    expect(isExtensionCommand({ type: "polyfill:reset-all" })).toBe(false);
    expect(
      isExtensionCommand({
        type: "polyfill:control",
        action: "resume",
        sessionVerified: "yes",
      }),
    ).toBe(false);
  });

  it("pauses and resumes live control without replaying or retaining tool access", async () => {
    const runtime = new ContentRuntime();
    stubBridge(runtime);
    const initial = runtime.state() as InspectorState & {
      control?: { mode: string };
    };
    expect(initial.control?.mode).toBe("running");

    const paused = await runtime.handleExtensionMessage({
      type: "polyfill:control",
      action: "pause",
    });
    expect((paused as { state: InspectorState }).state).toMatchObject({
      control: { mode: "paused", blocker: { code: "paused" } },
    });

    const blocked = await runtime.handleExtensionMessage({
      type: "polyfill:invoke",
      capabilityId: "missing",
      args: {},
    });
    expect((blocked as { result: { status: string } }).result.status).toBe(
      "cancelled",
    );

    const resumed = await runtime.handleExtensionMessage({
      type: "polyfill:control",
      action: "resume",
    });
    expect((resumed as { state: InspectorState }).state).toMatchObject({
      control: { mode: "running", blocker: null },
    });
    runtime.stop();
  });

  it("requires a fresh activation after explicit disconnect", async () => {
    const runtime = new ContentRuntime();
    stubBridge(runtime);
    const disconnected = await runtime.handleExtensionMessage({
      type: "polyfill:control",
      action: "disconnect",
    });
    expect((disconnected as { state: InspectorState }).state).toMatchObject({
      control: { mode: "disconnected", blocker: { code: "disconnected" } },
      activeProject: null,
    });
    const resume = await runtime.handleExtensionMessage({
      type: "polyfill:control",
      action: "resume",
    });
    expect((resume as { state: InspectorState }).state).toMatchObject({
      control: { mode: "disconnected" },
    });
    runtime.stop();
  });

  it("rejects stale discovery sessions and observations before execution", async () => {
    const runtime = new ContentRuntime();
    const tabId = 11;
    const graph = pageGraph("mutate");
    const project = createProject(new URL(window.location.href).hostname);
    const internals = runtime as unknown as {
      graph: CapabilityGraph;
      application: unknown;
      lastTargetTabId: number;
    };
    internals.graph = graph;
    internals.application = { graph };
    internals.lastTargetTabId = tabId;
    const runtimeGeneration = runtime.state().runtimeGeneration;
    if (!runtimeGeneration) throw new Error("Runtime generation is missing.");
    const sessionId = `${runtimeGeneration}:${tabId}`;

    try {
      const staleSession = await runtime.handleExtensionMessage({
        type: "polyfill:perform-browser-action",
        tabId,
        sessionId: "different-runtime:11",
        capabilityId: "fixture-capability",
        args: {},
        expectedObservation: "graph-1-7",
        project,
      });
      expect(responseAction(staleSession).status).toBe("session_expired");

      const staleObservation = await runtime.handleExtensionMessage({
        type: "polyfill:perform-browser-action",
        tabId,
        sessionId,
        capabilityId: "fixture-capability",
        args: {},
        expectedObservation: "graph-1-6",
        project,
      });
      expect(responseAction(staleObservation).status).toBe("validation_failed");

      const unapproved = await runtime.handleExtensionMessage({
        type: "polyfill:perform-browser-action",
        tabId,
        sessionId,
        capabilityId: "fixture-capability",
        args: {},
        expectedObservation: "graph-1-7",
        project,
      });
      expect(responseAction(unapproved).status).toBe("approval_required");
    } finally {
      runtime.stop();
    }
  });

  it("paginates bounded request observations and rejects invalid cursors", async () => {
    const runtime = new ContentRuntime();
    const tabId = 12;
    const graph = pageGraph();
    const internals = runtime as unknown as {
      graph: CapabilityGraph;
      lastTargetTabId: number;
      observedRequests: ObservedRequest[];
      requestObserver: { disconnect: () => void };
      captureStartedAt: number;
    };
    internals.graph = graph;
    internals.lastTargetTabId = tabId;
    internals.requestObserver = { disconnect: () => undefined };
    internals.captureStartedAt = 42;
    internals.observedRequests = Array.from({ length: 51 }, (_, index) => ({
      id: `request-${index}`,
      url: `${graph.page.origin}/api/${index}`,
      origin: graph.page.origin,
      path: `/api/${index}`,
      observedAt: index,
    }));
    const runtimeGeneration = runtime.state().runtimeGeneration;
    if (!runtimeGeneration) throw new Error("Runtime generation is missing.");
    const sessionId = `${runtimeGeneration}:${tabId}`;

    try {
      const first = await runtime.handleExtensionMessage({
        type: "polyfill:read-observed-requests",
        tabId,
        sessionId,
      });
      expect(first).toMatchObject({ ok: true });
      if (!first.ok || !("requests" in first))
        throw new Error("Expected a request page.");
      expect(first.requests.entries).toHaveLength(50);
      expect(first.requests.nextCursor).toBe("50");
      expect(first.requests.sessionId).toBe(sessionId);

      const second = await runtime.handleExtensionMessage({
        type: "polyfill:read-observed-requests",
        tabId,
        sessionId,
        cursor: first.requests.nextCursor,
      });
      expect(second).toMatchObject({ ok: true });
      if (!second.ok || !("requests" in second))
        throw new Error("Expected the final request page.");
      expect(second.requests.entries).toHaveLength(1);
      expect(second.requests.nextCursor).toBeUndefined();

      const invalid = await runtime.handleExtensionMessage({
        type: "polyfill:read-observed-requests",
        tabId,
        sessionId,
        cursor: "not-a-number",
      });
      expect(invalid).toEqual({
        ok: false,
        error: "The request cursor is invalid.",
      });
    } finally {
      runtime.stop();
    }
  });
});
