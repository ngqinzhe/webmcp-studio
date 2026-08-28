import type {
  Capability,
  CapabilityGraph,
  CapabilitySource,
  ExecutorDefinition,
  JSONSchema,
  SemanticLocator,
} from "../core/types";
import type { AdapterDefinition, CapabilityPatch } from "./types";

export class AdapterValidationError extends Error {
  readonly path: string;

  constructor(message: string, path = "adapter") {
    super(`${path}: ${message}`);
    this.name = "AdapterValidationError";
    this.path = path;
  }
}

const EFFECTS = new Set(["read", "navigate", "interact", "mutate"]);
const ORIGINS = new Set(["native", "inferred", "adapter"]);
const EXECUTOR_KINDS = new Set(["form", "control", "action", "read"]);
const CONTROL_KINDS = new Set([
  "input",
  "textarea",
  "select",
  "checkbox",
  "radio",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string, path: string): never {
  throw new AdapterValidationError(message, path);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) fail("expected an object", path);
  return value;
}

function requireString(value: unknown, path: string, nonEmpty = true): string {
  if (typeof value !== "string" || (nonEmpty && value.trim().length === 0)) {
    fail(nonEmpty ? "expected a non-empty string" : "expected a string", path);
  }
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail("expected an array", path);
  return value;
}

function validateNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail("expected a finite number", path);
  }
  return value;
}

function validateSchema(value: unknown, path: string): JSONSchema {
  const schema = requireRecord(value, path);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
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
        fail("contains an unsupported JSON Schema type", `${path}.type`);
      }
    }
  }
  if (schema.properties !== undefined) {
    const properties = requireRecord(schema.properties, `${path}.properties`);
    for (const [key, property] of Object.entries(properties)) {
      validateSchema(property, `${path}.properties.${key}`);
    }
  }
  if (schema.items !== undefined) validateSchema(schema.items, `${path}.items`);
  if (schema.required !== undefined) {
    const required = requireArray(schema.required, `${path}.required`);
    for (const name of required) requireString(name, `${path}.required[]`);
  }
  return value as JSONSchema;
}

function validateStableAttributes(value: unknown, path: string): void {
  const attributes = requireArray(value, path);
  for (const [index, attribute] of attributes.entries()) {
    const candidate = requireRecord(attribute, `${path}[${index}]`);
    requireString(candidate.name, `${path}[${index}].name`);
    requireString(candidate.value, `${path}[${index}].value`, false);
  }
}

function validateShadowPath(value: unknown, path: string): void {
  const hosts = requireArray(value, path);
  for (const [index, host] of hosts.entries()) {
    const candidate = requireRecord(host, `${path}[${index}]`);
    if (candidate.role !== undefined)
      requireString(candidate.role, `${path}[${index}].role`);
    if (candidate.accessibleName !== undefined) {
      requireString(
        candidate.accessibleName,
        `${path}[${index}].accessibleName`,
      );
    }
    if (candidate.selector !== undefined) {
      requireString(candidate.selector, `${path}[${index}].selector`);
    }
    if (candidate.index !== undefined) {
      const indexValue = validateNumber(
        candidate.index,
        `${path}[${index}].index`,
      );
      if (!Number.isInteger(indexValue) || indexValue < 0) {
        fail("expected a non-negative integer", `${path}[${index}].index`);
      }
    }
    if (candidate.stableAttribute !== undefined) {
      const attribute = requireRecord(
        candidate.stableAttribute,
        `${path}[${index}].stableAttribute`,
      );
      requireString(attribute.name, `${path}[${index}].stableAttribute.name`);
      requireString(
        attribute.value,
        `${path}[${index}].stableAttribute.value`,
        false,
      );
    }
  }
}

function validateLocator(value: unknown, path: string): SemanticLocator {
  const locator = requireRecord(value, path);
  const framePath = requireArray(locator.framePath, `${path}.framePath`);
  for (const [index, frame] of framePath.entries()) {
    const frameIndex = validateNumber(frame, `${path}.framePath[${index}]`);
    if (!Number.isInteger(frameIndex) || frameIndex < 0) {
      fail("expected a non-negative integer", `${path}.framePath[${index}]`);
    }
  }
  validateShadowPath(locator.shadowPath, `${path}.shadowPath`);
  if (locator.role !== undefined) requireString(locator.role, `${path}.role`);
  if (locator.accessibleName !== undefined) {
    requireString(locator.accessibleName, `${path}.accessibleName`);
  }
  if (locator.labelText !== undefined)
    requireString(locator.labelText, `${path}.labelText`);
  validateStableAttributes(
    locator.stableAttributes,
    `${path}.stableAttributes`,
  );
  const fallbacks = requireArray(locator.fallbacks, `${path}.fallbacks`);
  for (const [index, fallback] of fallbacks.entries()) {
    const candidate = requireRecord(fallback, `${path}.fallbacks[${index}]`);
    requireString(candidate.kind, `${path}.fallbacks[${index}].kind`);
    requireString(
      candidate.description,
      `${path}.fallbacks[${index}].description`,
    );
  }
  return value as SemanticLocator;
}

function validateSource(value: unknown, path: string): CapabilitySource {
  const source = requireRecord(value, path);
  const origin = requireString(source.type, `${path}.type`);
  if (!ORIGINS.has(origin))
    fail("contains an unsupported source type", `${path}.type`);
  requireString(source.url, `${path}.url`, false);
  const framePath = requireArray(source.framePath, `${path}.framePath`);
  for (const [index, frame] of framePath.entries()) {
    const frameIndex = validateNumber(frame, `${path}.framePath[${index}]`);
    if (!Number.isInteger(frameIndex) || frameIndex < 0) {
      fail("expected a non-negative integer", `${path}.framePath[${index}]`);
    }
  }
  validateShadowPath(source.shadowPath, `${path}.shadowPath`);
  if (source.nodeSignature !== undefined) {
    requireString(source.nodeSignature, `${path}.nodeSignature`, false);
  }
  if (source.reason !== undefined)
    requireString(source.reason, `${path}.reason`, false);
  if (source.adapterId !== undefined)
    requireString(source.adapterId, `${path}.adapterId`);
  return value as CapabilitySource;
}

function validateExecutor(value: unknown, path: string): ExecutorDefinition {
  const executor = requireRecord(value, path);
  const kind = requireString(executor.kind, `${path}.kind`);
  if (!EXECUTOR_KINDS.has(kind))
    fail("contains an unsupported executor kind", `${path}.kind`);
  if (kind === "form") {
    validateLocator(executor.form, `${path}.form`);
    const fields = requireRecord(executor.fields, `${path}.fields`);
    for (const [field, locator] of Object.entries(fields)) {
      validateLocator(locator, `${path}.fields.${field}`);
    }
    if (executor.submit !== undefined)
      validateLocator(executor.submit, `${path}.submit`);
  } else if (kind === "control") {
    const control = requireString(executor.control, `${path}.control`);
    if (!CONTROL_KINDS.has(control))
      fail("contains an unsupported control kind", `${path}.control`);
    validateLocator(executor.target, `${path}.target`);
    requireString(executor.valueField, `${path}.valueField`);
  } else if (kind === "action") {
    const action = requireString(executor.action, `${path}.action`);
    if (action !== "click" && action !== "navigate") {
      fail("contains an unsupported action", `${path}.action`);
    }
    validateLocator(executor.target, `${path}.target`);
    if (executor.entity !== undefined)
      requireRecord(executor.entity, `${path}.entity`);
  } else {
    validateLocator(executor.target, `${path}.target`);
  }
  requireRecord(executor.expected, `${path}.expected`);
  return value as ExecutorDefinition;
}

/** Validate and return a canonical capability without mutating it. */
export function validateCapability(
  value: unknown,
  path = "capability",
): Capability {
  const capability = requireRecord(value, path);
  requireString(capability.id, `${path}.id`);
  requireString(capability.name, `${path}.name`);
  requireString(capability.description, `${path}.description`, false);
  validateSchema(capability.inputSchema, `${path}.inputSchema`);
  const effect = requireString(capability.effect, `${path}.effect`);
  if (!EFFECTS.has(effect))
    fail("contains an unsupported effect", `${path}.effect`);
  const confidence = validateNumber(
    capability.confidence,
    `${path}.confidence`,
  );
  if (confidence < 0 || confidence > 1)
    fail("must be between 0 and 1", `${path}.confidence`);
  validateSource(capability.source, `${path}.source`);
  validateLocator(capability.locator, `${path}.locator`);
  validateExecutor(capability.executor, `${path}.executor`);
  if (
    capability.enabled !== undefined &&
    typeof capability.enabled !== "boolean"
  ) {
    fail("expected a boolean", `${path}.enabled`);
  }
  if (capability.nativeEquivalent !== undefined) {
    requireString(capability.nativeEquivalent, `${path}.nativeEquivalent`);
  }
  return value as Capability;
}

/** Validate a partial capability returned by an adapter override. */
export function validateCapabilityPatch(
  value: unknown,
  path = "override",
): CapabilityPatch {
  const patch = requireRecord(value, path);
  if (patch.id !== undefined) requireString(patch.id, `${path}.id`);
  if (patch.name !== undefined) requireString(patch.name, `${path}.name`);
  if (patch.description !== undefined) {
    requireString(patch.description, `${path}.description`, false);
  }
  if (patch.inputSchema !== undefined)
    validateSchema(patch.inputSchema, `${path}.inputSchema`);
  if (patch.effect !== undefined) {
    const effect = requireString(patch.effect, `${path}.effect`);
    if (!EFFECTS.has(effect))
      fail("contains an unsupported effect", `${path}.effect`);
  }
  if (patch.confidence !== undefined) {
    const confidence = validateNumber(patch.confidence, `${path}.confidence`);
    if (confidence < 0 || confidence > 1) {
      fail("must be between 0 and 1", `${path}.confidence`);
    }
  }
  if (patch.source !== undefined) {
    const source = requireRecord(patch.source, `${path}.source`);
    if (source.type !== undefined) {
      const origin = requireString(source.type, `${path}.source.type`);
      if (!ORIGINS.has(origin)) {
        fail("contains an unsupported source type", `${path}.source.type`);
      }
    }
    if (source.url !== undefined)
      requireString(source.url, `${path}.source.url`, false);
    if (source.framePath !== undefined) {
      const frames = requireArray(source.framePath, `${path}.source.framePath`);
      for (const [index, frame] of frames.entries()) {
        const frameIndex = validateNumber(
          frame,
          `${path}.source.framePath[${index}]`,
        );
        if (!Number.isInteger(frameIndex) || frameIndex < 0) {
          fail(
            "expected a non-negative integer",
            `${path}.source.framePath[${index}]`,
          );
        }
      }
    }
    if (source.shadowPath !== undefined) {
      validateShadowPath(source.shadowPath, `${path}.source.shadowPath`);
    }
    if (source.nodeSignature !== undefined) {
      requireString(
        source.nodeSignature,
        `${path}.source.nodeSignature`,
        false,
      );
    }
    if (source.reason !== undefined)
      requireString(source.reason, `${path}.source.reason`, false);
    if (source.adapterId !== undefined)
      requireString(source.adapterId, `${path}.source.adapterId`);
  }
  if (patch.locator !== undefined)
    validateLocator(patch.locator, `${path}.locator`);
  if (patch.executor !== undefined)
    validateExecutor(patch.executor, `${path}.executor`);
  if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
    fail("expected a boolean", `${path}.enabled`);
  }
  if (patch.nativeEquivalent !== undefined) {
    requireString(patch.nativeEquivalent, `${path}.nativeEquivalent`);
  }
  return value as CapabilityPatch;
}

/** Validate a graph before an adapter is allowed to transform it. */
export function validateCapabilityGraph(value: unknown): CapabilityGraph {
  const graph = requireRecord(value, "graph");
  if (graph.version !== 1) fail("unsupported graph version", "graph.version");
  const page = requireRecord(graph.page, "graph.page");
  requireString(page.url, "graph.page.url", false);
  requireString(page.title, "graph.page.title", false);
  requireString(page.origin, "graph.page.origin", false);
  requireString(page.hostname, "graph.page.hostname", false);
  const capabilities = requireRecord(graph.capabilities, "graph.capabilities");
  for (const [id, capability] of Object.entries(capabilities)) {
    const validated = validateCapability(
      capability,
      `graph.capabilities.${id}`,
    );
    if (validated.id !== id) {
      fail("record key must match capability.id", `graph.capabilities.${id}`);
    }
  }
  requireArray(graph.blocked, "graph.blocked");
  return value as CapabilityGraph;
}

/** Validate an adapter definition at registration time. */
export function validateAdapter(value: unknown): AdapterDefinition {
  const adapter = requireRecord(value, "adapter");
  const id = requireString(adapter.id, "adapter.id");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
    fail(
      "may contain only letters, numbers, dot, underscore, and hyphen",
      "adapter.id",
    );
  }
  if (adapter.name !== undefined) requireString(adapter.name, "adapter.name");
  if (typeof adapter.match !== "function")
    fail("match must be a function", "adapter.match");
  for (const hook of ["discover", "override", "suppress", "execute"] as const) {
    if (adapter[hook] !== undefined && typeof adapter[hook] !== "function") {
      fail(`${hook} must be a function`, `adapter.${hook}`);
    }
  }
  return value as AdapterDefinition;
}
