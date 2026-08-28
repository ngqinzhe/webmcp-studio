import { createMainWorldRuntime } from "./runtime";

declare global {
  interface Window {
    __webmcpStudioMainRuntime?: ReturnType<typeof createMainWorldRuntime>;
  }
}

if (!window.__webmcpStudioMainRuntime) {
  window.__webmcpStudioMainRuntime = createMainWorldRuntime({
    window,
    document,
  });
}

export * from "./runtime";
