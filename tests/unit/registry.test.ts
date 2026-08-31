import { describe, expect, it } from "vitest";
import type { InspectorState } from "../../core/types";
import {
  clearRegistryRecord,
  createRegistryRecord,
  readRegistryRecord,
  registryMatchesDocument,
  registryKey,
  saveRegistryState,
  type SessionStorageArea,
} from "../../extension/service-worker/registry";

function state(): InspectorState {
  return {
    graph: {
      version: 1,
      page: {
        url: "https://shop.example/catalog",
        title: "Catalog",
        origin: "https://shop.example",
        hostname: "shop.example",
      },
      generatedAt: 12,
      capabilities: {},
      blocked: [],
    },
    webmcp: {
      available: true,
      apiMethods: ["getTools"],
      nativeTools: [],
      registered: ["search_products"],
      rejected: [],
    },
    lastExecution: null,
    enabled: true,
    runtimeGeneration: "runtime-1",
    updatedAt: 13,
  };
}

function storage(): SessionStorageArea {
  const values = new Map<string, unknown>();
  return {
    get: async (key) => ({ [String(key)]: values.get(String(key)) }),
    set: async (items) => {
      for (const [key, value] of Object.entries(items)) values.set(key, value);
    },
    remove: async (key) => {
      for (const item of Array.isArray(key) ? key : [key]) values.delete(item);
    },
  };
}

describe("session tool registry", () => {
  it("stores reconnect metadata and the display-only state snapshot", async () => {
    const session = storage();
    const record = await saveRegistryState(session, 42, state());
    const restored = await readRegistryRecord(session, 42);

    expect(record.runtimeGeneration).toBe("runtime-1");
    expect(record.graphVersion).toBe(1);
    expect(restored?.state).toEqual(state());
    expect(restored?.capabilities).toEqual([]);
    expect(
      registryMatchesDocument(record, 42, "https://shop.example/catalog"),
    ).toBe(true);
    expect(
      registryMatchesDocument(record, 42, "https://shop.example/other"),
    ).toBe(false);
  });

  it("invalidates stored state explicitly when a tab closes", async () => {
    const session = storage();
    await saveRegistryState(session, 42, state());
    await clearRegistryRecord(session, 42);

    expect(await readRegistryRecord(session, 42)).toBeNull();
    expect(registryKey(42)).toBe("webmcp-studio:tab:42");
  });

  it("creates a record for a state with no graph without making it executable", () => {
    const pending = { ...state(), graph: null };
    const record = createRegistryRecord(42, pending);
    expect(record.url).toBe("");
    expect(record.capabilities).toEqual([]);
    expect(record.state.graph).toBeNull();
  });
});
