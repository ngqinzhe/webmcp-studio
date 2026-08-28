# WebMCP Studio

A Chrome MV3 developer extension that infers user-level tools from a page's semantic DOM and registers them through `document.modelContext`. Tools execute through the page's visible UI.

## Project plan

The [hackathon development brief](docs/project-brief.md) is the planning reference for the agreed MVP: Studio, external ChatGPT, the canonical config, and the universal extension. The [discovery research](docs/research/printing-press-discovery.md) records the supporting evidence and remaining proof gaps.

The code and setup below are the current extension prototype, described in the [extension design](docs/superpowers/specs/2026-08-28-webmcp-polyfill-design.md). The complete Studio workflow and native ChatGPT compatibility remain to be proven. Begin with gates **G1–G3** in the brief; mocked WebMCP tests or inspector invocation alone do not validate the complete browser connection.

The [August 28 feasibility report](docs/feasibility/2026-08-28.md) records real native shared-authoring and execution-runtime calls in Codex, including a verified registration-removal fix. The [installed-extension follow-up](docs/feasibility/installed-extension-2026-08-29.md) verifies Chrome registration, page-mediated native execution, tab effects, and DOM-driven removal/restoration across the actual extension boundary. The chosen ChatGPT setup, selected local-tab bridge, and agent-native consumption of injected tools remain open.

The [pre-build blocker audit](docs/feasibility/blocker-audit-2026-08-28.md) records the remaining compatibility, safety, and submission gates, with reproducible synthetic checks. Do not use this prototype for authenticated or consequential workflows until its retry, redaction, session, and approval controls are addressed.

The [Chrome agent-bridge investigation](docs/feasibility/chrome-agent-bridge-2026-08-29.md) isolates the current native-consumption failure to the tested agent connection: both page-provided and extension-provided tools fail capability acquisition. It records the supported-product evidence and the remaining desktop ChatGPT Work comparison; it does not claim that every ChatGPT setup is unsupported.

## Run

```bash
npm install
npm run build:extension
npm run demo
```

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select `dist/extension`.
4. Open `http://127.0.0.1:4173/index.html`.
5. Click the extension action to open the inspector and scan the page.

The demo includes search, ecommerce, SPA updates, Shadow DOM, same-origin iframes, weak semantics, stale tools, and native WebMCP overlap.

## Test

```bash
npm run typecheck
npm test
npm run test:e2e
npm run format:check
```

## Native feasibility fixture

Run `npm run spike:native` and open `http://127.0.0.1:4174/` in a browser with native Site tools. This small shared-draft fixture never mocks `document.modelContext`. The separate `/target.html` page starts without page-provided tools. See the [reproduction steps and limitations](docs/feasibility/2026-08-28.md) before treating a result as native compatibility evidence.

To test the existing scanner, compiler, message bridge, and DOM executor against native tools, run `node spikes/native-runtime/serve.mjs` and open `http://127.0.0.1:4175/`. This component fixture runs both runtime halves in one page world; it does not install or validate the MV3 extension.

With the extension manually loaded, run `node spikes/installed-extension/serve.mjs` and open `http://127.0.0.1:4176/` for the [installed-extension diagnostic](docs/feasibility/installed-extension-2026-08-29.md). It invokes the public browser API through visible buttons and does not register or mock tools. This verifies installed components, not native agent consumption.

## Adapters

Adapters transform the Capability Graph:

```ts
import { defineAdapter } from "./sdk";

export const adapter = defineAdapter({
  id: "my-site",
  match: ({ page }) => page.hostname.endsWith("example.com"),
  override: ({ capability }) =>
    capability.name === "search" ? { name: "search_products" } : undefined,
});
```

Register adapters with `AdapterRegistry`. Adapters can discover, rename, refine, suppress, or execute capabilities without bypassing the graph or browser security boundaries.

## Limitations

- Requires Chrome 120+ and host support for `document.modelContext`.
- Closed Shadow DOM and cross-origin iframe contents are inaccessible.
- Browser permissions, authentication, CAPTCHAs, and user confirmations are respected.
- Native WebMCP inventory APIs vary by browser and site.
