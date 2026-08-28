import type {
  LocatorFallback,
  LocatorContext,
  SemanticLocator,
  ShadowHostLocator,
  StableAttribute,
} from "../types";
import {
  collectOpenShadowElements,
  contextMatches,
  describeElement,
  getAccessibleName,
  getOpenShadowRoot,
  getSemanticRole,
  hostLocatorMatches,
  isFormControl,
  normalizeAccessibleText,
  type LocatorRoot,
} from "./accessibility";

export type LocatorResolutionStatus =
  | "matched"
  | "not_found"
  | "ambiguous"
  | "cross_origin_blocked"
  | "shadow_root_unavailable";

export type LocatorStrategy =
  | "role-name"
  | "context"
  | "label"
  | "stable-attribute"
  | "relationship"
  | "css";

export interface LocatorResolution {
  status: LocatorResolutionStatus;
  candidates: Element[];
  framePath: number[];
  shadowPath: ShadowHostLocator[];
  strategy?: LocatorStrategy;
  element?: Element;
  reason?: string;
}

export interface ResolveLocatorOptions {
  /** Search open nested roots when the locator has no explicit shadowPath. */
  includeOpenShadowDom?: boolean;
}

interface CandidateAttempt {
  candidates: Element[];
  strategy: LocatorStrategy;
}

function uniqueElements(elements: Element[]): Element[] {
  return Array.from(new Set(elements));
}

function exactNameMatches(
  root: LocatorRoot,
  element: Element,
  accessibleName: string | undefined,
): boolean {
  if (accessibleName === undefined) return true;
  return (
    getAccessibleName(root, element) === normalizeAccessibleText(accessibleName)
  );
}

function exactRoleMatches(element: Element, role: string | undefined): boolean {
  return role === undefined || getSemanticRole(element) === role;
}

function matchesRoleAndName(
  root: LocatorRoot,
  element: Element,
  role: string | undefined,
  accessibleName: string | undefined,
): boolean {
  return (
    exactRoleMatches(element, role) &&
    exactNameMatches(root, element, accessibleName)
  );
}

function matchesContext(
  element: Element,
  context: LocatorContext | undefined,
): boolean {
  return context ? contextMatches(element, context) : true;
}

function associatedLabelMatches(
  root: LocatorRoot,
  element: Element,
  labelText: string | undefined,
): boolean {
  if (labelText === undefined || !isFormControl(element)) return false;
  return (
    getAccessibleName(root, element) === normalizeAccessibleText(labelText)
  );
}

function matchesStableAttribute(
  element: Element,
  stableAttribute: StableAttribute | undefined,
): boolean {
  return (
    stableAttribute !== undefined &&
    element.getAttribute(stableAttribute.name) === stableAttribute.value
  );
}

function nearestContext(
  element: Element,
  context: LocatorContext | undefined,
): Element | null {
  if (!context) return null;
  let current: Node | null = element;
  while (current) {
    if (current.nodeType === 1) {
      const candidate = current as Element;
      if (contextMatches(candidate, context)) return candidate;
    }
    if (current.parentNode) {
      current = current.parentNode;
      continue;
    }
    if (current.nodeType === 11) {
      current = (current as ShadowRoot).host ?? null;
      continue;
    }
    current = null;
  }
  return null;
}

function isRelationshipMatch(
  root: LocatorRoot,
  element: Element,
  locator: SemanticLocator,
  relation: LocatorFallback["relation"] | SemanticLocator["relationship"],
): boolean {
  if (!relation) return false;

  switch (relation) {
    case "labelled-control":
      return associatedLabelMatches(root, element, locator.labelText);
    case "form-control": {
      if (!isFormControl(element)) return false;
      const formContext = locator.context;
      if (!formContext) return true;
      const form = nearestContext(element, formContext);
      return form !== null;
    }
    case "form-submit": {
      const tagName = element.localName.toLowerCase();
      const type = (element.getAttribute("type") ?? "").toLowerCase();
      const isSubmit =
        (tagName === "button" && (type === "" || type === "submit")) ||
        (tagName === "input" && (type === "submit" || type === "image"));
      if (!isSubmit) return false;
      if (!locator.context) return true;
      return nearestContext(element, locator.context) !== null;
    }
    case "context-action":
      return (
        nearestContext(element, locator.context) !== null &&
        (getSemanticRole(element) === "button" ||
          getSemanticRole(element) === "link")
      );
    default:
      return false;
  }
}

function fallbackCandidates(
  root: LocatorRoot,
  allElements: Element[],
  locator: SemanticLocator,
  fallback: LocatorFallback,
): Element[] {
  const scopeToContext = (candidates: Element[]): Element[] =>
    locator.context
      ? candidates.filter((element) => matchesContext(element, locator.context))
      : candidates;

  switch (fallback.kind) {
    case "role":
      return scopeToContext(
        allElements.filter((element) =>
          matchesRoleAndName(
            root,
            element,
            fallback.role,
            fallback.accessibleName,
          ),
        ),
      );
    case "label":
      return scopeToContext(
        allElements.filter((element) =>
          associatedLabelMatches(root, element, fallback.labelText),
        ),
      );
    case "stable-attribute":
      return scopeToContext(
        allElements.filter((element) =>
          matchesStableAttribute(element, fallback.stableAttribute),
        ),
      );
    case "relationship":
      return scopeToContext(
        allElements.filter((element) =>
          isRelationshipMatch(root, element, locator, fallback.relation),
        ),
      );
    case "css":
      if (!fallback.selector) return [];
      try {
        return scopeToContext(
          Array.from(root.querySelectorAll(fallback.selector)) as Element[],
        );
      } catch {
        // A stale or invalid CSS fallback must not take down scanning.
        return [];
      }
  }
}

function attemptUnique(attempts: CandidateAttempt[]): {
  match?: CandidateAttempt;
  ambiguous?: CandidateAttempt;
} {
  let ambiguous: CandidateAttempt | undefined;
  for (const attempt of attempts) {
    const candidates = uniqueElements(attempt.candidates);
    if (candidates.length === 1) {
      return { match: { ...attempt, candidates } };
    }
    if (candidates.length > 1 && !ambiguous) {
      ambiguous = { ...attempt, candidates };
    }
  }
  return ambiguous ? { ambiguous } : {};
}

function resolveWithinRoot(
  root: LocatorRoot,
  locator: SemanticLocator,
  options: ResolveLocatorOptions,
): LocatorResolution {
  const allElements =
    options.includeOpenShadowDom === false
      ? root.nodeType === 1
        ? [
            root as Element,
            ...(Array.from(root.querySelectorAll("*")) as Element[]),
          ]
        : (Array.from(root.querySelectorAll("*")) as Element[])
      : collectOpenShadowElements(root);

  const attempts: CandidateAttempt[] = [];

  if (locator.role !== undefined || locator.accessibleName !== undefined) {
    const roleNameCandidates = allElements.filter((element) =>
      matchesRoleAndName(root, element, locator.role, locator.accessibleName),
    );
    const contextualCandidates = locator.context
      ? roleNameCandidates.filter((element) =>
          matchesContext(element, locator.context),
        )
      : roleNameCandidates;
    attempts.push({ candidates: contextualCandidates, strategy: "role-name" });
  }

  if (locator.context) {
    const contextCandidates = allElements.filter((element) => {
      if (!matchesContext(element, locator.context)) return false;
      if (locator.role && getSemanticRole(element) !== locator.role)
        return false;
      return exactNameMatches(root, element, locator.accessibleName);
    });
    attempts.push({ candidates: contextCandidates, strategy: "context" });
  }

  if (locator.labelText !== undefined) {
    attempts.push({
      candidates: allElements
        .filter((element) =>
          associatedLabelMatches(root, element, locator.labelText),
        )
        .filter((element) => matchesContext(element, locator.context)),
      strategy: "label",
    });
  }

  for (const stableAttribute of locator.stableAttributes) {
    attempts.push({
      candidates: allElements
        .filter((element) => matchesStableAttribute(element, stableAttribute))
        .filter((element) => matchesContext(element, locator.context)),
      strategy: "stable-attribute",
    });
  }

  if (locator.relationship) {
    attempts.push({
      candidates: allElements.filter((element) =>
        isRelationshipMatch(root, element, locator, locator.relationship),
      ),
      strategy: "relationship",
    });
  }

  // Respect the required strategy ordering even when fallbacks were emitted
  // by a scanner in a different order.
  const fallbackKinds: LocatorFallback["kind"][] = [
    "role",
    "label",
    "stable-attribute",
    "relationship",
    "css",
  ];
  for (const kind of fallbackKinds) {
    for (const fallback of locator.fallbacks) {
      if (fallback.kind !== kind) continue;
      attempts.push({
        candidates: fallbackCandidates(root, allElements, locator, fallback),
        strategy:
          kind === "role"
            ? "role-name"
            : kind === "label"
              ? "label"
              : kind === "stable-attribute"
                ? "stable-attribute"
                : kind === "relationship"
                  ? "relationship"
                  : "css",
      });
    }
  }

  const { match, ambiguous } = attemptUnique(attempts);
  if (match) {
    const element = match.candidates[0];
    if (!element) {
      return {
        status: "not_found",
        candidates: [],
        framePath: locator.framePath,
        shadowPath: locator.shadowPath,
      };
    }
    return {
      status: "matched",
      candidates: match.candidates,
      element,
      strategy: match.strategy,
      framePath: locator.framePath,
      shadowPath: locator.shadowPath,
    };
  }

  if (ambiguous) {
    return {
      status: "ambiguous",
      candidates: ambiguous.candidates,
      strategy: ambiguous.strategy,
      framePath: locator.framePath,
      shadowPath: locator.shadowPath,
      reason: `Multiple elements matched ${ambiguous.strategy}.`,
    };
  }

  return {
    status: "not_found",
    candidates: [],
    framePath: locator.framePath,
    shadowPath: locator.shadowPath,
    reason: "No semantic or fallback locator matched an element.",
  };
}

function frameElements(root: LocatorRoot): Element[] {
  const elements = collectOpenShadowElements(root);
  return elements.filter((element) => {
    const tagName = element.localName.toLowerCase();
    return tagName === "iframe" || tagName === "frame";
  });
}

function getFrameDocument(frame: Element): Document | null {
  try {
    const contentDocument = (frame as HTMLIFrameElement).contentDocument;
    if (contentDocument) return contentDocument;
    const contentWindow = (frame as HTMLIFrameElement).contentWindow;
    return contentWindow?.document ?? null;
  } catch {
    return null;
  }
}

function isCrossOriginFrame(frame: Element): boolean {
  try {
    const source = frame.getAttribute("src");
    if (!source || source === "about:blank" || source === "srcdoc")
      return false;
    const owner = frame.ownerDocument;
    const baseUrl = owner?.defaultView?.location?.href ?? owner?.URL ?? "";
    const target = new URL(source, baseUrl || undefined);
    const base = new URL(baseUrl || target.href);
    return target.origin !== base.origin;
  } catch {
    return false;
  }
}

function descendFrames(
  root: LocatorRoot,
  framePath: number[],
): {
  document?: Document;
  status: "matched" | "not_found" | "cross_origin_blocked";
  reason?: string;
} {
  let currentRoot = root;
  let currentDocument =
    root.nodeType === 9 ? (root as Document) : root.ownerDocument;
  if (!currentDocument) {
    return {
      status: "not_found",
      reason: "The locator root has no owner document.",
    };
  }

  for (const frameIndex of framePath) {
    const frames = frameElements(currentRoot);
    const frame = frames[frameIndex];
    if (!frame) {
      return {
        status: "not_found",
        reason: `Frame index ${frameIndex} does not exist.`,
      };
    }

    if (isCrossOriginFrame(frame)) {
      return {
        status: "cross_origin_blocked",
        reason: `Frame index ${frameIndex} is cross-origin and cannot be inspected.`,
      };
    }

    const childDocument = getFrameDocument(frame);
    if (!childDocument) {
      return {
        status: "cross_origin_blocked",
        reason: `Frame index ${frameIndex} is not accessible from the current page.`,
      };
    }
    currentDocument = childDocument;
    currentRoot = childDocument;
  }

  return { status: "matched", document: currentDocument };
}

function resolveShadowPath(
  root: LocatorRoot,
  shadowPath: ShadowHostLocator[],
):
  | { status: "matched"; root: LocatorRoot }
  | { status: "not_found"; reason: string }
  | { status: "ambiguous"; candidates: Element[]; reason: string }
  | { status: "shadow_root_unavailable"; reason: string } {
  let currentRoot = root;
  for (const [pathIndex, hostLocator] of shadowPath.entries()) {
    const semanticCandidates = collectOpenShadowElements(currentRoot).filter(
      (element) => hostLocatorMatches(currentRoot, element, hostLocator),
    );
    let candidates = semanticCandidates;

    if (candidates.length === 0 && hostLocator.selector) {
      try {
        candidates = Array.from(
          currentRoot.querySelectorAll(hostLocator.selector),
        ) as Element[];
      } catch {
        // Keep semantic host candidates if a stale CSS fallback is invalid.
      }
    }

    const index = hostLocator.index;
    // A scanner may record the host's position in the complete element list,
    // not in the list of semantically matching hosts. Use that index only as
    // a disambiguator; a uniquely identified host wins regardless of its
    // global element position.
    if (index !== undefined && candidates.length > 1) {
      const indexed = candidates[index];
      candidates = indexed ? [indexed] : [];
    }

    if (candidates.length === 0) {
      return {
        status: "not_found",
        reason: `Shadow host at path index ${pathIndex} was not found.`,
      };
    }
    if (candidates.length > 1) {
      return {
        status: "ambiguous",
        candidates,
        reason: `Shadow host at path index ${pathIndex} is ambiguous.`,
      };
    }

    const host = candidates[0];
    if (!host) {
      return {
        status: "not_found",
        reason: `Shadow host at path index ${pathIndex} was not found.`,
      };
    }
    const shadowRoot = getOpenShadowRoot(host);
    if (!shadowRoot) {
      return {
        status: "shadow_root_unavailable",
        reason: `Shadow host ${describeElement(host)} has no accessible open shadow root.`,
      };
    }
    currentRoot = shadowRoot;
  }

  return {
    status: "matched",
    root: currentRoot,
  };
}

function pathFailure(
  status: LocatorResolutionStatus,
  framePath: number[],
  shadowPath: ShadowHostLocator[],
  candidates: Element[],
  reason: string | undefined,
): LocatorResolution {
  const result: LocatorResolution = {
    status,
    candidates,
    framePath,
    shadowPath,
  };
  if (reason) result.reason = reason;
  return result;
}

function resolveFrameThenShadow(
  root: LocatorRoot,
  locator: SemanticLocator,
  options: ResolveLocatorOptions,
): LocatorResolution {
  const framePath = locator.framePath ?? [];
  const shadowPath = locator.shadowPath ?? [];
  const frameResult = descendFrames(root, framePath);
  if (frameResult.status !== "matched" || !frameResult.document) {
    return pathFailure(
      frameResult.status === "cross_origin_blocked"
        ? "cross_origin_blocked"
        : "not_found",
      framePath,
      shadowPath,
      [],
      frameResult.reason,
    );
  }

  const shadowResult = resolveShadowPath(frameResult.document, shadowPath);
  if (shadowResult.status !== "matched") {
    return pathFailure(
      shadowResult.status,
      framePath,
      shadowPath,
      "candidates" in shadowResult ? shadowResult.candidates : [],
      shadowResult.reason,
    );
  }

  return resolveWithinRoot(
    shadowResult.root,
    { ...locator, framePath, shadowPath },
    options,
  );
}

function resolveShadowThenFrame(
  root: LocatorRoot,
  locator: SemanticLocator,
  options: ResolveLocatorOptions,
): LocatorResolution {
  const framePath = locator.framePath ?? [];
  const shadowPath = locator.shadowPath ?? [];
  const shadowResult = resolveShadowPath(root, shadowPath);
  if (shadowResult.status !== "matched") {
    return pathFailure(
      shadowResult.status,
      framePath,
      shadowPath,
      "candidates" in shadowResult ? shadowResult.candidates : [],
      shadowResult.reason,
    );
  }

  const frameResult = descendFrames(shadowResult.root, framePath);
  if (frameResult.status !== "matched" || !frameResult.document) {
    return pathFailure(
      frameResult.status === "cross_origin_blocked"
        ? "cross_origin_blocked"
        : "not_found",
      framePath,
      shadowPath,
      [],
      frameResult.reason,
    );
  }

  const resolved = resolveWithinRoot(
    frameResult.document,
    { ...locator, framePath, shadowPath: [] },
    options,
  );
  return { ...resolved, framePath, shadowPath };
}

/**
 * Resolve a SemanticLocator against a live document.
 *
 * Frame indices are evaluated in document order at each frame boundary.
 * `shadowPath` then walks open shadow hosts from the resulting document.
 */
export function resolveSemanticLocator(
  root: LocatorRoot,
  locator: SemanticLocator,
  options?: ResolveLocatorOptions,
): LocatorResolution;
export function resolveSemanticLocator(
  locator: SemanticLocator,
  root: LocatorRoot,
  options?: ResolveLocatorOptions,
): LocatorResolution;
export function resolveSemanticLocator(
  rootOrLocator: LocatorRoot | SemanticLocator,
  locatorOrRoot: SemanticLocator | LocatorRoot,
  options: ResolveLocatorOptions = {},
): LocatorResolution {
  const firstIsLocator = (
    value: LocatorRoot | SemanticLocator,
  ): value is SemanticLocator =>
    typeof value === "object" &&
    value !== null &&
    "framePath" in value &&
    "shadowPath" in value;
  const locator = firstIsLocator(rootOrLocator)
    ? rootOrLocator
    : (locatorOrRoot as SemanticLocator);
  const root = firstIsLocator(rootOrLocator)
    ? (locatorOrRoot as LocatorRoot)
    : rootOrLocator;
  const framePath = locator.framePath ?? [];
  const shadowPath = locator.shadowPath ?? [];
  const normalizedLocator: SemanticLocator = {
    ...locator,
    framePath,
    shadowPath,
    stableAttributes: locator.stableAttributes ?? [],
    fallbacks: locator.fallbacks ?? [],
  };
  const primary = resolveFrameThenShadow(root, normalizedLocator, options);
  if (
    framePath.length === 0 ||
    shadowPath.length === 0 ||
    primary.status === "matched"
  ) {
    return primary;
  }

  // Traversal records frame and shadow ancestry as two independent paths.
  // A frame may itself live inside an open shadow root, so try that legal
  // topology as a bounded alternate without weakening origin checks.
  const alternate = resolveShadowThenFrame(root, normalizedLocator, options);
  if (alternate.status === "matched") return alternate;
  if (primary.status === "cross_origin_blocked") return primary;
  if (alternate.status === "cross_origin_blocked") return alternate;
  if (primary.status === "ambiguous") return primary;
  return alternate;
}

export const resolveLocator = resolveSemanticLocator;

export function findSemanticTarget(
  root: LocatorRoot,
  locator: SemanticLocator,
  options: ResolveLocatorOptions = {},
): Element | null {
  const resolution = resolveSemanticLocator(root, locator, options);
  return resolution.status === "matched" ? (resolution.element ?? null) : null;
}

export { describeElement };
