# WebMCP Studio

WebMCP Studio is a visual builder for agent-ready WebMCP tools. It discovers
capabilities exposed by a website, infers useful actions from its interface,
and lets you compose those actions into a workflow. Workflows can run in
Studio's safe preview or be registered with `document.modelContext` for a
compatible WebMCP browser and agent. An optional Chrome extension supports
live external pages.

## Requirements

- Node.js and npm
- Chrome 120 or later for the optional extension
- A WebMCP-capable browser and agent for native WebMCP testing

## Setup

```bash
npm install
npm run build
npm run serve:hosted
```

Open <http://127.0.0.1:4177/> in your browser.

## Use the hosted Studio

1. Enter `/targets/commerce.html` in **Target website or domain** and click
   **Analyze**.
2. Drag discovered capabilities into the workflow canvas.
3. Enter a tool name and description, then click **Save tool**.
4. Click **Inject into page** and test with **Test WebMCP**. If native WebMCP
   is unavailable, use **Run preview** instead.

To test a live external page with the optional extension:

```bash
npm run build:extension
npm run demo
```

Then enable Developer mode at `chrome://extensions`, load `dist/extension` as
an unpacked extension, and open <http://127.0.0.1:4173/compat.html>.

## Test

```bash
npm run typecheck
npm test
npm run test:e2e
npm run format:check
```

`npm test` runs unit tests. `npm run test:e2e` builds the extension and runs
the Playwright browser tests.
