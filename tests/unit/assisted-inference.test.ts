import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import {
  inferCapabilitiesWithOptionalInterpreter,
  type CapabilityInterpreter,
} from "../../core/detection";
import { discoverDocument } from "../../core/dom/traverse";

describe("optional model-assisted inference seam", () => {
  it("keeps deterministic execution fields while allowing low-confidence interpretation", async () => {
    const dom = new JSDOM(
      `<form id="feedback" aria-label="Feedback"><input name="value"><button>Send</button></form>`,
      { url: "https://example.test/feedback" },
    );
    const snapshot = discoverDocument(dom.window.document);
    expect(snapshot.forms).toHaveLength(1);

    const interpreter: CapabilityInterpreter = {
      interpret: vi.fn(async ({ lowConfidence }) => [
        {
          capabilityId: lowConfidence[0]?.id ?? "missing",
          name: "send_feedback",
          description: "Send the feedback form.",
          confidence: 0.9,
        },
      ]),
    };
    const capabilities = await inferCapabilitiesWithOptionalInterpreter(
      snapshot,
      {
        page: {
          url: "https://example.test/feedback",
          title: "Feedback",
          origin: "https://example.test",
          hostname: "example.test",
        },
        interpreter,
        minimumConfidence: 1,
      },
    );

    expect(capabilities[0]?.name).toBe("send_feedback");
    expect(capabilities[0]?.executor.kind).toBe("form");
    expect(interpreter.interpret).toHaveBeenCalledOnce();
  });

  it("falls back to deterministic inference when the provider fails", async () => {
    const dom = new JSDOM(
      `<form aria-label="Search"><label>Search<input name="q" type="search"></label><button>Search</button></form>`,
      { url: "https://example.test/search" },
    );
    const snapshot = discoverDocument(dom.window.document);
    const capabilities = await inferCapabilitiesWithOptionalInterpreter(
      snapshot,
      {
        page: {
          url: "https://example.test/search",
          title: "Search",
          origin: "https://example.test",
          hostname: "example.test",
        },
        interpreter: {
          interpret: async () => {
            throw new Error("provider offline");
          },
        },
        minimumConfidence: 1,
      },
    );

    expect(capabilities[0]?.name).toBe("search_products");
  });
});
