import { ContentRuntime } from "../../extension/content/content-script";
import { createMainWorldRuntime } from "../../extension/main-world/runtime";

const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing fixture element: ${id}`);
  return value as T;
};
const context = (
  document as Document & { modelContext?: { registerTool?: unknown } }
).modelContext;
const status = element("runtime-status");
const form = element<HTMLFormElement>("product-search");
let submissions = 0;

form.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(form);
  element("search-status").textContent =
    `Results for ${String(data.get("q"))} (${String(data.get("category"))}).`;
  element<HTMLOutputElement>("submission-count").value = String(++submissions);
});

if (typeof context?.registerTool !== "function") {
  status.textContent = "Native WebMCP is unavailable. No mock was installed.";
} else {
  const main = createMainWorldRuntime({ window, document });
  main.start();
  const content = new ContentRuntime();

  function showDiagnostics(): void {
    const state = content.state();
    element("diagnostics").textContent = JSON.stringify(
      {
        fixtureOnly: true,
        executionWorlds: "Both runtime halves in the page's MAIN world",
        extensionInstalledByFixture: false,
        apiMockedByFixture: false,
        userAgent: navigator.userAgent,
        origin: location.origin,
        enabled: state.enabled,
        discoveredCapabilities: Object.values(
          state.graph?.capabilities ?? {},
        ).map(({ id, name, effect, executor }) => ({
          id,
          name,
          effect,
          executor,
        })),
        webmcp: state.webmcp,
        lastExecution: state.lastExecution,
      },
      null,
      2,
    );
  }

  for (const [id, enabled] of [
    ["disable-runtime", false],
    ["enable-runtime", true],
  ] as const) {
    element(id).addEventListener("click", () => {
      void content.setEnabled(enabled).then(() => {
        status.textContent = enabled
          ? "Runtime enabled; inspect native tool availability separately."
          : "Runtime disabled; inspect native tool availability separately.";
        showDiagnostics();
      });
    });
  }
  element("refresh-diagnostics").addEventListener("click", showDiagnostics);

  await content.start();
  await content.rescan();
  status.textContent =
    "Real discovery and registration completed; no mock used.";
  showDiagnostics();
}
