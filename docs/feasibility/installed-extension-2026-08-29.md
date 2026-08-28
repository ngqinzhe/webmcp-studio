# Installed MV3 extension verification — August 29, 2026

**Result: the installed extension can register and execute a native WebMCP tool in the tested Chrome profile. Native agent consumption is still unproven.** Eight page-mediated API attempts produced six successful synthetic submissions, one `invalid_arguments` response, and one rejected call after removal. This advances the installed-runtime component of G3; it does not close G1–G3 or clear the full project for implementation.

The [machine record](installed-extension-2026-08-29.json) retains the actual calls, raw returns/errors, five native inventory snapshots, 24 visible-state observations, and source/package hashes. The recorded run was **00:15–00:21 SGT on August 29** (`2026-08-28T16:15:23.807Z`–`16:21:28.911Z`). Six earlier exploratory calls used an earlier fixture version and are excluded from these totals.

## Setup and evidence boundary

- Baseline runtime: `4eaf27b6c79ded42cb6782b4e57e614d779bf7fb`; tracked runtime sources are unchanged.
- The user confirmed manually loading `dist/extension`. Browser automation rejected the extension-manager URL; the agent did not bypass that restriction or inspect the installed package through the manager. The 60 source and seven package hashes identify files on disk, not bytes attested from Chrome.
- The controlled [fixture](../../spikes/installed-extension/index.html) runs at `http://127.0.0.1:4176/`. Its [page script](../../spikes/installed-extension/site.mjs) neither registers nor mocks tools and imports no extension/runtime bundle. Its [server](../../spikes/installed-extension/serve.mjs) uses an exact route allowlist, loopback binding, a restrictive CSP, `Origin-Agent-Cluster: ?1`, and `Permissions-Policy: tools=(self)`.
- Chrome reported `Chrome/152.0.0.0`, a secure context, an origin-keyed agent cluster, and real `document.modelContext.getTools` / `executeTool` methods. This does not establish compatibility with every document policy or browser version.
- Ordinary visible buttons capture a `RegisteredTool` from `getTools()`, matching its name, origin, and `tool.window === window`, then call `executeTool(capturedTool, JSON.stringify(args))`. This follows the tested Chrome API shape in the [Chrome guide](https://developer.chrome.com/docs/ai/webmcp/imperative-api). No handler was invoked directly and no argument-format retry was used.
- Browser automation clicked those buttons and inspected the rendered evidence. These are **page-mediated calls**, not tools supplied natively to ChatGPT or Codex. The installed registration/callback and MAIN-to-ISOLATED executor bridge are exercised; the service-worker inspector command path is not.

## Observed results

| Check                   | Result                                                                                                                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native inventory        | Each intact fixture document exposed exactly one local `search_products` registration with required string argument `q`. An additional `search_items` registration was also present; only `search_products` was invoked.               |
| Normal execution        | All six successful calls returned `success: true`, changed the expected query/status, and incremented that document's submission counter by exactly one.                                                                               |
| Invalid input           | Empty arguments resolved with `success: false`, `status: invalid_arguments`, and `$input.q is required.` The counter, query, and status were unchanged. This was an application response, not a rejected API promise.                  |
| Current UI state        | After editing A's visible marker, a new call produced a result using the edited marker. The edit used UI automation, not a separate human participant.                                                                                 |
| Two-tab effects         | Calling B left A unchanged; then calling A left B unchanged. Both tabs had the same origin but distinct visible markers and native tool objects. This is not scoped Studio pairing or inspector-routing proof.                         |
| Full navigation         | Navigating B to a fresh fixture document reset its counter; a new inventory capture and call succeeded. A stayed unchanged. This covers static loopback reinjection, not public-domain activation or SPA-only navigation.              |
| DOM removal             | Removing A's form left its counter at three. Calling the previously captured descriptor rejected with `UnknownError` and no visible effect. A subsequent inventory had no `search_products`; `search_items` remained. B was unchanged. |
| DOM restoration         | Restoring the form reintroduced one `search_products`. A fresh capture and call succeeded, moving A's counter from three to four; B remained unchanged.                                                                                |
| Agent-native capability | After successful execution on that same Chrome tab, requesting the agent's `webmcp` capability still returned `Capability is not available: webmcp`.                                                                                   |

The removed-descriptor error text was: **“The operation failed for an unknown transient reason (e.g. out of memory).”** That generic browser error does not diagnose an out-of-memory condition or establish a particular stale-handle exception. Removal is supported separately by the native inventory and lack of visible effects.

Source inspection attributes the extra `search_items` to the diagnostic lifecycle buttons: they contain “search” and are outside the form, so the prototype's broad heuristic classifies them as search actions; duplicate-name suppression leaves one tool. Neither was invoked through WebMCP, and the inventory alone does not identify which supplied the surviving descriptor. The heuristic also labels this action as a read despite its DOM effect. This is an inference-accuracy limitation, not evidence that `search_products` survived removal or a demonstrated security-boundary failure. Production discovery still needs relevance review and human activation; see the [inference rules](../../core/detection/infer.ts).

## Reproduce this component check

Use a Chrome setup with the public native APIs already available. Do not change flags to address an agent connector that lacks native tool support. Review extension permissions and manually load the unpacked build only with the user's authorization.

```bash
npm run build:extension
node spikes/installed-extension/serve.mjs
```

1. Load `dist/extension` and open two tabs: `http://127.0.0.1:4176/?marker=A` and `http://127.0.0.1:4176/?marker=B`.
2. In A, click **Capture native inventory**, set **Invocation query**, then **Invoke captured tool**. Confirm the native return and one submission. Use **Invoke with empty arguments** and confirm no effect.
3. Edit **Tab marker (editable between calls)** in A, call again, and check the new marker in the status.
4. Capture and invoke B, check A is unchanged, then invoke A and check B is unchanged. Read each tab's own counter/status.
5. Navigate B to `http://127.0.0.1:4176/?marker=B-reloaded`. Capture again and invoke; confirm its fresh counter and A's unchanged state.
6. In A, click **Remove search form**, then **Invoke captured tool** before recapturing inventory. Record any rejection and effects without retrying. Capture inventory afterward and verify `search_products` is absent. The fixture clears its captured descriptor when recapturing, so reversing this order would not test the old native object.
7. Click **Restore search form**, capture again, and invoke. Confirm the registration and one new submission; check B is unchanged.
8. Separately probe the agent's supported native tool interface on the same tab. A successful page API call does not substitute for this step.

Dependency versions are captured in the machine record, but the repository still has no committed lockfile. A fresh run is new evidence, not an exact recreation of the historical installation. The fixture does not install an API fallback when native support is missing.

## What remains open

The [pre-build blocker audit](blocker-audit-2026-08-28.md) still applies. This run did not verify:

- Native calls from the chosen user-started ChatGPT session in the same Chrome setup, or the complete G1–G3 path.
- Scoped Studio-to-extension pairing, session/document/origin authorization, revocation, or the canonical config/editor/discovery/export/import flow.
- The inspector's actual enable/disable control, human activation approval, service-worker restart/suspension or routing, SPA-only navigation, in-flight cancellation, public-domain activation/reinjection, denied document policies, or frame cases.
- Authenticated state, real credentials, consequential actions, or a separate human's shared-session edits.
- Judge installation/access, hosting, source/license approval, submission materials, eligibility/rights, or conditional Reddit access.

The retry, sensitive-read, and demo-server defects identified in the audit are **not fixed**. Normal calls producing one submission do not settle ambiguous delivery. DOM removal/restoration is not an activation or approval test. No settled product decision has changed, and no relay, companion service, additional permission, or hosted model was introduced.

This follow-up adds a diagnostic fixture and evidence only. Validation matched all 67 recorded source/package hashes, reconciled eight unique attempts and all seven component checks, and resolved 37 local links across the updated reports/README. Prettier checks and `git diff --check` passed. The previous 94-test baseline is retained as historical verification, not presented as a freshly rerun suite.
