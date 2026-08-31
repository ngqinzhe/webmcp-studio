import { describe, expect, it } from "vitest";
import {
  AUTOMATIC_CONTENT_SCRIPT_ID,
  AUTOMATIC_MAIN_SCRIPT_ID,
  getAutomaticScanningSettings,
  setAutomaticScanning,
  shouldAutomaticallyActivate,
  type ActivationApi,
} from "../../extension/service-worker/activation";

function api(
  overrides: Partial<{
    permission: boolean;
    request: boolean;
  }> = {},
): ActivationApi & {
  requested: boolean;
  registered: string[];
  unregistered: boolean;
  injected: number[];
} {
  let permission = overrides.permission ?? false;
  const storage = new Map<string, unknown>();
  const result = {
    requested: false,
    registered: [] as string[],
    unregistered: false,
    injected: [] as number[],
  };
  return Object.assign(result, {
    permissions: {
      contains: async () => permission,
      request: async () => {
        result.requested = true;
        permission = overrides.request ?? true;
        return permission;
      },
    },
    scripting: {
      registerContentScripts: async (scripts: readonly unknown[]) => {
        result.registered.push(
          ...scripts.flatMap((script: unknown) =>
            typeof script === "object" && script !== null && "id" in script
              ? [String(script.id)]
              : [],
          ),
        );
      },
      unregisterContentScripts: async () => {
        result.unregistered = true;
      },
      getRegisteredContentScripts: async () =>
        result.registered.map((id) => ({ id })),
    },
    storage: {
      local: {
        get: async (
          key: string | string[] | Record<string, unknown> | null | undefined,
        ) => ({
          [String(key)]: storage.get(String(key)),
        }),
        set: async (items: Record<string, unknown>) => {
          for (const [key, value] of Object.entries(items))
            storage.set(key, value);
        },
      },
    },
    tabs: {
      query: async () => [
        { id: 7, url: "https://shop.example/catalog" },
        { id: 8, url: "chrome://settings" },
        { id: 9, url: "https://chromewebstore.google.com/detail/demo" },
      ],
    },
  });
}

describe("automatic WebMCP activation", () => {
  it("requests permission, registers dynamic scripts, and activates eligible tabs", async () => {
    const testApi = api();
    const settings = await setAutomaticScanning(
      testApi,
      true,
      async (tabId) => {
        testApi.injected.push(tabId);
      },
    );

    expect(testApi.requested).toBe(true);
    expect(testApi.registered).toEqual([
      AUTOMATIC_MAIN_SCRIPT_ID,
      AUTOMATIC_CONTENT_SCRIPT_ID,
    ]);
    expect(testApi.injected).toEqual([7]);
    expect(settings).toEqual({ enabled: true, permissionGranted: true });
    expect(
      await shouldAutomaticallyActivate(testApi, {
        url: "https://shop.example",
      }),
    ).toBe(true);
  });

  it("does not enable automatic scanning when permission is denied", async () => {
    const testApi = api({ request: false });
    const settings = await setAutomaticScanning(testApi, true);

    expect(settings).toEqual({ enabled: false, permissionGranted: false });
    expect(testApi.registered).toEqual([]);
    expect(await getAutomaticScanningSettings(testApi)).toEqual(settings);
  });

  it("unregisters dynamic scripts when automatic scanning is disabled", async () => {
    const testApi = api({ permission: true });
    await setAutomaticScanning(testApi, true);
    const settings = await setAutomaticScanning(testApi, false);

    expect(testApi.unregistered).toBe(true);
    expect(settings.enabled).toBe(false);
    expect(
      await shouldAutomaticallyActivate(testApi, {
        url: "https://shop.example",
      }),
    ).toBe(false);
  });
});
