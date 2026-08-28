import type {
  EntityReference,
  LocatorContext,
  LocatorFallback,
  SemanticLocator,
  ShadowHostLocator,
  StableAttribute,
} from "../types";
import { associatedLabelText, getAccessibleName } from "./accessibility";
import {
  isHidden,
  parentElementAcrossRoots,
  readableText,
  readAttribute,
  semanticRole,
  stableAttributes,
} from "./utils";

export interface SemanticContext {
  element: Element;
  locator: LocatorContext;
  entity: EntityReference;
}

function contextRole(element: Element): string | undefined {
  const explicit = readAttribute(element, "role")
    ?.split(/\s+/, 1)[0]
    ?.toLowerCase();
  if (
    explicit &&
    ["article", "listitem", "region", "group", "dialog"].includes(explicit)
  )
    return explicit;
  const tag = element.localName.toLowerCase();
  if (tag === "article") return "article";
  if (tag === "li") return "listitem";
  return undefined;
}

function looksLikeEntityContainer(element: Element): boolean {
  const tag = element.localName.toLowerCase();
  if (["article", "li"].includes(tag)) return true;

  const role = contextRole(element);
  if (role && ["article", "listitem", "region", "group"].includes(role))
    return true;

  const stable = stableAttributes(element);
  if (
    stable.some(({ name }) =>
      ["data-product-id", "data-sku", "data-item-id"].includes(name),
    )
  )
    return true;

  const identifyingText = [
    readAttribute(element, "class"),
    readAttribute(element, "data-testid"),
    readAttribute(element, "data-test-id"),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  // Action wrappers such as `.product-actions` inherit the product keyword
  // from their parent but are not semantic entities themselves. Prefer the
  // enclosing card so duplicate actions can be resolved contextually.
  if (/(?:actions?|controls?|buttons?)/.test(identifyingText)) return false;
  return /(?:product|item|card|result|listing|tile|row)/.test(identifyingText);
}

function contextText(element: Element): string | undefined {
  for (const child of Array.from(
    element.querySelectorAll(
      "h1,h2,h3,h4,h5,h6,[data-product-name],[data-item-name]",
    ),
  )) {
    if (isHidden(child)) continue;
    const text = readableText(child, 160);
    if (text) return text;
  }
  return readableText(element, 180) || undefined;
}

export function findSemanticContext(
  element: Element,
): SemanticContext | undefined {
  let current = parentElementAcrossRoots(element);
  let depth = 0;
  while (current && depth < 12) {
    if (looksLikeEntityContainer(current)) {
      const role = contextRole(current);
      const stableAttribute = stableAttributes(current).find(({ name }) =>
        [
          "data-testid",
          "data-test-id",
          "data-product-id",
          "data-sku",
          "data-item-id",
          "id",
        ].includes(name),
      );
      const text = contextText(current);
      const locator: LocatorContext = {};
      if (role) locator.role = role;
      if (text) locator.text = text;
      if (stableAttribute) locator.stableAttribute = stableAttribute;
      if (Object.keys(locator).length === 0) return undefined;

      const entity: EntityReference = {};
      if (role) entity.role = role;
      if (text) entity.text = text;
      if (stableAttribute) entity.stableAttribute = stableAttribute;
      return { element: current, locator, entity };
    }
    current = parentElementAcrossRoots(current);
    depth += 1;
  }
  return undefined;
}

function cssIdent(value: string): string {
  return value.replace(
    /(^-?\d)|[^a-zA-Z0-9_-]/g,
    (character, leadingDigit: string | undefined) => {
      if (leadingDigit) return `\\${character.codePointAt(0)?.toString(16)} `;
      return `\\${character}`;
    },
  );
}

function cssString(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\n\r]/g, " ");
}

export function cssFallbacks(element: Element): string[] {
  const selectors: string[] = [];
  for (const attribute of stableAttributes(element)) {
    if (attribute.name === "id")
      selectors.push(`#${cssIdent(attribute.value)}`);
    else selectors.push(`[${attribute.name}="${cssString(attribute.value)}"]`);
  }

  const tag = element.localName.toLowerCase();
  const parent = element.parentElement;
  if (parent) {
    const siblings = Array.from(parent.children).filter(
      (candidate) => candidate.localName.toLowerCase() === tag,
    );
    if (siblings.length > 1) {
      const index = siblings.indexOf(element);
      if (index >= 0) selectors.push(`${tag}:nth-of-type(${index + 1})`);
    } else {
      selectors.push(tag);
    }
  } else {
    selectors.push(tag);
  }

  return Array.from(new Set(selectors));
}

export function buildCssFallback(element: Element): string | undefined {
  return cssFallbacks(element)[0];
}

function hostLocator(host: Element): ShadowHostLocator {
  const locator: ShadowHostLocator = {};
  const role = semanticRole(host);
  const accessibleName = getAccessibleName(host);
  const stableAttribute = stableAttributes(host)[0];
  const selector = buildCssFallback(host);
  if (role) locator.role = role;
  if (accessibleName) locator.accessibleName = accessibleName;
  if (stableAttribute) locator.stableAttribute = stableAttribute;
  if (selector) locator.selector = selector;
  return locator;
}

export function buildShadowPath(
  hosts: readonly Element[],
): ShadowHostLocator[] {
  return hosts.map(hostLocator);
}

function pushFallback(
  fallbacks: LocatorFallback[],
  fallback: LocatorFallback,
): void {
  const fingerprint = JSON.stringify(fallback);
  if (!fallbacks.some((candidate) => JSON.stringify(candidate) === fingerprint))
    fallbacks.push(fallback);
}

export function buildSemanticLocator(
  element: Element,
  framePath: readonly number[] = [],
  shadowHosts: readonly Element[] = [],
  relationship?: SemanticLocator["relationship"],
): SemanticLocator {
  const role = semanticRole(element);
  const accessibleName = getAccessibleName(element);
  const labelText = associatedLabelText(element);
  const stable = stableAttributes(element);
  const context = findSemanticContext(element);
  const locator: SemanticLocator = {
    framePath: [...framePath],
    shadowPath: buildShadowPath(shadowHosts),
    stableAttributes: stable,
    fallbacks: [],
  };
  if (role) locator.role = role;
  if (accessibleName) locator.accessibleName = accessibleName;
  if (labelText) locator.labelText = labelText;
  if (context) locator.context = context.locator;
  if (relationship) locator.relationship = relationship;

  const fallbacks = locator.fallbacks;
  if (role && accessibleName) {
    pushFallback(fallbacks, {
      kind: "role",
      description: `role ${role} with accessible name ${accessibleName}`,
      role,
      accessibleName,
    });
  }
  if (labelText) {
    pushFallback(fallbacks, {
      kind: "label",
      description: `associated label ${labelText}`,
      labelText,
      relation: "labelled-control",
    });
  }
  for (const attribute of stable) {
    pushFallback(fallbacks, {
      kind: "stable-attribute",
      description: `${attribute.name}=${attribute.value}`,
      stableAttribute: attribute,
    });
  }
  if (relationship) {
    pushFallback(fallbacks, {
      kind: "relationship",
      description: `resolve by ${relationship}`,
      relation: relationship,
    });
  }
  if (context) {
    pushFallback(fallbacks, {
      kind: "relationship",
      description: "resolve action within its semantic entity context",
      relation: "context-action",
    });
  }
  for (const selector of cssFallbacks(element)) {
    pushFallback(fallbacks, {
      kind: "css",
      description: `CSS fallback ${selector}`,
      selector,
    });
  }
  return locator;
}

export function locatorStableKey(locator: SemanticLocator): string {
  const stable = locator.stableAttributes
    .map((attribute) => `${attribute.name}=${attribute.value}`)
    .join("|");
  const context = locator.context ? JSON.stringify(locator.context) : "";
  return [
    locator.framePath.join("."),
    locator.shadowPath.map((host) => JSON.stringify(host)).join("/"),
    locator.role ?? "",
    locator.accessibleName ?? "",
    stable,
    context,
  ].join("::");
}
