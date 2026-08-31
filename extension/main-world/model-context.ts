import type { JSONSchema } from "../../core/types";

/** Internal markers are visible only to the MAIN-world extension/page realm. */
export const EXTENSION_MODEL_CONTEXT_MARKER = Symbol.for(
  "webmcp-studio.extension-model-context",
);
export const EXTENSION_TOOL_REGISTRATION_MARKER = Symbol.for(
  "webmcp-studio.extension-tool-registration",
);

export interface ModelContextTool {
  name: string;
  description?: string;
  inputSchema?: JSONSchema;
  annotations?: Record<string, unknown>;
  execute?: (args: unknown) => unknown;
  [key: string | symbol]: unknown;
}

export interface ExtensionModelContext extends Record<string, unknown> {
  provideTool: (tool: ModelContextTool) => boolean;
  provideTools: (tools: unknown) => boolean;
  registerTool: (tool: ModelContextTool) => boolean;
  registerTools: (tools: unknown) => boolean;
  updateTool: (
    nameOrTool: string | ModelContextTool,
    tool?: ModelContextTool,
  ) => boolean;
  updateTools: (tools: unknown) => boolean;
  unregisterTool: (name: string) => boolean;
  unregisterTools: (names: unknown) => boolean;
  removeTool: (name: string) => boolean;
  removeTools: (names: unknown) => boolean;
  clearContext: () => boolean;
  clearTools: () => boolean;
  getTools: () => ModelContextTool[];
  listTools: () => ModelContextTool[];
  getToolDefinitions: () => ModelContextTool[];
  /** Chrome's imperative API invocation shape for the extension fallback. */
  executeTool: (tool: unknown, input: unknown) => Promise<unknown>;
}

export interface ModelContextResolution {
  context: Record<string, unknown>;
  owned: boolean;
  source: "document" | "navigator" | "extension";
}

const UNSET = Symbol("unset");
const syntheticByDocument = new WeakMap<
  Document,
  {
    context: ExtensionModelContext;
    documentOverride: unknown;
    navigatorOverride: unknown;
  }
>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOwned(value: unknown): value is Record<string | symbol, unknown> {
  if (!isRecord(value)) return false;
  try {
    return (
      (value as Record<string | symbol, unknown>)[
        EXTENSION_MODEL_CONTEXT_MARKER
      ] === true
    );
  } catch {
    return false;
  }
}

function readProperty(
  target: object | null | undefined,
  name: string,
): unknown {
  if (!target) return undefined;
  try {
    return Reflect.get(target, name);
  } catch {
    return undefined;
  }
}

function nativeContextOf(document: Document): ModelContextResolution | null {
  const documentContext = readProperty(document, "modelContext");
  if (isRecord(documentContext) && !isOwned(documentContext)) {
    return {
      context: documentContext,
      owned: false,
      source: "document",
    };
  }

  const navigator = document.defaultView?.navigator;
  const navigatorContext = readProperty(navigator, "modelContext");
  if (isRecord(navigatorContext) && !isOwned(navigatorContext)) {
    return {
      context: navigatorContext,
      owned: false,
      source: "navigator",
    };
  }
  return null;
}

function toolName(value: unknown): string | null {
  if (!isRecord(value) || typeof value.name !== "string") return null;
  const name = value.name.trim();
  return name || null;
}

function isExtensionTool(value: unknown): value is ModelContextTool {
  return (
    isRecord(value) &&
    (value as Record<string | symbol, unknown>)[
      EXTENSION_TOOL_REGISTRATION_MARKER
    ] === true
  );
}

function markExtensionTool<T extends ModelContextTool>(tool: T): T {
  try {
    Object.defineProperty(tool, EXTENSION_TOOL_REGISTRATION_MARKER, {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    });
    return tool;
  } catch {
    return Object.defineProperty(
      { ...tool },
      EXTENSION_TOOL_REGISTRATION_MARKER,
      {
        configurable: false,
        enumerable: false,
        value: true,
        writable: false,
      },
    ) as T;
  }
}

function toolList(value: unknown): ModelContextTool[] {
  if (Array.isArray(value)) return value.filter(isRecord) as ModelContextTool[];
  if (isRecord(value) && Array.isArray(value.tools)) {
    return value.tools.filter(isRecord) as ModelContextTool[];
  }
  return [];
}

function namesList(value: unknown): string[] {
  const values = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.names)
      ? value.names
      : [value];
  return values.flatMap((item) => {
    if (typeof item === "string") return [item];
    const name = toolName(item);
    return name ? [name] : [];
  });
}

function parseToolInput(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new TypeError("Tool input must be valid JSON.");
  }
}

function defineSyntheticProperty(
  target: object,
  name: string,
  getter: () => unknown,
  setter: (value: unknown) => void,
): boolean {
  try {
    const own = Object.getOwnPropertyDescriptor(target, name);
    if (own && !own.configurable) return false;
    Object.defineProperty(target, name, {
      configurable: true,
      enumerable: own?.enumerable ?? false,
      get: getter,
      set: setter,
    });
    return true;
  } catch {
    return false;
  }
}

function exposeNativeNavigatorAsDocumentCompatibilityAlias(
  document: Document,
): void {
  const navigator = document.defaultView?.navigator;
  if (!navigator) return;
  const descriptor = Object.getOwnPropertyDescriptor(document, "modelContext");
  if (descriptor && !descriptor.configurable) return;

  defineSyntheticProperty(
    document,
    "modelContext",
    () => {
      const context = readProperty(navigator, "modelContext");
      return isRecord(context) && !isOwned(context) ? context : undefined;
    },
    (value) => {
      try {
        Object.defineProperty(document, "modelContext", {
          configurable: true,
          enumerable: descriptor?.enumerable ?? false,
          value,
          writable: true,
        });
      } catch {
        // A page may expose a non-configurable document property between the
        // alias read and a page assignment. Keep the native navigator intact.
      }
    },
  );
}

function createSyntheticContext(): ExtensionModelContext {
  const tools = new Map<string, { tool: ModelContextTool; owned: boolean }>();

  const register = (tool: ModelContextTool): boolean => {
    const name = toolName(tool);
    if (!name) return false;
    const existing = tools.get(name);
    const owned = isExtensionTool(tool);
    // A page-provided tool always wins a name collision. This lets a native
    // registration that arrives after an inferred registration take over
    // without allowing a later extension sync to overwrite it.
    if (existing && existing.owned && !owned) {
      tools.set(name, { tool, owned: false });
      return true;
    }
    if (existing && !existing.owned && owned) return false;
    tools.set(name, { tool, owned });
    return true;
  };

  const update = (
    nameOrTool: string | ModelContextTool,
    maybeTool?: ModelContextTool,
  ): boolean => {
    const tool = typeof nameOrTool === "string" ? maybeTool : nameOrTool;
    if (!tool) return false;
    const name = typeof nameOrTool === "string" ? nameOrTool : toolName(tool);
    if (!name) return false;
    const existing = tools.get(name);
    const owned = isExtensionTool(tool);
    if (existing && existing.owned !== owned) return false;
    const next = { ...tool, name };
    return register(owned ? markExtensionTool(next) : next);
  };

  const unregister = (name: string): boolean => {
    if (typeof name !== "string" || !name.trim()) return false;
    return tools.delete(name.trim());
  };

  const clear = (): boolean => {
    for (const [name, entry] of tools) {
      if (entry.owned) tools.delete(name);
    }
    return true;
  };

  const context = {
    provideTool: register,
    provideTools: (value: unknown): boolean => {
      const items = toolList(value);
      return items.length > 0 && items.every(register);
    },
    registerTool: register,
    registerTools: (value: unknown): boolean => {
      const items = toolList(value);
      return items.length > 0 && items.every(register);
    },
    updateTool: update,
    updateTools: (value: unknown): boolean => {
      const items = toolList(value);
      return items.length > 0 && items.every((item) => update(item));
    },
    unregisterTool: unregister,
    unregisterTools: (value: unknown): boolean => {
      const names = namesList(value);
      return names.length > 0 && names.every(unregister);
    },
    removeTool: unregister,
    removeTools: (value: unknown): boolean => {
      const names = namesList(value);
      return names.length > 0 && names.every(unregister);
    },
    clearContext: clear,
    clearTools: clear,
    getTools: (): ModelContextTool[] =>
      [...tools.values()].map(({ tool }) => tool),
    listTools: (): ModelContextTool[] =>
      [...tools.values()].map(({ tool }) => tool),
    getToolDefinitions: (): ModelContextTool[] =>
      [...tools.values()].map(({ tool }) => tool),
    executeTool: async (value: unknown, input: unknown): Promise<unknown> => {
      // Chrome's imperative host passes the registered tool object, while a
      // few compatible consumers pass the tool name. Accept both forms but
      // keep object invocations identity-checked so an arbitrary lookalike
      // descriptor cannot dispatch an extension-owned handler.
      const name = typeof value === "string" ? value.trim() : toolName(value);
      if (!name) throw new TypeError("A registered WebMCP tool is required.");
      const entry = tools.get(name);
      if (
        !entry ||
        (typeof value !== "string" && entry.tool !== value) ||
        typeof entry.tool.execute !== "function"
      )
        throw new Error("The WebMCP tool is no longer registered.");
      return entry.tool.execute(parseToolInput(input));
    },
  } satisfies ExtensionModelContext;

  Object.defineProperty(context, EXTENSION_MODEL_CONTEXT_MARKER, {
    configurable: false,
    enumerable: false,
    value: true,
    writable: false,
  });
  return context;
}

function exposeSyntheticContext(
  document: Document,
  context: ExtensionModelContext,
  state: {
    context: ExtensionModelContext;
    documentOverride: unknown;
    navigatorOverride: unknown;
  },
): void {
  const readNativeNavigator = (): unknown =>
    readProperty(document.defaultView?.navigator, "modelContext");
  const readNativeDocument = (): unknown => {
    const override = state.documentOverride;
    return override === UNSET ? undefined : override;
  };

  defineSyntheticProperty(
    document,
    "modelContext",
    () => {
      const override = readNativeDocument();
      if (isRecord(override) && !isOwned(override)) return override;
      const navigatorContext = readNativeNavigator();
      if (isRecord(navigatorContext) && !isOwned(navigatorContext))
        return navigatorContext;
      return context;
    },
    (value) => {
      state.documentOverride = value;
    },
  );

  const navigator = document.defaultView?.navigator;
  if (!navigator) return;
  defineSyntheticProperty(
    navigator,
    "modelContext",
    () => {
      const override = state.navigatorOverride;
      if (isRecord(override) && !isOwned(override)) return override;
      const documentContext = readProperty(document, "modelContext");
      if (isRecord(documentContext) && !isOwned(documentContext))
        return documentContext;
      return context;
    },
    (value) => {
      state.navigatorOverride = value;
    },
  );
}

/** Select native WebMCP first, otherwise install one extension-owned host. */
export function ensureModelContext(document: Document): ModelContextResolution {
  const native = nativeContextOf(document);
  if (native) {
    if (native.source === "navigator")
      exposeNativeNavigatorAsDocumentCompatibilityAlias(document);
    return native;
  }

  const existing = syntheticByDocument.get(document);
  if (existing) {
    exposeSyntheticContext(document, existing.context, existing);
    return { context: existing.context, owned: true, source: "extension" };
  }

  const context = createSyntheticContext();
  const state = {
    context,
    documentOverride: UNSET,
    navigatorOverride: UNSET,
  };
  syntheticByDocument.set(document, state);
  exposeSyntheticContext(document, context, state);

  const resolved = nativeContextOf(document);
  if (resolved) return resolved;
  return { context, owned: true, source: "extension" };
}

/** Re-read both page surfaces so a native context can replace a synthetic one. */
export function getModelContext(document: Document): ModelContextResolution {
  return ensureModelContext(document);
}

export function isExtensionOwnedModelContext(value: unknown): boolean {
  return isOwned(value);
}

export function isExtensionOwnedToolRegistration(value: unknown): boolean {
  return isExtensionTool(value);
}

export function markExtensionToolRegistration<T extends ModelContextTool>(
  tool: T,
): T {
  return markExtensionTool(tool);
}
