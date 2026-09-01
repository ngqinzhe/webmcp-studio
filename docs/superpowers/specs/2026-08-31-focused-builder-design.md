# WebMCP Studio focused builder design

**Date:** 2026-08-31  
**Status:** Approved for implementation

## Goal

Make the hosted Studio understandable to a first-time judge from one input:
the site or domain to inspect. A judge should be able to discover page-native
WebMCP primitives, drag them into an ordered workflow, name a higher-level
tool, publish it to the selected controlled page, and test the page-level
capability without installing the extension.

The focused builder is the primary hosted experience. The existing extension,
arbitrary production-site analysis, structured workflow runtime, controlled
targets, and native WebMCP registration remain useful supporting architecture.

## Product boundaries

The hosted path has two classes of discovery:

- **Native**: the target page declares a tool through
  `document.modelContext.registerTool`; controlled target descriptors use
  `source: "webmcp"`.
- **Inferred**: Studio proposes a capability from DOM/interface evidence or
  external URL evidence; these descriptors use non-WebMCP provenance. They can
  be composed and executed against Studio's sanitized local snapshot, but they
  are not live tools on the external origin.

Native/inferred is provenance. It is displayed separately from runtime
availability, which can be **Live WebMCP** or **Preview only** when the browser
does not expose the native API. Studio must never call a preview handler a
native WebMCP invocation.

External URLs remain potential on their original origin. Hosted Studio does not
inject scripts, read a third-party DOM, or persist registrations on an external
origin. Their inferred descriptors can still be composed into generated Studio
tools and executed against a sanitized local snapshot. The optional extension
is the advanced adapter for live external instrumentation.

## Focused builder experience

The first workspace viewport contains:

1. A single **Site or domain** field and **Discover tools** action. The field
   accepts an absolute `http:`/`https:` URL or a supported controlled target
   path. Small Commerce and Travel example shortcuts seed the deterministic
   demo without becoming a second navigation model.
2. A two-column builder. The left column contains the live target identity and
   discovered capability library. The right column contains the workflow
   canvas and generated-tool form.
3. A compact execution panel that follows the generated tool from publication
   through a visible target state change.

Discovery cards show name, agent-facing description, typed JSON Schema, source
primitive/action, DOM or UI evidence, confidence, effect, and the green Native
or yellow Inferred badge. The legend and text labels ensure classification is
not color-only. A separate live/preview indicator explains whether an agent
can currently consume the registration.

Each executable discovery card has a drag handle and an accessible **Add to
workflow** action. The workflow canvas accepts drops, shows insertion points,
supports reorder and remove, and exposes the generated tool name and
description beside the flow. The existing workflow DAG and binding logic are
the only source of truth; the UI does not create arbitrary JavaScript.

The primary post-generation actions are:

- **Inject into page**: publish the validated generated descriptor to the
  selected controlled target page.
- **Test WebMCP**: invoke the page-registered generated handler with the
  deterministic example input and show the target state change.
- **Run preview**: for inferred external tools or unsupported native hosts,
  invoke the same structured workflow against the safe local snapshot.

When native WebMCP is unavailable, the UI changes the action to an explicitly
labeled **Run preview** path and preserves the unsupported-browser message.
It does not claim native registration or agent discovery.

## Runtime and bridge design

The Studio remains the top-level owner of the project document, workflow
validation, workflow interpreter, generated-tool session storage, and target
selection. The target iframe remains the owner of primitive handlers and page
state.

Extend the existing same-origin, versioned target bridge with typed messages
for dynamic page publication and page-level invocation:

- parent → target: `register-generated-tool` with a JSON-safe descriptor and
  the generated workflow identity;
- parent → target: `test-generated-tool` with a request ID and deterministic
  input for the page-level test button;
- target → parent: `generated-tool-ready` with registration mode and an
  actionable error when registration is rejected;
- target → parent: `generated-tool-call` with request ID, generated name, and
  validated arguments;
- parent → target: `generated-tool-result` or `generated-tool-error`.

The target runtime registers the generated descriptor with its own
`document.modelContext` when available. Its handler relays calls to Studio,
which resolves the existing structured workflow against the target's native
primitive bridge. The target runtime owns request timeouts and rejects stale,
unknown, malformed, or cross-origin messages. Registration names cannot
shadow a primitive or another generated tool.

For `test-generated-tool`, the target prefers the host's exposed page-tool
execution helper when available. Otherwise it invokes the exact registered
target handler through the typed test bridge and returns a structured
`generated-tool-test-result` or `generated-tool-test-error`. The result is
clearly labeled as a page registration test and is not represented as ChatGPT
evidence. In all cases the trace is built from the workflow runner's
structured trace, not UI-only fake steps.

The top-level Studio native registrations remain intact for hosts that keep
Studio as the current page. Page injection is the primary judge path and is
the only path required to demonstrate a generated tool on the controlled
target.

## State model and performance

Add only the smallest state needed to the existing `HostedStudio` model:

- normalized input URL and target resolution state;
- discovery provenance (`native` or `inferred`) derived from descriptors;
- ordered draft primitive IDs;
- generated tool publication state (`draft`, `generated`, `injected`,
  `failed`) and registration mode.

Drag operations update a lightweight draft array. The DOM is patched on drop,
reorder, and removal rather than on every pointer movement. Event delegation,
stable card identities, and one render per committed state change keep the
composer responsive. Keyboard add/reorder controls provide an equivalent
path for touch and accessibility.

Generation and injection validate names, schemas, primitive ownership,
bindings, target identity, and workflow readiness before any page-side
registration. Mutating primitive annotations are preserved so the native host
can apply its safety behavior.

## Failure handling

Errors are local, explicit, and recoverable:

- malformed or unsupported URL → inline correction and no discovery request;
- external URL → inferred/potential cards plus the extension boundary note;
- no native tools → empty state with a preview explanation;
- duplicate or invalid drop → no mutation and an inline message;
- invalid tool name/schema or incomplete bindings → generation stays disabled;
- registration rejection or timeout → generated tool remains editable and can
  be retried after the target reloads;
- primitive failure → trace stops at the failed step, names the primitive and
  reason, and leaves the page in the observed state.

## Verification

Add unit coverage for provenance classification, URL resolution, dynamic
bridge validation, registration lifecycle, generated-tool invocation, and
drag/drop ordering. Update hosted end-to-end coverage to exercise a clean
no-extension session:

1. enter/use a controlled site URL;
2. discover Native primitives and confirm Inferred cards are visually distinct;
3. drag primitives into the composer and set a custom name;
4. generate and inject the tool into the target page;
5. click Test WebMCP / Run preview as appropriate;
6. assert the trace reaches the underlying primitives and the target page
   visibly changes;
7. assert the generated tool is discoverable from the target page's native
   model context in the synthetic native host;
8. run the production build and public HTTPS smoke checks without the
   extension.

The existing extension E2E suite remains a separate optional-adapter check.

## Deployment

Keep the hosted build's same-origin target paths, security headers, and
`tools=(self)` Permissions Policy. Do not add wildcard CORS or localhost-only
assumptions. Update the hosted deployment guide with the new single-input,
inject, and test flow and preserve the explicit native/preview limitation.
