import {
  attribute,
  getAccessibleName,
  getContextEntity,
  getRole,
  getStableAttributes,
  isProbablyVisible,
  visibleText,
} from "../dom/accessibility";
import type {
  LocatorFallback,
  SemanticLocator,
  StableAttribute,
} from "../types";

function escapeCss(value: string): string {
  const css = (globalThis as { CSS?: { escape?: (value: string) => string } })
    .CSS;
  if (css?.escape) return css.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
}

function stableSelector(stable: StableAttribute): string {
  return `[${stable.name}="${escapeCss(stable.value)}"]`;
}

export function cssFallbackSelector(element: Element): string {
  const stable = getStableAttributes(element)[0];
  if (stable) return stableSelector(stable);
  const parts: string[] = [];
  let current: Element | null = element;
  while (
    current &&
    current.tagName.toLowerCase() !== "html" &&
    parts.length < 5
  ) {
    let part = current.tagName.toLowerCase();
    const id = attribute(current, "id");
    if (id && !/^\d+$/.test(id)) {
      part += `#${escapeCss(id)}`;
      parts.unshift(part);
      break;
    }
    const parent: Element | null = current.parentElement;
    if (parent) {
      const siblings: Element[] = Array.from(parent.children).filter(
        (child: Element) => child.tagName === current?.tagName,
      );
      if (siblings.length > 1)
        part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    current = parent;
  }
  return parts.join(" > ");
}

export interface LocatorContextOptions {
  framePath?: number[];
  shadowPath?: SemanticLocator["shadowPath"];
  relationship?: SemanticLocator["relationship"];
}

export function createSemanticLocator(
  element: Element,
  options: LocatorContextOptions = {},
): SemanticLocator {
  const role = getRole(element);
  const accessibleName = getAccessibleName(element) || undefined;
  const labelText = element.matches("input,textarea,select")
    ? accessibleName
    : undefined;
  const contextEntity = getContextEntity(element);
  const stableAttributes = getStableAttributes(element);
  const fallbacks: LocatorFallback[] = [];
  if (role && accessibleName) {
    fallbacks.push({
      kind: "role",
      description: `role ${role} named ${accessibleName}`,
      role,
      accessibleName,
    });
  }
  if (labelText) {
    fallbacks.push({
      kind: "label",
      description: `associated label ${labelText}`,
      labelText,
    });
  }
  for (const stableAttribute of stableAttributes.slice(0, 3)) {
    fallbacks.push({
      kind: "stable-attribute",
      description: `${stableAttribute.name}=${stableAttribute.value}`,
      stableAttribute,
    });
  }
  if (options.relationship) {
    fallbacks.push({
      kind: "relationship",
      description: options.relationship,
      relation: options.relationship,
    });
  }
  const selector = cssFallbackSelector(element);
  if (selector)
    fallbacks.push({ kind: "css", description: selector, selector });
  const locator: SemanticLocator = {
    framePath: options.framePath ?? [],
    shadowPath: options.shadowPath ?? [],
    stableAttributes,
    fallbacks,
  };
  if (role) locator.role = role;
  if (accessibleName) locator.accessibleName = accessibleName;
  if (labelText) locator.labelText = labelText;
  if (contextEntity) locator.context = contextEntity;
  if (options.relationship) locator.relationship = options.relationship;
  return locator;
}

export function locatorKey(locator: SemanticLocator): string {
  return JSON.stringify({
    framePath: locator.framePath,
    shadowPath: locator.shadowPath.map((host) => ({
      stable: host.stableAttribute,
      selector: host.selector,
      index: host.index,
    })),
    role: locator.role,
    accessibleName: locator.accessibleName,
    labelText: locator.labelText,
    context: locator.context,
    stableAttributes: locator.stableAttributes,
    relationship: locator.relationship,
    fallbacks: locator.fallbacks,
  });
}

export function matchesContext(
  element: Element,
  locator: SemanticLocator,
): boolean {
  const context = locator.context;
  if (!context) return true;
  let current: Element | null = element.parentElement;
  while (current) {
    const roleMatches =
      !context.role ||
      getRole(current) === context.role ||
      current.tagName.toLowerCase() === context.role;
    const stableMatches =
      !context.stableAttribute ||
      attribute(current, context.stableAttribute.name) ===
        context.stableAttribute.value;
    const textMatches =
      !context.text ||
      visibleText(current, 300)
        .toLowerCase()
        .includes(context.text.toLowerCase());
    if (roleMatches && stableMatches && textMatches) return true;
    current = current.parentElement;
  }
  return false;
}

export function findLabelledCandidates(
  root: Document | ShadowRoot,
  labelText: string,
): Element[] {
  const normalized = labelText.trim().toLowerCase();
  return Array.from(root.querySelectorAll("input,textarea,select")).filter(
    (element) => {
      const name = (getAccessibleName(element) ?? "").toLowerCase();
      return (
        name === normalized ||
        name.includes(normalized) ||
        normalized.includes(name)
      );
    },
  );
}

export function candidateElements(root: Document | ShadowRoot): Element[] {
  return Array.from(root.querySelectorAll("*"))
    .filter(isProbablyVisible)
    .filter(
      (element) =>
        getRole(element) !== undefined ||
        element.matches("input,textarea,select,button,a"),
    );
}
