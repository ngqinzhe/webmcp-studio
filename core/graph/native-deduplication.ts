import type { Capability, CapabilityGraph, NativeToolSummary } from "../types";
import { createCapabilityGraph, listCapabilities } from "./capability-graph";

export interface NativeCapabilityMatch {
  capability: Capability;
  nativeTool: NativeToolSummary;
}

export interface NativeDeduplicationResult {
  /** Capabilities safe to send to the inferred-tool registrar. */
  retained: Capability[];
  /** Equivalent capabilities omitted because the page already owns the tool. */
  suppressed: Capability[];
  matches: NativeCapabilityMatch[];
}

export interface NativeGraphDeduplicationResult extends NativeDeduplicationResult {
  graph: CapabilityGraph;
}

/** Normalize common WebMCP naming styles without guessing semantic synonyms. */
export function normalizeToolName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Find the native tool that is equivalent to an inferred capability, if any. */
export function findNativeEquivalent(
  capability: Capability,
  nativeTools: readonly NativeToolSummary[],
): NativeToolSummary | undefined {
  const capabilityName = normalizeToolName(capability.name);
  const explicitEquivalent = capability.nativeEquivalent
    ? normalizeToolName(capability.nativeEquivalent)
    : "";

  return nativeTools.find((nativeTool) => {
    const nativeName = normalizeToolName(nativeTool.name);
    return (
      nativeName.length > 0 &&
      (nativeName === capabilityName ||
        (explicitEquivalent.length > 0 && nativeName === explicitEquivalent))
    );
  });
}

/**
 * Annotate equivalent capabilities while retaining them in the graph.
 * This is useful to inspectors that want to explain why registration was
 * skipped without changing the scanner's canonical output.
 */
export function markNativeEquivalents(
  capabilities: readonly Capability[],
  nativeTools: readonly NativeToolSummary[],
): Capability[] {
  return capabilities.map((capability) => {
    const nativeTool = findNativeEquivalent(capability, nativeTools);
    if (nativeTool === undefined) return capability;
    return { ...capability, nativeEquivalent: nativeTool.name };
  });
}

/**
 * Remove inferred/adapter capabilities that would duplicate a native tool.
 * Matching deliberately uses exact normalized names or an explicit
 * `nativeEquivalent`; broad fuzzy matching would hide legitimate tools.
 */
export function deduplicateNativeCapabilities(
  capabilities: readonly Capability[],
  nativeTools: readonly NativeToolSummary[],
): NativeDeduplicationResult {
  const retained: Capability[] = [];
  const suppressed: Capability[] = [];
  const matches: NativeCapabilityMatch[] = [];

  for (const capability of capabilities) {
    const nativeTool = findNativeEquivalent(capability, nativeTools);
    if (nativeTool === undefined) {
      retained.push(capability);
      continue;
    }

    suppressed.push(capability);
    matches.push({ capability, nativeTool });
  }

  return { retained, suppressed, matches };
}

/** Apply native deduplication to a complete graph without mutating it. */
export function deduplicateGraphNativeCapabilities(
  graph: CapabilityGraph,
  nativeTools: readonly NativeToolSummary[],
): NativeGraphDeduplicationResult {
  const result = deduplicateNativeCapabilities(
    listCapabilities(graph),
    nativeTools,
  );

  return {
    ...result,
    graph: createCapabilityGraph({
      page: graph.page,
      capabilities: result.retained,
      blocked: graph.blocked,
      generatedAt: graph.generatedAt,
    }),
  };
}

/** Alias for compiler code that speaks in terms of tools rather than graph nodes. */
export const deduplicateNativeTools = deduplicateNativeCapabilities;
