export const AUTOMATIC_HOST_PATTERNS = ["http://*/*", "https://*/*"] as const;

export const AUTOMATIC_MAIN_SCRIPT_ID = "webmcp-studio-automatic-main";
export const AUTOMATIC_CONTENT_SCRIPT_ID = "webmcp-studio-automatic-content";
export const AUTOMATIC_SETTING_KEY = "automaticScanningEnabled";

export interface ActivationTab {
  id?: number | undefined;
  url?: string | undefined;
}

export interface ActivationStorage {
  get(
    keys?: string | string[] | Record<string, unknown> | null,
  ): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface ActivationApi {
  permissions: {
    contains(details: { origins: readonly string[] }): Promise<boolean>;
    request(details: { origins: readonly string[] }): Promise<boolean>;
  };
  scripting: {
    registerContentScripts(scripts: readonly unknown[]): Promise<void>;
    unregisterContentScripts(filter: { ids: readonly string[] }): Promise<void>;
    getRegisteredContentScripts?(filter?: {
      ids?: readonly string[];
    }): Promise<Array<{ id?: string }>>;
  };
  storage: { local: ActivationStorage };
  tabs: {
    query(queryInfo: Record<string, unknown>): Promise<ActivationTab[]>;
  };
}

export interface AutomaticScanningSettings {
  enabled: boolean;
  permissionGranted: boolean;
}

export function isEligiblePageUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname.toLowerCase();
    return (
      !(
        hostname === "chrome.google.com" && url.pathname.startsWith("/webstore")
      ) && hostname !== "chromewebstore.google.com"
    );
  } catch {
    return false;
  }
}

export const automaticContentScriptDefinitions = [
  {
    id: AUTOMATIC_MAIN_SCRIPT_ID,
    matches: [...AUTOMATIC_HOST_PATTERNS],
    excludeMatches: [
      "https://chrome.google.com/webstore/*",
      "https://chromewebstore.google.com/*",
    ],
    js: ["main-world.js"],
    runAt: "document_start",
    world: "MAIN",
    persistAcrossSessions: true,
  },
  {
    id: AUTOMATIC_CONTENT_SCRIPT_ID,
    matches: [...AUTOMATIC_HOST_PATTERNS],
    excludeMatches: [
      "https://chrome.google.com/webstore/*",
      "https://chromewebstore.google.com/*",
    ],
    js: ["content.js"],
    runAt: "document_idle",
    world: "ISOLATED",
    persistAcrossSessions: true,
  },
] as const;

async function hasPagePermission(api: ActivationApi): Promise<boolean> {
  try {
    return await api.permissions.contains({
      origins: AUTOMATIC_HOST_PATTERNS,
    });
  } catch {
    return false;
  }
}

export async function getAutomaticScanningSettings(
  api: ActivationApi,
): Promise<AutomaticScanningSettings> {
  const stored = await api.storage.local.get(AUTOMATIC_SETTING_KEY);
  const permissionGranted = await hasPagePermission(api);
  return {
    enabled: stored[AUTOMATIC_SETTING_KEY] === true && permissionGranted,
    permissionGranted,
  };
}

async function registeredScriptIds(api: ActivationApi): Promise<Set<string>> {
  if (!api.scripting.getRegisteredContentScripts) return new Set();
  try {
    const scripts = await api.scripting.getRegisteredContentScripts({
      ids: [AUTOMATIC_MAIN_SCRIPT_ID, AUTOMATIC_CONTENT_SCRIPT_ID],
    });
    return new Set(
      scripts
        .map((script) => script.id)
        .filter((id): id is string => typeof id === "string"),
    );
  } catch {
    return new Set();
  }
}

export async function syncAutomaticContentScripts(
  api: ActivationApi,
  enabled: boolean,
): Promise<void> {
  if (!enabled || !(await hasPagePermission(api))) {
    try {
      await api.scripting.unregisterContentScripts({
        ids: [AUTOMATIC_MAIN_SCRIPT_ID, AUTOMATIC_CONTENT_SCRIPT_ID],
      });
    } catch {
      // The scripts may not have been registered yet.
    }
    return;
  }

  const registered = await registeredScriptIds(api);
  const missing = automaticContentScriptDefinitions.filter(
    (script) => !registered.has(script.id),
  );
  if (missing.length > 0) {
    await api.scripting.registerContentScripts(missing);
  }
}

export async function setAutomaticScanning(
  api: ActivationApi,
  enabled: boolean,
  injectTab?: (tabId: number) => Promise<void>,
): Promise<AutomaticScanningSettings> {
  if (!enabled) {
    await api.storage.local.set({ [AUTOMATIC_SETTING_KEY]: false });
    await syncAutomaticContentScripts(api, false);
    return getAutomaticScanningSettings(api);
  }

  let permissionGranted = await hasPagePermission(api);
  if (!permissionGranted) {
    try {
      permissionGranted = await api.permissions.request({
        origins: AUTOMATIC_HOST_PATTERNS,
      });
    } catch {
      permissionGranted = false;
    }
  }
  if (!permissionGranted) {
    await api.storage.local.set({ [AUTOMATIC_SETTING_KEY]: false });
    return getAutomaticScanningSettings(api);
  }

  await syncAutomaticContentScripts(api, true);
  await api.storage.local.set({ [AUTOMATIC_SETTING_KEY]: true });

  if (injectTab) {
    const tabs = await api.tabs.query({});
    await Promise.all(
      tabs.flatMap((tab) =>
        typeof tab.id === "number" && isEligiblePageUrl(tab.url)
          ? [injectTab(tab.id).catch(() => undefined)]
          : [],
      ),
    );
  }
  return getAutomaticScanningSettings(api);
}

export async function shouldAutomaticallyActivate(
  api: ActivationApi,
  tab: ActivationTab,
): Promise<boolean> {
  const settings = await getAutomaticScanningSettings(api);
  return (
    settings.enabled && settings.permissionGranted && isEligiblePageUrl(tab.url)
  );
}
