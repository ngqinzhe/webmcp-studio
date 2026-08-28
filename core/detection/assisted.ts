import type {
  Capability,
  CapabilityEffect,
  JSONSchema,
  PageIdentity,
} from "../types";
import type { DiscoverySnapshot } from "../dom/types";
import { inferCapabilities } from "./infer";

/**
 * A deliberately narrow seam for a future model-assisted interpreter.
 *
 * The interpreter may improve the meaning of an already discovered
 * capability, but it cannot supply a new locator or executor. Keeping those
 * fields deterministic ensures that optional model assistance never turns
 * into arbitrary page-code execution.
 */
export interface CapabilityInterpretation {
  capabilityId: string;
  name?: string;
  description?: string;
  inputSchema?: JSONSchema;
  effect?: CapabilityEffect;
  confidence?: number;
}

export interface CapabilityInterpretationRequest {
  page: PageIdentity;
  snapshot: DiscoverySnapshot;
  deterministic: readonly Capability[];
  lowConfidence: readonly Capability[];
}

export interface CapabilityInterpreter {
  interpret(
    request: CapabilityInterpretationRequest,
  ): Promise<readonly CapabilityInterpretation[]>;
}

export interface OptionalInferenceOptions {
  interpreter?: CapabilityInterpreter;
  minimumConfidence?: number;
  page: PageIdentity;
}

function isEffect(value: unknown): value is CapabilityEffect {
  return (
    value === "read" ||
    value === "navigate" ||
    value === "interact" ||
    value === "mutate"
  );
}

function cloneSchema(schema: JSONSchema): JSONSchema {
  if (typeof structuredClone === "function") return structuredClone(schema);
  return JSON.parse(JSON.stringify(schema)) as JSONSchema;
}

function applyInterpretations(
  capabilities: readonly Capability[],
  interpretations: readonly CapabilityInterpretation[],
): Capability[] {
  const byId = new Map(
    interpretations.map((item) => [item.capabilityId, item]),
  );
  return capabilities.map((capability) => {
    const interpretation = byId.get(capability.id);
    if (!interpretation) return capability;

    const next: Capability = { ...capability };
    if (typeof interpretation.name === "string" && interpretation.name.trim())
      next.name = interpretation.name.trim();
    if (
      typeof interpretation.description === "string" &&
      interpretation.description.trim()
    ) {
      next.description = interpretation.description.trim();
    }
    if (interpretation.inputSchema) {
      next.inputSchema = cloneSchema(interpretation.inputSchema);
    }
    if (isEffect(interpretation.effect)) next.effect = interpretation.effect;
    if (
      typeof interpretation.confidence === "number" &&
      Number.isFinite(interpretation.confidence)
    ) {
      next.confidence = Math.max(0, Math.min(1, interpretation.confidence));
    }
    return next;
  });
}

/**
 * Run deterministic inference first and optionally improve only low
 * confidence interpretations. If the provider fails, deterministic results
 * remain the complete and safe fallback.
 */
export async function inferCapabilitiesWithOptionalInterpreter(
  snapshot: DiscoverySnapshot,
  options: OptionalInferenceOptions,
): Promise<Capability[]> {
  const deterministic = inferCapabilities(snapshot);
  const interpreter = options.interpreter;
  if (!interpreter) return deterministic;

  const threshold = Math.max(0, Math.min(1, options.minimumConfidence ?? 0.7));
  const lowConfidence = deterministic.filter(
    (capability) => capability.confidence < threshold,
  );
  if (lowConfidence.length === 0) return deterministic;

  try {
    const interpretations = await interpreter.interpret({
      page: options.page,
      snapshot,
      deterministic,
      lowConfidence,
    });
    return applyInterpretations(deterministic, interpretations);
  } catch {
    return deterministic;
  }
}
