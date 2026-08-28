import type {
  Capability,
  CapabilityGraph,
  GraphDiff,
  ExecutionResult,
} from "../core/types";
import type {
  AdapterApplicationResult,
  AdapterDefinition,
  AdapterExecute,
  AdapterMatchContext,
  AdapterOverrideResult,
  AdapterTransformRecord,
  CapabilityPatch,
  DefaultCapabilityExecutor,
} from "./types";
import {
  AdapterValidationError,
  validateAdapter,
  validateCapability,
  validateCapabilityGraph,
  validateCapabilityPatch,
} from "./validation";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function cloneValue<T>(value: T): T {
  if (typeof globalThis.structuredClone === "function") {
    return globalThis.structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

export function cloneCapability(capability: Capability): Capability {
  validateCapability(capability);
  return cloneValue(capability);
}

export function cloneGraph(graph: CapabilityGraph): CapabilityGraph {
  validateCapabilityGraph(graph);
  return cloneValue(graph);
}

function contextFor(graph: CapabilityGraph): AdapterMatchContext {
  const snapshot = cloneGraph(graph);
  return {
    graph: snapshot,
    page: snapshot.page,
    capabilities: Object.values(snapshot.capabilities),
  };
}

function capabilityContext(
  graph: CapabilityGraph,
  capability: Capability,
  adapter: AdapterDefinition,
) {
  const snapshot = cloneGraph(graph);
  const snapshotCapability =
    snapshot.capabilities[capability.id] ?? cloneCapability(capability);
  return {
    adapter,
    graph: snapshot,
    page: snapshot.page,
    capabilities: Object.values(snapshot.capabilities),
    capability: snapshotCapability,
  };
}

function hookError(
  adapter: AdapterDefinition,
  hook: string,
  error: unknown,
): never {
  if (error instanceof AdapterValidationError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  throw new AdapterValidationError(
    `hook threw${message.length > 0 ? `: ${message}` : ""}`,
    `adapter.${adapter.id}.${hook}`,
  );
}

function invokeHook<T>(
  adapter: AdapterDefinition,
  hook: string,
  callback: () => T,
): T {
  try {
    return callback();
  } catch (error) {
    return hookError(adapter, hook, error);
  }
}

function discoveredCapabilities(
  adapter: AdapterDefinition,
  value: ReturnType<NonNullable<AdapterDefinition["discover"]>>,
): Capability[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value))
    return value.map((capability, index) => {
      validateCapability(
        capability,
        `adapter.${adapter.id}.discover[${index}]`,
      );
      return cloneCapability(capability);
    });
  if (isRecord(value) && hasOwn(value, "capabilities")) {
    if (!Array.isArray(value.capabilities)) {
      throw new AdapterValidationError(
        "capabilities must be an array",
        `adapter.${adapter.id}.discover.capabilities`,
      );
    }
    return value.capabilities.map((capability, index) => {
      validateCapability(
        capability,
        `adapter.${adapter.id}.discover[${index}]`,
      );
      return cloneCapability(capability);
    });
  }
  validateCapability(value as Capability, `adapter.${adapter.id}.discover`);
  return [cloneCapability(value as Capability)];
}

function normalizeOverride(
  adapter: AdapterDefinition,
  value: AdapterOverrideResult,
): CapabilityPatch | undefined {
  if (value === null || value === undefined) return undefined;
  const candidate =
    isRecord(value) && hasOwn(value, "capability") ? value.capability : value;
  validateCapabilityPatch(candidate, `adapter.${adapter.id}.override`);
  return candidate as CapabilityPatch;
}

function attributedToAdapter(
  capability: Capability,
  adapter: AdapterDefinition,
): Capability {
  const next: Capability = {
    ...cloneCapability(capability),
    source: {
      ...capability.source,
      type: "adapter",
      adapterId: adapter.id,
    },
  };
  validateCapability(next, `adapter.${adapter.id}.capability`);
  return next;
}

function applyPatch(
  capability: Capability,
  patch: CapabilityPatch,
  adapter: AdapterDefinition,
): Capability {
  const next: Capability = {
    ...capability,
    ...(patch.id === undefined ? {} : { id: patch.id }),
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.description === undefined
      ? {}
      : { description: patch.description }),
    ...(patch.inputSchema === undefined
      ? {}
      : { inputSchema: cloneValue(patch.inputSchema) }),
    ...(patch.effect === undefined ? {} : { effect: patch.effect }),
    ...(patch.confidence === undefined ? {} : { confidence: patch.confidence }),
    ...(patch.locator === undefined
      ? {}
      : { locator: cloneValue(patch.locator) }),
    ...(patch.executor === undefined
      ? {}
      : { executor: cloneValue(patch.executor) }),
    ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
    ...(patch.nativeEquivalent === undefined
      ? {}
      : { nativeEquivalent: patch.nativeEquivalent }),
    source: {
      ...capability.source,
      ...(patch.source ?? {}),
      type: "adapter",
      adapterId: adapter.id,
    },
  };
  const cloned = cloneCapability(next);
  validateCapability(cloned, `adapter.${adapter.id}.override.result`);
  return cloned;
}

function setCapability(
  capabilities: Record<string, Capability>,
  id: string,
  capability: Capability,
): void {
  Object.defineProperty(capabilities, id, {
    configurable: true,
    enumerable: true,
    value: capability,
    writable: true,
  });
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (
      !Array.isArray(left) ||
      !Array.isArray(right) ||
      left.length !== right.length
    ) {
      return false;
    }
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && deepEqual(left[key], right[key]),
    );
  }
  return false;
}

export function diffGraphs(
  before: CapabilityGraph,
  after: CapabilityGraph,
): GraphDiff {
  validateCapabilityGraph(before);
  validateCapabilityGraph(after);
  const beforeCapabilities = before.capabilities;
  const afterCapabilities = after.capabilities;
  const added: Capability[] = [];
  const removed: Capability[] = [];
  const changed: Array<{ before: Capability; after: Capability }> = [];
  const unchanged: Capability[] = [];

  for (const id of Object.keys(afterCapabilities).sort()) {
    const afterCapability = afterCapabilities[id];
    if (!afterCapability) continue;
    const beforeCapability = beforeCapabilities[id];
    if (!beforeCapability) {
      added.push(cloneCapability(afterCapability));
    } else if (deepEqual(beforeCapability, afterCapability)) {
      unchanged.push(cloneCapability(afterCapability));
    } else {
      changed.push({
        before: cloneCapability(beforeCapability),
        after: cloneCapability(afterCapability),
      });
    }
  }
  for (const id of Object.keys(beforeCapabilities).sort()) {
    const beforeCapability = beforeCapabilities[id];
    if (beforeCapability && !hasOwn(afterCapabilities, id)) {
      removed.push(cloneCapability(beforeCapability));
    }
  }
  return { added, removed, changed, unchanged };
}

/** Return matching adapters in deterministic registration order. */
export function matchAdapters(
  graph: CapabilityGraph,
  adapters: readonly AdapterDefinition[],
): AdapterDefinition[] {
  const snapshot = cloneGraph(graph);
  const definitions = adapters.map((adapter) => validateAdapter(adapter));
  const matched: AdapterDefinition[] = [];
  for (const adapter of definitions) {
    const matches = invokeHook(adapter, "match", () =>
      adapter.match(contextFor(snapshot)),
    );
    if (typeof matches !== "boolean") {
      throw new AdapterValidationError(
        "match must return a boolean",
        `adapter.${adapter.id}.match`,
      );
    }
    if (matches) matched.push(adapter);
  }
  return matched;
}

/** Apply all matching adapters in registration order without mutating the input graph. */
export function applyAdapters(
  graph: CapabilityGraph,
  adapters: readonly AdapterDefinition[],
): AdapterApplicationResult {
  const original = cloneGraph(graph);
  const definitions = adapters.map((adapter) => validateAdapter(adapter));
  const working = cloneGraph(original);
  const matchedAdapters: AdapterDefinition[] = [];
  const executorOverrides = new Map<string, AdapterExecute>();
  const executorAdapters = new Map<string, AdapterDefinition>();
  const records: AdapterTransformRecord[] = [];

  for (const adapter of definitions) {
    const matches = invokeHook(adapter, "match", () =>
      adapter.match(contextFor(working)),
    );
    if (typeof matches !== "boolean") {
      throw new AdapterValidationError(
        "match must return a boolean",
        `adapter.${adapter.id}.match`,
      );
    }
    if (!matches) continue;
    matchedAdapters.push(adapter);

    const discovered: string[] = [];
    const overridden: string[] = [];
    const suppressed: string[] = [];
    const owned = new Set<string>();

    if (adapter.discover) {
      const discoverContext = contextFor(working);
      const result = invokeHook(adapter, "discover", () =>
        adapter.discover!({
          adapter,
          graph: discoverContext.graph,
          page: discoverContext.page,
          capabilities: discoverContext.capabilities,
        }),
      );
      for (const capability of discoveredCapabilities(adapter, result)) {
        if (hasOwn(working.capabilities, capability.id)) {
          throw new AdapterValidationError(
            `discovered capability id already exists: ${capability.id}`,
            `adapter.${adapter.id}.discover`,
          );
        }
        const attributed = attributedToAdapter(capability, adapter);
        setCapability(working.capabilities, attributed.id, attributed);
        discovered.push(attributed.id);
        owned.add(attributed.id);
      }
    }

    if (adapter.override) {
      const currentCapabilities = Object.values(working.capabilities);
      for (const capability of currentCapabilities) {
        if (!hasOwn(working.capabilities, capability.id)) continue;
        if (capability.source.type === "native") continue;
        const result = invokeHook(adapter, "override", () =>
          adapter.override!(capabilityContext(working, capability, adapter)),
        );
        const patch = normalizeOverride(adapter, result);
        if (!patch) continue;

        const next = applyPatch(capability, patch, adapter);
        const oldId = capability.id;
        if (next.id !== oldId && hasOwn(working.capabilities, next.id)) {
          throw new AdapterValidationError(
            `override would collide with capability id: ${next.id}`,
            `adapter.${adapter.id}.override`,
          );
        }
        delete working.capabilities[oldId];
        setCapability(working.capabilities, next.id, next);
        executorOverrides.delete(oldId);
        executorAdapters.delete(oldId);
        overridden.push(next.id);
        owned.delete(oldId);
        owned.add(next.id);
      }
    }

    if (adapter.suppress) {
      for (const capability of Object.values(working.capabilities)) {
        if (capability.source.type === "native") continue;
        const shouldSuppress = invokeHook(adapter, "suppress", () =>
          adapter.suppress!(capabilityContext(working, capability, adapter)),
        );
        if (typeof shouldSuppress !== "boolean") {
          throw new AdapterValidationError(
            "suppress must return a boolean",
            `adapter.${adapter.id}.suppress`,
          );
        }
        if (!shouldSuppress) continue;
        delete working.capabilities[capability.id];
        executorOverrides.delete(capability.id);
        executorAdapters.delete(capability.id);
        owned.delete(capability.id);
        suppressed.push(capability.id);
      }
    }

    if (adapter.execute) {
      for (const id of owned) {
        if (!hasOwn(working.capabilities, id)) continue;
        executorOverrides.set(id, adapter.execute);
        executorAdapters.set(id, adapter);
      }
    }

    records.push({
      adapterId: adapter.id,
      discovered,
      overridden,
      suppressed,
      executorCapabilities: adapter.execute ? [...owned] : [],
    });
  }

  return {
    graph: working,
    matchedAdapters,
    executorOverrides,
    executorAdapters,
    records,
    diff: diffGraphs(original, working),
  };
}

export const transformGraph = applyAdapters;

/** Invoke an adapter executor when one owns a capability, otherwise use the default runtime. */
export async function executeWithAdapters(
  application: AdapterApplicationResult,
  capabilityId: string,
  args: unknown,
  executeDefault: DefaultCapabilityExecutor,
): Promise<ExecutionResult> {
  const capability = application.graph.capabilities[capabilityId];
  if (!capability) {
    throw new AdapterValidationError(
      `capability not found: ${capabilityId}`,
      "execute.capabilityId",
    );
  }
  const execute = application.executorOverrides.get(capabilityId);
  const adapter = application.executorAdapters.get(capabilityId);
  const snapshot = cloneGraph(application.graph);
  const snapshotCapability = snapshot.capabilities[capabilityId];
  if (!snapshotCapability) {
    throw new AdapterValidationError(
      `capability not found: ${capabilityId}`,
      "execute.capabilityId",
    );
  }
  if (!execute || !adapter) return executeDefault(snapshotCapability, args);
  return execute({
    adapter,
    args,
    capabilities: Object.values(snapshot.capabilities),
    capability: snapshotCapability,
    executeDefault,
    graph: snapshot,
    page: snapshot.page,
  });
}

export const executeCapability = executeWithAdapters;
