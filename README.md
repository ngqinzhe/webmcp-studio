# WebMCP Studio

WebMCP Studio turns websites into agent-native interfaces: **Discover →
Compose → Generate → Use**. The hosted Studio is the primary product and is
designed to work from one public HTTPS URL in a WebMCP-capable ChatGPT
browser. The Chrome MV3 extension remains an optional advanced adapter for
instrumenting eligible external sites; it is not part of the hackathon judging
path.

## Project plan

The [hackathon development brief](docs/project-brief.md) is the planning reference for the agreed MVP: Studio, external ChatGPT, the canonical config, and the universal extension. The [discovery research](docs/research/printing-press-discovery.md) records the supporting evidence and remaining proof gaps.

The current implementation includes the Studio project/command model, workflow interpreter, discovery-first drag-and-drop authoring, approval-aware activation, and the semantic DOM runtime. Native ChatGPT compatibility remains an external runtime gate: synthetic browser calls or inspector invocation alone do not validate the complete browser connection.

The [August 28 feasibility report](docs/feasibility/2026-08-28.md) records real native shared-authoring and execution-runtime calls in Codex, including a verified registration-removal fix. The [installed-extension follow-up](docs/feasibility/installed-extension-2026-08-29.md) verifies Chrome registration, page-mediated native execution, tab effects, and DOM-driven removal/restoration across the actual extension boundary. The [Chrome agent-bridge investigation](docs/feasibility/chrome-agent-bridge-2026-08-29.md) documents the tested agent connection's failure to acquire the WebMCP capability; the exact native ChatGPT/browser route and G1–G3 remain open.

The [pre-build blocker audit](docs/feasibility/blocker-audit-2026-08-28.md) records historical compatibility, safety, and submission findings with reproducible synthetic checks. The current implementation includes capture redaction, session checks, and approval/activation controls; the audit's ambiguous-delivery/retry concern remains open. Validate authenticated or consequential workflows against controlled pages until native compatibility and site-specific behavior are verified.

The [Chrome agent-bridge investigation](docs/feasibility/chrome-agent-bridge-2026-08-29.md) isolates the current native-consumption failure to the provider boundary: the tested Chrome integration advertises only `pageAssets`, while the in-app-browser provider advertises `webmcp`, so the tested agent connection cannot acquire WebMCP. The user clarified that a pasted follow-up was not a ChatGPT Work run, so that independent comparison remains unperformed. The direct route is blocked in the current Chrome provider; this does not claim that WebMCP or every future provider is incapable.

## Run the hosted Studio (judge path)

Open the deployed `https://<studio-domain>/` URL in ChatGPT's WebMCP-capable
browser. This is the complete first-run path: no extension installation,
cloning, API key, account, terminal, or configuration is required.

1. Click **Try the 60-second demo** (or enter `/targets/commerce.html` in
   **Site or domain**).
2. Click **Discover tools** and look for the five green **Native** cards,
   including `view_cart`. The focused example uses `search_products`,
   `filter_products`, `get_product`, and `add_to_cart`.
3. Drag those cards into the workflow canvas, keep the name
   `buy_best_product`, and click **Generate tool**.
4. Click **Inject into page**, then **Test WebMCP**. If the browser does not
   expose native WebMCP, the honest fallback is **Run preview**.
5. In a native WebMCP browser, ask ChatGPT to use `buy_best_product` with
   requirements `keyboard` and max price `200`. Watch the trace resolve the
   primitive calls and confirm that Northstar Supply visibly narrows to the
   selected product and the cart count becomes `1`.

The header must say **WebMCP live** before a run is described as native
WebMCP evidence. **Preview only** keeps discovery, composition, and the local
test useful when the browser does not expose `document.modelContext`, but it
never pretends to be an agent connection. See the [hosted deployment
guide](docs/hosted-deployment.md) for the production contract and browser
checks.

## Local hosted preview

```bash
npm install
npm run build
python3 -m http.server 4177 --directory dist
```

Open `http://127.0.0.1:4177/`. The build emits the hosted shell, bundled
Studio and controlled targets, and `dist/server/index.js`. Python's static
server is sufficient for a UI/preview walkthrough, but it does not reproduce
the production response headers or public HTTPS; use the deployed URL to
validate the native ChatGPT/WebMCP connection. `npm run demo` remains the
separate extension fixture server described below.

## Optional extension adapter

Use this path only when testing the advanced adapter against an eligible
external or local page. It is not required for the hosted judge flow.

```bash
npm run build:extension
npm run demo
```

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Choose **Load unpacked** and select `dist/extension`.
4. Open `http://127.0.0.1:4173/compat.html`.
5. Click the extension action. Studio opens for that exact tab, injects the
   runtime, and automatically discovers the page's supported capabilities.
6. Drag one or more discovered cards into **Ordered flow**, name the custom
   tool, and choose **Save & inject**. The saved tool is registered on the
   current page through `document.modelContext`; an agent can discover it with
   `getTools()` and invoke its `execute` handler.

Save & inject is the explicit human approval for the selected tab and current
project snapshot. Protected or consequential actions retain their safety
checks. The MVP surface intentionally omits project import/export and the
legacy inspector panels.

The extension fixture includes search, ecommerce, SPA updates, Shadow DOM,
same-origin iframes, weak semantics, stale tools, and native WebMCP overlap.

## Test

```bash
npm run typecheck
npm test
npm run test:e2e
npm run format:check
```

The end-to-end suite launches a headed Chromium context with the unpacked
extension. Its Studio and injected-tool checks are synthetic component
evidence; use the feasibility records for the separate native ChatGPT/browser
connection gate.

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

- Requires Chrome 120+ for the MV3 extension. Native agent discovery and invocation additionally require a compatible WebMCP host and browser/profile connection; the local model-context fallback does not establish that compatibility.
- Closed Shadow DOM and cross-origin iframe contents are inaccessible.
- Browser permissions, authentication, CAPTCHAs, and user confirmations are respected.
- Native WebMCP inventory APIs vary by browser and site.
