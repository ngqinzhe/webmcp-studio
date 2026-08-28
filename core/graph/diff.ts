import type { GraphDiff } from "../types";
import { diffGraphs } from "./capability-graph";

export { diffGraphs };

export function hasGraphChanges(diff: GraphDiff): boolean {
  return (
    diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0
  );
}
