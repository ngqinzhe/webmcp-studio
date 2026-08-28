# WebMCP Studio Design

## Goal

WebMCP Studio is a Chrome Manifest V3 developer extension that turns meaningful controls in an already-open page into browser-native WebMCP tools. It never starts a second browser, calls a private site API, or edits the site's source. The extension is useful even when WebMCP is unavailable: the inspector exposes the inferred graph and the explicit blocked reason.

## Boundaries and data flow

The isolated content script owns scanning, graph lifecycle, adapters, locator resolution, and visible UI execution. A MAIN-world runtime owns only `document.modelContext` detection and tool registration. They exchange a versioned, tokenized `window.postMessage` protocol containing JSON-serializable capability data and invocation results. The service worker routes inspector messages and opens the inspector for the active tab. The inspector is an extension page and does not receive page privileges.

The pipeline is strictly layered:

```text
semantic DOM → Capability Graph → adapters/deduplication → locators → execution → modelContext registration
```

The graph is canonical. Each capability carries its schema, effect, confidence, semantic locator, and executor definition. Graph diffing drives unregister/register updates after debounced mutations and History API navigation. Open shadow roots and same-origin frames are traversed; closed shadow roots and cross-origin frames are reported as blocked rather than bypassed.

## Discovery and execution

Discovery prioritizes accessible labels, ARIA names, semantic text, stable attributes, and contextual entities. It produces user-level names such as `search_products`, `filter_results`, `change_sort`, and `add_to_cart`; unnamed positional controls are suppressed. Schema inference maps native controls to JSON Schema, including required values, enums, numeric constraints, email/date formats, and safe patterns.

Locators prefer role/name, context, labels, and stable attributes, with relationship and CSS selectors as fallbacks. Execution uses native setters/events, `requestSubmit`, and normal clicks/navigation. It snapshots URL/title/text/state and verifies an observable change or an expected navigation. Every failure is structured and distinguishes missing, ambiguous, blocked, invalid, unsupported, timeout, and no-change outcomes.

## WebMCP and native tools

The MAIN-world runtime uses `document.modelContext` only. It adapts to the currently exposed registration method (`provideTool`, `provideTools`, or compatible register/unregister methods), rejects unsafe/unsupported shapes gracefully, and tracks inferred registrations. Native tool summaries are read when exposed by the host; equivalent inferred names are suppressed while missing UI capabilities supplement native tools. Registration rejection is visible in the inspector.

## Adapter SDK and inspector

Adapters match a page, then transform the graph through `discover`, `override`, `suppress`, and optional executor hooks. Generic inference remains the baseline. The inspector shows page status, native/inferred/adapter origin, effect, confidence, schema, locator/fallbacks, registration, and the last structured result. Developers can rescan, toggle inferred registration, invoke a tool with JSON arguments, and export a stable adapter seed.

## Validation

Pure core behavior is tested with Vitest and jsdom. Playwright tests run only as browser validation: a local demo server, a loaded extension, a mock `document.modelContext`, visible form/card interaction, dynamic graph updates, and inspector invocation. The product runtime has no Playwright dependency or automation-browser path.
