# Hosted WebMCP Studio Design

**Date:** 2026-08-31
**Status:** Implementation design derived from the hackathon submission requirements.

## Outcome

The primary product is a public HTTPS WebMCP Studio page. A first-time judge can open one URL, choose a controlled commerce or travel target, discover native page primitives, compose a higher-level workflow, register the generated tool through the browser-provided WebMCP API, and invoke it so the live target visibly changes. The browser extension remains an optional adapter for arbitrary external pages.

## Architecture

The hosted app is a dependency-light static application with a small Cloudflare Worker-compatible entrypoint. The Studio page is the top-level WebMCP document. It owns the native Studio tools and generated tools. A same-origin target iframe is the controlled execution surface. Commerce and travel target documents register their own primitive tools through `document.modelContext.registerTool` and send sanitized metadata to the parent only for discovery. The parent invokes a primitive by asking the target document to call the handler it registered; no third-party script injection is required.

The existing `core` types and extension runtime stay intact. The hosted runtime uses the existing JSON Schema conventions and structured workflow concepts, with a small hosted adapter for the target-document boundary. The legacy demo fixtures and extension tests remain available.

## Tool surface and data flow

Studio registers these native tools when `document.modelContext` is available:

- `discover_site_tools`: select a controlled target or inspect an external URL as potential-only; returns descriptors, evidence, confidence, and live/potential status.
- `inspect_tool`: returns one discovered descriptor and its schema/evidence.
- `compose_workflow`: creates a structured ordered workflow draft from selected primitive names; it never evaluates generated JavaScript.
- `generate_tool`: validates the draft, persists it in session storage, and registers the generated tool on the Studio document.
- `list_generated_tools`: returns session-generated tools and registration state.
- `execute_workflow`: executes a generated workflow and returns a structured result plus trace.

The generated demo workflow `buy_best_product` is a deterministic DAG-like ordered definition: search → filter → get details → add to cart. Bindings pass prior outputs to later primitive calls. The execution engine emits a trace for every node, stops on the first understandable failure, and never retries a mutating call after an uncertain result.

## Discovery and UX

The landing view leads with “WebMCP Studio — Turn websites into agent-native interfaces” and a visible Discover → Compose → Generate → Test → Execute strip. The strongest panel is the discovery inspector: every card shows name, description, typed schema, source primitive, DOM/UI evidence, confidence, and a clear Live WebMCP or Potential Tool status. A concise 60-second demo primes the commerce target and selects a useful primitive set without hiding the individual steps.

Unsupported browsers keep the editor and a clearly labeled preview path usable, but never install a fake `modelContext` or claim that preview execution is native. The UI explains the required supported browser capability and exposes the live registration status.

## Security and deployment

Only same-origin controlled demo targets are executable in the hosted path. External URLs are analyzed as potential/discovered information and cannot become live tools without an optional extension adapter. Schemas and tool inputs are validated at the registration and execution boundaries; errors are returned as safe, agent-readable objects. The production response sets `Permissions-Policy: tools=(self)`, secure framing/CSP headers, and no localhost-only assumptions.

The existing extension build remains part of the repository build. A hosted build copies the public Studio and controlled targets into `dist`, emits a Workers-compatible `dist/server/index.js`, and is independently served locally for fresh-session checks. Deployment metadata is kept in `.openai/hosting.json` and the hosted URL is the handoff artifact.

## Verification

Unit tests cover schema/input validation, discovery status, workflow bindings, registration degradation, and trace/error behavior. A no-extension Playwright flow loads the hosted page, checks the native registration adapter when present, discovers commerce primitives, generates `buy_best_product`, invokes it through the same tool handler boundary, and asserts visible cart/target changes. The deployment build is run separately from the existing extension tests. The final report distinguishes native WebMCP evidence from preview-only browser evidence.
