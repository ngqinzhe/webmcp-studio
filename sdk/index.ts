export { defineAdapter, isAdapterDefinition } from "./define-adapter";
export {
  AdapterValidationError,
  validateAdapter,
  validateCapability,
  validateCapabilityGraph,
  validateCapabilityPatch,
} from "./validation";
export {
  applyAdapters,
  cloneCapability,
  cloneGraph,
  diffGraphs,
  executeCapability,
  executeWithAdapters,
  matchAdapters,
  transformGraph,
} from "./transform";
export { AdapterRegistry } from "./registry";
export type {
  AdapterApplicationResult,
  AdapterCapabilityContext,
  AdapterDefinition,
  AdapterDiscover,
  AdapterDiscoverContext,
  AdapterDiscoverResult,
  AdapterExecute,
  AdapterExecuteContext,
  AdapterMatch,
  AdapterMatchContext,
  AdapterOverride,
  AdapterOverrideResult,
  AdapterSuppress,
  AdapterSuppressContext,
  AdapterTransformRecord,
  CapabilityPatch,
  DefaultCapabilityExecutor,
} from "./types";
