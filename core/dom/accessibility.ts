type DocumentOrShadowRoot = Document | ShadowRoot;
import {
  findElementById,
  hasAttribute,
  isHidden,
  parentElementAcrossRoots,
  readableText,
  readAttribute,
  rootQueryAll,
  semanticRole,
} from "./utils";
import type { EntityReference, StableAttribute } from "../types";

export function associatedLabelText(element: Element): string | undefined {
  const root = element.getRootNode();
  const labels =
    root && (root.nodeType === 9 || root.nodeType === 11)
      ? rootQueryAll(root as DocumentOrShadowRoot, "label")
      : [];
  const id = readAttribute(element, "id");
  const labelled = labels.filter((label) => {
    const forValue = readAttribute(label, "for");
    if (forValue && id && forValue === id) return true;
    let parent: Element | null = element;
    while (parent) {
      if (parent === label) return true;
      parent = parentElementAcrossRoots(parent);
    }
    return false;
  });

  const text = labelled
    .map((label) => readableText(label, 160))
    .filter(Boolean)
    .join(" ");
  return text || undefined;
}

function ariaLabelledByText(element: Element): string | undefined {
  const references =
    readAttribute(element, "aria-labelledby")?.split(/\s+/).filter(Boolean) ??
    [];
  if (references.length === 0) return undefined;

  const root = element.getRootNode();
  if (!root || (root.nodeType !== 9 && root.nodeType !== 11)) return undefined;

  const values = references
    .map((id) => findElementById(root as DocumentOrShadowRoot, id))
    .filter((candidate): candidate is Element => Boolean(candidate))
    .map((candidate) => readableText(candidate, 160))
    .filter(Boolean);
  return values.length > 0 ? values.join(" ") : undefined;
}

function semanticElementText(element: Element): string | undefined {
  const tag = element.localName.toLowerCase();
  if (tag === "input") {
    const type = readAttribute(element, "type")?.toLowerCase() ?? "text";
    if (["button", "submit", "reset", "image"].includes(type)) {
      return readAttribute(element, "value");
    }
    return undefined;
  }

  if (
    ["button", "a", "summary", "option", "legend"].includes(tag) ||
    semanticRole(element)
  ) {
    return readableText(element, 160) || undefined;
  }
  return undefined;
}

function fieldsetLegendText(element: Element): string | undefined {
  let current = parentElementAcrossRoots(element);
  while (current) {
    if (current.localName.toLowerCase() === "fieldset") {
      const legend = Array.from(current.children).find(
        (child) => child.localName.toLowerCase() === "legend",
      );
      if (legend) return readableText(legend, 160) || undefined;
      break;
    }
    current = parentElementAcrossRoots(current);
  }
  return undefined;
}

function nearbyHeadingText(element: Element): string | undefined {
  let current = parentElementAcrossRoots(element);
  let depth = 0;
  while (current && depth < 4) {
    const heading = Array.from(current.children).find((child) =>
      /^h[1-6]$/.test(child.localName.toLowerCase()),
    );
    if (heading) {
      const text = readableText(heading, 160);
      if (text) return text;
    }
    current = parentElementAcrossRoots(current);
    depth += 1;
  }
  return undefined;
}

/**
 * A deterministic accessible-name approximation for controls and actions.
 * The order intentionally favours explicit form labels, then ARIA metadata,
 * followed by visible semantic text and stable HTML attributes.
 */
export function getAccessibleName(element: Element): string | undefined {
  const explicitLabel = associatedLabelText(element);
  if (explicitLabel) return explicitLabel;

  const ariaLabel = readAttribute(element, "aria-label");
  if (ariaLabel) return ariaLabel;

  const labelledBy = ariaLabelledByText(element);
  if (labelledBy) return labelledBy;

  const semanticText = semanticElementText(element);
  if (semanticText) return semanticText;

  const name = readAttribute(element, "name");
  if (name) return name;

  const placeholder = readAttribute(element, "placeholder");
  if (placeholder) return placeholder;

  const title = readAttribute(element, "title");
  if (title) return title;

  return fieldsetLegendText(element) ?? nearbyHeadingText(element);
}

export const extractAccessibleName = getAccessibleName;

/** Compatibility helpers used by the lightweight inference facade. */
export function attribute(element: Element, name: string): string | undefined {
  return readAttribute(element, name);
}

export function visibleText(element: Element, maxLength = 240): string {
  return readableText(element, maxLength);
}

export function isProbablyVisible(element: Element): boolean {
  return !isHidden(element);
}

export function getRole(element: Element): string | undefined {
  return semanticRole(element);
}

export function getStableAttributes(element: Element): StableAttribute[] {
  const names = [
    "data-testid",
    "data-test-id",
    "data-test",
    "data-qa",
    "data-cy",
    "data-product-id",
    "data-id",
    "id",
    "name",
  ];
  return names.flatMap((name) => {
    const value = readAttribute(element, name);
    return value ? [{ name, value }] : [];
  });
}

export function getContextEntity(
  element: Element,
): EntityReference | undefined {
  let current = parentElementAcrossRoots(element);
  while (current) {
    const role = semanticRole(current);
    const className = readAttribute(current, "class")?.toLowerCase() ?? "";
    const testId = readAttribute(current, "data-testid")?.toLowerCase() ?? "";
    const tag = current.localName.toLowerCase();
    if (
      tag === "article" ||
      role === "article" ||
      /product|item|card|result|listing/.test(`${className} ${testId}`)
    ) {
      const heading = current.querySelector(
        "h1,h2,h3,h4,h5,h6,[role='heading'],[data-product-name],[data-item-name]",
      );
      const text = readableText(heading ?? current, 160);
      const stableAttribute = getStableAttributes(current)[0];
      if (text || stableAttribute)
        return {
          role: role ?? tag,
          ...(text ? { text } : {}),
          ...(stableAttribute ? { stableAttribute } : {}),
        };
    }
    current = parentElementAcrossRoots(current);
  }
  return undefined;
}

export function slug(value: string | undefined, fallback = "item"): string {
  const normalized = (value ?? "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || fallback;
}

export function isRequired(element: Element): boolean {
  return (
    hasAttribute(element, "required") ||
    readAttribute(element, "aria-required") === "true"
  );
}
