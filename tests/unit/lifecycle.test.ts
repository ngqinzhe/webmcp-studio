import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  DomStabilizer,
  LifecycleController,
  type StabilizedDomEvent,
} from "../../core/lifecycle";
import { createCapabilityGraph } from "../../core/graph";
import type { Capability, PageIdentity } from "../../core/types";

const page: PageIdentity = {
  url: "http://localhost/products",
  title: "Products",
  origin: "http://localhost",
  hostname: "localhost",
};

function capability(id: string): Capability {
  return {
    id,
    name: id,
    description: id,
    inputSchema: { type: "object" },
    effect: "read",
    confidence: 1,
    source: {
      type: "inferred",
      url: page.url,
      framePath: [],
      shadowPath: [],
    },
    locator: {
      framePath: [],
      shadowPath: [],
      stableAttributes: [],
      fallbacks: [],
    },
    executor: {
      kind: "read",
      target: {
        framePath: [],
        shadowPath: [],
        stableAttributes: [],
        fallbacks: [],
      },
      expected: {},
    },
  };
}

async function settleMutationObserver(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settleMutationObserver();
}

describe("DomStabilizer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main id="app"></main>';
  });

  afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState({}, "", "/");
  });

  it("waits for a quiet window after the initial ready event", async () => {
    const events: StabilizedDomEvent[] = [];
    const stabilizer = new DomStabilizer({
      document,
      window,
      quietWindowMs: 25,
      maxWaitMs: 100,
      onStable: (event) => {
        events.push(event);
      },
    });
    const next = stabilizer.waitForNextStability();

    stabilizer.start();
    await advance(24);
    expect(events).toHaveLength(0);
    await advance(1);
    const event = await next;

    expect(event.reason).toBe("initial");
    expect(event.fullScan).toBe(true);
    expect(event.affectedSubtrees).toEqual([document]);
    expect(events).toHaveLength(1);
    stabilizer.stop();
  });

  it("coalesces mutations and reports the smallest affected subtree", async () => {
    const events: StabilizedDomEvent[] = [];
    const stabilizer = new DomStabilizer({
      document,
      window,
      quietWindowMs: 20,
      maxWaitMs: 100,
      onStable: (event) => {
        events.push(event);
      },
    }).start();

    await advance(20);
    events.length = 0;
    const app = document.querySelector("#app");
    expect(app).not.toBeNull();
    app?.append(document.createElement("section"));
    await settleMutationObserver();
    app?.append(document.createElement("section"));
    await settleMutationObserver();

    await advance(19);
    expect(events).toHaveLength(0);
    await advance(1);

    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe("mutation");
    expect(events[0]?.fullScan).toBe(false);
    expect(events[0]?.affectedSubtrees).toEqual([app]);
    expect(events[0]?.mutations).toHaveLength(2);
    stabilizer.stop();
  });

  it("emits at the maximum wait even when mutations never become quiet", async () => {
    const events: StabilizedDomEvent[] = [];
    const stabilizer = new DomStabilizer({
      document,
      window,
      quietWindowMs: 50,
      maxWaitMs: 100,
      onStable: (event) => {
        events.push(event);
      },
    }).start();

    await advance(50);
    events.length = 0;
    const app = document.querySelector("#app");
    expect(app).not.toBeNull();
    app?.append(document.createElement("p"));
    await settleMutationObserver();
    await advance(40);
    app?.append(document.createElement("p"));
    await settleMutationObserver();
    await advance(50);

    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe("mutation");
    stabilizer.stop();
  });

  it("turns History API and popstate activity into full navigation scans", async () => {
    const events: StabilizedDomEvent[] = [];
    const stabilizer = new DomStabilizer({
      document,
      window,
      quietWindowMs: 10,
      maxWaitMs: 100,
      onStable: (event) => {
        events.push(event);
      },
    }).start();
    await advance(10);
    events.length = 0;

    window.history.pushState({}, "", "/next");
    await advance(10);
    expect(events[0]?.reason).toBe("navigation");
    expect(events[0]?.navigationType).toBe("pushState");
    expect(events[0]?.fullScan).toBe(true);
    expect(events[0]?.url).toContain("/next");

    events.length = 0;
    window.dispatchEvent(new PopStateEvent("popstate"));
    await advance(10);
    expect(events[0]?.navigationType).toBe("popstate");
    stabilizer.stop();
  });

  it("restores history hooks and disconnects observers on stop", async () => {
    const events: StabilizedDomEvent[] = [];
    const originalPushState = window.history.pushState;
    const stabilizer = new DomStabilizer({
      document,
      window,
      quietWindowMs: 10,
      maxWaitMs: 100,
      onStable: (event) => {
        events.push(event);
      },
    }).start();
    await advance(10);
    stabilizer.stop();

    expect(window.history.pushState).toBe(originalPushState);
    document.body.append(document.createElement("div"));
    await advance(20);
    expect(events).toHaveLength(1);
  });
});

describe("LifecycleController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '<main id="app"></main>';
  });

  afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState({}, "", "/");
  });

  it("passes incremental subtree hints and diffs each completed graph", async () => {
    const contexts: StabilizedDomEvent[] = [];
    const graphEvents: Array<{ diffAdded: string[]; fullScan: boolean }> = [];
    let scanNumber = 0;
    const controller = new LifecycleController({
      stabilizerOptions: {
        document,
        window,
        quietWindowMs: 10,
        maxWaitMs: 100,
      },
      scan: (context) => {
        contexts.push(context);
        scanNumber += 1;
        return createCapabilityGraph(
          page,
          [capability(scanNumber === 1 ? "initial" : "updated")],
          [],
          scanNumber,
        );
      },
      onGraphChange: ({ diff, context }) => {
        graphEvents.push({
          diffAdded: diff.added.map(({ id }) => id),
          fullScan: context.fullScan,
        });
      },
    }).start();

    await advance(10);
    await controller.waitForIdle();
    expect(contexts[0]?.reason).toBe("initial");
    expect(graphEvents[0]).toEqual({ diffAdded: ["initial"], fullScan: true });

    const app = document.querySelector("#app");
    app?.append(document.createElement("article"));
    await settleMutationObserver();
    await advance(10);
    await controller.waitForIdle();
    expect(contexts[1]?.reason).toBe("mutation");
    expect(contexts[1]?.fullScan).toBe(false);
    expect(contexts[1]?.affectedSubtrees).toEqual([app]);
    expect(graphEvents[1]?.diffAdded).toEqual(["updated"]);

    window.history.pushState({}, "", "/details");
    await advance(10);
    await controller.waitForIdle();
    expect(contexts[2]?.reason).toBe("navigation");
    expect(contexts[2]?.fullScan).toBe(true);
    controller.stop();
  });

  it("does not let a slower old scan overwrite a newer scan", async () => {
    const resolvers: Array<
      (graph: ReturnType<typeof createCapabilityGraph>) => void
    > = [];
    const controller = new LifecycleController({
      stabilizerOptions: {
        document,
        window,
        quietWindowMs: 5,
        maxWaitMs: 50,
      },
      scan: () =>
        new Promise((resolve) => {
          resolvers.push(resolve);
        }),
    }).start();

    await advance(5);
    document.body.append(document.createElement("div"));
    await settleMutationObserver();
    await advance(5);
    expect(resolvers).toHaveLength(2);

    const newer = createCapabilityGraph(page, [capability("newer")]);
    const older = createCapabilityGraph(page, [capability("older")]);
    resolvers[1]?.(newer);
    resolvers[0]?.(older);
    await controller.waitForIdle();

    expect(controller.graph?.capabilities).toHaveProperty("newer");
    expect(controller.graph?.capabilities).not.toHaveProperty("older");
    controller.stop();
  });

  it("makes an explicit rescan completion wait for stabilization and scanning", async () => {
    let scans = 0;
    const controller = new LifecycleController({
      stabilizerOptions: {
        document,
        window,
        quietWindowMs: 15,
        maxWaitMs: 100,
      },
      scan: () => {
        scans += 1;
        return createCapabilityGraph(page, [capability(`scan-${scans}`)]);
      },
    }).start();

    await advance(15);
    await controller.waitForIdle();
    expect(scans).toBe(1);

    const completion = controller.rescan();
    await vi.advanceTimersByTimeAsync(14);
    await Promise.resolve();
    expect(scans).toBe(1);
    await advance(1);
    await completion;
    expect(scans).toBe(2);
    controller.stop();
  });
});
