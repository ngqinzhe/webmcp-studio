# WebMCP Studio

A Chrome MV3 developer extension that infers user-level tools from a page's semantic DOM and registers them through `document.modelContext`. Tools execute through the page's visible UI.

## Project plan

The [hackathon development brief](docs/project-brief.md) is the planning reference for the agreed MVP: Studio, external ChatGPT, the canonical config, and the universal extension. The [discovery research](docs/research/printing-press-discovery.md) records the supporting evidence and remaining proof gaps.

The code and setup below are the current extension prototype, described in the [extension design](docs/superpowers/specs/2026-08-28-webmcp-polyfill-design.md). The complete Studio workflow and native ChatGPT compatibility remain to be proven. Begin with gates **G1–G3** in the brief; mocked WebMCP tests or inspector invocation alone do not validate the complete browser connection.

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
