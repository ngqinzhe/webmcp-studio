# WebMCP Studio MVP Implementation Design

## Scope

Implement the approved MVP in `docs/project-brief.md` by extending the existing
semantic DOM and MV3 runtime. Keep the extension prototype's detection,
locators, native-tool compatibility, adapter hooks, and lifecycle behavior. Add
the missing canonical project model, shared authoring commands, workflow
interpreter, Studio editor, discovery/session state, import/export, and
approval-aware activation.

The external ChatGPT client remains the agent and no model provider or hosted
agent loop is added. Native ChatGPT/Chrome compatibility remains a runtime gate;
synthetic WebMCP and Playwright checks provide component evidence only.

## Architecture and data flow

`core/project` is the shared contract. A project contains site scope,
discovered action templates, per-tool workflows, editor metadata, revision, and
test history. Workflows contain owned nodes and control edges. Node settings use
explicit JSON-safe bindings; no JavaScript expressions, loops, parallel paths,
or nested subflows are supported.

`core/workflow` validates projects and interprets the seven approved node types:
HTTP request, DOM action, wait, extract, transform, condition, and return. The
interpreter runs against an injected runtime adapter, so Studio tests and the
installed content runtime share step semantics. It serializes a run, enforces
finite limits, returns bounded sanitized traces, rejects cycles and unresolved
bindings, and never retries an uncertain side effect.

The inspector becomes the Studio surface. Its UI and WebMCP handlers call one
revisioned command store for reads, tool/node edits, discovery results, tests,
undo, import, export, and guide content. Human and agent edits therefore share
the same state. A test and an activation identify an exact project snapshot.

The extension keeps privileged control in the service worker/content runtime.
An approved imported snapshot is validated, matched to the connected tab's
origin/document, and stored separately from draft state. The content runtime
registers workflow tools alongside inferred tools; calls resolve against the
live graph and current document. Activation and consequential runs require an
explicit human approval record. Passwords, tokens, cookies, and raw request
secrets never enter the project or shared traces.

The existing MAIN-world model-context adapter remains the smallest page-side
registration layer. It preserves native tools, supports compatible registration
aliases, and bridges only capability IDs and JSON arguments to the isolated
runtime. Studio's own page uses the same compatibility host for agent-style
verification when a native host is unavailable.

## Failure and authority rules

- Unsupported schema versions, node kinds, cross-tool references, cycles,
  invalid bindings, unsafe URLs, oversized imports, and incomplete runnable
  paths are rejected with field-level errors.
- A lost response after an action is treated as ambiguous and stops the run;
  connection recovery never replays a DOM mutation, HTTP request, or click.
- Sensitive DOM reads are blocked and observations/results are redacted.
- Scope, tab, origin, document generation, session, and approval are checked
  on every privileged command. Revoke, takeover, logout, navigation out of
  scope, or document replacement stops future work.
- Draft edits are visible and undoable. Undo changes the draft only; it does
  not reverse a website effect. Stale expected revisions return a conflict.
- Importing a config validates and previews it; it does not activate or run it.

## Verification

Unit tests cover project round trips, invalid imports, revision conflicts,
branch/binding semantics, all node types, sensitive-read blocking, ambiguous
delivery, activation/registry freshness, and command handlers. Browser tests
cover the existing extension flow plus a Studio page that starts a project,
uses the same WebMCP tool inventory to read/edit/test it, exports/imports a
snapshot, and invokes an injected tool without DOM guessing. The native
ChatGPT route is tested when the connected browser exposes it and otherwise is
recorded as an explicit unsupported-environment result.
