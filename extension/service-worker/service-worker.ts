import type {
  ExtensionResponse,
  ExtensionMessage,
} from "../../core/bridge-protocol";
import type { InspectorState } from "../../core/types";

export const MAIN_WORLD_BUNDLE_PATH = "main-world.js";
export const CONTENT_BUNDLE_PATH = "content.js";
export const INSPECTOR_PAGE_PATH = "inspector/index.html";

type ExtensionCommand = Exclude<
  ExtensionMessage,
  { type: "polyfill:state-update" }
>;

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
      return true;
    case "polyfill:set-enabled":
      return typeof value.enabled === "boolean";
    case "polyfill:invoke":
      return (
        typeof value.capabilityId === "string" &&
        value.capabilityId.trim().length > 0 &&
        "args" in value
      );
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

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

function isExtensionResponse(value: unknown): value is ExtensionResponse {
  if (!isRecord(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) return typeof value.error === "string";
  return (
    "state" in value ||
    "graph" in value ||
    "result" in value ||
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
  if (response.ok && "state" in response) stateByTab.set(tabId, response.state);
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

function broadcastState(state: InspectorState): void {
  try {
    void Promise.resolve(
      chrome.runtime.sendMessage({
        type: "polyfill:state-update",
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
  const tabId = validTabId(requestedTab)
    ? requestedTab
    : validTabId(senderTabId)
      ? senderTabId
      : undefined;
  if (!validTabId(tabId)) return errorResponse("No target tab is available.");

  try {
    const response = await sendToTab(tabId, message);
    cacheResponse(tabId, response);
    return response;
  } catch {
    try {
      await injectPolyfill(tabId);
      const response = await sendToTab(tabId, message);
      cacheResponse(tabId, response);
      return response;
    } catch (secondError) {
      const cached =
        message.type === "polyfill:get-state"
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
          broadcastState(message.state);
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

  chrome.tabs.onRemoved?.addListener((tabId) => stateByTab.delete(tabId));
  chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading" || changeInfo.url !== undefined) {
      stateByTab.delete(tabId);
    }
  });
}

if (
  typeof chrome !== "undefined" &&
  chrome.runtime?.onMessage &&
  chrome.action?.onClicked
)
  registerServiceWorker();
