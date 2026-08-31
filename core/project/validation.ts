import type {
  Capability,
  JSONSchema,
  JsonValue,
  SemanticLocator,
} from "../types";
import {
  MAX_PROJECT_BYTES,
  MAX_TRACE_ENTRIES,
  PROJECT_SCHEMA_VERSION,
  type Binding,
  type ConditionNodeConfig,
  type ControlEdge,
  type DiscoveryEvidence,
  type DiscoveredAction,
  type ProjectDocument,
  type WorkflowTraceEntry,
  type SessionSnapshot,
  type ToolAvailability,
  type ToolDefinition,
  type Workflow,
  type WorkflowNode,
  type WorkflowNodeType,
} from "./types";

export interface ProjectValidationIssue {
  path: string;
  message: string;
}

export class ProjectValidationError extends Error {
  readonly issues: ProjectValidationIssue[];

  constructor(issues: ProjectValidationIssue[] | string, path = "project") {
    const normalized =
      typeof issues === "string" ? [{ path, message: issues }] : issues;
    super(
      normalized.map((issue) => `${issue.path}: ${issue.message}`).join("; "),
    );
    this.name = "ProjectValidationError";
    this.issues = normalized;
  }
}

export interface ProjectValidationOptions {
  requireRunnable?: boolean;
  maxBytes?: number;
}

export interface ProjectValidationResult {
  ok: boolean;
  value?: ProjectDocument;
  issues: ProjectValidationIssue[];
}

const NODE_TYPES = new Set<WorkflowNodeType>([
  "http",
  "dom",
  "wait",
  "extract",
  "transform",
  "condition",
  "return",
]);
const EFFECTS = new Set(["read", "navigate", "interact", "mutate"]);
const ACCESS = new Set(["public", "authenticated"]);
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const CONDITION_OPERATORS = new Set([
  "equals",
  "not_equals",
  "contains",
  "exists",
  "truthy",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function issue(
  issues: ProjectValidationIssue[],
  path: string,
  message: string,
): void {
  issues.push({ path, message });
}

function requireRecord(
  value: unknown,
  path: string,
  issues: ProjectValidationIssue[],
): value is Record<string, unknown> {
  if (!isRecord(value)) {
    issue(issues, path, "must be an object");
    return false;
  }
  return true;
}

function requireString(
  value: unknown,
  path: string,
  issues: ProjectValidationIssue[],
  nonEmpty = true,
): value is string {
  if (typeof value !== "string" || (nonEmpty && value.trim().length === 0)) {
    issue(
      issues,
      path,
      nonEmpty ? "must be a non-empty string" : "must be a string",
    );
    return false;
  }
  return true;
}

function requireFiniteNumber(
  value: unknown,
  path: string,
  issues: ProjectValidationIssue[],
): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issue(issues, path, "must be a finite number");
    return false;
  }
  return true;
}

function requireArray(
  value: unknown,
  path: string,
  issues: ProjectValidationIssue[],
): value is unknown[] {
  if (!Array.isArray(value)) {
    issue(issues, path, "must be an array");
    return false;
  }
  return true;
}

function isJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
): value is JsonValue {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const next = new Set(ancestors);
  next.add(value);
  if (Array.isArray(value))
    return value.every((item) => isJsonValue(item, next));
  return Object.entries(value).every(
    ([key, item]) => key !== "__proto__" && isJsonValue(item, next),
  );
}

/** Hostnames that must never be reached by a production workflow by default. */
export function isPrivateNetworkHostname(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host === "::1" ||
    host.endsWith(".local") ||
    host.endsWith(".localhost")
  )
    return true;
  const octets = host.split(".");
  if (octets.length === 4 && octets.every((part) => /^\d+$/.test(part))) {
    const numbers = octets.map(Number);
    if (numbers.some((part) => part > 255)) return true;
    const [first, second] = numbers;
    if (first === undefined || second === undefined) return true;
    return (
      first === 0 ||
      first === 10 ||
      (first === 100 && second >= 64 && second <= 127) ||
      first === 127 ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 0) ||
      (first === 192 && second === 168)
    );
  }
  // IPv6 loopback, unique-local, link-local, and IPv4-mapped private space.
  return (
    host === "0:0:0:0:0:0:0:1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe8") ||
    host.startsWith("fe9") ||
    host.startsWith("fea") ||
    host.startsWith("feb") ||
    host.startsWith("::ffff:127.") ||
    host.startsWith("::ffff:10.") ||
    host.startsWith("::ffff:192.168.") ||
    host.startsWith("::ffff:172.")
  );
}

function validateHttpDestination(
  value: string,
  path: string,
  issues: ProjectValidationIssue[],
  allowPrivateNetwork = false,
): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      issue(issues, path, "must use http or https");
      return;
    }
    if (url.username || url.password)
      issue(issues, path, "must not contain credentials");
    if (!allowPrivateNetwork && isPrivateNetworkHostname(url.hostname))
      issue(issues, path, "private or local network destinations are blocked");
    for (const key of url.searchParams.keys())
      if (isSensitiveKey(key))
        issue(issues, path, "must not contain sensitive query parameters");
    if (url.hash) issue(issues, path, "must not contain a URL fragment");
  } catch {
    issue(issues, path, "must be an absolute http or https URL");
  }
}

export interface HttpDestinationPolicy {
  allowedOrigins?: readonly string[];
  allowPrivateNetwork?: boolean;
}

/** Runtime check for both literal and dynamically resolved request destinations. */
export function isSafeHttpDestination(
  value: string,
  policy: HttpDestinationPolicy = {},
): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (url.username || url.password || url.hash) return false;
    if (!policy.allowPrivateNetwork && isPrivateNetworkHostname(url.hostname))
      return false;
    if ([...url.searchParams.keys()].some((key) => isSensitiveKey(key)))
      return false;
    if (policy.allowedOrigins && !policy.allowedOrigins.includes(url.origin))
      return false;
    return true;
  } catch {
    return false;
  }
}

function validateLiteralData(
  value: unknown,
  path: string,
  issues: ProjectValidationIssue[],
  ancestors = new Set<object>(),
): void {
  if (value === null || typeof value !== "object") return;
  if (ancestors.has(value)) return;
  const next = new Set(ancestors);
  next.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      validateLiteralData(item, `${path}[${index}]`, issues, next),
    );
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key))
      issue(
        issues,
        `${path}.${key}`,
        "sensitive values must come from the authorized runtime",
      );
    validateLiteralData(child, `${path}.${key}`, issues, next);
  }
}

function validateSchema(
  value: unknown,
  path: string,
  issues: ProjectValidationIssue[],
  ancestors = new Set<object>(),
): value is JSONSchema {
  if (!isRecord(value) || ancestors.has(value)) {
    issue(issues, path, "must be a non-cyclic JSON Schema object");
    return false;
  }
  const next = new Set(ancestors);
  next.add(value);
  if (value.type !== undefined) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    for (const type of types) {
      if (
        type !== "string" &&
        type !== "number" &&
        type !== "integer" &&
        type !== "boolean" &&
        type !== "object" &&
        type !== "array" &&
        type !== "null"
      ) {
        issue(
          issues,
          `${path}.type`,
          "contains an unsupported JSON Schema type",
        );
      }
    }
  }
  if (
    value.enum !== undefined &&
    (!Array.isArray(value.enum) ||
      !value.enum.every((item) => isJsonValue(item)))
  ) {
    issue(issues, `${path}.enum`, "must contain JSON primitive values");
  }
  if (
    value.properties !== undefined &&
    requireRecord(value.properties, `${path}.properties`, issues)
  ) {
    for (const [key, schema] of Object.entries(value.properties)) {
      validateSchema(schema, `${path}.properties.${key}`, issues, next);
    }
  }
  if (value.items !== undefined)
    validateSchema(value.items, `${path}.items`, issues, next);
  if (
    value.required !== undefined &&
    requireArray(value.required, `${path}.required`, issues)
  ) {
    for (const [index, name] of value.required.entries()) {
      requireString(name, `${path}.required[${index}]`, issues);
    }
  }
  if (
    value.additionalProperties !== undefined &&
    typeof value.additionalProperties !== "boolean"
  ) {
    validateSchema(
      value.additionalProperties,
      `${path}.additionalProperties`,
      issues,
      next,
    );
  }
  for (const key of ["minimum", "maximum", "minLength", "maxLength"]) {
    if (value[key] !== undefined)
      requireFiniteNumber(value[key], `${path}.${key}`, issues);
  }
  if (value.pattern !== undefined)
    requireString(value.pattern, `${path}.pattern`, issues);
  if (value.default !== undefined && !isJsonValue(value.default)) {
    issue(issues, `${path}.default`, "must be JSON-compatible");
  }
  return true;
}

function validateLocator(
  value: unknown,
  path: string,
  issues: ProjectValidationIssue[],
): value is SemanticLocator {
  if (!requireRecord(value, path, issues)) return false;
  if (requireArray(value.framePath, `${path}.framePath`, issues)) {
    for (const [index, frame] of value.framePath.entries()) {
      if (
        requireFiniteNumber(frame, `${path}.framePath[${index}]`, issues) &&
        (!Number.isInteger(frame) || frame < 0)
      ) {
        issue(
          issues,
          `${path}.framePath[${index}]`,
          "must be a non-negative integer",
        );
      }
    }
  }
  if (requireArray(value.shadowPath, `${path}.shadowPath`, issues)) {
    for (const [index, host] of value.shadowPath.entries()) {
      if (!requireRecord(host, `${path}.shadowPath[${index}]`, issues))
        continue;
      for (const key of ["role", "accessibleName", "selector"]) {
        if (host[key] !== undefined)
          requireString(
            host[key],
            `${path}.shadowPath[${index}].${key}`,
            issues,
          );
      }
      if (
        host.index !== undefined &&
        requireFiniteNumber(
          host.index,
          `${path}.shadowPath[${index}].index`,
          issues,
        ) &&
        (!Number.isInteger(host.index) || host.index < 0)
      ) {
        issue(
          issues,
          `${path}.shadowPath[${index}].index`,
          "must be a non-negative integer",
        );
      }
    }
  }
  for (const key of ["role", "accessibleName", "labelText"]) {
    if (value[key] !== undefined)
      requireString(value[key], `${path}.${key}`, issues);
  }
  if (
    value.context !== undefined &&
    !requireRecord(value.context, `${path}.context`, issues)
  )
    return false;
  if (
    requireArray(value.stableAttributes, `${path}.stableAttributes`, issues)
  ) {
    for (const [index, attribute] of value.stableAttributes.entries()) {
      if (
        !requireRecord(attribute, `${path}.stableAttributes[${index}]`, issues)
      )
        continue;
      requireString(
        attribute.name,
        `${path}.stableAttributes[${index}].name`,
        issues,
      );
      requireString(
        attribute.value,
        `${path}.stableAttributes[${index}].value`,
        issues,
        false,
      );
    }
  }
  if (
    value.relationship !== undefined &&
    ![
      "form-control",
      "form-submit",
      "context-action",
      "labelled-control",
    ].includes(String(value.relationship))
  ) {
    issue(
      issues,
      `${path}.relationship`,
      "contains an unsupported relationship",
    );
  }
  if (requireArray(value.fallbacks, `${path}.fallbacks`, issues)) {
    for (const [index, fallback] of value.fallbacks.entries()) {
      if (!requireRecord(fallback, `${path}.fallbacks[${index}]`, issues))
        continue;
      requireString(fallback.kind, `${path}.fallbacks[${index}].kind`, issues);
      requireString(
        fallback.description,
        `${path}.fallbacks[${index}].description`,
        issues,
        false,
      );
    }
  }
  return true;
}

function validateCapability(
  value: unknown,
  path: string,
  issues: ProjectValidationIssue[],
): value is Capability {
  if (!requireRecord(value, path, issues)) return false;
  requireString(value.id, `${path}.id`, issues);
  requireString(value.name, `${path}.name`, issues);
  requireString(value.description, `${path}.description`, issues, false);
  validateSchema(value.inputSchema, `${path}.inputSchema`, issues);
  if (typeof value.effect !== "string" || !EFFECTS.has(value.effect))
    issue(issues, `${path}.effect`, "contains an unsupported effect");
  if (
    requireFiniteNumber(value.confidence, `${path}.confidence`, issues) &&
    (value.confidence < 0 || value.confidence > 1)
  )
    issue(issues, `${path}.confidence`, "must be between 0 and 1");
  if (!requireRecord(value.source, `${path}.source`, issues)) return false;
  if (typeof value.source.url === "string" && value.source.url)
    validateHttpDestination(
      value.source.url,
      `${path}.source.url`,
      issues,
      true,
    );
  validateLocator(value.locator, `${path}.locator`, issues);
  if (!requireRecord(value.executor, `${path}.executor`, issues)) return false;
  return true;
}

function validateEvidence(
  value: unknown,
  path: string,
  issues: ProjectValidationIssue[],
): value is DiscoveryEvidence {
  if (!requireRecord(value, path, issues)) return false;
  if (!(["dom", "http", "manual"] as string[]).includes(String(value.type)))
    issue(issues, `${path}.type`, "must be dom, http, or manual");
  requireString(value.url, `${path}.url`, issues, false);
  if (typeof value.url === "string" && value.url)
    validateHttpDestination(value.url, `${path}.url`, issues, true);
  if (
    requireFiniteNumber(value.observedAt, `${path}.observedAt`, issues) &&
    value.observedAt < 0
  )
    issue(issues, `${path}.observedAt`, "must not be negative");
  if (value.note !== undefined)
    requireString(value.note, `${path}.note`, issues, false);
  if (value.locator !== undefined)
    validateLocator(value.locator, `${path}.locator`, issues);
  return true;
}

function validateDiscoveredAction(
  value: unknown,
  path: string,
  issues: ProjectValidationIssue[],
): value is DiscoveredAction {
  if (!requireRecord(value, path, issues)) return false;
  for (const key of ["id", "name"])
    requireString(value[key], `${path}.${key}`, issues);
  requireString(value.description, `${path}.description`, issues, false);
  validateSchema(value.inputSchema, `${path}.inputSchema`, issues);
  if (typeof value.effect !== "string" || !EFFECTS.has(value.effect))
    issue(issues, `${path}.effect`, "contains an unsupported effect");
  if (
    requireFiniteNumber(value.confidence, `${path}.confidence`, issues) &&
    (value.confidence < 0 || value.confidence > 1)
  )
    issue(issues, `${path}.confidence`, "must be between 0 and 1");
  if (typeof value.access !== "string" || !ACCESS.has(value.access))
    issue(issues, `${path}.access`, "must be public or authenticated");
  if (
    typeof value.status !== "string" ||
    !["observed", "inferred", "blocked"].includes(value.status)
  )
    issue(issues, `${path}.status`, "contains an unsupported discovery status");
  if (requireArray(value.evidence, `${path}.evidence`, issues))
    value.evidence.forEach((item, index) =>
      validateEvidence(item, `${path}.evidence[${index}]`, issues),
    );
  if (value.capability !== undefined)
    validateCapability(value.capability, `${path}.capability`, issues);
  if (value.blockedReason !== undefined)
    requireString(value.blockedReason, `${path}.blockedReason`, issues, false);
  return true;
}

function validateBinding(
  value: unknown,
  path: string,
  issues: ProjectValidationIssue[],
  nodeIds: Set<string>,
  ownerNodeId: string,
): value is Binding {
  if (!requireRecord(value, path, issues)) return false;
  if (value.kind === "literal") {
    if (!isJsonValue(value.value))
      issue(issues, `${path}.value`, "must be JSON-compatible");
    else validateLiteralData(value.value, `${path}.value`, issues);
    return true;
  }
  if (value.kind === "input" || value.kind === "context") {
    requireString(value.path, `${path}.path`, issues);
    if (
      value.kind === "context" &&
      !["url", "origin", "title"].includes(String(value.path))
    )
      issue(issues, `${path}.path`, "is not a supported runtime value");
    return true;
  }
  if (value.kind === "output") {
    requireString(value.nodeId, `${path}.nodeId`, issues);
    if (value.nodeId === ownerNodeId)
      issue(issues, path, "cannot reference its own output");
    else if (typeof value.nodeId === "string" && !nodeIds.has(value.nodeId))
      issue(
        issues,
        `${path}.nodeId`,
        "references a node outside this workflow",
      );
    if (value.path !== undefined)
      requireString(value.path, `${path}.path`, issues, false);
    return true;
  }
  issue(issues, `${path}.kind`, "contains an unsupported binding kind");
  return false;
}

function validateNode(
  node: unknown,
  path: string,
  issues: ProjectValidationIssue[],
  nodeIds: Set<string>,
): node is WorkflowNode {
  if (!requireRecord(node, path, issues)) return false;
  requireString(node.id, `${path}.id`, issues);
  const nodeId = typeof node.id === "string" ? node.id : "";
  requireString(node.label, `${path}.label`, issues, false);
  if (!requireRecord(node.position, `${path}.position`, issues)) return false;
  requireFiniteNumber(node.position.x, `${path}.position.x`, issues);
  requireFiniteNumber(node.position.y, `${path}.position.y`, issues);
  if (
    typeof node.type !== "string" ||
    !NODE_TYPES.has(node.type as WorkflowNodeType)
  ) {
    issue(issues, `${path}.type`, "contains an unsupported node type");
    return false;
  }
  if (!requireRecord(node.config, `${path}.config`, issues)) return false;
  const config = node.config;
  switch (node.type) {
    case "dom":
      requireString(config.capabilityId, `${path}.config.capabilityId`, issues);
      if (
        config.args !== undefined &&
        requireRecord(config.args, `${path}.config.args`, issues)
      )
        for (const [key, binding] of Object.entries(config.args))
          validateBinding(
            binding,
            `${path}.config.args.${key}`,
            issues,
            nodeIds,
            nodeId,
          );
      if (
        config.requiresApproval !== undefined &&
        typeof config.requiresApproval !== "boolean"
      )
        issue(issues, `${path}.config.requiresApproval`, "must be boolean");
      break;
    case "http":
      if (typeof config.method !== "string" || !METHODS.has(config.method))
        issue(
          issues,
          `${path}.config.method`,
          "contains an unsupported HTTP method",
        );
      validateBinding(
        config.url,
        `${path}.config.url`,
        issues,
        nodeIds,
        nodeId,
      );
      if (
        isRecord(config.url) &&
        config.url.kind === "literal" &&
        typeof config.url.value === "string"
      )
        validateHttpDestination(
          config.url.value,
          `${path}.config.url.value`,
          issues,
        );
      if (
        config.headers !== undefined &&
        requireRecord(config.headers, `${path}.config.headers`, issues)
      )
        for (const [key, binding] of Object.entries(config.headers)) {
          if (/authorization|cookie|token|password|secret|csrf/i.test(key))
            issue(
              issues,
              `${path}.config.headers.${key}`,
              "sensitive headers must be supplied by the authorized runtime, not stored in config",
            );
          validateBinding(
            binding,
            `${path}.config.headers.${key}`,
            issues,
            nodeIds,
            nodeId,
          );
        }
      if (config.body !== undefined)
        validateBinding(
          config.body,
          `${path}.config.body`,
          issues,
          nodeIds,
          nodeId,
        );
      if (
        config.parseAs !== undefined &&
        !["json", "text"].includes(String(config.parseAs))
      )
        issue(issues, `${path}.config.parseAs`, "must be json or text");
      break;
    case "wait":
      if (config.selector === undefined && config.textIncludes === undefined)
        issue(
          issues,
          `${path}.config`,
          "must provide selector or textIncludes",
        );
      if (config.selector !== undefined)
        requireString(config.selector, `${path}.config.selector`, issues);
      if (config.textIncludes !== undefined)
        requireString(
          config.textIncludes,
          `${path}.config.textIncludes`,
          issues,
        );
      if (
        requireFiniteNumber(
          config.timeoutMs,
          `${path}.config.timeoutMs`,
          issues,
        ) &&
        (config.timeoutMs < 1 || config.timeoutMs > 120_000)
      )
        issue(
          issues,
          `${path}.config.timeoutMs`,
          "must be between 1 and 120000",
        );
      if (
        config.pollMs !== undefined &&
        requireFiniteNumber(config.pollMs, `${path}.config.pollMs`, issues) &&
        (config.pollMs < 1 || config.pollMs > 5_000)
      )
        issue(issues, `${path}.config.pollMs`, "must be between 1 and 5000");
      break;
    case "extract":
      if (config.target === undefined && config.selector === undefined)
        issue(issues, `${path}.config`, "must provide target or selector");
      if (config.target !== undefined)
        validateLocator(config.target, `${path}.config.target`, issues);
      if (config.selector !== undefined)
        requireString(config.selector, `${path}.config.selector`, issues);
      if (
        config.fields !== undefined &&
        requireRecord(config.fields, `${path}.config.fields`, issues)
      )
        for (const [key, selector] of Object.entries(config.fields))
          requireString(selector, `${path}.config.fields.${key}`, issues);
      if (
        config.includeText !== undefined &&
        typeof config.includeText !== "boolean"
      )
        issue(issues, `${path}.config.includeText`, "must be boolean");
      if (config.sensitive === true)
        issue(
          issues,
          `${path}.config.sensitive`,
          "sensitive extraction is not supported",
        );
      break;
    case "transform":
      validateBinding(
        config.source,
        `${path}.config.source`,
        issues,
        nodeIds,
        nodeId,
      );
      if (
        typeof config.operation !== "string" ||
        !["pick", "project", "filter", "stringify", "coalesce"].includes(
          config.operation,
        )
      )
        issue(
          issues,
          `${path}.config.operation`,
          "contains an unsupported transform",
        );
      if (config.path !== undefined)
        requireString(config.path, `${path}.config.path`, issues, false);
      if (
        config.fields !== undefined &&
        requireArray(config.fields, `${path}.config.fields`, issues)
      )
        config.fields.forEach((field, index) =>
          requireString(field, `${path}.config.fields[${index}]`, issues),
        );
      if (config.predicate !== undefined) {
        if (
          !requireRecord(config.predicate, `${path}.config.predicate`, issues)
        )
          break;
        requireString(
          config.predicate.path,
          `${path}.config.predicate.path`,
          issues,
          false,
        );
        if (
          config.predicate.equals === undefined &&
          config.predicate.contains === undefined
        )
          issue(issues, `${path}.config.predicate`, "needs equals or contains");
        if (
          config.predicate.equals !== undefined &&
          !isJsonValue(config.predicate.equals)
        )
          issue(
            issues,
            `${path}.config.predicate.equals`,
            "must be JSON-compatible",
          );
        if (config.predicate.contains !== undefined)
          requireString(
            config.predicate.contains,
            `${path}.config.predicate.contains`,
            issues,
            false,
          );
      }
      break;
    case "condition":
      validateCondition(
        config as unknown as ConditionNodeConfig,
        path,
        issues,
        nodeIds,
        nodeId,
      );
      break;
    case "return":
      if (config.value === undefined && config.fields === undefined)
        issue(issues, `${path}.config`, "must provide value or fields");
      if (config.value !== undefined)
        validateBinding(
          config.value,
          `${path}.config.value`,
          issues,
          nodeIds,
          nodeId,
        );
      if (
        config.fields !== undefined &&
        requireRecord(config.fields, `${path}.config.fields`, issues)
      )
        for (const [key, binding] of Object.entries(config.fields))
          validateBinding(
            binding,
            `${path}.config.fields.${key}`,
            issues,
            nodeIds,
            nodeId,
          );
      break;
  }
  return true;
}

function validateCondition(
  config: ConditionNodeConfig,
  path: string,
  issues: ProjectValidationIssue[],
  nodeIds: Set<string>,
  ownerNodeId: string,
): void {
  validateBinding(
    config.left,
    `${path}.config.left`,
    issues,
    nodeIds,
    ownerNodeId,
  );
  if (
    typeof config.operator !== "string" ||
    !CONDITION_OPERATORS.has(config.operator)
  )
    issue(
      issues,
      `${path}.config.operator`,
      "contains an unsupported condition operator",
    );
  if (config.right !== undefined)
    validateBinding(
      config.right,
      `${path}.config.right`,
      issues,
      nodeIds,
      ownerNodeId,
    );
  if (
    ["equals", "not_equals", "contains"].includes(String(config.operator)) &&
    config.right === undefined
  )
    issue(issues, `${path}.config.right`, "is required for this operator");
}

function validateEdges(
  workflow: Workflow,
  path: string,
  issues: ProjectValidationIssue[],
  requireRunnable: boolean,
): void {
  const nodeMap = new Map(workflow.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, string[]>();
  for (const [index, edge] of workflow.edges.entries()) {
    const edgePath = `${path}.edges[${index}]`;
    if (!requireRecord(edge, edgePath, issues)) continue;
    requireString(edge.from, `${edgePath}.from`, issues);
    requireString(edge.to, `${edgePath}.to`, issues);
    if (typeof edge.from === "string" && !nodeMap.has(edge.from))
      issue(issues, `${edgePath}.from`, "references a missing node");
    if (typeof edge.to === "string" && !nodeMap.has(edge.to))
      issue(issues, `${edgePath}.to`, "references a missing node");
    if (
      edge.when !== undefined &&
      !["always", "true", "false"].includes(String(edge.when))
    )
      issue(issues, `${edgePath}.when`, "contains an unsupported branch");
    if (typeof edge.from === "string" && typeof edge.to === "string") {
      const entries = adjacency.get(edge.from) ?? [];
      entries.push(edge.to);
      adjacency.set(edge.from, entries);
    }
  }
  for (const node of workflow.nodes) {
    const outgoing = workflow.edges.filter((edge) => edge.from === node.id);
    if (node.type === "return" && outgoing.length > 0)
      issue(
        issues,
        `${path}.nodes.${node.id}`,
        "return nodes cannot have outgoing edges",
      );
    if (node.type === "condition") {
      const trueEdges = outgoing.filter((edge) => edge.when === "true");
      const falseEdges = outgoing.filter((edge) => edge.when === "false");
      if (
        requireRunnable &&
        (trueEdges.length !== 1 || falseEdges.length !== 1)
      )
        issue(
          issues,
          `${path}.nodes.${node.id}`,
          "conditions need exactly one true and one false edge",
        );
      if (
        outgoing.some(
          (edge) => edge.when === "always" || edge.when === undefined,
        )
      )
        issue(
          issues,
          `${path}.nodes.${node.id}`,
          "conditions may not use an always edge",
        );
    } else if (
      outgoing.some((edge) => edge.when === "true" || edge.when === "false")
    ) {
      issue(
        issues,
        `${path}.nodes.${node.id}`,
        "only conditions may have branch edges",
      );
    } else if (outgoing.length > 1) {
      issue(
        issues,
        `${path}.nodes.${node.id}`,
        "a sequential node may have at most one outgoing edge",
      );
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      issue(issues, `${path}.edges`, "workflow contains a cycle");
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of adjacency.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  if (typeof workflow.entryNodeId === "string") visit(workflow.entryNodeId);
}

function validateWorkflow(
  value: unknown,
  path: string,
  issues: ProjectValidationIssue[],
  requireRunnable: boolean,
): value is Workflow {
  if (!requireRecord(value, path, issues)) return false;
  requireString(value.entryNodeId, `${path}.entryNodeId`, issues);
  if (!requireArray(value.nodes, `${path}.nodes`, issues)) return false;
  const nodeIds = new Set<string>();
  for (const [index, node] of value.nodes.entries()) {
    if (isRecord(node) && typeof node.id === "string") {
      if (nodeIds.has(node.id))
        issue(
          issues,
          `${path}.nodes[${index}].id`,
          "duplicates another node ID",
        );
      nodeIds.add(node.id);
    }
  }
  value.nodes.forEach((node, index) =>
    validateNode(node, `${path}.nodes[${index}]`, issues, nodeIds),
  );
  if (!requireArray(value.edges, `${path}.edges`, issues)) return false;
  validateEdges(value as unknown as Workflow, path, issues, requireRunnable);
  if (typeof value.entryNodeId === "string" && !nodeIds.has(value.entryNodeId))
    issue(issues, `${path}.entryNodeId`, "references a missing node");

  if (requireRunnable && nodeIds.size > 0) {
    const map = new Map(
      value.nodes.flatMap((node): [string, WorkflowNode][] =>
        isRecord(node) && typeof node.id === "string"
          ? [[node.id, node as unknown as WorkflowNode]]
          : [],
      ),
    );
    const reachable = new Set<string>();
    const visit = (id: string): void => {
      if (reachable.has(id)) return;
      reachable.add(id);
      for (const edge of value.edges as ControlEdge[])
        if (edge.from === id) visit(edge.to);
    };
    if (typeof value.entryNodeId === "string") visit(value.entryNodeId);
    for (const id of map.keys())
      if (!reachable.has(id))
        issue(
          issues,
          `${path}.nodes.${id}`,
          "is disconnected from the entry node",
        );
    for (const id of reachable) {
      const node = map.get(id);
      if (
        node &&
        node.type !== "return" &&
        !(value.edges as ControlEdge[]).some((edge) => edge.from === id)
      )
        issue(issues, `${path}.nodes.${id}`, "has no completion path");
    }
  }
  return true;
}

function validateTool(
  value: unknown,
  path: string,
  issues: ProjectValidationIssue[],
  requireRunnable: boolean,
): value is ToolDefinition {
  if (!requireRecord(value, path, issues)) return false;
  for (const key of ["id", "name"])
    requireString(value[key], `${path}.${key}`, issues);
  if (
    typeof value.name === "string" &&
    !/^[a-z][a-z0-9_]{0,63}$/.test(value.name)
  )
    issue(issues, `${path}.name`, "must use a stable snake_case tool name");
  requireString(value.description, `${path}.description`, issues, false);
  validateSchema(value.inputSchema, `${path}.inputSchema`, issues);
  if (value.resultSchema !== undefined)
    validateSchema(value.resultSchema, `${path}.resultSchema`, issues);
  if (typeof value.access !== "string" || !ACCESS.has(value.access))
    issue(issues, `${path}.access`, "must be public or authenticated");
  if (typeof value.enabled !== "boolean")
    issue(issues, `${path}.enabled`, "must be boolean");
  validateWorkflow(value.workflow, `${path}.workflow`, issues, requireRunnable);
  return true;
}

function validateToolAccess(
  tool: unknown,
  toolPath: string,
  discoveredActions: readonly unknown[],
  issues: ProjectValidationIssue[],
): void {
  if (!isRecord(tool) || tool.access !== "public" || !isRecord(tool.workflow))
    return;
  const protectedCapabilityIds = new Set(
    discoveredActions.flatMap((action) => {
      if (!isRecord(action) || action.access !== "authenticated") return [];
      const capability = isRecord(action.capability) ? action.capability : null;
      return capability && typeof capability.id === "string"
        ? [capability.id]
        : [];
    }),
  );
  if (!protectedCapabilityIds.size || !Array.isArray(tool.workflow.nodes))
    return;
  tool.workflow.nodes.forEach((node, index) => {
    if (
      isRecord(node) &&
      node.type === "dom" &&
      isRecord(node.config) &&
      typeof node.config.capabilityId === "string" &&
      protectedCapabilityIds.has(node.config.capabilityId)
    )
      issue(
        issues,
        `${toolPath}.workflow.nodes[${index}].config.capabilityId`,
        "a public tool cannot reach an authenticated capability",
      );
  });
}

function validateTraceEntry(
  value: unknown,
  path: string,
  issues: ProjectValidationIssue[],
): value is WorkflowTraceEntry {
  if (!requireRecord(value, path, issues)) return false;
  requireString(value.nodeId, `${path}.nodeId`, issues);
  requireString(value.type, `${path}.type`, issues);
  if (
    !(
      [
        "http",
        "dom",
        "wait",
        "extract",
        "transform",
        "condition",
        "return",
      ] as string[]
    ).includes(String(value.type))
  )
    issue(issues, `${path}.type`, "contains an unsupported node type");
  if (
    !(["completed", "failed", "skipped"] as string[]).includes(
      String(value.status),
    )
  )
    issue(issues, `${path}.status`, "contains an unsupported trace status");
  requireFiniteNumber(value.startedAt, `${path}.startedAt`, issues);
  requireFiniteNumber(value.finishedAt, `${path}.finishedAt`, issues);
  if (value.input !== undefined) {
    if (!isJsonValue(value.input))
      issue(issues, `${path}.input`, "must be JSON-compatible");
    else validateLiteralData(value.input, `${path}.input`, issues);
  }
  if (value.output !== undefined) {
    if (!isJsonValue(value.output))
      issue(issues, `${path}.output`, "must be JSON-compatible");
    else validateLiteralData(value.output, `${path}.output`, issues);
  }
  if (value.error !== undefined)
    requireString(value.error, `${path}.error`, issues, false);
  return true;
}

function validateTestRun(
  value: unknown,
  path: string,
  issues: ProjectValidationIssue[],
): void {
  if (!requireRecord(value, path, issues)) return;
  requireString(value.id, `${path}.id`, issues);
  requireString(value.toolId, `${path}.toolId`, issues);
  if (
    requireFiniteNumber(value.revision, `${path}.revision`, issues) &&
    (!Number.isSafeInteger(value.revision) || value.revision < 0)
  )
    issue(issues, `${path}.revision`, "must be a non-negative integer");
  requireFiniteNumber(value.startedAt, `${path}.startedAt`, issues);
  requireFiniteNumber(value.finishedAt, `${path}.finishedAt`, issues);
  if (typeof value.success !== "boolean")
    issue(issues, `${path}.success`, "must be boolean");
  requireString(value.status, `${path}.status`, issues);
  if (value.result !== undefined) {
    if (!isJsonValue(value.result))
      issue(issues, `${path}.result`, "must be JSON-compatible");
    else validateLiteralData(value.result, `${path}.result`, issues);
  }
  if (requireArray(value.trace, `${path}.trace`, issues)) {
    if (value.trace.length > MAX_TRACE_ENTRIES)
      issue(
        issues,
        `${path}.trace`,
        `must contain at most ${MAX_TRACE_ENTRIES} entries`,
      );
    value.trace.forEach((entry, index) =>
      validateTraceEntry(entry, `${path}.trace[${index}]`, issues),
    );
  }
}

function validateOrigin(
  value: string,
  path: string,
  issues: ProjectValidationIssue[],
): void {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:")
      issue(issues, path, "must use http or https");
    if (url.username || url.password)
      issue(issues, path, "must not contain credentials");
    if (url.pathname !== "/" || url.search || url.hash)
      issue(
        issues,
        path,
        "must be an origin without a path, query, or fragment",
      );
  } catch {
    issue(issues, path, "must be a valid origin");
  }
}

/** Validate a project draft; set requireRunnable for activation/import execution. */
export function validateProject(
  value: unknown,
  options: ProjectValidationOptions = {},
): ProjectDocument {
  const issues: ProjectValidationIssue[] = [];
  const maxBytes = options.maxBytes ?? MAX_PROJECT_BYTES;
  try {
    const serialized = JSON.stringify(value);
    if (serialized && serialized.length > maxBytes)
      issue(issues, "project", `exceeds the ${maxBytes}-byte limit`);
  } catch {
    issue(issues, "project", "must be JSON-compatible");
  }
  if (!requireRecord(value, "project", issues))
    throw new ProjectValidationError(issues);
  if (value.schemaVersion !== PROJECT_SCHEMA_VERSION)
    issue(issues, "schemaVersion", `must be ${PROJECT_SCHEMA_VERSION}`);
  if (!requireRecord(value.project, "project.project", issues)) {
    throw new ProjectValidationError(issues);
  }
  requireString(value.project.id, "project.project.id", issues);
  requireString(value.project.name, "project.project.name", issues);
  if (
    requireFiniteNumber(
      value.project.revision,
      "project.project.revision",
      issues,
    ) &&
    (!Number.isInteger(value.project.revision) || value.project.revision < 0)
  )
    issue(issues, "project.project.revision", "must be a non-negative integer");
  if (!requireRecord(value.site, "project.site", issues))
    throw new ProjectValidationError(issues);
  requireString(value.site.domain, "project.site.domain", issues, false);
  if (value.site.goal !== undefined)
    requireString(value.site.goal, "project.site.goal", issues, false);
  if (value.site.origin !== undefined && typeof value.site.origin === "string")
    validateOrigin(value.site.origin, "project.site.origin", issues);
  if (!requireArray(value.site.origins, "project.site.origins", issues))
    value.site.origins = [];
  else
    value.site.origins.forEach((origin, index) => {
      if (requireString(origin, `project.site.origins[${index}]`, issues))
        validateOrigin(origin, `project.site.origins[${index}]`, issues);
    });
  if (
    value.site.pathPatterns !== undefined &&
    requireArray(value.site.pathPatterns, "project.site.pathPatterns", issues)
  )
    value.site.pathPatterns.forEach((pattern, index) =>
      requireString(pattern, `project.site.pathPatterns[${index}]`, issues),
    );
  if (
    typeof value.site.sessionMode !== "string" ||
    !["public", "authenticated"].includes(value.site.sessionMode)
  )
    issue(
      issues,
      "project.site.sessionMode",
      "must be public or authenticated",
    );
  if (
    !requireArray(value.discoveredActions, "project.discoveredActions", issues)
  )
    value.discoveredActions = [];
  else
    value.discoveredActions.forEach((action, index) =>
      validateDiscoveredAction(
        action,
        `project.discoveredActions[${index}]`,
        issues,
      ),
    );
  if (!requireArray(value.tools, "project.tools", issues)) value.tools = [];
  else {
    const ids = new Set<string>();
    const names = new Set<string>();
    value.tools.forEach((tool, index) => {
      if (isRecord(tool)) {
        if (typeof tool.id === "string" && ids.has(tool.id))
          issue(
            issues,
            `project.tools[${index}].id`,
            "duplicates another tool ID",
          );
        if (typeof tool.id === "string") ids.add(tool.id);
        if (typeof tool.name === "string" && names.has(tool.name))
          issue(
            issues,
            `project.tools[${index}].name`,
            "duplicates another tool name",
          );
        if (typeof tool.name === "string") names.add(tool.name);
      }
      validateTool(
        tool,
        `project.tools[${index}]`,
        issues,
        options.requireRunnable ?? false,
      );
      validateToolAccess(
        tool,
        `project.tools[${index}]`,
        value.discoveredActions as readonly unknown[],
        issues,
      );
    });
  }
  if (!requireRecord(value.editor, "project.editor", issues))
    throw new ProjectValidationError(issues);
  if (requireArray(value.editor.toolOrder, "project.editor.toolOrder", issues))
    value.editor.toolOrder.forEach((id, index) =>
      requireString(id, `project.editor.toolOrder[${index}]`, issues),
    );
  if (
    !requireRecord(
      value.editor.nodePositions,
      "project.editor.nodePositions",
      issues,
    )
  )
    value.editor.nodePositions = {};
  if (!requireRecord(value.editor.viewport, "project.editor.viewport", issues))
    value.editor.viewport = { x: 0, y: 0, zoom: 1 };
  else
    for (const key of ["x", "y", "zoom"])
      requireFiniteNumber(
        value.editor.viewport[key],
        `project.editor.viewport.${key}`,
        issues,
      );
  if (value.editor.selectedToolId !== undefined)
    requireString(
      value.editor.selectedToolId,
      "project.editor.selectedToolId",
      issues,
    );
  if (!requireArray(value.testRuns, "project.testRuns", issues))
    value.testRuns = [];
  else {
    if (value.testRuns.length > 50)
      issue(issues, "project.testRuns", "must contain at most 50 test runs");
    value.testRuns.forEach((run, index) =>
      validateTestRun(run, `project.testRuns[${index}]`, issues),
    );
  }
  if (issues.length > 0) throw new ProjectValidationError(issues);
  return value as unknown as ProjectDocument;
}

export function validateProjectResult(
  value: unknown,
  options: ProjectValidationOptions = {},
): ProjectValidationResult {
  try {
    return { ok: true, value: validateProject(value, options), issues: [] };
  } catch (error) {
    if (error instanceof ProjectValidationError)
      return { ok: false, issues: error.issues };
    return {
      ok: false,
      issues: [{ path: "project", message: "could not be validated" }],
    };
  }
}

export const validateDraft = (value: unknown): ProjectDocument =>
  validateProject(value, { requireRunnable: false });
export const validateRunnable = (value: unknown): ProjectDocument =>
  validateProject(value, { requireRunnable: true });

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Stable content identity for approval and revision checks. */
export function projectFingerprint(project: ProjectDocument): string {
  const input = stableJson(project);
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `p1-${(hash >>> 0).toString(16).padStart(8, "0")}-${input.length}`;
}

export function serializeProject(project: ProjectDocument): string {
  validateProject(project);
  const text = `${JSON.stringify(project, null, 2)}\n`;
  if (text.length > MAX_PROJECT_BYTES)
    throw new ProjectValidationError(
      "serialized project exceeds the size limit",
    );
  return text;
}

export function parseProject(
  text: string,
  options: ProjectValidationOptions = {},
): ProjectDocument {
  if (
    typeof text !== "string" ||
    text.length > (options.maxBytes ?? MAX_PROJECT_BYTES)
  )
    throw new ProjectValidationError("config exceeds the size limit");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ProjectValidationError("config is not valid JSON");
  }
  return validateProject(value, options);
}

export function cloneProject(project: ProjectDocument): ProjectDocument {
  return parseProject(JSON.stringify(project));
}

export function matchesSiteScope(
  project: ProjectDocument,
  url: string,
): boolean {
  try {
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:")
      return false;
    const origins = project.site.origins.map((origin) =>
      origin.replace(/\/$/, ""),
    );
    const exactOrigin = origins.includes(target.origin);
    const domain = project.site.domain
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");
    if (!domain) return false;
    const domainMatch =
      target.hostname.toLowerCase() === domain ||
      target.hostname.toLowerCase().endsWith(`.${domain}`);
    if (!exactOrigin && !domainMatch) return false;
    if (project.site.pathPatterns?.length)
      return project.site.pathPatterns.some((pattern) =>
        target.pathname.includes(pattern),
      );
    return true;
  } catch {
    return false;
  }
}

/** Request destinations use the explicit origin allowlist, never domain suffix matching. */
export function matchesHttpScope(
  project: ProjectDocument,
  url: string,
): boolean {
  try {
    const target = new URL(url);
    return (
      isSafeHttpDestination(target.href) &&
      project.site.origins.includes(target.origin)
    );
  } catch {
    return false;
  }
}

export function isSensitiveKey(value: string): boolean {
  return /password|passwd|token|secret|cookie|csrf|authorization|api[-_]?key|private[-_]?key|credential/i.test(
    value,
  );
}

export function getToolAvailability(
  project: ProjectDocument,
  session: SessionSnapshot = { status: "unknown", verified: false },
): ToolAvailability[] {
  return project.tools.map((tool) => {
    if (!tool.enabled)
      return {
        toolId: tool.id,
        access: tool.access,
        available: false,
        reason: "disabled",
      };
    if (tool.access === "public")
      return {
        toolId: tool.id,
        access: tool.access,
        available: true,
        reason: "available",
      };
    if (session.status !== "authenticated")
      return {
        toolId: tool.id,
        access: tool.access,
        available: false,
        reason: "protected_session_required",
      };
    if (!session.verified)
      return {
        toolId: tool.id,
        access: tool.access,
        available: false,
        reason: "session_unverified",
      };
    return {
      toolId: tool.id,
      access: tool.access,
      available: true,
      reason: "available",
    };
  });
}

export function isToolAvailable(
  project: ProjectDocument,
  toolId: string,
  session?: SessionSnapshot,
): boolean {
  return (
    getToolAvailability(project, session).find(
      (entry) => entry.toolId === toolId,
    )?.available === true
  );
}
