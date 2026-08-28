import type {
  BlockedCapability,
  Capability,
  CapabilityGraph,
  GraphDiff,
  PageIdentity,
} from "../types";

/** A collection accepted by the graph construction helpers. */
export type CapabilityCollection =
  Iterable<Capability> | Readonly<Record<string, Capability>>;

export interface CapabilityGraphInput {
  page: PageIdentity;
  capabilities?: CapabilityCollection;
  blocked?: Iterable<BlockedCapability>;
  generatedAt?: number;
}

/**
 * Create a canonical graph from the scanner's output.
 *
 * Capability IDs are the graph's identity boundary. The object form is
 * sorted by ID so graph snapshots and inspector messages are deterministic.
 */
export function createCapabilityGraph(
  input: CapabilityGraphInput,
): CapabilityGraph;
export function createCapabilityGraph(
  page: PageIdentity,
  capabilities?: CapabilityCollection,
  blocked?: Iterable<BlockedCapability>,
  generatedAt?: number,
): CapabilityGraph;
export function createCapabilityGraph(
  inputOrPage: CapabilityGraphInput | PageIdentity,
  capabilities: CapabilityCollection = [],
  blocked: Iterable<BlockedCapability> = [],
  generatedAt?: number,
): CapabilityGraph {
  const input = isGraphInput(inputOrPage)
    ? inputOrPage
    : {
        page: inputOrPage,
        capabilities,
        blocked,
        ...(generatedAt === undefined ? {} : { generatedAt }),
      };

  return {
    version: 1,
    page: input.page,
    generatedAt: input.generatedAt ?? Date.now(),
    capabilities: toCapabilityRecord(input.capabilities ?? []),
    blocked: [...(input.blocked ?? [])],
  };
}

/** Convenience constructor for the initial empty graph. */
export function emptyCapabilityGraph(
  page: PageIdentity,
  generatedAt?: number,
): CapabilityGraph {
  return createCapabilityGraph({
    page,
    ...(generatedAt === undefined ? {} : { generatedAt }),
  });
}

/** Return capabilities in stable ID order. */
export function listCapabilities(graph: CapabilityGraph): Capability[] {
  return Object.keys(graph.capabilities)
    .sort()
    .map((id) => graph.capabilities[id])
    .filter((capability): capability is Capability => capability !== undefined);
}

/** Look up a capability without exposing the graph's backing record. */
export function getCapability(
  graph: CapabilityGraph,
  id: string,
): Capability | undefined {
  return graph.capabilities[id];
}

/**
 * Replace only the capability collection while retaining the page and blocked
 * records. This is useful after an adapter or native-tool filtering pass.
 */
export function withCapabilities(
  graph: CapabilityGraph,
  capabilities: CapabilityCollection,
  generatedAt = graph.generatedAt,
): CapabilityGraph {
  return createCapabilityGraph({
    page: graph.page,
    capabilities,
    blocked: graph.blocked,
    generatedAt,
  });
}

/**
 * Canonicalize an arbitrary JSON-like value for stable comparison.
 * Object key order is not semantic; array order is preserved because fallback
 * locators and required fields may intentionally be prioritized.
 */
export function canonicalizeForComparison(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeForComparison(item));
  }

  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const canonical: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      const item = record[key];
      if (item !== undefined) {
        canonical[key] = canonicalizeForComparison(item);
      }
    }
    return canonical;
  }

  return value;
}

/** A deterministic fingerprint for all semantically relevant capability data. */
export function capabilityFingerprint(capability: Capability): string {
  return JSON.stringify(
    canonicalizeForComparison({
      ...capability,
      // `enabled` is optional in the shared contract and omitted means enabled.
      enabled: capability.enabled ?? true,
    }),
  );
}

/** Stable semantic comparison; object insertion order does not matter. */
export function capabilitiesEqual(
  left: Capability,
  right: Capability,
): boolean {
  return capabilityFingerprint(left) === capabilityFingerprint(right);
}

/** Backwards-friendly name for callers that want an explicit stable comparison. */
export const stableCapabilityEqual = capabilitiesEqual;

/** Alias useful to consumers that prefer the singular form. */
export const capabilityEqual = capabilitiesEqual;

/**
 * Fingerprint graph content without generatedAt. A graph can be rescanned at a
 * different time without becoming semantically changed solely due to a clock.
 */
export function graphFingerprint(graph: CapabilityGraph): string {
  const capabilities = Object.fromEntries(
    listCapabilities(graph).map((capability) => [
      capability.id,
      canonicalizeForComparison({
        ...capability,
        enabled: capability.enabled ?? true,
      }),
    ]),
  );

  return JSON.stringify(
    canonicalizeForComparison({
      version: graph.version,
      page: graph.page,
      capabilities,
      blocked: graph.blocked,
    }),
  );
}

export function graphsEqual(
  left: CapabilityGraph,
  right: CapabilityGraph,
): boolean {
  return graphFingerprint(left) === graphFingerprint(right);
}

/**
 * Compare two graph snapshots by capability ID.
 *
 * `unchanged` contains the newer capability instances, making it safe for a
 * consumer to use the returned arrays as the next registration set.
 */
export function diffGraphs(
  previous: CapabilityGraph | null | undefined,
  next: CapabilityGraph,
): GraphDiff {
  const previousCapabilities = previous?.capabilities ?? {};
  const nextCapabilities = next.capabilities;

  const added: Capability[] = [];
  const removed: Capability[] = [];
  const changed: Array<{ before: Capability; after: Capability }> = [];
  const unchanged: Capability[] = [];

  for (const id of Object.keys(nextCapabilities).sort()) {
    const after = nextCapabilities[id];
    if (after === undefined) continue;

    const before = previousCapabilities[id];
    if (before === undefined) {
      added.push(after);
    } else if (capabilitiesEqual(before, after)) {
      unchanged.push(after);
    } else {
      changed.push({ before, after });
    }
  }

  for (const id of Object.keys(previousCapabilities).sort()) {
    if (nextCapabilities[id] === undefined) {
      const before = previousCapabilities[id];
      if (before !== undefined) removed.push(before);
    }
  }

  return { added, removed, changed, unchanged };
}

export function isGraphDiffEmpty(diff: GraphDiff): boolean {
  return (
    diff.added.length === 0 &&
    diff.removed.length === 0 &&
    diff.changed.length === 0
  );
}

/** Alias for callers that describe this operation as graph comparison. */
export const compareGraphs = diffGraphs;

function isGraphInput(
  value: CapabilityGraphInput | PageIdentity,
): value is CapabilityGraphInput {
  return "page" in value;
}

function toCapabilityRecord(
  capabilities: CapabilityCollection,
): Record<string, Capability> {
  const values = isIterable(capabilities)
    ? [...capabilities]
    : Object.values(capabilities);
  const record: Record<string, Capability> = {};

  for (const capability of values) {
    const existing = record[capability.id];
    if (existing !== undefined && !capabilitiesEqual(existing, capability)) {
      throw new Error(`Duplicate capability id: ${capability.id}`);
    }
    record[capability.id] = capability;
  }

  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((id) => [id, record[id]])
      .filter((entry): entry is [string, Capability] => entry[1] !== undefined),
  );
}

function isIterable(
  value: CapabilityCollection,
): value is Iterable<Capability> {
  return (
    typeof value === "object" && value !== null && Symbol.iterator in value
  );
}
