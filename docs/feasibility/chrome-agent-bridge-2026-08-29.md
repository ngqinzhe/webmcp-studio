# Chrome agent bridge investigation — August 29, 2026

**Assessment: the current Codex Chrome provider does not expose native WebMCP consumption. The installed extension's registration is not the failing boundary.** A fresh provider-level comparison shows that Chrome advertises only `pageAssets`, while the in-app-browser provider advertises `pageAssets` and `webmcp`. The Chrome failure therefore occurs before the agent can request native inventory or inspect one of our tool definitions. This identifies the immediate cause without establishing why the provider omits the capability or whether another supported consumer does.

This is a prerequisite for the agreed project, not a minor implementation detail. **Do not assume the full ChatGPT → same local Chrome profile → installed extension workflow is feasible yet.** No settled decision has changed. Three sub-agents independently reviewed OpenAI product support, our registration path, and Chrome/standards integration; the primary agent ran the fresh browser comparison below.

## Controlled comparison

The [machine record](chrome-agent-bridge-2026-08-29.json) captures the fresh run at **00:36–00:37 SGT on August 29**, with UTC timestamps, rendered evidence, errors, source hashes and confounds. It reused the working Chrome connection and existing fixtures without changing settings, permissions, profiles, or runtime code.

| Evidence                                             | Native page state                                                                                                                                                       | Agent result                                                                                                                                       |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh page-provided control, port 4174               | The owned Studio fixture reported three tools registered through the browser API; no native handler event was recorded.                                                 | `Capability is not available: webmcp`                                                                                                              |
| Fresh extension-provided control, port 4176          | The explicit public `getTools()` button captured exactly one local `search_products`, with the correct origin/window and required `q`. `search_items` was also present. | Same capability error; no native agent call was possible.                                                                                          |
| Earlier Chrome run, before project-extension loading | Three ordinary page-provided registrations in Chrome 152; only `pageAssets` advertised to the agent.                                                                    | The same capability error already existed. [Record](chrome-relaunch-2026-08-28.json)                                                               |
| Earlier installed-extension execution                | Six public page-API calls succeeded through the actual installed registration/executor boundary.                                                                        | The capability still failed afterward on the same tab. [Record](installed-extension-2026-08-29.json)                                               |
| Earlier separate built-in-browser run                | The repository's runtime exposed tools that the agent discovered and invoked natively.                                                                                  | Positive component control in a different browser implementation; not the installed Chrome path. [Record](native-runtime-reviewed-2026-08-28.json) |

After that recorded comparison, the user pasted output showing Chrome connected, only `pageAssets` exposed, and the same `webmcp` error. The user later clarified that this output **did not come from ChatGPT Work**. It repeats the current provider symptom and is not an independent Work comparison.

A fresh connection using Browser integration package `26.825.32147` made the provider differential explicit. On the same app host, the Chrome provider advertised one tab capability, `pageAssets`; the in-app-browser provider advertised `pageAssets` and `webmcp`. The port-4174 page still visibly reported three browser-API registrations, while its Chrome tab capability list contained only `pageAssets` and requesting `webmcp` failed. The [provider-capability record](chrome-provider-capabilities-2026-08-29.json) preserves this result.

Ordinary Chrome navigation and DOM inspection succeeded in the fresh comparison. This is not a completely disconnected extension/native-host transport. The only explicitly requested page-side diagnostic operation was one inventory capture; no page-mediated tool execution or native agent call occurred, and B's submission count stayed zero. Registration and runtime inventory activity also occurred automatically.

**Confounds:** both current loopback fixtures receive extension injection. The first is a page-provided-tool control, not an extension-free environment. Ports/origins, schemas, and headers also differ. A differential result would need a tighter control. The historical pre-installation result is what shows the error predates our injection.

## What this rules against

- **Registration in the wrong world or document:** the [manifest](../../extension/manifest.json) places registration in MAIN and execution in ISOLATED; Chrome returned the local descriptor and successfully executed it. The agent capability failed for ordinary tools even before installation.
- **Malformed schema, callback, or duplicate `search_products`:** Chrome accepted and executed the descriptor, and the inventory contains one matching local tool. The separate `search_items` inference defect does not explain the pre-installation failure.
- **A probe made too early:** the prior capability request failed after a completed native page-API execution. The fresh comparison again waited for visible registration evidence.
- **A generally incompatible repository runtime:** the same runtime sources previously supported native agent calls in the built-in browser fixture. That fixture's different world arrangement and consumer remain explicit limits.

No reviewed executable repository source emits `Capability is not available: webmcp`, and no concrete repository correction has been identified for it. These results justify investigating the connector rather than changing tool names, schemas, or registration timing speculatively. They do not diagnose the connector's internal implementation or exclude connector caching/gating.

## What OpenAI currently documents

| Setup                                                                | Supported claim and limitation                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop ChatGPT Work or Codex → built-in browser                     | Native Site tools are explicitly supported with Sol/Terra, subject to rollout, current app version, workspace restrictions and the page's tools. Luna and Enterprise/Edu are excluded in the current documentation. [Site tools](https://learn.chatgpt.com/docs/webmcp)                       |
| Desktop ChatGPT Work or Codex → Chrome through the browser extension | Existing-profile tab context and browser control are supported. The reviewed extension guide does not establish native WebMCP consumption on this route; absence of that claim is not an explicit universal prohibition. [Browser extension](https://learn.chatgpt.com/docs/chrome-extension) |
| August 25 browser release                                            | The release describes external-browser support separately from native Site tools in the built-in browser. It does not extend the native-tool claim to external Chrome. [Release notes](https://learn.chatgpt.com/docs/changelog#codex-2026-08-25-browser)                                     |
| ChatGPT Work cloud browser                                           | A separate browser environment, not the selected local Chrome profile with our extension. It is not a substitute for this test. [Browser](https://learn.chatgpt.com/docs/browser)                                                                                                             |

The documented **Enable site tools** setting applies to the built-in browser. It is not a documented external-Chrome enable switch. Prior native success in this task is evidence that native consumption worked in that other environment at the time; it does not prove current global settings or a working Chrome route.

Official extension troubleshooting permits a new chat to clear chat-specific **connection state**, checking the active profile, and reviewing **Computer Use → Manage**. A fresh user-started Work session is therefore a reasonable bounded comparison, but no documentation establishes it as a fix for missing native WebMCP. Repeated reinstalls, relaunches, flag changes, or broader permissions have no identified cause to address here. [Troubleshooting](https://learn.chatgpt.com/docs/chrome-extension#troubleshooting)

## Can a compatible consumer do this?

**There is a documented engineering path, but that does not establish support in the chosen ChatGPT connector.** The WebMCP draft distinguishes page-to-page API use from browser-agent integration and leaves the agent-facing transport implementation-defined. A connector must expose registered definitions to the agent, dispatch authorized calls to the correct tab/document, return actual results, and track lifecycle changes. Our extension registering a tool does not implement that consumer integration. [WebMCP draft](https://webmachinelearning.github.io/webmcp/)

Chrome's experimental public CDP `WebMCP` domain documents discovery through `enable` / `toolsAdded`, invocation through `invokeTool`, results through `toolResponded`, and removal/cancellation events or commands. This is evidence that a consumer can be engineered, not that the current OpenAI connector implements it or that our Chrome 152 build exposes the exact tip-of-tree version. That protocol explicitly lacks backward-compatibility guarantees. **No direct CDP call or alternate transport was used in this investigation.** [WebMCP protocol](https://chromedevtools.github.io/devtools-protocol/tot/WebMCP/), [Version caveat](https://chromedevtools.github.io/devtools-protocol/)

There is real API-version drift to account for: the tested Chrome page API accepts JSON-string arguments and returns a string-valued schema, while the current draft describes object arguments/schemas. An older consumer may also expect the prior `navigator.modelContext` location. These are plausible compatibility checks for the connector maintainer, **not diagnosed causes** of our capability error. We have no evidence of which API its implementation uses. [Chrome API](https://developer.chrome.com/docs/ai/webmcp/imperative-api), [Draft](https://webmachinelearning.github.io/webmcp/), [Puppeteer migration issue](https://github.com/puppeteer/puppeteer/issues/15063)

An inspector or another agent consumer could provide additional component evidence. It would not fulfill the settled ChatGPT requirement, and building a custom connector/relay would be a design change requiring review.

## What is and is not impossible

For the **current Codex Chrome provider**, native WebMCP is unavailable by construction: the provider does not advertise that optional tab capability. Page registration, schema changes, extension reloads, and argument formatting cannot make an unadvertised agent capability appear. Ordinary browser control still works because it uses a different interface.

WebMCP itself is not impossible. Three independent facts remain positive:

- Chrome's page API inventories and executes the installed extension's native tools.
- The in-app-browser provider advertises `webmcp`, and earlier native agent calls there succeeded.
- Chrome documents an experimental WebMCP consumer integration surface, so another provider can be engineered.

The settled end-to-end architecture remains unproved because the in-app browser cannot be assumed to host the third-party MV3 extension, while the current external-Chrome provider lacks the agent capability. A provider update could make the direct route viable. A custom connector, relay, different consumer, or page-hosted replacement could also bridge the gap, but each would be an explicit design change rather than a fix to tool registration.

The independent ChatGPT Work comparison has **not** been run. The exact producing mode of the user-pasted output was not captured beyond the clarification that it was not Work. That result must not be used to claim Work support or failure.

## Platform confirmation needed

The extension guide recommends `/feedback` with the chat ID for unresolved connection problems. The following is a draft only; no feedback or support message has been sent.

> Does desktop ChatGPT Work or Codex support native discovery and invocation of top-level WebMCP tools registered by a third-party MV3 extension in the Chrome profile selected through `@Chrome`? If yes, which desktop/extension versions, rollout eligibility and settings enable it? Does `Capability is not available: webmcp` identify an unsupported route or a disabled feature? Ordinary Chrome control works, native page registration/execution succeeds, and the same capability error occurs with page-provided tools before our extension is loaded.

We have isolated the failing boundary, not repaired the platform connection. The [blocker audit](blocker-audit-2026-08-28.md), missing scoped transport, canonical workflow and safety findings remain open. Any different consumer, relay or companion would require a separate explicit design decision. Safe synthetic foundation work can continue, but the full build schedule must not depend on the currently failing native Chrome route.

Artifact validation passed for the original comparison: both captured capability errors and zero executions reconciled, and all 13 recorded source/evidence hashes matched. The provider follow-up separately validates the advertised capability IDs, corrected provenance, machine records, and local links. Prettier and `git diff --check` passed; tracked runtime/build sources still match the baseline. No new full-suite run or runtime fix is claimed.
