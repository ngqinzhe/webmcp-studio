import type { JsonValue } from "../types";
import type { Binding, WorkflowNode } from "../project/types";

export type JsonBinding = Binding;

export interface BindingLocation {
  binding: Binding;
  path: string;
}

export interface BindingContext {
  inputs: JsonValue;
  outputs: Readonly<Record<string, JsonValue>>;
  runtime: Readonly<{ url?: string; origin?: string; title?: string }>;
}

export type BindingResolution =
  { ok: true; value: JsonValue } | { ok: false; message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return true;
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

function validPath(value: unknown, allowEmpty = false): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    !value.includes("\u0000") &&
    !value.split(".").some((segment) => segment === "..")
  );
}

export function isJsonBinding(value: unknown): value is Binding {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  switch (value.kind) {
    case "literal":
      return isJsonValue(value.value);
    case "input":
      return validPath(value.path);
    case "output":
      return (
        validPath(value.nodeId) &&
        (value.path === undefined || validPath(value.path, true))
      );
    case "context":
      return (
        value.path === "url" ||
        value.path === "origin" ||
        value.path === "title"
      );
    default:
      return false;
  }
}

export function literalBinding(value: JsonValue): Binding {
  return { kind: "literal", value };
}

export function inputBinding(path: string): Binding {
  return { kind: "input", path };
}

export function outputBinding(nodeId: string, path?: string): Binding {
  return path === undefined
    ? { kind: "output", nodeId }
    : { kind: "output", nodeId, path };
}

export function contextBinding(path: "url" | "origin" | "title"): Binding {
  return { kind: "context", path };
}

export function readJsonPath(
  value: JsonValue,
  path = "",
): JsonValue | undefined {
  if (!path) return value;
  let current: JsonValue = value;
  for (const part of path.split(".")) {
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) return undefined;
      const next = current[Number(part)];
      if (next === undefined) return undefined;
      current = next;
    } else if (
      isRecord(current) &&
      Object.prototype.hasOwnProperty.call(current, part)
    ) {
      current = current[part] as JsonValue;
    } else return undefined;
    if (current === undefined) return undefined;
  }
  return current;
}

export function resolveBinding(
  binding: Binding,
  context: BindingContext,
): BindingResolution {
  if (!isJsonBinding(binding))
    return { ok: false, message: "Unsupported binding." };
  switch (binding.kind) {
    case "literal":
      return { ok: true, value: binding.value };
    case "input": {
      const value = readJsonPath(context.inputs, binding.path);
      return value === undefined
        ? { ok: false, message: `Input path ${binding.path} is unavailable.` }
        : { ok: true, value };
    }
    case "output": {
      const output = context.outputs[binding.nodeId];
      if (output === undefined)
        return {
          ok: false,
          message: `Output ${binding.nodeId} is unavailable.`,
        };
      const value = readJsonPath(output, binding.path ?? "");
      return value === undefined
        ? {
            ok: false,
            message: `Output path ${binding.nodeId}.${binding.path ?? ""} is unavailable.`,
          }
        : { ok: true, value };
    }
    case "context": {
      const value = context.runtime[binding.path];
      return value === undefined
        ? {
            ok: false,
            message: `Runtime value ${binding.path} is unavailable.`,
          }
        : { ok: true, value };
    }
  }
}

function predicateBindings(value: unknown, path: string): BindingLocation[] {
  if (!isRecord(value)) return [];
  const result: BindingLocation[] = [];
  for (const key of ["left", "right", "value", "source", "item"]) {
    if (key in value && isJsonBinding(value[key]))
      result.push({ binding: value[key], path: `${path}.${key}` });
  }
  return result;
}

function nodeBindings(node: WorkflowNode, path: string): BindingLocation[] {
  const result: BindingLocation[] = [];
  const add = (binding: unknown, location: string): void => {
    if (isJsonBinding(binding)) result.push({ binding, path: location });
  };
  switch (node.type) {
    case "http":
      add(node.config.url, `${path}.config.url`);
      for (const [key, binding] of Object.entries(node.config.headers ?? {}))
        add(binding, `${path}.config.headers.${key}`);
      add(node.config.body, `${path}.config.body`);
      break;
    case "dom":
      for (const [key, binding] of Object.entries(node.config.args ?? {}))
        add(binding, `${path}.config.args.${key}`);
      break;
    case "transform":
      add(node.config.source, `${path}.config.source`);
      if (node.config.predicate)
        result.push(
          ...predicateBindings(
            node.config.predicate,
            `${path}.config.predicate`,
          ),
        );
      break;
    case "condition":
      add(node.config.left, `${path}.config.left`);
      add(node.config.right, `${path}.config.right`);
      break;
    case "return":
      add(node.config.value, `${path}.config.value`);
      for (const [key, binding] of Object.entries(node.config.fields ?? {}))
        add(binding, `${path}.config.fields.${key}`);
      break;
    case "wait":
    case "extract":
      break;
  }
  return result;
}

export function collectNodeBindings(node: WorkflowNode): BindingLocation[] {
  return nodeBindings(node, `.nodes[?(${node.id})]`);
}

export const collectBindingsFromNode = collectNodeBindings;

export function outputDependencies(node: WorkflowNode): string[] {
  return [
    ...new Set(
      collectNodeBindings(node)
        .map(({ binding }) =>
          binding.kind === "output" ? binding.nodeId : null,
        )
        .filter((id): id is string => id !== null),
    ),
  ];
}
