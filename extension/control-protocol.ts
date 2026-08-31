/**
 * Extension-only control state.  It deliberately does not belong in the
 * distributable project or the shared core protocol: it describes the live
 * browser connection, not an authored workflow.
 */
export type RuntimeControlMode =
  "running" | "paused" | "takeover" | "disconnected";

export type RuntimeAuthenticationState =
  "not_required" | "unknown" | "login_required" | "verified" | "expired";

export type RuntimeBlockerCode =
  | "paused"
  | "human_takeover"
  | "disconnected"
  | "login_required"
  | "session_expired"
  | "tab_lost"
  | "document_changed"
  | "out_of_scope"
  | "bridge_unavailable";

export interface RuntimeBlocker {
  code: RuntimeBlockerCode;
  message: string;
}

export interface RuntimeControlState {
  mode: RuntimeControlMode;
  authentication: RuntimeAuthenticationState;
  sessionId: string;
  observationId: string;
  tabId: number | null;
  url: string;
  origin: string;
  runtimeGeneration: string;
  blocker: RuntimeBlocker | null;
  registeredPublicTools: number;
  registeredProtectedTools: number;
}

export type RuntimeControlAction =
  "pause" | "takeover" | "login" | "resume" | "disconnect";

export interface RuntimeControlMessage {
  type: "polyfill:control";
  action: RuntimeControlAction;
  /** Required for an authenticated resume. */
  sessionVerified?: boolean;
  tabId?: number;
}

export function isRuntimeControlMessage(
  value: unknown,
): value is RuntimeControlMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.type !== "polyfill:control" ||
    !["pause", "takeover", "login", "resume", "disconnect"].includes(
      String(candidate.action),
    )
  )
    return false;
  if (
    candidate.tabId !== undefined &&
    (typeof candidate.tabId !== "number" ||
      !Number.isSafeInteger(candidate.tabId) ||
      candidate.tabId < 0)
  )
    return false;
  return (
    candidate.sessionVerified === undefined ||
    typeof candidate.sessionVerified === "boolean"
  );
}

export function isRuntimeControlState(
  value: unknown,
): value is RuntimeControlState {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const candidate = value as Record<string, unknown>;
  const blocker = candidate.blocker;
  return (
    ["running", "paused", "takeover", "disconnected"].includes(
      String(candidate.mode),
    ) &&
    [
      "not_required",
      "unknown",
      "login_required",
      "verified",
      "expired",
    ].includes(String(candidate.authentication)) &&
    typeof candidate.sessionId === "string" &&
    typeof candidate.observationId === "string" &&
    (candidate.tabId === null ||
      (typeof candidate.tabId === "number" &&
        Number.isSafeInteger(candidate.tabId) &&
        candidate.tabId >= 0)) &&
    typeof candidate.url === "string" &&
    typeof candidate.origin === "string" &&
    typeof candidate.runtimeGeneration === "string" &&
    (blocker === null ||
      (typeof blocker === "object" &&
        blocker !== null &&
        !Array.isArray(blocker) &&
        typeof (blocker as Record<string, unknown>).code === "string" &&
        typeof (blocker as Record<string, unknown>).message === "string")) &&
    typeof candidate.registeredPublicTools === "number" &&
    Number.isSafeInteger(candidate.registeredPublicTools) &&
    candidate.registeredPublicTools >= 0 &&
    typeof candidate.registeredProtectedTools === "number" &&
    Number.isSafeInteger(candidate.registeredProtectedTools) &&
    candidate.registeredProtectedTools >= 0
  );
}
