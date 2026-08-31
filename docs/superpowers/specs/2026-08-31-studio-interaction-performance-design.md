# Studio Interaction Performance Design

## Scope

Make the discovery-first Studio surface responsive while preserving the
existing ordered-flow data and the current arrow-button fallback. This covers
the tool-name field and reordering discoveries that are already in the flow.

## Interaction design

- Tool-name `input` events update only the Save & inject button's eligibility.
  They do not rebuild discovery cards or flow rows.
- Flow rows become natively draggable. A single delegated listener set on the
  flow container handles `dragstart`, `dragover`, `dragleave`, `drop`, and
  `dragend`.
- During a drag, `dragover` updates only a lightweight insertion marker,
  scheduled at most once per animation frame. The backing order is unchanged
  until a valid drop.
- A valid drop moves the dragged discovery ID once, then rerenders only the
  flow composer. Cancelled or invalid drags remove the marker and preserve the
  existing order.
- Existing ↑/↓/remove controls remain available and use the same flow-only
  render path.

## State and boundaries

The canonical order remains `droppedDiscoveryIds`; no project revision is
created while composing this unsaved flow. The name value remains in the DOM,
and Save & inject reads it when submitted. Discovery availability and the
activation contract are unchanged.

## Verification

Regression coverage will verify that name input does not replace existing
discovery/flow DOM nodes, that a drag/drop sequence reorders rows correctly,
that cancelled drags do not mutate order, and that arrow controls still
reorder the same state. Existing Studio E2E composition and activation tests
must continue to pass.
