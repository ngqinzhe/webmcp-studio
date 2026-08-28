import type {
  Capability,
  JSONSchema,
  JsonValue,
  NativeToolSummary,
} from "../types";
import type {
  CompilationResult,
  CompilerOptions,
  NativeToolInput,
  WebMcpToolAnnotations,
  WebMcpToolDescriptor,
} from "./types";

const OMIT = Symbol("omit");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneSerializable(
  value: unknown,
  ancestors: Set<object> = new Set(),
): JsonValue | typeof OMIT {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "bigint":
      return OMIT;
    case "undefined":
    case "function":
    case "symbol":
      return OMIT;
    default:
      break;
  }

  if (typeof value !== "object") return OMIT;
  if (ancestors.has(value)) return OMIT;

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);

  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value) {
      const cloned = cloneSerializable(item, nextAncestors);
      result.push(cloned === OMIT ? null : cloned);
    }
    return result;
  }

  const result: Record<string, JsonValue> = {};
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const cloned = cloneSerializable(record[key], nextAncestors);
    if (cloned === OMIT) continue;

    // defineProperty keeps a hostile `__proto__` schema key as data instead
    // of changing the prototype of the output object.
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: cloned,
      writable: true,
    });
  }
  return result;
}

/** Clone a schema while removing values that cannot cross postMessage. */
export function cloneJsonSchema(schema: JSONSchema): JSONSchema {
  const cloned = cloneSerializable(schema);
  return isRecord(cloned) ? (cloned as JSONSchema) : {};
}

function normalizedName(value: string): string {
  return value.trim().toLowerCase();
}

function nativeName(value: NativeToolInput): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (value && typeof value.name === "string") return value.name.trim() || null;
  return null;
}

function collectNativeNames(
  nativeTools: Iterable<NativeToolInput> | undefined,
  nativeToolNames: Iterable<string> | undefined,
): Set<string> {
  const names = new Set<string>();
  if (nativeTools) {
    for (const nativeTool of nativeTools) {
      const name = nativeName(nativeTool);
      if (name) names.add(normalizedName(name));
    }
  }
  if (nativeToolNames) {
    for (const name of nativeToolNames) {
      if (typeof name === "string" && name.trim()) {
        names.add(normalizedName(name));
      }
    }
  }
  return names;
}

function annotationForEffect(
  effect: Capability["effect"],
): WebMcpToolAnnotations {
  switch (effect) {
    case "read":
      return { readOnlyHint: true };
    case "mutate":
      return { destructiveHint: true };
    case "navigate":
    case "interact":
      return {};
    default:
      return {};
  }
}

function fallbackDescription(capability: Capability): string {
  const name = capability.name.replace(/[_-]+/g, " ").trim();
  return name ? `Perform ${name}.` : "Perform the page capability.";
}

function isValidCapability(capability: Capability): boolean {
  return (
    Boolean(capability) &&
    typeof capability === "object" &&
    typeof capability.id === "string" &&
    capability.id.trim().length > 0 &&
    typeof capability.name === "string" &&
    capability.name.trim().length > 0 &&
    typeof capability.description === "string" &&
    isRecord(capability.inputSchema) &&
    ["read", "navigate", "interact", "mutate"].includes(capability.effect)
  );
}

/** Compile one capability into a serializable descriptor. */
export function compileCapability(
  capability: Capability,
): WebMcpToolDescriptor {
  const description =
    capability.description.trim() || fallbackDescription(capability);
  return {
    capabilityId: capability.id,
    name: capability.name.trim(),
    description,
    inputSchema: cloneJsonSchema(capability.inputSchema),
    annotations: annotationForEffect(capability.effect),
  };
}

/**
 * Compile capabilities and retain diagnostics for an inspector or adapter
 * pipeline.  The simple `compileCapabilities` wrapper below is convenient for
 * registration code that only needs the accepted descriptors.
 */
export function compileCapabilitiesWithDiagnostics(
  capabilities: readonly Capability[],
  options: CompilerOptions = {},
): CompilationResult {
  const nativeNames = collectNativeNames(
    options.nativeTools,
    options.nativeToolNames,
  );
  const seenNames = new Set<string>();
  const tools: WebMcpToolDescriptor[] = [];
  const skipped: CompilationResult["skipped"] = [];

  for (const capability of capabilities) {
    if (!isValidCapability(capability)) {
      skipped.push({
        capability,
        reason: "invalid",
        detail:
          "Capability is missing a non-empty id, name, description, schema, or valid effect.",
      });
      continue;
    }

    if (capability.enabled === false && !options.includeDisabled) {
      skipped.push({
        capability,
        reason: "disabled",
        detail: "Capability is disabled in the current graph state.",
      });
      continue;
    }

    const name = normalizedName(capability.name);
    const equivalent = capability.nativeEquivalent
      ? normalizedName(capability.nativeEquivalent)
      : null;
    if (
      nativeNames.has(name) ||
      (equivalent !== null && nativeNames.has(equivalent))
    ) {
      skipped.push({
        capability,
        reason: "native-equivalent",
        detail: "A native WebMCP tool already provides this capability.",
      });
      continue;
    }

    if (seenNames.has(name)) {
      skipped.push({
        capability,
        reason: "duplicate-name",
        detail: `Another inferred capability already uses the tool name "${capability.name.trim()}".`,
      });
      continue;
    }

    seenNames.add(name);
    tools.push(compileCapability(capability));
  }

  return { tools, skipped };
}

export function compileCapabilities(
  capabilities: readonly Capability[],
  optionsOrNativeTools: CompilerOptions | Iterable<NativeToolInput> = {},
): WebMcpToolDescriptor[] {
  const options: CompilerOptions = isCompilerOptions(optionsOrNativeTools)
    ? optionsOrNativeTools
    : { nativeTools: optionsOrNativeTools };
  return compileCapabilitiesWithDiagnostics(capabilities, options).tools;
}

/** Descriptive aliases for callers that name the compiler by its output. */
export const compileWebMcpTools = compileCapabilities;
export const compileWebMCPTools = compileCapabilities;
export const compileToolDescriptors = compileCapabilities;

function isCompilerOptions(
  value: CompilerOptions | Iterable<NativeToolInput>,
): value is CompilerOptions {
  if (!isRecord(value)) return false;
  return typeof Reflect.get(value, Symbol.iterator) !== "function";
}

/** A stable, JSON-safe comparison for descriptor update decisions. */
export function descriptorsEqual(
  left: WebMcpToolDescriptor,
  right: WebMcpToolDescriptor,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Normalize a native summary returned by a model context for compiler use. */
export function nativeToolName(
  value: NativeToolSummary | string,
): string | null {
  return nativeName(value);
}
