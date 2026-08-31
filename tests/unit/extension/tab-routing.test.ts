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

function extensionPageSender(id: number): chrome.runtime.MessageSender {
  return {
    tab: { id } as chrome.tabs.Tab,
    url: "chrome-extension://test/inspector/index.html?tabId=11",
  };
}

const selectedState = pageState("Selected-tab");
const inspectorMarkup = readFileSync(
  resolve("extension/inspector/index.html"),
  "utf8",
);
let listeners: MessageListener[];
let sendMessage: ReturnType<typeof vi.fn>;
let actionClick: ((tab: chrome.tabs.Tab) => void) | undefined;
let createTab: ReturnType<typeof vi.fn>;
let executeScript: ReturnType<typeof vi.fn>;
let sendToContent: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  listeners = [];
  sendMessage = vi.fn().mockResolvedValue({ ok: true, state: selectedState });
  createTab = vi.fn().mockResolvedValue({ id: 99 });
  executeScript = vi.fn().mockResolvedValue(undefined);
  sendToContent = vi.fn().mockResolvedValue({ ok: true, state: selectedState });
  actionClick = undefined;
  vi.stubGlobal("chrome", {
    runtime: {
      onMessage: {
        addListener: (listener: MessageListener) => listeners.push(listener),
      },
      sendMessage,
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    action: {
      onClicked: {
        addListener: (listener: (tab: chrome.tabs.Tab) => void) => {
          actionClick = listener;
        },
      },
    },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
      create: createTab,
      sendMessage: sendToContent,
    },
    scripting: { executeScript },
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

  it("routes a content command to its sender tab, not a claimed tab", async () => {
    const response = new Promise<unknown>((resolve) => {
      listeners[0]!(
        { type: "polyfill:get-state", tabId: 11 },
        tabSender(22),
        resolve,
      );
    });

    await expect(response).resolves.toEqual({ ok: true, state: selectedState });
    expect(sendToContent).toHaveBeenCalledWith(22, {
      type: "polyfill:get-state",
      tabId: 22,
    });
  });

  it("keeps an extension-page command bound to its explicit tab", async () => {
    const response = new Promise<unknown>((resolve) => {
      listeners[0]!(
        { type: "polyfill:get-state", tabId: 11 },
        extensionPageSender(22),
        resolve,
      );
    });

    await expect(response).resolves.toEqual({ ok: true, state: selectedState });
    expect(sendToContent).toHaveBeenCalledWith(11, {
      type: "polyfill:get-state",
      tabId: 11,
    });
  });

  it("opens Studio for the clicked tab and injects both page adapters", async () => {
    expect(actionClick).toBeTypeOf("function");
    actionClick!({
      id: 42,
      url: "https://shop.test/catalog",
    } as chrome.tabs.Tab);

    await vi.waitFor(() => expect(createTab).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(2));

    expect(createTab).toHaveBeenCalledWith({
      url: "chrome-extension://test/inspector/index.html?tabId=42",
    });
    expect(executeScript).toHaveBeenNthCalledWith(1, {
      target: { tabId: 42 },
      world: "MAIN",
      files: ["main-world.js"],
    });
    expect(executeScript).toHaveBeenNthCalledWith(2, {
      target: { tabId: 42 },
      world: "ISOLATED",
      files: ["content.js"],
    });
  });
});
