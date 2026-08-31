# Hosted WebMCP Studio deployment

The hosted Studio is the primary hackathon product. A deployment should give a
judge one public HTTPS URL that loads the Studio, its same-origin controlled
targets, and the browser-native WebMCP registrations. The optional extension
is an adapter for advanced external-site work, not a deployment prerequisite.

## Release checklist

Before publishing a URL, confirm that a clean browser session can:

1. Open the HTTPS Studio URL without an account, API key, extension, or local
   configuration.
2. Click **Try the 60-second demo** and discover the controlled commerce
   primitives.
3. Compose and generate `buy_best_product` from the discovered actions.
4. See **WebMCP live** when the supported WebMCP host is connected, then ask
   ChatGPT to invoke the generated tool.
5. See the execution trace and the target page change, including the cart count
   becoming `1`.

Use **Preview only** as a useful fallback for unsupported browsers, but do not
count a preview handler or a direct page-local test as proof that ChatGPT
discovered and invoked a native WebMCP tool.

## Build and local serve

Use the repository's normal build from the project root:

```bash
npm install
npm run build
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
```

The primary build intentionally leaves out the optional extension. Run
`npm run build:all` when you also need the separate extension bundle for
advanced external-site instrumentation; run `npm run build` again before
packaging the hosted deployment.

For a local UI walkthrough, serve that directory as static files:

```bash
python3 -m http.server 4177 --directory dist
```

Then open `http://127.0.0.1:4177/`. This simple server does not add the
production security headers and is not a substitute for the public HTTPS
judge check. `npm run demo` serves the older extension fixtures on port 4173;
it is intentionally separate from the hosted shell.

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

`dist/server/index.js` is a small module Worker entrypoint. It delegates static
requests to the provider's asset binding:

```js
export default {
  async fetch(request, env) {
    return env.ASSETS.fetch(request);
  },
};
```

Configure the hosting provider's static-assets binding with the exact name
`ASSETS` and route requests to this Worker. Sites supplies that binding; a
Cloudflare-style deployment must provide the equivalent binding. The browser
application has no server API route, database, or inference service in the
core demo.

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

The production Worker currently emits these response policies:

```text
Content-Security-Policy: default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self'
Permissions-Policy: tools=(self)
Origin-Agent-Cluster: ?1
Referrer-Policy: strict-origin-when-cross-origin
X-Content-Type-Options: nosniff
X-Frame-Options: SAMEORIGIN
```

`connect-src 'self'` and the absence of an application API keep the primary
flow self-contained. Do not add `Access-Control-Allow-Origin: *` as a shortcut
for external-site discovery. If a future API is introduced, allowlist exact
origins and methods, validate request origins and input on the server, and
keep credentials out of cross-origin browser calls.

## WebMCP support and Permissions Policy

The Studio and controlled target pages use the browser-provided
`document.modelContext.registerTool` API (with the supported browser's
equivalent exposure where available). The application does not install a fake
`modelContext` when the API is absent. Native registrations are attempted on
the top-level Studio and target documents; generated tools are registered for
the current page/session and are not a durable public registry.

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
**Preview only · WebMCP unavailable**. Preview discovery and the controlled
parent bridge can demonstrate the workflow UI, but they do not manufacture an
agent capability or claim native invocation. Reloading in a supported
browser/profile after fixing the origin or policy is the recovery path.

## External URL discovery and the optional adapter

An external URL entered in hosted Studio is a **Discovered/Potential Tool**
source only. The hosted page does not inject JavaScript, persist WebMCP
registrations, read a third-party DOM, or turn that origin into an executable
tool. Browser same-origin and CORS rules make that boundary explicit. The UI
must keep potential metadata visually distinct from a **Live/Executable
WebMCP Tool**.

For advanced external-site instrumentation, build and load the optional
extension from `dist/extension`, grant the browser's requested tab/site access,
and use the explicit Studio activation flow. The extension can provide
page-scoped discovery and execution where the browser grants access, subject
to the target's authentication, CSP, frame, and permission boundaries. It is
not bundled into the hosted URL and must never be required for the controlled
commerce/travel demo.

## Troubleshooting a deployed URL

- **Preview only:** check the HTTPS certificate, the response's
  `Permissions-Policy`, the browser/profile's WebMCP support, and whether the
  Studio is the top-level page. A normal browser tab without an agent host may
  still show preview mode.
- **Target not discovered:** confirm `/targets/commerce.html` or
  `/targets/travel.html` is served from the same origin, that the target script
  loaded, and that no proxy stripped the target's script or frame headers.
- **Target calls fail:** inspect the visible execution trace. The runtime
  validates typed input and stops at the first primitive error; fix the input
  or reload the clean session rather than retrying an uncertain mutating call.
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
