import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeCapability } from "../../core/execution";
import type {
  Capability,
  ExecutorDefinition,
  SemanticLocator,
} from "../../core/types";

type MessageListener = Parameters<
  typeof chrome.runtime.onMessage.addListener
>[0];

function tabSender(id: number): chrome.runtime.MessageSender {
  return { tab: { id } as chrome.tabs.Tab };
}

function dispatchCommand(
  listener: MessageListener,
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  return new Promise((resolve) => {
    const keepChannelOpen = listener(message, sender, resolve);
    expect(keepChannelOpen).toBe(true);
  });
}

let listeners: MessageListener[];

beforeEach(() => {
  vi.resetModules();
  listeners = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("safety and delivery regressions", () => {
  it("does not replay an invocation when its effect happened but the reply was lost", async () => {
    let deliveryCount = 0;
    const executeScript = vi.fn().mockResolvedValue([]);
    const sendMessage = vi.fn(async () => {
      deliveryCount += 1;
      if (deliveryCount === 1) {
        throw new Error("Message port closed after the action took effect");
      }
      return {
        ok: true,
        result: {
          success: true,
          status: "completed",
          urlBefore: "https://fixture.test",
          urlAfter: "https://fixture.test",
          navigationOccurred: false,
          stateChanged: true,
          warnings: [],
        },
      };
    });

    vi.stubGlobal("chrome", {
      action: { onClicked: { addListener: vi.fn() } },
      runtime: {
        onMessage: {
          addListener: (listener: MessageListener) => listeners.push(listener),
        },
      },
      tabs: {
        onRemoved: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
        sendMessage,
      },
      scripting: { executeScript },
    });

    await import("../../extension/service-worker/service-worker");
    const response = await dispatchCommand(
      listeners[0]!,
      {
        type: "polyfill:invoke",
        tabId: 11,
        capabilityId: "synthetic-counted-action",
        args: {},
      },
      tabSender(11),
    );

    expect(deliveryCount).toBe(1);
    expect(executeScript).not.toHaveBeenCalled();
    expect(response).toEqual({
      ok: true,
      result: {
        success: false,
        status: "execution_timeout",
        urlBefore: "",
        urlAfter: "",
        navigationOccurred: false,
        stateChanged: false,
        warnings: [],
        error: {
          code: "execution_timeout",
          message: expect.stringContaining("was not retried"),
          details: {
            delivery: "uncertain",
            mayHaveExecuted: true,
            retried: false,
          },
        },
      },
    });
  });

  it("retries a read-only state query after reinjecting the connection", async () => {
    const executeScript = vi.fn().mockResolvedValue([]);
    const state = { enabled: true };
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("No content-script receiver"))
      .mockResolvedValueOnce({ ok: true, state });

    vi.stubGlobal("chrome", {
      action: { onClicked: { addListener: vi.fn() } },
      runtime: {
        onMessage: {
          addListener: (listener: MessageListener) => listeners.push(listener),
        },
      },
      tabs: {
        onRemoved: { addListener: vi.fn() },
        onUpdated: { addListener: vi.fn() },
        sendMessage,
      },
      scripting: { executeScript },
    });

    await import("../../extension/service-worker/service-worker");
    const response = await dispatchCommand(
      listeners[0]!,
      { type: "polyfill:get-state", tabId: 11 },
      tabSender(11),
    );

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(executeScript).toHaveBeenCalledTimes(2);
    expect(executeScript.mock.calls.map(([options]) => options.world)).toEqual([
      "MAIN",
      "ISOLATED",
    ]);
    expect(response).toEqual({ ok: true, state });
  });
});

function locator(overrides: Partial<SemanticLocator> = {}): SemanticLocator {
  return {
    framePath: [],
    shadowPath: [],
    stableAttributes: [],
    fallbacks: [],
    ...overrides,
  };
}

function readCapability(target: SemanticLocator): Capability {
  const executor: ExecutorDefinition = {
    kind: "read",
    target,
    expected: {},
  };
  return {
    id: "sensitive-read",
    name: "sensitive_read",
    description: "Synthetic sensitive-read regression capability.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
    },
    effect: "read",
    confidence: 1,
    source: {
      type: "adapter",
      url: "https://fixture.test/account",
      framePath: [],
      shadowPath: [],
    },
    locator: target,
    executor,
  };
}

function controlCapability(target: SemanticLocator): Capability {
  return {
    ...readCapability(target),
    id: "sensitive-control",
    name: "sensitive_control",
    effect: "interact",
    inputSchema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
    executor: {
      kind: "control",
      control: "input",
      target,
      valueField: "value",
      expected: {},
    },
  };
}

async function readWithId(
  markup: string,
  id: string,
): Promise<Awaited<ReturnType<typeof executeCapability>>> {
  const dom = new JSDOM(markup, { url: "https://fixture.test/account" });
  try {
    return await executeCapability(
      readCapability(
        locator({ stableAttributes: [{ name: "id", value: id }] }),
      ),
      {},
      { document: dom.window.document },
    );
  } finally {
    dom.window.close();
  }
}

describe("sensitive DOM reads", () => {
  it("blocks an explicitly targeted password input without returning its value", async () => {
    const result = await readWithId(
      '<label for="account-password">Account password</label>' +
        '<input id="account-password" type="password" value="synthetic-secret-sentinel">',
      "account-password",
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe("unsupported_control");
    expect(JSON.stringify(result)).not.toContain("synthetic-secret-sentinel");
  });

  it("blocks hidden credential inputs before reading their value", async () => {
    const result = await readWithId(
      '<input id="csrf-field" type="hidden" name="csrf_token" value="hidden-credential-sentinel">',
      "csrf-field",
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe("unsupported_control");
    expect(JSON.stringify(result)).not.toContain("hidden-credential-sentinel");
  });

  it.each([
    {
      label: "token-named input",
      id: "api-token",
      markup: '<input id="api-token" name="apiToken" value="token-sentinel">',
      sentinel: "token-sentinel",
    },
    {
      label: "secret-named input",
      id: "client-secret",
      markup:
        '<input id="client-secret" name="clientSecret" value="secret-sentinel">',
      sentinel: "secret-sentinel",
    },
    {
      label: "CSRF-named input",
      id: "csrf-value",
      markup: '<input id="csrf-value" name="csrfToken" value="csrf-sentinel">',
      sentinel: "csrf-sentinel",
    },
    {
      label: "current-password autocomplete input",
      id: "current-password-field",
      markup:
        '<input id="current-password-field" name="login" autocomplete="current-password" value="current-password-sentinel">',
      sentinel: "current-password-sentinel",
    },
    {
      label: "new-password autocomplete input",
      id: "new-password-field",
      markup:
        '<input id="new-password-field" name="newLogin" autocomplete="new-password" value="new-password-sentinel">',
      sentinel: "new-password-sentinel",
    },
  ])("blocks a $label", async ({ id, markup, sentinel }) => {
    const result = await readWithId(markup, id);

    expect(result.success).toBe(false);
    expect(result.status).toBe("unsupported_control");
    expect(JSON.stringify(result)).not.toContain(sentinel);
  });

  it("redacts sensitive-looking values from an otherwise visible read result", async () => {
    const result = await readWithId(
      '<label for="display-status">Display status</label>' +
        '<input id="display-status" name="display" value="token=visible-secret-sentinel">',
      "display-status",
    );

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ value: "[REDACTED]" });
    expect(JSON.stringify(result)).not.toContain("visible-secret-sentinel");
  });

  it("redacts sensitive markers from visible text trace fields", async () => {
    const result = await readWithId(
      '<div id="status">Status: token=visible-text-secret-sentinel</div>',
      "status",
    );

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({
      accessibleName: "[REDACTED]",
      text: "[REDACTED]",
    });
    expect(JSON.stringify(result)).not.toContain(
      "visible-text-secret-sentinel",
    );
  });

  it("does not expose a password control value in the completed result", async () => {
    const dom = new JSDOM(
      '<input id="account-password" type="password" value="old-value">',
      { url: "https://fixture.test/account" },
    );
    try {
      const result = await executeCapability(
        controlCapability(
          locator({
            stableAttributes: [{ name: "id", value: "account-password" }],
          }),
        ),
        { value: "new-value-without-a-marker" },
        { document: dom.window.document },
      );

      expect(result.success).toBe(true);
      expect(result.result).toEqual({ value: "[REDACTED]" });
      expect(JSON.stringify(result)).not.toContain(
        "new-value-without-a-marker",
      );
    } finally {
      dom.window.close();
    }
  });
});
