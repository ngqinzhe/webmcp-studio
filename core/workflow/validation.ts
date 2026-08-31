import type { JsonValue } from "../types";
import { ProjectValidationError, validateProject } from "../project/validation";
import type { ProjectDocument, Workflow } from "../project/types";

export type WorkflowValidationCode =
  | "invalid_type"
  | "unsupported_version"
  | "missing_field"
  | "invalid_field"
  | "invalid_binding"
  | "duplicate_id"
  | "unknown_reference"
  | "cross_tool_reference"
  | "invalid_edge"
  | "cycle"
  | "unreachable_node"
  | "incomplete_path"
  | "missing_return"
  | "missing_branch"
  | "branch_not_available"
  | "unsupported_feature"
  | "unsafe_url";

export interface WorkflowValidationIssue {
  code: WorkflowValidationCode;
  path: string;
  message: string;
  details?: Record<string, JsonValue>;
}

export interface WorkflowValidationResult {
  valid: boolean;
  issues: WorkflowValidationIssue[];
}

export interface ValidateWorkflowOptions {
  requireRunnable?: boolean;
}

function codeFor(message: string): WorkflowValidationCode {
  const normalized = message.toLowerCase();
  if (normalized.includes("cycle")) return "cycle";
  if (normalized.includes("duplicate")) return "duplicate_id";
  if (
    normalized.includes("missing node") ||
    normalized.includes("references a missing")
  )
    return "unknown_reference";
  if (normalized.includes("binding")) return "invalid_binding";
  if (normalized.includes("edge") || normalized.includes("outgoing"))
    return "invalid_edge";
  if (normalized.includes("return")) return "missing_return";
  if (normalized.includes("condition")) return "missing_branch";
  if (
    normalized.includes("disconnected") ||
    normalized.includes("completion path")
  )
    return "incomplete_path";
  if (normalized.includes("unsupported")) return "unsupported_feature";
  return "invalid_field";
}

function minimalProject(workflow: unknown): ProjectDocument {
  return {
    schemaVersion: 1,
    project: {
      id: "workflow-validation",
      name: "workflow-validation",
      revision: 0,
    },
    site: { domain: "", origins: [], sessionMode: "public" },
    discoveredActions: [],
    tools: [
      {
        id: "workflow-tool",
        name: "workflow_tool",
        description: "Workflow validation wrapper",
        inputSchema: { type: "object", additionalProperties: true },
        access: "public",
        enabled: true,
        workflow: workflow as Workflow,
      },
    ],
    editor: {
      toolOrder: ["workflow-tool"],
      nodePositions: {},
      viewport: { x: 0, y: 0, zoom: 1 },
    },
    testRuns: [],
  };
}

export function validateWorkflow(
  value: unknown,
  options: ValidateWorkflowOptions = {},
): WorkflowValidationResult {
  try {
    validateProject(minimalProject(value), {
      requireRunnable: options.requireRunnable ?? false,
    });
    return { valid: true, issues: [] };
  } catch (error) {
    const source =
      error instanceof ProjectValidationError
        ? error.issues
        : [{ path: ".workflow", message: String(error) }];
    const issues = source
      .filter((entry) => entry.path.startsWith("project.tools[0].workflow"))
      .map((entry) => ({
        code: codeFor(entry.message),
        path: entry.path.replace(/^project\.tools\[0\]\.workflow/, ""),
        message: entry.message,
      }));
    return { valid: false, issues };
  }
}

export function isWorkflowDefinition(value: unknown): value is Workflow {
  return validateWorkflow(value).valid;
}

export function assertRunnableWorkflow(
  value: unknown,
): asserts value is Workflow {
  const result = validateWorkflow(value, { requireRunnable: true });
  if (!result.valid)
    throw new Error(
      result.issues
        .map((entry) => `${entry.path}: ${entry.message}`)
        .join("\n"),
    );
}

export const validateWorkflowDefinition = validateWorkflow;
export const checkOwnership = (value: Workflow): WorkflowValidationIssue[] =>
  validateWorkflow(value).issues.filter((entry) =>
    ["duplicate_id", "unknown_reference", "cross_tool_reference"].includes(
      entry.code,
    ),
  );
export const checkCycles = (value: Workflow): WorkflowValidationIssue[] =>
  validateWorkflow(value).issues.filter((entry) => entry.code === "cycle");
export const checkReadiness = (value: Workflow): WorkflowValidationIssue[] =>
  validateWorkflow(value, { requireRunnable: true }).issues;

export type { Workflow };
