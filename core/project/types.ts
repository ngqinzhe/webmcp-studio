import type {
  Capability,
  CapabilityEffect,
  JSONSchema,
  JsonValue,
  SemanticLocator,
} from "../types";

/** The on-disk format is deliberately independent from the WebMCP draft. */
export const PROJECT_SCHEMA_VERSION = 1 as const;
export const MAX_PROJECT_BYTES = 1_000_000;
/** Hard ceilings used by the shared interpreter, independent of caller hints. */
export const MAX_WORKFLOW_STEPS = 80;
export const MAX_WORKFLOW_ELAPSED_MS = 120_000;
export const MAX_HTTP_REQUEST_BYTES = 1_000_000;
export const MAX_HTTP_RESPONSE_BYTES = 1_000_000;
export const MAX_TRACE_ENTRIES = 80;
export const MAX_TRACE_VALUE_LENGTH = 8_000;

export type ProjectSchemaVersion = typeof PROJECT_SCHEMA_VERSION;
export type SessionMode = "public" | "authenticated";
export type ToolAccess = "public" | "authenticated";
export type DiscoveryStatus = "observed" | "inferred" | "blocked";
export type SessionStatus =
  "unknown" | "unauthenticated" | "authenticated" | "expired" | "changing";

/** Ephemeral, verified state from the selected target tab; never serialized in a project. */
export interface SessionSnapshot {
  status: SessionStatus;
  verified: boolean;
  accountId?: string;
}

export interface ToolAvailability {
  toolId: string;
  access: ToolAccess;
  available: boolean;
  reason?:
    | "disabled"
    | "protected_session_required"
    | "session_unverified"
    | "available";
}

export interface SiteScope {
  /** Human-entered domain, e.g. `example.com`. */
  domain: string;
  /** Optional human goal used to guide discovery; it is not an executable rule. */
  goal?: string;
  /** Canonical origin used for exact matching when known. */
  origin?: string;
  /** Explicit request/execution origins; this list never grants permission. */
  origins: string[];
  pathPatterns?: string[];
  sessionMode: SessionMode;
}

export interface ProjectIdentity {
  id: string;
  name: string;
  revision: number;
}

export interface DiscoveryEvidence {
  type: "dom" | "http" | "manual";
  url: string;
  observedAt: number;
  note?: string;
  locator?: SemanticLocator;
}

/** A bounded resource observation captured after the selected tab was attached. */
export interface ObservedRequest {
  id: string;
  url: string;
  origin: string;
  path: string;
  initiatorType?: string;
  observedAt: number;
}

export interface ObservedRequestPage {
  sessionId: string;
  observationId: string;
  entries: ObservedRequest[];
  nextCursor?: string;
  captureStartedAt: number;
  available: boolean;
}

export interface DiscoveredAction {
  id: string;
  name: string;
  description: string;
  inputSchema: JSONSchema;
  effect: CapabilityEffect;
  confidence: number;
  access: ToolAccess;
  status: DiscoveryStatus;
  evidence: DiscoveryEvidence[];
  /** The safe live capability used by the installed runtime when available. */
  capability?: Capability;
  blockedReason?: string;
}

export interface CanvasPosition {
  x: number;
  y: number;
}

export type Binding =
  | { kind: "literal"; value: JsonValue }
  | { kind: "input"; path: string }
  | { kind: "output"; nodeId: string; path?: string }
  | { kind: "context"; path: "url" | "origin" | "title" };

export type WorkflowNodeType =
  "http" | "dom" | "wait" | "extract" | "transform" | "condition" | "return";

export interface WorkflowNodeBase<T extends WorkflowNodeType, C> {
  id: string;
  type: T;
  label: string;
  position: CanvasPosition;
  config: C;
}

export interface HttpNodeConfig {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: Binding;
  headers?: Record<string, Binding>;
  body?: Binding;
  parseAs?: "json" | "text";
}

export interface DomNodeConfig {
  capabilityId: string;
  args?: Record<string, Binding>;
  requiresApproval?: boolean;
}

export interface WaitNodeConfig {
  selector?: string;
  textIncludes?: string;
  timeoutMs: number;
  pollMs?: number;
}

export interface ExtractNodeConfig {
  target?: SemanticLocator;
  selector?: string;
  fields?: Record<string, string>;
  includeText?: boolean;
  sensitive?: boolean;
}

export type TransformOperation =
  "pick" | "project" | "filter" | "stringify" | "coalesce";

export interface TransformNodeConfig {
  source: Binding;
  operation: TransformOperation;
  path?: string;
  fields?: string[];
  predicate?: {
    path: string;
    equals?: JsonValue;
    contains?: string;
  };
}

export type ConditionOperator =
  "equals" | "not_equals" | "contains" | "exists" | "truthy";

export interface ConditionNodeConfig {
  left: Binding;
  operator: ConditionOperator;
  right?: Binding;
}

export interface ReturnNodeConfig {
  value?: Binding;
  fields?: Record<string, Binding>;
}

export type WorkflowNode =
  | WorkflowNodeBase<"http", HttpNodeConfig>
  | WorkflowNodeBase<"dom", DomNodeConfig>
  | WorkflowNodeBase<"wait", WaitNodeConfig>
  | WorkflowNodeBase<"extract", ExtractNodeConfig>
  | WorkflowNodeBase<"transform", TransformNodeConfig>
  | WorkflowNodeBase<"condition", ConditionNodeConfig>
  | WorkflowNodeBase<"return", ReturnNodeConfig>;

export interface ControlEdge {
  from: string;
  to: string;
  when?: "always" | "true" | "false";
}

export type WorkflowEdge = ControlEdge;

export interface Workflow {
  entryNodeId: string;
  nodes: WorkflowNode[];
  edges: ControlEdge[];
}

export interface ToolDefinition {
  id: string;
  name: string;
  description: string;
  inputSchema: JSONSchema;
  resultSchema?: JSONSchema;
  access: ToolAccess;
  enabled: boolean;
  workflow: Workflow;
}

export interface EditorState {
  toolOrder: string[];
  selectedToolId?: string;
  nodePositions: Record<string, CanvasPosition>;
  viewport: { x: number; y: number; zoom: number };
}

export interface TestRunSummary {
  id: string;
  toolId: string;
  revision: number;
  startedAt: number;
  finishedAt: number;
  success: boolean;
  status: string;
  result?: JsonValue;
  trace: WorkflowTraceEntry[];
}

export interface ProjectDocument {
  schemaVersion: ProjectSchemaVersion;
  project: ProjectIdentity;
  site: SiteScope;
  discoveredActions: DiscoveredAction[];
  tools: ToolDefinition[];
  editor: EditorState;
  testRuns: TestRunSummary[];
}

export type ProjectConfig = ProjectDocument;
export type StudioProject = ProjectDocument;

export interface WorkflowTraceEntry {
  nodeId: string;
  type: WorkflowNodeType;
  status: "completed" | "failed" | "skipped";
  startedAt: number;
  finishedAt: number;
  input?: JsonValue;
  output?: JsonValue;
  error?: string;
}

export type WorkflowRunStatus =
  | "completed"
  | "validation_failed"
  | "invalid_arguments"
  | "permission_blocked"
  | "approval_required"
  | "scope_blocked"
  | "session_expired"
  | "execution_timeout"
  | "cancelled"
  | "ambiguous_delivery"
  | "unsupported_control";

export interface WorkflowRunResult {
  success: boolean;
  status: WorkflowRunStatus;
  result?: JsonValue;
  trace: WorkflowTraceEntry[];
  warnings: string[];
  runId: string;
  toolId: string;
  revision: number;
  failedNodeId?: string;
}

export interface ActivationApproval {
  snapshotHash: string;
  approvedAt: number;
  tabId: number;
  origin: string;
  allowConsequential: boolean;
  /** Explicit human confirmation that the current tab's protected session is valid. */
  sessionVerified?: boolean;
}

export interface ActiveProjectState {
  projectId: string;
  revision: number;
  snapshotHash: string;
  tabId: number;
  origin: string;
  runtimeGeneration: string;
  approved: boolean;
  toolNames: string[];
}
