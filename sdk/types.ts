import type {
  Capability,
  CapabilityEffect,
  CapabilityGraph,
  CapabilitySource,
  ExecutionResult,
  ExecutorDefinition,
  JSONSchema,
  SemanticLocator,
} from "../core/types";

/** Data made available to an adapter when deciding whether it applies. */
export interface AdapterMatchContext {
  readonly graph: CapabilityGraph;
  readonly page: CapabilityGraph["page"];
  readonly capabilities: readonly Capability[];
}

/** Data made available while transforming one capability. */
export interface AdapterCapabilityContext extends AdapterMatchContext {
  readonly adapter: AdapterDefinition;
  readonly capability: Capability;
}

/** Data made available while discovering graph-level capabilities. */
export interface AdapterDiscoverContext extends AdapterMatchContext {
  readonly adapter: AdapterDefinition;
}

/** Data made available while deciding whether a capability should be removed. */
export interface AdapterSuppressContext extends AdapterCapabilityContext {}

/** Data made available to a custom executor. */
export interface AdapterExecuteContext extends AdapterCapabilityContext {
  readonly args: unknown;
  readonly executeDefault: DefaultCapabilityExecutor;
}

/** A patch may change capability metadata without recreating the graph node. */
export interface CapabilityPatch {
  readonly id?: string;
  readonly name?: string;
  readonly description?: string;
  readonly inputSchema?: JSONSchema;
  readonly effect?: CapabilityEffect;
  readonly confidence?: number;
  readonly source?: Partial<CapabilitySource>;
  readonly locator?: SemanticLocator;
  readonly executor?: ExecutorDefinition;
  readonly enabled?: boolean;
  readonly nativeEquivalent?: string;
}

export type AdapterMatch = (context: AdapterMatchContext) => boolean;

export type AdapterDiscoverResult =
  | Capability
  | readonly Capability[]
  | { readonly capabilities: readonly Capability[] }
  | null
  | undefined;

export type AdapterDiscover = (
  context: AdapterDiscoverContext,
) => AdapterDiscoverResult;

export type AdapterOverrideResult =
  CapabilityPatch | { readonly capability: CapabilityPatch } | null | undefined;

export type AdapterOverride = (
  context: AdapterCapabilityContext,
) => AdapterOverrideResult;

export type AdapterSuppress = (context: AdapterSuppressContext) => boolean;

export type DefaultCapabilityExecutor = (
  capability: Capability,
  args: unknown,
) => ExecutionResult | Promise<ExecutionResult>;

export type AdapterExecute = (
  context: AdapterExecuteContext,
) => ExecutionResult | Promise<ExecutionResult>;

/** The public adapter definition accepted by `defineAdapter`. */
export interface AdapterDefinition {
  readonly id: string;
  readonly name?: string;
  readonly match: AdapterMatch;
  readonly discover?: AdapterDiscover;
  readonly override?: AdapterOverride;
  readonly suppress?: AdapterSuppress;
  readonly execute?: AdapterExecute;
}

export interface AdapterTransformRecord {
  readonly adapterId: string;
  readonly discovered: readonly string[];
  readonly overridden: readonly string[];
  readonly suppressed: readonly string[];
  readonly executorCapabilities: readonly string[];
}

export interface AdapterApplicationResult {
  readonly graph: CapabilityGraph;
  readonly matchedAdapters: readonly AdapterDefinition[];
  readonly executorOverrides: ReadonlyMap<string, AdapterExecute>;
  readonly executorAdapters: ReadonlyMap<string, AdapterDefinition>;
  readonly records: readonly AdapterTransformRecord[];
  readonly diff: import("../core/types").GraphDiff;
}
