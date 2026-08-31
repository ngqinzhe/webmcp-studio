/**
 * Public workflow aliases.
 *
 * The project document is the single serialized contract. These aliases keep
 * workflow-focused consumers from having to import the larger project barrel
 * while avoiding a second, incompatible `kind`/array-path format.
 */
export const WORKFLOW_SCHEMA_VERSION = 1 as const;
export type WorkflowSchemaVersion = typeof WORKFLOW_SCHEMA_VERSION;

export type {
  Binding,
  CanvasPosition,
  ConditionNodeConfig,
  ControlEdge,
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
} from "../project/types";

import type {
  Binding,
  ProjectDocument,
  ToolDefinition,
  Workflow,
  WorkflowNode,
  WorkflowNodeType,
} from "../project/types";

export type JsonObject = { [key: string]: import("../types").JsonValue };
export type JsonBinding = Binding;
export type WorkflowDefinition = Workflow;
export type WorkflowDefinitionV1 = Workflow;
export type WorkflowNodeKind = WorkflowNodeType;
export type WorkflowEdgeKind = NonNullable<Workflow["edges"][number]["when"]>;

export interface RuntimeValues {
  url?: string;
  title?: string;
  origin?: string;
  session?: import("../types").JsonValue;
}

export interface WorkflowRuntimeContext {
  readonly runId: string;
  readonly nodeId: string;
  readonly inputs: import("../types").JsonValue;
  readonly outputs: Readonly<Record<string, import("../types").JsonValue>>;
  readonly runtime: Readonly<RuntimeValues>;
  readonly signal: AbortSignal;
}

/** Compatibility boundary for hosts that implement a workflow directly. */
export interface WorkflowRuntimeAdapter {
  http?: (...args: never[]) => unknown;
  dom?: (...args: never[]) => unknown;
  wait?: (...args: never[]) => unknown;
  extract?: (...args: never[]) => unknown;
}

export type WorkflowAdapter = WorkflowRuntimeAdapter;
export type RuntimeAdapter = WorkflowRuntimeAdapter;

export type WorkflowErrorCode =
  | "validation_failed"
  | "invalid_binding"
  | "adapter_missing"
  | "adapter_error"
  | "unsafe_url"
  | "timeout"
  | "cancelled"
  | "ambiguous_delivery"
  | "step_limit_exceeded"
  | "trace_limit_exceeded";

export interface WorkflowError {
  code: WorkflowErrorCode;
  message: string;
  nodeId?: string;
  path?: string;
  details?: JsonObject;
}

export type WorkflowTraceStatus = "completed" | "failed" | "skipped";

export interface WorkflowTraceEntry {
  nodeId: string;
  type: WorkflowNodeType;
  status: WorkflowTraceStatus;
  input?: import("../types").JsonValue;
  output?: import("../types").JsonValue;
  error?: string;
  startedAt: number;
  finishedAt: number;
}

/** Names kept for code that accepts a complete project rather than a tool. */
export type WorkflowProject = ProjectDocument;
export type WorkflowTool = ToolDefinition;
export type WorkflowNodeInstance = WorkflowNode;
