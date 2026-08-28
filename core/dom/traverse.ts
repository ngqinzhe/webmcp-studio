import type {
  BlockedCapability,
  EntityReference,
  LocatorContext,
  SemanticLocator,
  ShadowHostLocator,
} from "../types";
import { associatedLabelText, getAccessibleName } from "./accessibility";
import { buildSemanticLocator, findSemanticContext } from "./locator";
import type {
  DiscoveredElement,
  DiscoveredForm,
  DiscoverySnapshot,
  TraversalRoot,
  TraversalOptions,
} from "./types";
import {
  controlType,
  documentUrl,
  isActionElement,
  isDisabled,
  isHidden,
  parentElementAcrossRoots,
  readAttribute,
  readableText,
  rootQueryAll,
  safeUrlOrigin,
  semanticRole,
} from "./utils";

interface TraversalState {
  rootDocument: Document;
  elements: DiscoveredElement[];
  forms: DiscoveredForm[];
  formsByElement: Map<Element, DiscoveredForm>;
  blocked: BlockedCapability[];
  blockedElements: Map<string, Element>;
  seenDocuments: Set<Document>;
  documentsScanned: number;
  rootsScanned: number;
  elementsScanned: number;
}

interface DocumentTraversalState {
  nextFrameIndex: number;
}

function isDocumentRoot(root: TraversalRoot): root is Document {
  return root.nodeType === 9;
}

function isShadowRoot(root: TraversalRoot): root is ShadowRoot {
  return root.nodeType === 11;
}

function isElementRoot(root: TraversalRoot): root is Element {
  return root.nodeType === 1;
}

function pathLabel(path: readonly number[]): string {
  return path.length > 0 ? path.join("-") : "root";
}

function isForm(element: Element): boolean {
  return element.localName.toLowerCase() === "form";
}

function nearestForm(element: Element): Element | undefined {
  let current: Element | null = element;
  while (current) {
    if (isForm(current)) return current;
    current = parentElementAcrossRoots(current);
  }
  return undefined;
}

function elementKind(element: Element): DiscoveredElement["kind"] | undefined {
  const control = controlType(element);
  if (control) return control === "input" ? "input" : control;
  if (isActionElement(element)) {
    const tag = element.localName.toLowerCase();
    if (tag === "a" || semanticRole(element) === "link") return "link";
    if (tag === "button" || semanticRole(element) === "button") return "button";
    return "action";
  }
  return undefined;
}

function contextFor(element: Element): {
  context?: LocatorContext;
  entity?: EntityReference;
} {
  const context = findSemanticContext(element);
  if (!context) return {};
  return { context: context.locator, entity: context.entity };
}

function sourceLocator(
  element: Element,
  framePath: readonly number[],
  shadowHosts: readonly Element[],
  relationship?: SemanticLocator["relationship"],
): SemanticLocator {
  return buildSemanticLocator(element, framePath, shadowHosts, relationship);
}

function makeDiscoveredElement(
  element: Element,
  ownerDocument: Document,
  framePath: number[],
  shadowHosts: Element[],
  relationship?: SemanticLocator["relationship"],
): DiscoveredElement | undefined {
  if (isHidden(element)) return undefined;
  const kind = elementKind(element);
  if (!kind) return undefined;

  const accessibleName = getAccessibleName(element);
  const labelText = associatedLabelText(element);
  const context = contextFor(element);
  const form = nearestForm(element);
  const locator = sourceLocator(element, framePath, shadowHosts, relationship);
  const result: DiscoveredElement = {
    element,
    document: ownerDocument,
    framePath: [...framePath],
    shadowPath: locator.shadowPath,
    kind,
    locator,
    disabled: isDisabled(element),
  };
  const role = semanticRole(element);
  const control = controlType(element);
  if (role) result.role = role;
  if (accessibleName) result.accessibleName = accessibleName;
  if (labelText) result.labelText = labelText;
  if (control) result.controlType = control;
  if (form) result.form = form;
  if (context.context) result.context = context.context;
  if (context.entity) result.entity = context.entity;
  return result;
}

function makeForm(
  element: Element,
  ownerDocument: Document,
  framePath: number[],
  shadowHosts: Element[],
): DiscoveredForm {
  const accessibleName = getAccessibleName(element);
  const locator = sourceLocator(element, framePath, shadowHosts);
  const form: DiscoveredForm = {
    element,
    document: ownerDocument,
    framePath: [...framePath],
    shadowPath: locator.shadowPath,
    locator,
    controls: [],
    submitControls: [],
  };
  if (accessibleName) form.accessibleName = accessibleName;
  return form;
}

function iframeName(iframe: Element): string {
  return (
    getAccessibleName(iframe) ??
    readAttribute(iframe, "title") ??
    readAttribute(iframe, "src") ??
    "cross-origin frame"
  );
}

function iframeIsCrossOrigin(
  iframe: Element,
  ownerDocument: Document,
): boolean {
  const source = readAttribute(iframe, "src");
  if (
    !source ||
    source === "about:blank" ||
    source.startsWith("#") ||
    source.startsWith("data:") ||
    source.startsWith("blob:")
  )
    return false;
  try {
    const resolved = new URL(source, documentUrl(ownerDocument));
    const currentOrigin = safeUrlOrigin(ownerDocument);
    return Boolean(
      currentOrigin && resolved.origin && resolved.origin !== currentOrigin,
    );
  } catch {
    return false;
  }
}

function unsupportedControl(element: Element): boolean {
  if (element.localName.toLowerCase() !== "input") return false;
  const type = readAttribute(element, "type")?.toLowerCase() ?? "text";
  return type === "file";
}

function blockedUnsupportedControl(
  element: Element,
  framePath: readonly number[],
): BlockedCapability {
  const name = getAccessibleName(element) ?? "unsupported control";
  return {
    id: `blocked-unsupported-control-${pathLabel(framePath)}-${
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "control"
    }`,
    name,
    reason: "unsupported_control",
    detail:
      "File upload controls are intentionally not inferred because execution requires a user-selected local file.",
    framePath: [...framePath],
  };
}

function blockedFrame(
  iframe: Element,
  framePath: readonly number[],
  detail: string,
): BlockedCapability {
  const path = pathLabel(framePath);
  return {
    id: `blocked-cross-origin-frame-${path}`,
    name: iframeName(iframe),
    reason: "cross_origin_blocked",
    detail,
    framePath: [...framePath],
  };
}

function addBlocked(
  state: TraversalState,
  blocked: BlockedCapability,
  element: Element,
): void {
  state.blocked.push(blocked);
  state.blockedElements.set(blocked.id, element);
}

function addFormControl(
  state: TraversalState,
  discovered: DiscoveredElement,
): void {
  state.elements.push(discovered);
  if (discovered.form) {
    const form = state.formsByElement.get(discovered.form);
    if (form) {
      form.controls.push(discovered);
      if (
        discovered.kind === "button" ||
        discovered.kind === "link" ||
        discovered.kind === "action"
      ) {
        form.submitControls.push(discovered);
      }
    }
  }
}

function walkRoot(
  root: TraversalRoot,
  ownerDocument: Document,
  framePath: number[],
  shadowHosts: Element[],
  state: TraversalState,
  documentState: DocumentTraversalState,
  options: TraversalOptions,
): void {
  state.rootsScanned += 1;
  const roots = isElementRoot(root)
    ? [root, ...rootQueryAll(root, "*")]
    : rootQueryAll(root, "*");
  for (const element of roots) {
    state.elementsScanned += 1;

    if (!isHidden(element) && unsupportedControl(element)) {
      addBlocked(state, blockedUnsupportedControl(element, framePath), element);
    }

    if (isForm(element)) {
      const form = makeForm(element, ownerDocument, framePath, shadowHosts);
      state.forms.push(form);
      state.formsByElement.set(element, form);
    }

    const kind = elementKind(element);
    if (kind) {
      const relationship: SemanticLocator["relationship"] = nearestForm(element)
        ? kind === "button" || kind === "link" || kind === "action"
          ? "form-submit"
          : "form-control"
        : undefined;
      const discovered = makeDiscoveredElement(
        element,
        ownerDocument,
        framePath,
        shadowHosts,
        relationship,
      );
      if (discovered) addFormControl(state, discovered);
    }

    if (options.includeShadowDom) {
      let shadowRoot: ShadowRoot | null = null;
      try {
        shadowRoot = element.shadowRoot;
      } catch {
        shadowRoot = null;
      }
      if (shadowRoot) {
        walkRoot(
          shadowRoot,
          ownerDocument,
          framePath,
          [...shadowHosts, element],
          state,
          documentState,
          options,
        );
      }
    }

    if (options.includeFrames && element.localName.toLowerCase() === "iframe") {
      const frameIndex = documentState.nextFrameIndex;
      documentState.nextFrameIndex += 1;
      const childFramePath = [...framePath, frameIndex];
      const crossOrigin = iframeIsCrossOrigin(element, ownerDocument);
      let childDocument: Document | null = null;
      let accessError: unknown;
      if (!crossOrigin) {
        try {
          childDocument = (element as HTMLIFrameElement).contentDocument;
        } catch (error) {
          accessError = error;
        }
      }

      if (childDocument && !crossOrigin) {
        if (!state.seenDocuments.has(childDocument)) {
          walkDocument(childDocument, childFramePath, state, options);
        }
      } else if (crossOrigin || accessError) {
        const detail = accessError
          ? "The iframe document is inaccessible across a browser security boundary."
          : `The iframe document at ${readAttribute(element, "src") ?? "the embedded origin"} is not same-origin.`;
        addBlocked(
          state,
          blockedFrame(element, childFramePath, detail),
          element,
        );
      }
    }
  }
}

function walkDocument(
  document: Document,
  framePath: number[],
  state: TraversalState,
  options: TraversalOptions,
): void {
  if (state.seenDocuments.has(document)) return;
  state.seenDocuments.add(document);
  state.documentsScanned += 1;
  walkRoot(
    document,
    document,
    framePath,
    [],
    state,
    { nextFrameIndex: 0 },
    options,
  );
}

function newTraversalState(document: Document): TraversalState {
  return {
    rootDocument: document,
    elements: [],
    forms: [],
    formsByElement: new Map(),
    blocked: [],
    blockedElements: new Map(),
    seenDocuments: new Set(),
    documentsScanned: 0,
    rootsScanned: 0,
    elementsScanned: 0,
  };
}

function snapshotFromState(state: TraversalState): DiscoverySnapshot {
  return {
    rootDocument: state.rootDocument,
    elements: state.elements,
    forms: state.forms,
    blocked: state.blocked,
    blockedElements: state.blockedElements,
    documentsScanned: state.documentsScanned,
    rootsScanned: state.rootsScanned,
    elementsScanned: state.elementsScanned,
  };
}

function containsNode(container: Node, candidate: Node): boolean {
  if (container === candidate) return true;
  try {
    return container.contains(candidate);
  } catch {
    return false;
  }
}

function rootContains(
  existing: TraversalRoot,
  candidate: TraversalRoot,
): boolean {
  if (existing === candidate) return true;
  if (isDocumentRoot(existing)) {
    return (
      (isElementRoot(candidate) || isShadowRoot(candidate)) &&
      (candidate.ownerDocument === existing ||
        containsNode(existing, candidate))
    );
  }
  return containsNode(existing, candidate);
}

function mergeRoots(roots: TraversalRoot[]): TraversalRoot[] {
  const result: TraversalRoot[] = [];
  for (const root of roots) {
    if (result.some((existing) => rootContains(existing, root))) continue;
    for (let index = result.length - 1; index >= 0; index -= 1) {
      const existing = result[index];
      if (existing && rootContains(root, existing)) result.splice(index, 1);
    }
    result.push(root);
  }
  return result;
}

function shadowHostsFor(node: Node): Element[] {
  const hosts: Element[] = [];
  let current: Node = node;
  while (true) {
    let root: Node;
    try {
      root = current.getRootNode();
    } catch {
      break;
    }
    if (root.nodeType !== 11) break;
    const host = (root as ShadowRoot).host;
    if (!host) break;
    hosts.unshift(host);
    current = host;
  }
  return hosts;
}

function openElementsInRoot(root: Document | DocumentFragment): Element[] {
  const result: Element[] = [];
  const visit = (currentRoot: Document | DocumentFragment): void => {
    for (const element of rootQueryAll(currentRoot, "*")) {
      result.push(element);
      let shadowRoot: ShadowRoot | null = null;
      try {
        shadowRoot = element.shadowRoot;
      } catch {
        shadowRoot = null;
      }
      if (shadowRoot) visit(shadowRoot);
    }
  };
  visit(root);
  return result;
}

function frameIndexInDocument(document: Document, frame: Element): number {
  return openElementsInRoot(document)
    .filter((element) => {
      const tag = element.localName.toLowerCase();
      return tag === "iframe" || tag === "frame";
    })
    .indexOf(frame);
}

function framePathForDocument(
  rootDocument: Document,
  document: Document,
): number[] {
  const path: number[] = [];
  let current = document;
  const seen = new Set<Document>();
  while (current !== rootDocument && !seen.has(current)) {
    seen.add(current);
    let frame: Element | null = null;
    try {
      frame = current.defaultView?.frameElement ?? null;
    } catch {
      frame = null;
    }
    if (!frame || !frame.ownerDocument) return [];
    const index = frameIndexInDocument(frame.ownerDocument, frame);
    if (index < 0) return [];
    path.unshift(index);
    current = frame.ownerDocument;
  }
  return current === rootDocument ? path : [];
}

function frameIndexOffset(document: Document, root: TraversalRoot): number {
  if (isDocumentRoot(root)) return 0;
  const rootNode = isShadowRoot(root) ? root.host : root;
  const frames = openElementsInRoot(document).filter((element) => {
    const tag = element.localName.toLowerCase();
    return tag === "iframe" || tag === "frame";
  });
  return frames.filter((frame) => {
    if (frame === rootNode) return false;
    try {
      return Boolean(
        rootNode.compareDocumentPosition(frame) &
        2 /* Node.DOCUMENT_POSITION_PRECEDING */,
      );
    } catch {
      return false;
    }
  }).length;
}

function traversalRootFor(
  rootDocument: Document,
  root: TraversalRoot,
): {
  root: TraversalRoot;
  ownerDocument: Document;
  framePath: number[];
  shadowHosts: Element[];
} {
  const ownerDocument = isDocumentRoot(root)
    ? root
    : (root.ownerDocument ?? rootDocument);
  const framePath = framePathForDocument(rootDocument, ownerDocument);
  return {
    root,
    ownerDocument,
    framePath,
    shadowHosts: shadowHostsFor(root),
  };
}

export function discoverDocument(
  document: Document,
  options: Partial<TraversalOptions> = {},
): DiscoverySnapshot {
  const traversalOptions: TraversalOptions = {
    includeFrames: options.includeFrames ?? true,
    includeShadowDom: options.includeShadowDom ?? true,
  };
  const state = newTraversalState(document);
  walkDocument(document, [], state, traversalOptions);
  return snapshotFromState(state);
}

/** Discover only selected DOM subtrees while retaining frame and shadow context. */
export function discoverDocumentSubtrees(
  document: Document,
  roots: readonly TraversalRoot[],
  options: Partial<TraversalOptions> = {},
): DiscoverySnapshot {
  const traversalOptions: TraversalOptions = {
    includeFrames: options.includeFrames ?? true,
    includeShadowDom: options.includeShadowDom ?? true,
  };
  const state = newTraversalState(document);
  for (const root of mergeRoots([...roots])) {
    if (root === document) {
      walkDocument(document, [], state, traversalOptions);
      continue;
    }
    const context = traversalRootFor(document, root);
    walkRoot(
      context.root,
      context.ownerDocument,
      context.framePath,
      context.shadowHosts,
      state,
      { nextFrameIndex: frameIndexOffset(context.ownerDocument, context.root) },
      traversalOptions,
    );
  }
  return snapshotFromState(state);
}

export const traverseDocument = discoverDocument;
