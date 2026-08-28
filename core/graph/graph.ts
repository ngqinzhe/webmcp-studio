import type {
  BlockedCapability,
  Capability,
  CapabilityGraph,
  NativeToolSummary,
  PageIdentity,
} from "../types";
import { createCapabilityGraph, listCapabilities } from "./capability-graph";
import { deduplicateNativeCapabilities } from "./native-deduplication";

// Compatibility entry point for consumers that imported the original graph
// module before the graph helpers were split into focused files.
export * from "./capability-graph";

export function graphCapabilities(
  graph: CapabilityGraph | null | undefined,
): Capability[] {
  return graph === null || graph === undefined ? [] : listCapabilities(graph);
}

export function removeNativeDuplicates(
  capabilities: readonly Capability[],
  nativeTools: readonly NativeToolSummary[],
): Capability[] {
  return deduplicateNativeCapabilities(capabilities, nativeTools).retained;
}

export function graphFromCapabilities(
  page: PageIdentity,
  capabilities: readonly Capability[],
  blocked: readonly BlockedCapability[] = [],
  nativeTools: readonly NativeToolSummary[] = [],
): CapabilityGraph {
  return createCapabilityGraph({
    page,
    capabilities: removeNativeDuplicates(capabilities, nativeTools),
    blocked,
  });
}
