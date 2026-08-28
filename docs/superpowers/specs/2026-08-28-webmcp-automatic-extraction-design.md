# Automatic Production WebMCP Extraction Design

## Goal

Extend WebMCP Studio so an explicitly enabled extension can scan eligible production pages, expose inferred visible interactions through a page-side WebMCP host, and let a WebMCP-aware agent discover and invoke those interactions without agent-side DOM rediscovery.

The existing safety boundary remains canonical: deterministic isolated-world DOM discovery produces semantic locators and executor definitions; MAIN world only hosts WebMCP registrations and bridges invocation; the isolated runtime resolves locators and calls `executeCapability()` through visible UI behavior.

## Architecture

The change adds three focused extension-side responsibilities:

- An activation/permission module owns the inspector preference, optional host-permission request, eligible-tab checks, automatic injection, and duplicate prevention. Automatic scanning is off by default. The existing `activeTab` toolbar flow remains the manual fallback.
- A MAIN-world model-context compatibility module selects a native `document.modelContext` or `navigator.modelContext` when available, and creates a marked extension-owned context only when neither exists. It supports the current registration, update, removal, clearing, and inventory APIs, including the `provide*` and `register*` aliases used by compatible hosts.
- A session-backed registry stores reconnect/display metadata by tab and document/runtime generation. It never becomes an execution authority; the live content runtime remains the source of truth.

`ContentRuntime` continues to own lifecycle scanning, adapters, native deduplication, graph state, semantic locators, and visible execution. `MainWorldWebMcpRuntime` continues to reconcile inferred descriptors, inspect native tools, and bridge `execute` callbacks. The inspector requests live content state first and uses session state only as a display/recovery fallback.

## Activation and data flow

The manifest retains `activeTab` and scripting permissions, adds optional HTTP/HTTPS host permissions, and makes automatic injection available only after the user grants access. The inspector’s automatic-mode toggle immediately calls `chrome.permissions.request`; Chrome’s approval prompt is mandatory because an extension cannot silently grant page access. The preference is enabled only after a successful grant.

For automatic mode, the service worker observes tab updates and document navigation. It injects MAIN-world code at document start and isolated content code when the DOM is usable, then activates eligible existing tabs when the setting is enabled. Restricted schemes and extension-controlled pages are skipped gracefully, including `chrome:`, `edge:`, `about:`, `file:`, extension URLs, Chrome Web Store pages, and unsupported schemes.

Each bundle uses a per-document global marker. The MAIN runtime starts early enough to be present before page-side WebMCP discovery; the content runtime starts at DOM idle and runs its existing lifecycle/mutation pipeline. Full reloads create a new runtime generation. SPA navigation and relevant DOM mutations reconcile the graph and registrations within the current document.

The invocation path is:

```text
WebMCP agent inventory → generated tool execute(args)
  → MAIN runtime bridge { capabilityId, args }
  → isolated live graph validation
  → semantic locator resolution
  → executeCapability()
  → structured result and visible page state
```

The agent sees only tool metadata and schema when choosing an action. It does not inspect selectors, HTML, DOM snapshots, or page routes to determine how to act.

## Native and synthetic WebMCP behavior

Native context precedence is strict. An existing `document.modelContext` is preferred, followed by `navigator.modelContext`. The extension-owned host is installed only if neither is available. It is marked with an internal ownership symbol and is replaceable/configurable where possible so a later native context can appear without being clobbered.

The compatibility host maintains an extension-owned tool registry and exposes each inferred tool’s name, description, input schema, annotations, and bridge-backed execute callback. It implements `provideTool`, `provideTools`, `registerTool`, `registerTools`, `updateTool`, `updateTools`, `unregisterTool`, `unregisterTools`, `getTools`, and `listTools`, with compatible removal/clear aliases where supported.

Only tools registered by the extension may be updated or removed. Native tools are preserved. Native inventories are used for deduplication, while inferred capabilities supplement native tools that have no equivalent. If a native context appears after the synthetic host was installed, the runtime relinquishes synthetic ownership, preserves native registrations, and reconciles inferred tools into the native context.

## Registry and staleness

Session registry records include tab ID, document/runtime identity, page origin and URL, timestamp, graph version, capability metadata, native-tool metadata, and registration status. Records are invalidated when a tab closes, a new document loads, the URL/document identity changes, or the runtime generation changes.

Persisted capability metadata may support inspector display and reconnect recovery, but persisted locators are never invoked blindly. Every invocation must find a matching capability in the live content runtime and resolve its semantic locator against the current DOM. Missing live state, generation mismatch, or failed resolution returns a structured failure and does not execute.

Execution results retain the existing URL-before/after, navigation, state-change, warnings, and structured error fields. Unsafe, hidden, disabled, tracking-only, destructive, unsupported, or ambiguous controls are omitted or reported as blocked. Generated names remain readable and deterministic; duplicate visible labels receive stable contextual suffixes, and native-equivalent names remain suppressed.

## Assisted inference

Deterministic inference remains sufficient and is the normal extension path. If the existing assisted-inference provider is wired into runtime scanning, it is optional and may improve names, descriptions, schemas, or confidence only. It cannot create locators or executor definitions; deterministic output remains the safe fallback, and no API key is required for normal extension operation.

## Validation

Unit tests cover synthetic-host installation, native preservation and late takeover, registration aliases, bridge-backed execution, deterministic naming, unsafe-control filtering, SPA reconciliation, activation permission gating, reconnect recovery, and stale-state rejection.

An extension E2E fixture without a static `modelContext` proves the complete generic workflow. The test loads the page, waits for the extension host, enumerates `document.modelContext.getTools()` or `navigator.modelContext.getTools()`, selects a tool from its name/description/schema, invokes `execute(args)`, and asserts the visible result plus `success`, `stateChanged`, `navigationOccurred`, and error fields. The agent simulation does not read HTML or DOM to choose the action and does not call direct locators, navigation, guessed URLs, or direct clicks for that action.

Validation commands are `npm run typecheck`, `npm test`, `npm run test:e2e`, and `npm run format:check`.
