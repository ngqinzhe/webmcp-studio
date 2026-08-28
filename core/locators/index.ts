export {
  collectOpenShadowElements,
  contextMatches,
  describeElement,
  extractAccessibleName,
  getAccessibleName,
  getExplicitLabelText,
  getOpenShadowRoot,
  getRole,
  getSemanticRole,
  isClickableElement,
  isFormControl,
  normalizeAccessibleText,
} from "./accessibility";
export type { LocatorRoot } from "./accessibility";

export {
  findSemanticTarget,
  resolveLocator,
  resolveSemanticLocator,
} from "./resolve";
export type {
  LocatorResolution,
  LocatorResolutionStatus,
  LocatorStrategy,
  ResolveLocatorOptions,
} from "./resolve";

export {
  candidateElements,
  createSemanticLocator,
  cssFallbackSelector,
  findLabelledCandidates,
  locatorKey,
  matchesContext as matchesSemanticContext,
} from "./semantic";
export type { LocatorContextOptions } from "./semantic";
