export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JSONSchemaType =
  "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";

export interface JSONSchema {
  $schema?: string;
  type?: JSONSchemaType | JSONSchemaType[];
  title?: string;
  description?: string;
  format?: string;
  enum?: JsonPrimitive[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  additionalProperties?: boolean | JSONSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  default?: JsonPrimitive;
  [key: string]: unknown;
}

export type CapabilityEffect = "read" | "navigate" | "interact" | "mutate";

export type CapabilityOrigin = "native" | "inferred" | "adapter";

export interface StableAttribute {
  name: string;
  value: string;
}

export interface LocatorContext {
  role?: string;
  text?: string;
  stableAttribute?: StableAttribute;
}

export interface ShadowHostLocator {
  role?: string;
  accessibleName?: string;
  stableAttribute?: StableAttribute;
  selector?: string;
  index?: number;
}

export interface LocatorFallback {
  kind: "role" | "label" | "stable-attribute" | "relationship" | "css";
  description: string;
  role?: string;
  accessibleName?: string;
  labelText?: string;
  stableAttribute?: StableAttribute;
  selector?: string;
  relation?:
    "form-control" | "form-submit" | "context-action" | "labelled-control";
}

export interface SemanticLocator {
  framePath: number[];
  shadowPath: ShadowHostLocator[];
  role?: string;
  accessibleName?: string;
  labelText?: string;
  context?: LocatorContext;
  stableAttributes: StableAttribute[];
  relationship?:
    "form-control" | "form-submit" | "context-action" | "labelled-control";
  fallbacks: LocatorFallback[];
}

export interface EntityReference {
  role?: string;
  text?: string;
  stableAttribute?: StableAttribute;
}

export interface ExpectedOutcome {
  event?: "navigation" | "input" | "change" | "submit" | "click";
  urlPattern?: string;
  textIncludes?: string;
  selector?: string;
  stateAttribute?: string;
  waitMs?: number;
}

export type ExecutorDefinition =
  | {
      kind: "form";
      form: SemanticLocator;
      fields: Record<string, SemanticLocator>;
      submit?: SemanticLocator;
      expected: ExpectedOutcome;
    }
  | {
      kind: "control";
      control: "input" | "textarea" | "select" | "checkbox" | "radio";
      target: SemanticLocator;
      valueField: string;
      expected: ExpectedOutcome;
    }
  | {
      kind: "action";
      action: "click" | "navigate";
      target: SemanticLocator;
      entity?: EntityReference;
      expected: ExpectedOutcome;
    }
  | {
      kind: "read";
      target: SemanticLocator;
      expected: ExpectedOutcome;
    };

export interface CapabilitySource {
  type: CapabilityOrigin;
  url: string;
  framePath: number[];
  shadowPath: ShadowHostLocator[];
  nodeSignature?: string;
  reason?: string;
  adapterId?: string;
}

export interface Capability {
  id: string;
  name: string;
  description: string;
  inputSchema: JSONSchema;
  effect: CapabilityEffect;
  confidence: number;
  source: CapabilitySource;
  locator: SemanticLocator;
  executor: ExecutorDefinition;
  enabled?: boolean;
  nativeEquivalent?: string;
}

export interface PageIdentity {
  url: string;
  title: string;
  origin: string;
  hostname: string;
}

export interface CapabilityGraph {
  version: 1;
  page: PageIdentity;
  generatedAt: number;
  capabilities: Record<string, Capability>;
  blocked: BlockedCapability[];
}

export interface BlockedCapability {
  id: string;
  name: string;
  reason:
    | "cross_origin_blocked"
    | "permission_blocked"
    | "webmcp_unavailable"
    | "unsupported_control";
  detail: string;
  framePath: number[];
}

export interface GraphDiff {
  added: Capability[];
  removed: Capability[];
  changed: Array<{ before: Capability; after: Capability }>;
  unchanged: Capability[];
}

export type ExecutionFailureCode =
  | "target_not_found"
  | "ambiguous_target"
  | "validation_failed"
  | "no_observable_change"
  | "cross_origin_blocked"
  | "permission_blocked"
  | "webmcp_unavailable"
  | "execution_timeout"
  | "unsupported_control"
  | "invalid_arguments"
  | "registration_rejected"
  | "approval_required"
  | "scope_blocked"
  | "session_expired"
  | "cancelled"
  | "ambiguous_delivery";

export interface ExecutionError {
  code: ExecutionFailureCode;
  message: string;
  details?: Record<string, JsonValue>;
}

export interface ExecutionResult {
  success: boolean;
  status: "completed" | ExecutionFailureCode;
  urlBefore: string;
  urlAfter: string;
  navigationOccurred: boolean;
  stateChanged: boolean;
  matchedTarget?: string;
  result?: JsonValue;
  warnings: string[];
  error?: ExecutionError;
}

export interface NativeToolSummary {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
}

export interface WebMcpStatus {
  available: boolean;
  apiMethods: string[];
  nativeTools: NativeToolSummary[];
  registered: string[];
  rejected: Array<{ name: string; message: string }>;
}

export interface InspectorState {
  graph: CapabilityGraph | null;
  webmcp: WebMcpStatus;
  lastExecution: { capabilityId: string; result: ExecutionResult } | null;
  enabled: boolean;
  /** Changes when a new content-document runtime starts. */
  runtimeGeneration?: string;
  /** Approved imported snapshot currently registered on this exact tab. */
  activeProject?: {
    projectId: string;
    revision: number;
    snapshotHash: string;
    tabId: number;
    origin: string;
    runtimeGeneration: string;
    approved: boolean;
    toolNames: string[];
  } | null;
  updatedAt: number;
}

export interface ScanOptions {
  quietWindowMs?: number;
  maxWaitMs?: number;
  includeFrames?: boolean;
  includeShadowDom?: boolean;
}
