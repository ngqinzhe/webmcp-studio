import type {
  Capability,
  CapabilityGraph,
  ExecutionResult,
  InspectorState,
  WebMcpStatus,
} from "./types";

export const BRIDGE_CHANNEL = "webmcp-studio";
export const BRIDGE_VERSION = 1 as const;

export type BridgeRequestPayload =
  | { type: "init"; token: string }
  | { type: "sync-tools"; capabilities: Capability[]; enabled: boolean }
  | { type: "invoke"; requestId: string; capabilityId: string; args: unknown }
  | { type: "get-status" };

export type BridgeResponsePayload =
  | { type: "ready"; status: WebMcpStatus }
  | { type: "status"; status: WebMcpStatus }
  | { type: "invoke-result"; requestId: string; result: ExecutionResult }
  | { type: "registration"; status: WebMcpStatus }
  | { type: "error"; message: string };

export interface BridgeRequest {
  channel: typeof BRIDGE_CHANNEL;
  version: typeof BRIDGE_VERSION;
  direction: "to-main";
  token: string;
  messageId: string;
  payload: BridgeRequestPayload;
}

export interface BridgeResponse {
  channel: typeof BRIDGE_CHANNEL;
  version: typeof BRIDGE_VERSION;
  direction: "from-main";
  token: string;
  messageId: string;
  payload: BridgeResponsePayload;
}

export type ExtensionMessage =
  | { type: "polyfill:get-state"; tabId?: number }
  | { type: "polyfill:rescan"; tabId?: number }
  | { type: "polyfill:set-enabled"; enabled: boolean; tabId?: number }
  | {
      type: "polyfill:invoke";
      capabilityId: string;
      args: unknown;
      tabId?: number;
    }
  | { type: "polyfill:get-graph"; tabId?: number }
  | { type: "polyfill:state-update"; state: InspectorState };

export type ExtensionResponse =
  | { ok: true; state: InspectorState }
  | { ok: true; graph: CapabilityGraph | null }
  | { ok: true; result: ExecutionResult }
  | { ok: true; started: true }
  | { ok: false; error: string };

export function isBridgeRequest(value: unknown): value is BridgeRequest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BridgeRequest>;
  return (
    candidate.channel === BRIDGE_CHANNEL &&
    candidate.version === BRIDGE_VERSION &&
    candidate.direction === "to-main" &&
    typeof candidate.token === "string" &&
    typeof candidate.messageId === "string" &&
    Boolean(candidate.payload && typeof candidate.payload === "object")
  );
}

export function createBridgeMessage<T extends BridgeRequestPayload>(
  token: string,
  payload: T,
): BridgeRequest {
  return {
    channel: BRIDGE_CHANNEL,
    version: BRIDGE_VERSION,
    direction: "to-main",
    token,
    messageId: crypto.randomUUID(),
    payload,
  };
}
