import { findSemanticContext } from "../dom/locator";
import type { TraversalRoot } from "../dom/types";
import { parentElementAcrossRoots, readAttribute } from "../dom/utils";

function isElement(node: Node | null): node is Element {
  return node?.nodeType === 1;
}

function elementForNode(node: Node, document: Document): Element | null {
  if (isElement(node)) return node;
  if (node.nodeType === 3 || node.nodeType === 4) {
    return isElement(node.parentElement) ? node.parentElement : null;
  }
  if (node.nodeType === 11) return null;
  return document.documentElement;
}

function nearestForm(element: Element): Element | undefined {
  let current: Element | null = element;
  while (current) {
    if (current.localName.toLowerCase() === "form") return current;
    current = parentElementAcrossRoots(current);
  }
  return undefined;
}

/** Promote a changed node to the smallest semantic scope that owns a tool. */
export function mutationScopeForNode(
  node: Node,
  document: Document,
): TraversalRoot | null {
  if (node.nodeType === 9) return document;
  if (node.nodeType === 11) return node as DocumentFragment;

  const element = elementForNode(node, document);
  if (!element) return null;

  const form = nearestForm(element);
  if (form) return form;

  const context = findSemanticContext(element);
  if (context) return context.element;

  return element;
}

function hasElementChild(node: Node): boolean {
  return Array.from(node.childNodes).some((child) => child.nodeType === 1);
}

function targetIsReusableSemanticScope(target: Node): boolean {
  if (!isElement(target)) return false;
  if (target.localName.toLowerCase() === "form") return true;
  if (findSemanticContext(target) !== undefined) return true;

  const role = readAttribute(target, "role")?.toLowerCase();
  if (
    ["article", "listitem", "region", "group", "dialog"].includes(role ?? "")
  ) {
    return true;
  }
  if (["article", "li"].includes(target.localName.toLowerCase())) return true;

  const identifiers = [
    readAttribute(target, "class"),
    readAttribute(target, "data-testid"),
    readAttribute(target, "data-test-id"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return (
    /(?:product|item|card|result|listing|tile|row)/.test(identifiers) &&
    !/(?:actions?|controls?|buttons?)/.test(identifiers)
  );
}

/**
 * Select bounded roots for a mutation batch. Added subtrees are preferred over
 * their often-broad parent target; removals are represented by the mutation's
 * removedNodes and only rescan a semantic parent when its contract changed.
 */
export function mutationScanRoots(
  document: Document,
  mutations: readonly MutationRecord[],
  fallbackSubtrees: readonly Node[] = [],
): TraversalRoot[] {
  const roots: TraversalRoot[] = [];

  for (const mutation of mutations) {
    if (mutation.type === "childList") {
      for (const added of Array.from(mutation.addedNodes)) {
        const root = mutationScopeForNode(added, document);
        if (root) roots.push(root);
      }

      if (
        mutation.addedNodes.length === 0 &&
        (targetIsReusableSemanticScope(mutation.target) ||
          !hasElementChild(mutation.target))
      ) {
        const root = mutationScopeForNode(mutation.target, document);
        if (root) roots.push(root);
      }
      continue;
    }

    const root = mutationScopeForNode(mutation.target, document);
    if (root) roots.push(root);
  }

  if (roots.length > 0 || mutations.length > 0) return roots;
  return fallbackSubtrees.flatMap((node) => {
    const root = mutationScopeForNode(node, document);
    return root ? [root] : [];
  });
}

function containsNode(container: Node, candidate: Node): boolean {
  if (container === candidate) return true;
  try {
    return container.contains(candidate);
  } catch {
    return false;
  }
}

/** Test whether an indexed capability belongs to a mutation's rescanned scope. */
export function nodeAffectedByMutation(
  element: Element,
  mutations: readonly MutationRecord[],
  scanRoots: readonly TraversalRoot[],
): boolean {
  if (scanRoots.some((root) => containsNode(root, element))) return true;

  return mutations.some((mutation) => {
    if (
      mutation.type === "childList" &&
      Array.from(mutation.removedNodes).some((removed) =>
        containsNode(removed, element),
      )
    ) {
      return true;
    }

    return (
      mutation.type !== "childList" &&
      (mutation.target === element || containsNode(element, mutation.target))
    );
  });
}
