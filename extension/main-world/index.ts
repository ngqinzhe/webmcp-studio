import { createMainWorldRuntime } from "./runtime";
import { ensureModelContext } from "./model-context";

declare global {
  interface Window {
    __webmcpStudioMainRuntime?: ReturnType<typeof createMainWorldRuntime>;
  }
}

if (!window.__webmcpStudioMainRuntime) {
  // Keep the extension useful on pages that do not expose a native WebMCP
  // host. The compatibility module strictly preserves a native document or
  // navigator context when one appears later.
  ensureModelContext(document);
  window.__webmcpStudioMainRuntime = createMainWorldRuntime({
    window,
    document,
  });
}

export * from "./runtime";
