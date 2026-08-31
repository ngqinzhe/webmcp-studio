# Hosted WebMCP Studio deployment

The hosted Studio is the primary hackathon product. A deployment should give a
judge one public HTTPS URL that loads the Studio, its same-origin controlled
targets, and the browser-native WebMCP registrations. The optional extension
is an adapter for advanced external-site work, not a deployment prerequisite.

## Release checklist

Before publishing a URL, confirm that a clean browser session can:

1. Open the HTTPS Studio URL without an account, API key, extension, or local
   configuration.
2. Enter `/targets/commerce.html` (or the public controlled URL) in **Target
   website or domain** and click **Analyze**.
3. See discovered cards labelled **Native** in green. If potential interface
   suggestions are shown, they must be labelled **Inferred** in yellow and kept
   out of the executable workflow.
4. Drag `search_products`, `filter_products`, `get_product`, and `add_to_cart`
   into the right-hand workflow canvas, name it `buy_best_product`, and click
   **Save tool**.
5. Click **Inject into page**. In a supported WebMCP host, confirm that the
   target page's `document.modelContext` now contains `buy_best_product`.
6. Click **Test WebMCP** and confirm the target page changes, including the
   cart count becoming `1`.

When native WebMCP is unavailable, the final action must be labelled **Run
preview**. A preview validates the controlled workflow and visible page effect,
but it is not evidence that ChatGPT discovered or invoked a native tool.

The intended judge path is:

`Target website → Analyze → Native primitives → drag workflow → Save tool → Inject into page → Test WebMCP`

Use **Preview only** as a useful fallback for unsupported browsers, but do not
count a preview handler or a direct page-local test as proof that ChatGPT
discovered and invoked a native WebMCP tool.

## Build and local serve

Use the repository's normal build from the project root:

```bash
npm install
npm run build
npm run serve:hosted
```

`npm run build` type-checks the project and builds the hosted site. The hosted
portion emits a static `dist/` tree similar to:

```text
dist/index.html
dist/styles.css
dist/assets/studio.js
dist/assets/commerce.js
dist/assets/travel.js
dist/targets/commerce.html
dist/targets/travel.html
dist/server/index.js
dist/server/external-discovery.mjs
```

The primary build intentionally leaves out the optional extension. Run
`npm run build:all` when you also need the separate extension bundle for
advanced external-site instrumentation; run `npm run build` again before
packaging the hosted deployment.

For a local walkthrough, run `npm run serve:hosted` and open
`http://127.0.0.1:4177/`. This server includes the same-origin
`/api/analyze-external` route and mirrors the production security headers.
`npm run demo` serves the older extension fixtures on port 4173; it is
intentionally separate from the hosted shell.

Hosted UI verification:

```bash
npm run build
npm test -- tests/unit/target-runtime-injection.test.ts
npx playwright test tests/e2e/hosted-studio-flow.spec.ts
```

The hosted E2E creates a clean browser context with no extension. Its synthetic
native host exercises the browser registration boundary and is not proof of a
ChatGPT connection. Repeat the final flow in the supported ChatGPT/WebMCP
browser before claiming native agent invocation.

## Sites deployment contract

The Sites deployment must publish the exact successful `dist/` output and the
Workers-compatible entrypoint. The repository's `.openai/hosting.json` is
deployment metadata, not application configuration. For a new Site, the
publishing workflow persists the returned `project_id`; optional logical D1 or
R2 bindings may be recorded there only when the application actually uses
them. Do not put credentials, tokens, or user data in that file.

The Sites package contains `dist/` and stages the metadata as
`dist/.openai/hosting.json`. Validate these required archive entries before
saving a Site version:

```text
dist/server/index.js
dist/server/external-discovery.mjs
dist/index.html
dist/assets/studio.js
dist/targets/commerce.html
dist/targets/travel.html
dist/.openai/hosting.json
```

Save the version against the validated commit, deploy it with public access,
and wait for the deployment status to be successful before handing the URL to
a judge. An owner-only Site is not a valid hackathon handoff. The public URL
must serve the same origin for `/`, `/assets/*`, and `/targets/*`.

## Cloudflare-style output contract

`dist/server/index.js` is a small module Worker entrypoint. The build embeds
the allowlisted Studio HTML, CSS, JavaScript, and controlled target pages so a
static-assets binding is not required for the core demo. It also uses an
`ASSETS` binding when the provider supplies one, which lets a host add its
normal static asset pipeline without changing the application:

```js
const embedded = embeddedAssetResponse(request);
if (embedded) return embedded;
if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
  return withSecurityHeaders(await env.ASSETS.fetch(request));
}
return withSecurityHeaders(new Response("Not Found", { status: 404 }));
```

Route the public HTTPS hostname to this Worker and keep `/`, `/assets/*`,
`/targets/*`, and `/api/analyze-external` on that same origin. The core demo
has no database, inference service, API key, or required runtime secret; the
single inspection route fetches and analyzes bounded public HTML on demand.

## Environment variables

The hosted demo requires no environment variables, API keys, login, or
third-party service. `ASSETS` is a provider runtime binding, not a browser
environment variable and not a secret to put in `.env`.

If a future deployment adds a server integration, configure its values as
provider-managed runtime variables/secrets. Keep secrets out of
`hosted/`, `dist/`, `.openai/hosting.json`, client bundles, and commit history.
Only deliberately public, non-sensitive settings may be exposed to browser
code. A missing optional integration should produce a visible error state; it
must not silently change the controlled demo path.

## Origins, frames, CORS, and security

The executable demo uses two controlled target documents at paths on the same
deployed origin:

- `/targets/commerce.html` — Northstar Supply commerce primitives such as
  `search_products`, `filter_products`, `get_product`, `add_to_cart`, and
  `view_cart`.
- `/targets/travel.html` — Skyline Travel search, filtering, details,
  selection, and itinerary primitives.

The Studio embeds these documents in same-origin iframes. It discovers their
typed descriptors and invokes them through a versioned `postMessage` bridge
that checks both `event.source` and the expected origin. Same-origin framing is
an intentional security boundary; it is not a reason to enable permissive
cross-origin access.

Generated page tools use the same checked bridge. **Inject into page** sends a
JSON-safe generated descriptor and structured workflow identity to the selected
controlled target. The target registers that descriptor with its own
`document.modelContext`; the handler resolves the existing workflow runtime and
primitive bridge. **Test WebMCP** invokes that page registration with the
deterministic input, so the visible state change comes from the same
page-facing handler an agent would use. Registration is session-scoped and is
invalidated when the target changes or the page is reloaded.

Injection is not arbitrary JavaScript injection. It is available only for the
controlled same-origin targets. The hosted Studio never publishes a generated
registration into an external origin.

The production Worker currently emits these response policies:

```text
Content-Security-Policy: default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self' https:
Permissions-Policy: tools=(self)
Origin-Agent-Cluster: ?1
Referrer-Policy: strict-origin-when-cross-origin
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
```

`connect-src 'self'` keeps the browser call to the inspection route same-origin.
The route does not need CORS, and it must not add
`Access-Control-Allow-Origin: *`. It accepts only a JSON URL, omits request
credentials, validates public web hosts and every redirect, enforces bounded
HTML size and timeouts, and returns sanitized evidence. Production HTTPS
Studio requires external inspection URLs to use HTTPS; same-origin controlled
target paths remain available for the deterministic demo.

## WebMCP support and Permissions Policy

The Studio and controlled target pages use the browser-provided
`modelContext.registerTool` API, accepting the compatible `provideTool` spelling
where a supported host exposes it. The application does not install a fake
`modelContext` when the API is absent. Native registrations are attempted on
the top-level Studio and target documents. Studio's native tools remain
available on the Studio page; an injected generated tool is registered on the
selected controlled target page for the current session and is not a durable
public registry. The registration payload keeps the native WebMCP shape
(`name`, `description`, `inputSchema`, `annotations`, `execute`) and does not
send Studio-only evidence metadata across the browser boundary.

Native behavior depends on all of these conditions:

- a WebMCP-capable browser and ChatGPT/browser profile, with the feature
  enabled by that host;
- a public HTTPS secure context (or a browser-recognized secure local origin
  during development);
- an origin-keyed document/agent cluster accepted by the browser;
- `Permissions-Policy: tools=(self)` reaching the Studio and controlled target
  documents; and
- the agent connection actually seeing the page's registered tools.

The `tools` policy is deliberately same-origin. If targets are moved to a
different origin, the policy and frame delegation must be redesigned and
tested; the current hosted path does not claim cross-origin iframe execution.
An extension permission or a permissive CORS header cannot override a denied
WebMCP policy or browser same-origin restriction.

Browser support is host- and version-dependent. The extension's Chrome MV3
baseline is separate from native WebMCP support; Chrome 120+ for the
extension alone does not establish that ChatGPT can consume WebMCP. Validate
the deployed URL in the exact supported ChatGPT/browser environment used for
judging. Useful references are the [WebMCP specification](https://webmachinelearning.github.io/webmcp/),
[Chrome WebMCP guidance](https://developer.chrome.com/docs/ai/webmcp), and
[ChatGPT WebMCP guidance](https://learn.chatgpt.com/docs/webmcp).

When registration is unavailable or rejected, the UI must remain explicit:
**Preview only · WebMCP unavailable** and **Run preview**. Preview discovery
and the controlled parent bridge can demonstrate the workflow UI, but they do
not manufacture an agent capability or claim native invocation. Reloading in a
supported browser/profile after fixing the origin or policy is the recovery
path. A failed injection leaves the generated workflow editable so it can be
retried after the target or browser state is fixed.

## External URL discovery and the optional adapter

An external URL entered in hosted Studio is a **Discovered/Potential Tool**
source only. Its proposals are **Inferred**, shown in yellow, and never
eligible for the live workflow canvas. The hosted page does not inject
JavaScript, persist WebMCP registrations, read a third-party DOM, or turn that
origin into an executable tool. Browser same-origin and CORS rules make that
boundary explicit. The UI must keep inferred/potential metadata visually
distinct from a **Native** **Live/Executable WebMCP Tool**.

For advanced external-site instrumentation, build and load the optional
extension from `dist/extension`, grant the browser's requested tab/site access,
and use the explicit Studio activation flow. The extension can provide
page-scoped discovery and execution where the browser grants access, subject
to the target's authentication, CSP, frame, and permission boundaries. It is
not bundled into the hosted URL and must never be required for the controlled
commerce/travel demo.

### External inspection contract

The hosted path makes external analysis evidence-based through a same-origin
request:

```text
POST /api/analyze-external
Content-Type: application/json

{"url":"https://example.com/catalog"}
```

The Worker follows a small number of redirects only when each destination
passes the same public-host validation. It fetches HTML without caller
credentials, limits the response size and fetch time, reads page title, forms,
buttons, and potential `modelContext` declarations, and returns sanitized
selectors, schemas, and confidence. A URL word such as `booking` or `shop`
cannot create a tool by itself. A fetched `modelContext` declaration is still
shown as **Inferred** because a server fetch cannot verify the live browser
registration on a third-party origin.

External pages are loaded into the live target preview only when the target's
own framing policy and the browser permit it. `frame-src 'self' https:` allows
HTTPS frames from the Studio, but `X-Frame-Options` and
`Content-Security-Policy: frame-ancestors` on the target can still block the
preview. In that case Studio shows a clear fallback link to open the page in a
new tab. The parent page never reads the external DOM, sends the WebMCP bridge
to it, injects JavaScript, or executes inferred tools. Use the optional
extension adapter only when external-site instrumentation is explicitly
appropriate.

## Troubleshooting a deployed URL

- **Preview only:** check the HTTPS certificate, the response's
  `Permissions-Policy`, the browser/profile's WebMCP support, and whether the
  Studio is the top-level page. A normal browser tab without an agent host may
  still show preview mode.
- **Target not discovered:** confirm `/targets/commerce.html` or
  `/targets/travel.html` is served from the same origin, that the target script
  loaded, and that no proxy stripped the target's script or frame headers.
- **Target calls fail:** read the status message under the workflow controls.
  The runtime validates typed input and stops at the first primitive error; fix
  the input or reload the clean session rather than retrying an uncertain
  mutating call.
- **Inject into page is unavailable:** confirm that the selected target is one
  of the same-origin controlled paths and that a generated workflow exists.
  External URLs are intentionally potential-only; unsupported native hosts use
  **Run preview**.
- **External URL is potential-only:** this is expected for the hosted path;
  use the optional extension adapter only when explicit site access is
  appropriate.

For a quick header check, replace the placeholder with the deployed host:

```bash
curl -sSI https://<studio-domain>/
```

The result should include HTTPS, `Permissions-Policy: tools=(self)`, the CSP
above, and the standard security headers. The final acceptance test remains a
fresh no-extension judge session against the public URL.
