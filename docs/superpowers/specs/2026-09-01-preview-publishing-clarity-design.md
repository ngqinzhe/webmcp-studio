# Hosted preview and publishing clarity design

**Date:** 2026-09-01  
**Status:** Approved for implementation

## Goal

Make the hosted builder self-explanatory when a user creates a tool from an
external site's inferred capabilities. The form must invite the user to name
the tool, the preview must visibly prove that execution occurred, and the two
publication boundaries must remain distinct.

## Experience

- The custom tool name and description fields start empty. Placeholders show
  examples without creating a hidden default tool definition.
- **Run preview** is available without the extension for inferred workflows.
  It executes against Studio's interactive sanitized snapshot and reports the
  generated tool name, completed steps, and visible state change both in the
  Studio publication card and in the preview surface.
- **Inject into live page** remains the external-site path supplied by the
  optional extension adapter. It is not replaced by the preview action and is
  never represented as a hosted cross-origin injection.
- Controlled same-origin targets retain direct page injection and page-level
  WebMCP testing without an extension.

## Runtime and security boundary

Preview status is derived from the structured workflow result, not from a
visual-only highlight. The snapshot may highlight the affected evidence, but
the parent Studio also records the successful run so the confirmation remains
visible if the snapshot markup does not provide its own status element.

The hosted page does not bypass same-origin, CSP, or frame policy. External
live injection is only exposed when the extension adapter owns the target tab;
unsupported browsers retain a clear recovery message and the no-extension
preview path.

## Verification

Regression coverage will assert empty initial form values, successful preview
status and visible snapshot feedback, and distinct controlled/external
publication labels. Existing native registration, inferred workflow, build,
and extension adapter tests must continue to pass.
