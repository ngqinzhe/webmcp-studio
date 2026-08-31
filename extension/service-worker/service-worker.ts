import type {
  ExtensionResponse,
  ExtensionMessage,
} from "../../core/bridge-protocol";
import type { ExecutionResult, InspectorState } from "../../core/types";
import { shouldAutomaticallyActivate, type ActivationApi } from "./activation";
import {
  clearRegistryRecord,
  saveRegistryState,
  type SessionStorageArea,
} from "./registry";
import {
  isRuntimeControlMessage,
  type RuntimeControlMessage,
  type RuntimeControlState,
} from "../control-protocol";

export const MAIN_WORLD_BUNDLE_PATH = "main-world.js";
export const CONTENT_BUNDLE_PATH = "content.js";
export const INSPECTOR_PAGE_PATH = "inspector/index.html";

type ExtensionCommand =
  | Exclude<ExtensionMessage, { type: "polyfill:state-update" }>
  | RuntimeControlMessage;

const stateByTab = new Map<number, InspectorState>();

function validTabId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExtensionCommand(value: unknown): value is ExtensionCommand {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  const tabId = value.tabId;
  if (tabId !== undefined && !validTabId(tabId)) return false;
  switch (value.type) {
    case "polyfill:get-state":
    case "polyfill:rescan":
    case "polyfill:get-graph":
    case "polyfill:get-project":
    case "polyfill:deactivate-project":
      return true;
    case "polyfill:control":
      return isRuntimeControlMessage(value);
    case "polyfill:set-enabled":
      return typeof value.enabled === "boolean";
    case "polyfill:invoke":
      return (
        typeof value.capabilityId === "string" &&
        value.capabilityId.trim().length > 0 &&
        "args" in value
      );
    case "polyfill:test-project":
      return (
        "project" in value &&
        typeof value.toolId === "string" &&
        value.toolId.trim().length > 0 &&
        "args" in value
      );
    case "polyfill:perform-browser-action":
      return (
        typeof value.sessionId === "string" &&
        value.sessionId.trim().length > 0 &&
        typeof value.capabilityId === "string" &&
        value.capabilityId.trim().length > 0 &&
        typeof value.expectedObservation === "string" &&
        value.expectedObservation.trim().length > 0 &&
        "args" in value
      );
    case "polyfill:read-observed-requests":
      return (
        typeof value.sessionId === "string" &&
        value.sessionId.trim().length > 0 &&
        (value.cursor === undefined || typeof value.cursor === "string")
      );
    case "polyfill:activate-project":
      return "project" in value && "approval" in value;
    default:
      return false;
  }
}

function isStateUpdate(
  value: unknown,
): value is Extract<ExtensionMessage, { type: "polyfill:state-update" }> {
  if (
    !isRecord(value) ||
    value.type !== "polyfill:state-update" ||
    !isRecord(value.state)
  )
    return false;
  const state = value.state;
  const webmcp = state.webmcp;
  return (
    (state.graph === null || isRecord(state.graph)) &&
    isRecord(webmcp) &&
    typeof webmcp.available === "boolean" &&
    Array.isArray(webmcp.apiMethods) &&
    Array.isArray(webmcp.nativeTools) &&
    Array.isArray(webmcp.registered) &&
    Array.isArray(webmcp.rejected) &&
    (state.lastExecution === null || isRecord(state.lastExecution)) &&
    typeof state.enabled === "boolean" &&
    typeof state.updatedAt === "number"
  );
}

function errorResponse(message: string): ExtensionResponse {
  return { ok: false, error: message };
}

function isSafeRecoveryRead(message: ExtensionCommand): boolean {
  return (
    message.type === "polyfill:get-state" ||
    message.type === "polyfill:get-graph"
  );
}

function uncertainSideEffectResponse(
  variant: "result" | "action" = "result",
): ExtensionResponse {
  const result: ExecutionResult = {
    success: false,
    status: "execution_timeout",
    urlBefore: "",
    urlAfter: "",
    navigationOccurred: false,
    stateChanged: false,
    warnings: [],
    error: {
      code: "execution_timeout",
      message:
        "The command response was lost after delivery; the effect may have happened and was not retried.",
      details: {
        delivery: "uncertain",
        mayHaveExecuted: true,
        retried: false,
      },
    },
  };
  return variant === "action"
    ? { ok: true, action: result }
    : { ok: true, result };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

function disconnectedState(
  tabId: number,
  reason: RuntimeControlState["blocker"],
): InspectorState {
  return {
    graph: null,
    webmcp: {
      available: false,
      apiMethods: [],
      nativeTools: [],
      registered: [],
      rejected: [],
    },
    lastExecution: null,
    enabled: true,
    runtimeGeneration: `tab-${tabId}-disconnected`,
    activeProject: null,
    control: {
      mode: "disconnected",
      authentication: "unknown",
      sessionId: `disconnected:${tabId}`,
      observationId: `disconnected:${tabId}`,
      tabId,
      url: "",
      origin: "",
      runtimeGeneration: `tab-${tabId}-disconnected`,
      blocker: reason,
      registeredPublicTools: 0,
      registeredProtectedTools: 0,
    },
    updatedAt: Date.now(),
  } as InspectorState;
}

function isExtensionResponse(value: unknown): value is ExtensionResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) return typeof value.error === "string";
  return (
    "state" in value ||
    "graph" in value ||
    "result" in value ||
    "action" in value ||
    "requests" in value ||
    "workflow" in value ||
    "project" in value ||
    value.started === true
  );
}

async function sendToTab(
  tabId: number,
  message: ExtensionCommand,
): Promise<ExtensionResponse> {
  const response: unknown = await chrome.tabs.sendMessage(tabId, message);
  if (!isExtensionResponse(response)) {
    throw new Error("The content script returned an invalid response.");
  }
  return response;
}

function cacheResponse(tabId: number, response: ExtensionResponse): void {
  if (response.ok && "state" in response) {
    stateByTab.set(tabId, response.state);
    void saveRegistryState(registryStorage(), tabId, response.state).catch(
      () => undefined,
    );
  }
}

function registryStorage(): SessionStorageArea {
  const storage = (
    chrome as unknown as {
      storage?: {
        session?: SessionStorageArea;
        local?: SessionStorageArea;
      };
    }
  ).storage;
  if (!storage) {
    return {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    };
  }
  const areas = storage as {
    session?: SessionStorageArea;
    local?: SessionStorageArea;
  };
  return (
    areas.session ??
    areas.local ?? {
      get: async () => ({}),
      set: async () => undefined,
      remove: async () => undefined,
    }
  );
}

function activationApi(): ActivationApi {
  return {
    permissions: chrome.permissions as unknown as ActivationApi["permissions"],
    scripting: chrome.scripting as unknown as ActivationApi["scripting"],
    storage: { local: chrome.storage.local as unknown as SessionStorageArea },
    tabs: {
      query: async (query) =>
        (await chrome.tabs.query(query as chrome.tabs.QueryInfo)).map(
          (tab) => ({
            id: tab.id,
            url: tab.url,
          }),
        ),
    },
  };
}

async function automaticallyActivate(
  tabId: number,
  url?: string,
): Promise<void> {
  if (!(await shouldAutomaticallyActivate(activationApi(), { id: tabId, url })))
    return;
  try {
    await injectPolyfill(tabId);
  } catch {
    // A tab can navigate or close between the eligibility check and injection.
  }
}

export async function injectPolyfill(tabId: number): Promise<void> {
  if (!validTabId(tabId))
    throw new Error("A valid tab id is required for injection.");
  // MAIN must be present before content sends its init/sync messages. The
  // injected files are idempotent, so this is also safe after a manifest
  // content-script injection or an inspector-triggered retry.
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    files: [MAIN_WORLD_BUNDLE_PATH],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    world: "ISOLATED",
    files: [CONTENT_BUNDLE_PATH],
  });
}

export async function openInspectorForTab(tab: chrome.tabs.Tab): Promise<void> {
  if (!validTabId(tab.id)) return;
  const inspectorUrl = `${chrome.runtime.getURL(INSPECTOR_PAGE_PATH)}?tabId=${encodeURIComponent(String(tab.id))}`;
  await chrome.tabs.create({ url: inspectorUrl });
}

function broadcastState(tabId: number, state: InspectorState): void {
  try {
    void Promise.resolve(
      chrome.runtime.sendMessage({
        type: "polyfill:state-update",
        tabId,
        state,
      } satisfies ExtensionMessage),
    ).catch(() => undefined);
  } catch {
    // There may be no inspector open. State remains cached in the service worker.
  }
}

async function routeCommand(
  message: ExtensionCommand,
  sender: chrome.runtime.MessageSender,
): Promise<ExtensionResponse> {
  const requestedTab = "tabId" in message ? message.tabId : undefined;
  const senderTabId = sender.tab?.id;
  const senderIsExtensionPage =
    typeof sender.url === "string" &&
    sender.url.startsWith("chrome-extension://");
  // A content-script sender is authoritative.  Its payload can contain a
  // stale or spoofed tab id, but it must never redirect a command to another
  // tab.  Extension-page callers (Studio) have no sender tab and therefore
  // use the explicit tab id bound into their URL.
  const tabId =
    !senderIsExtensionPage && validTabId(senderTabId)
      ? senderTabId
      : validTabId(requestedTab)
        ? requestedTab
        : undefined;
  if (!validTabId(tabId)) return errorResponse("No target tab is available.");

  // Carry the resolved sender/request tab into the content command so session,
  // approval, and exact-tab checks cannot accidentally fall back to an
  // unbound or stale tab identity.
  const routedMessage = { ...message, tabId } as ExtensionCommand;

  try {
    const response = await sendToTab(tabId, routedMessage);
    cacheResponse(tabId, response);
    return response;
  } catch (firstError) {
    if (!isSafeRecoveryRead(routedMessage)) {
      return routedMessage.type === "polyfill:invoke" ||
        routedMessage.type === "polyfill:perform-browser-action"
        ? uncertainSideEffectResponse(
            routedMessage.type === "polyfill:perform-browser-action"
              ? "action"
              : "result",
          )
        : errorResponse(errorMessage(firstError));
    }
    try {
      await injectPolyfill(tabId);
      const response = await sendToTab(tabId, routedMessage);
      cacheResponse(tabId, response);
      return response;
    } catch (secondError) {
      const cached =
        routedMessage.type === "polyfill:get-state"
          ? stateByTab.get(tabId)
          : undefined;
      if (cached) return { ok: true, state: cached };
      return errorResponse(errorMessage(secondError));
    }
  }
}

export function registerServiceWorker(): void {
  chrome.action.onClicked.addListener((tab) => {
    void (async () => {
      try {
        await openInspectorForTab(tab);
      } catch (error) {
        console.warn("WebMCP Studio inspector failed to open", error);
      }
      if (validTabId(tab.id)) {
        try {
          await injectPolyfill(tab.id);
        } catch (error) {
          console.warn("WebMCP Studio injection failed", error);
        }
      }
    })();
  });

  chrome.runtime.onMessage.addListener(
    (message: unknown, sender, sendResponse) => {
      if (isStateUpdate(message)) {
        const tabId = sender.tab?.id;
        if (validTabId(tabId)) {
          stateByTab.set(tabId, message.state);
          void saveRegistryState(registryStorage(), tabId, message.state).catch(
            () => undefined,
          );
          broadcastState(tabId, message.state);
        }
        sendResponse({ ok: true, started: true } satisfies ExtensionResponse);
        return false;
      }
      if (!isExtensionCommand(message)) return false;
      void routeCommand(message, sender)
        .then(sendResponse)
        .catch((error: unknown) => {
          sendResponse(errorResponse(errorMessage(error)));
        });
      return true;
    },
  );

  chrome.tabs.onRemoved?.addListener((tabId) => {
    stateByTab.delete(tabId);
    void clearRegistryRecord(registryStorage(), tabId).catch(() => undefined);
    const state = disconnectedState(tabId, {
      code: "tab_lost",
      message:
        "The selected tab was closed; live visibility and agent control stopped.",
    });
    stateByTab.set(tabId, state);
    broadcastState(tabId, state);
  });
  chrome.tabs.onUpdated?.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "loading" || changeInfo.url !== undefined) {
      stateByTab.delete(tabId);
      void clearRegistryRecord(registryStorage(), tabId).catch(() => undefined);
      const state = disconnectedState(tabId, {
        code: "document_changed",
        message:
          "The selected tab is navigating; the previous live document is no longer controlled.",
      });
      stateByTab.set(tabId, state);
      broadcastState(tabId, state);
    }
    if (changeInfo.status === "complete" || changeInfo.url !== undefined)
      void automaticallyActivate(tabId, changeInfo.url ?? tab.url);
  });
}

if (
  typeof chrome !== "undefined" &&
  chrome.runtime?.onMessage &&
  chrome.action?.onClicked
)
  registerServiceWorker();
