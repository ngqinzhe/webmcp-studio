import type {
  Capability,
  InspectorState,
  JSONSchema,
  NativeToolSummary,
  WebMcpStatus,
} from "../../core/types";
import { cloneJsonSchema } from "../../core/compiler";

export const SESSION_REGISTRY_PREFIX = "webmcp-studio:tab:";

export interface SessionStorageArea {
  get(
    keys?: string | string[] | Record<string, unknown> | null,
  ): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
}

export interface RegistryCapabilityMetadata {
  id: string;
  name: string;
  description: string;
  inputSchema: JSONSchema;
  effect: Capability["effect"];
  confidence: number;
  sourceType: Capability["source"]["type"];
}

export interface SessionRegistryRecord {
  tabId: number;
  url: string;
  origin: string;
  timestamp: number;
  graphVersion: number | null;
  runtimeGeneration: string;
  capabilities: RegistryCapabilityMetadata[];
  nativeTools: NativeToolSummary[];
  registration: WebMcpStatus;
  state: InspectorState;
}

export function registryKey(tabId: number): string {
  return `${SESSION_REGISTRY_PREFIX}${tabId}`;
}

function cloneNativeTools(
  tools: readonly NativeToolSummary[],
): NativeToolSummary[] {
  return tools.map((tool) => ({
    name: tool.name,
    ...(tool.description === undefined
      ? {}
      : { description: tool.description }),
    ...(tool.inputSchema === undefined
      ? {}
      : { inputSchema: cloneJsonSchema(tool.inputSchema) }),
  }));
}

function metadataForCapability(
  capability: Capability,
): RegistryCapabilityMetadata {
  return {
    id: capability.id,
    name: capability.name,
    description: capability.description,
    inputSchema: cloneJsonSchema(capability.inputSchema),
    effect: capability.effect,
    confidence: capability.confidence,
    sourceType: capability.source.type,
  };
}

export function createRegistryRecord(
  tabId: number,
  state: InspectorState,
): SessionRegistryRecord {
  const graph = state.graph;
  return {
    tabId,
    url: graph?.page.url ?? "",
    origin: graph?.page.origin ?? "",
    timestamp: Date.now(),
    graphVersion: graph?.version ?? null,
    runtimeGeneration: state.runtimeGeneration ?? "unknown",
    capabilities: graph
      ? Object.values(graph.capabilities).map(metadataForCapability)
      : [],
    nativeTools: cloneNativeTools(state.webmcp.nativeTools),
    registration: {
      available: state.webmcp.available,
      apiMethods: [...state.webmcp.apiMethods],
      nativeTools: cloneNativeTools(state.webmcp.nativeTools),
      registered: [...state.webmcp.registered],
      rejected: state.webmcp.rejected.map((entry) => ({ ...entry })),
    },
    state,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuntimeState(value: unknown): value is InspectorState {
  return (
    isRecord(value) &&
    (value.graph === null || isRecord(value.graph)) &&
    isRecord(value.webmcp) &&
    typeof value.enabled === "boolean" &&
    typeof value.runtimeGeneration === "string" &&
    typeof value.updatedAt === "number"
  );
}

export function isSessionRegistryRecord(
  value: unknown,
): value is SessionRegistryRecord {
  if (!isRecord(value)) return false;
  return (
    typeof value.tabId === "number" &&
    typeof value.url === "string" &&
    typeof value.origin === "string" &&
    typeof value.timestamp === "number" &&
    (value.graphVersion === null || typeof value.graphVersion === "number") &&
    typeof value.runtimeGeneration === "string" &&
    Array.isArray(value.capabilities) &&
    Array.isArray(value.nativeTools) &&
    isRecord(value.registration) &&
    isRuntimeState(value.state)
  );
}

export async function saveRegistryRecord(
  storage: SessionStorageArea,
  record: SessionRegistryRecord,
): Promise<void> {
  await storage.set({ [registryKey(record.tabId)]: record });
}

export async function saveRegistryState(
  storage: SessionStorageArea,
  tabId: number,
  state: InspectorState,
): Promise<SessionRegistryRecord> {
  const record = createRegistryRecord(tabId, state);
  await saveRegistryRecord(storage, record);
  return record;
}

export async function readRegistryRecord(
  storage: SessionStorageArea,
  tabId: number,
): Promise<SessionRegistryRecord | null> {
  try {
    const result = await storage.get(registryKey(tabId));
    const record = result[registryKey(tabId)];
    return isSessionRegistryRecord(record) ? record : null;
  } catch {
    return null;
  }
}

export async function clearRegistryRecord(
  storage: SessionStorageArea,
  tabId: number,
): Promise<void> {
  await storage.remove(registryKey(tabId));
}

export function registryMatchesDocument(
  record: SessionRegistryRecord,
  tabId: number,
  url: string | undefined,
): boolean {
  return (
    record.tabId === tabId &&
    typeof url === "string" &&
    url.length > 0 &&
    record.url === url
  );
}
