import type { StableAttribute } from "../types";

/**
 * Attribute access is deliberately routed through the element's own DOM
 * realm.  Page markup can contain names that shadow convenient properties;
 * calling the platform method keeps discovery deterministic.
 */
export function readAttribute(
  element: Element,
  name: string,
): string | undefined {
  const value = readRawAttribute(element, name);
  if (value === null) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Read an attribute without collapsing a meaningful empty string to absent. */
export function readRawAttribute(
  element: Element,
  name: string,
): string | null {
  const view = element.ownerDocument?.defaultView;
  const getAttribute = view?.Element?.prototype.getAttribute;
  const value =
    typeof getAttribute === "function"
      ? getAttribute.call(element, name)
      : element.getAttribute(name);

  return value;
}

export function hasAttribute(element: Element, name: string): boolean {
  const view = element.ownerDocument?.defaultView;
  const has = view?.Element?.prototype.hasAttribute;
  return typeof has === "function"
    ? has.call(element, name)
    : element.hasAttribute(name);
}

export function normalizedText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

/** Read text while ignoring explicitly hidden semantic content. */
export function readableText(node: Node, maxLength = 240): string {
  const chunks: string[] = [];

  const append = (current: Node): void => {
    if (chunks.join(" ").length >= maxLength) return;

    if (current.nodeType === 3) {
      const value = normalizedText(current.nodeValue);
      if (value) chunks.push(value);
      return;
    }

    if (current.nodeType !== 1) {
      for (const child of Array.from(current.childNodes)) append(child);
      return;
    }

    const element = current as Element;
    if (isHidden(element)) return;
    for (const child of Array.from(element.childNodes)) append(child);
  };

  append(node);
  return normalizedText(chunks.join(" ")).slice(0, maxLength).trim();
}

export function isHidden(element: Element): boolean {
  if (hasAttribute(element, "hidden")) return true;
  if (readAttribute(element, "aria-hidden")?.toLowerCase() === "true")
    return true;

  if (
    ["script", "style", "template", "noscript"].includes(
      element.localName.toLowerCase(),
    )
  )
    return true;

  const type = readAttribute(element, "type")?.toLowerCase();
  if (element.localName.toLowerCase() === "input" && type === "hidden")
    return true;

  const style = readAttribute(element, "style")?.toLowerCase();
  return Boolean(
    style &&
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)/.test(style),
  );
}

export function isDisabled(element: Element): boolean {
  if (
    hasAttribute(element, "disabled") ||
    readAttribute(element, "aria-disabled") === "true"
  ) {
    return true;
  }

  let current = element.parentElement;
  while (current) {
    if (
      current.localName.toLowerCase() === "fieldset" &&
      hasAttribute(current, "disabled")
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

export function semanticRole(element: Element): string | undefined {
  const explicit = readAttribute(element, "role")?.split(/\s+/, 1)[0];
  if (explicit) return explicit.toLowerCase();

  const tag = element.localName.toLowerCase();
  if (
    tag === "button" ||
    (tag === "input" &&
      ["button", "submit", "reset", "image"].includes(
        readAttribute(element, "type")?.toLowerCase() ?? "",
      ))
  ) {
    return "button";
  }
  if (tag === "a" && readAttribute(element, "href")) return "link";
  if (tag === "textarea") return "textbox";
  if (tag === "select")
    return hasAttribute(element, "multiple") ? "listbox" : "combobox";
  if (tag === "input") {
    const type = readAttribute(element, "type")?.toLowerCase() ?? "text";
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "range") return "slider";
    if (type === "search") return "searchbox";
    if (
      type !== "hidden" &&
      !["button", "submit", "reset", "image"].includes(type)
    )
      return "textbox";
  }
  if (tag === "form") return "form";
  if (tag === "article") return "article";
  if (tag === "li") return "listitem";
  return undefined;
}

export function controlType(
  element: Element,
): "input" | "textarea" | "select" | "checkbox" | "radio" | undefined {
  const tag = element.localName.toLowerCase();
  if (tag === "textarea") return "textarea";
  if (tag === "select") return "select";
  if (tag !== "input") return undefined;

  const type = readAttribute(element, "type")?.toLowerCase() ?? "text";
  if (
    type === "hidden" ||
    ["button", "submit", "reset", "image", "file"].includes(type)
  )
    return undefined;
  if (type === "checkbox") return "checkbox";
  if (type === "radio") return "radio";
  return "input";
}

export function isActionElement(element: Element): boolean {
  const tag = element.localName.toLowerCase();
  if (tag === "button") return true;
  if (tag === "a" && Boolean(readAttribute(element, "href"))) return true;
  const role = semanticRole(element);
  return (
    role === "button" ||
    role === "link" ||
    role === "menuitem" ||
    role === "tab"
  );
}

const STABLE_ATTRIBUTE_NAMES = [
  "data-testid",
  "data-test-id",
  "data-test",
  "data-qa",
  "data-cy",
  "data-product-id",
  "data-item-id",
  "data-sku",
  "data-id",
  "id",
  "name",
] as const;

export function stableAttributes(element: Element): StableAttribute[] {
  const result: StableAttribute[] = [];
  const seen = new Set<string>();
  for (const name of STABLE_ATTRIBUTE_NAMES) {
    const value = readAttribute(element, name);
    if (value) {
      result.push({ name, value });
      seen.add(name);
    }
  }
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase();
    if (!name.startsWith("data-") || seen.has(name)) continue;
    const value = readAttribute(element, name);
    if (value) {
      result.push({ name, value });
      seen.add(name);
    }
  }
  return result;
}

export function firstStableAttribute(
  element: Element,
): StableAttribute | undefined {
  return stableAttributes(element)[0];
}

export function parentElementAcrossRoots(element: Element): Element | null {
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  if (root && root.nodeType === 11 && "host" in root) {
    const host = (root as ShadowRoot).host;
    return host && host.nodeType === 1 ? host : null;
  }
  return null;
}

export function rootQueryAll(
  root: Document | DocumentFragment | Element,
  selector: string,
): Element[] {
  return Array.from(root.querySelectorAll(selector));
}

export function findElementById(
  root: Document | DocumentFragment,
  id: string,
): Element | undefined {
  for (const candidate of rootQueryAll(root, "*[id]")) {
    if (readAttribute(candidate, "id") === id) return candidate;
  }
  return undefined;
}

export function documentUrl(document: Document): string {
  try {
    return document.location?.href || "";
  } catch {
    return "";
  }
}

export function safeUrlOrigin(document: Document): string {
  const href = documentUrl(document);
  try {
    return href ? new URL(href).origin : "";
  } catch {
    return "";
  }
}

export function slugify(value: string, fallback = "item"): string {
  const slug = normalizedText(value)
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug || fallback;
}

export function uniqueStrings(values: readonly string[]): string[] {
  return Array.from(
    new Set(values.map((value) => normalizedText(value)).filter(Boolean)),
  );
}
