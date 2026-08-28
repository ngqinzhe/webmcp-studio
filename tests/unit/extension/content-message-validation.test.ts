import { describe, expect, it } from "vitest";
import { isExtensionCommand } from "../../../extension/content/content-script";

describe("content-script extension message validation", () => {
  it("accepts the narrow commands used by the inspector", () => {
    expect(isExtensionCommand({ type: "polyfill:get-state", tabId: 4 })).toBe(
      true,
    );
    expect(isExtensionCommand({ type: "polyfill:rescan" })).toBe(true);
    expect(isExtensionCommand({ type: "polyfill:get-graph" })).toBe(true);
    expect(
      isExtensionCommand({ type: "polyfill:set-enabled", enabled: false }),
    ).toBe(true);
    expect(
      isExtensionCommand({
        type: "polyfill:invoke",
        capabilityId: "cap_1",
        args: { query: "keyboard" },
      }),
    ).toBe(true);
  });

  it("rejects malformed or unrelated page messages", () => {
    expect(isExtensionCommand(null)).toBe(false);
    expect(
      isExtensionCommand({ type: "polyfill:set-enabled", enabled: "false" }),
    ).toBe(false);
    expect(
      isExtensionCommand({
        type: "polyfill:invoke",
        capabilityId: "",
        args: {},
      }),
    ).toBe(false);
    expect(
      isExtensionCommand({ type: "polyfill:invoke", capabilityId: "cap_1" }),
    ).toBe(false);
    expect(
      isExtensionCommand({ type: "polyfill:get-state", tabId: null }),
    ).toBe(false);
    expect(
      isExtensionCommand({ type: "polyfill:state-update", state: {} }),
    ).toBe(false);
    expect(isExtensionCommand({ type: "polyfill:reset-all" })).toBe(false);
  });
});
