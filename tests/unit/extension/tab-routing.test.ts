import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCapabilityGraph } from "../../../core/graph";
import type { InspectorState } from "../../../core/types";

type MessageListener = Parameters<
  typeof chrome.runtime.onMessage.addListener
>[0];

function pageState(title: string): InspectorState {
  return {
    graph: createCapabilityGraph({
      page: {
        url: `https://shop.test/${title}`,
        title,
        origin: "https://shop.test",
        hostname: "shop.test",
      },
      capabilities: [],
      generatedAt: 1,
    }),
    webmcp: {
      available: true,
      apiMethods: ["registerTool"],
      nativeTools: [],
      registered: [],
      rejected: [],
    },
    lastExecution: null,
    enabled: true,
    updatedAt: 1,
  };
}

function tabSender(id: number): chrome.runtime.MessageSender {
  return { tab: { id } as chrome.tabs.Tab };
}

const selectedState = pageState("Selected-tab");
const inspectorMarkup = readFileSync(
  resolve("extension/inspector/index.html"),
  "utf8",
);
let listeners: MessageListener[];
let sendMessage: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  listeners = [];
  sendMessage = vi.fn().mockResolvedValue({ ok: true, state: selectedState });
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: {
        addListener: (listener: MessageListener) => listeners.push(listener),
      },
      sendMessage,
    },
    action: { onClicked: { addListener: vi.fn() } },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
});

describe("inspector tab isolation", () => {
  beforeEach(async () => {
    window.history.replaceState(null, "", "/inspector/index.html?tabId=11");
    document.documentElement.innerHTML = inspectorMarkup;
    await import("../../../extension/inspector/inspector");
    await vi.waitFor(() =>
      expect(document.querySelector("#page-title")?.textContent).toBe(
        "Selected-tab",
      ),
    );
  });

  it.each([
    {
      label: "another tab's worker broadcast",
      scope: { tabId: 22 },
      sender: {},
    },
    { label: "an unscoped broadcast", scope: {}, sender: {} },
    { label: "an invalid tab id", scope: { tabId: -1 }, sender: {} },
    {
      label: "a payload spoofing the selected tab",
      scope: { tabId: 11 },
      sender: tabSender(22),
    },
  ])("ignores $label", ({ scope, sender }) => {
    listeners[0]!(
      {
        type: "polyfill:state-update",
        ...scope,
        state: pageState("Other-tab"),
      },
      sender,
      vi.fn(),
    );

    expect(document.querySelector("#page-title")?.textContent).toBe(
      "Selected-tab",
    );
  });

  it.each([
    { label: "the worker", scope: { tabId: 11 }, sender: {} },
    { label: "the selected content script", scope: {}, sender: tabSender(11) },
  ])("accepts an update from $label", ({ scope, sender }) => {
    listeners[0]!(
      {
        type: "polyfill:state-update",
        ...scope,
        state: pageState("Selected-tab-updated"),
      },
      sender,
      vi.fn(),
    );

    expect(document.querySelector("#page-title")?.textContent).toBe(
      "Selected-tab-updated",
    );
  });
});

describe("service-worker state broadcasts", () => {
  beforeEach(async () => {
    await import("../../../extension/service-worker/service-worker");
  });

  it("binds the forwarded state to the sender tab, ignoring a claimed tab id", () => {
    listeners[0]!(
      { type: "polyfill:state-update", tabId: 11, state: selectedState },
      tabSender(22),
      vi.fn(),
    );

    expect(sendMessage).toHaveBeenCalledWith({
      type: "polyfill:state-update",
      tabId: 22,
      state: selectedState,
    });
  });

  it("does not rebroadcast a message without an originating content tab", () => {
    listeners[0]!(
      { type: "polyfill:state-update", tabId: 11, state: selectedState },
      {},
      vi.fn(),
    );

    expect(sendMessage).not.toHaveBeenCalled();
  });
});
