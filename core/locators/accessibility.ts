import type { LocatorContext, ShadowHostLocator } from "../types";

export type LocatorRoot = Document | DocumentFragment | Element;

/** Collapse DOM whitespace without changing the meaning of a label or name. */
export function normalizeAccessibleText(
  value: string | null | undefined,
): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function ownerDocument(root: LocatorRoot): Document | null {
  if (root.nodeType === 9) return root as Document;
  return root.ownerDocument;
}

function queryElements(root: LocatorRoot): Element[] {
  const elements: Element[] = [];
  if (root.nodeType === 1) elements.push(root as Element);

  if (typeof root.querySelectorAll === "function") {
    for (const element of Array.from(root.querySelectorAll("*"))) {
      elements.push(element);
    }
  }
  return elements;
}

function findById(root: LocatorRoot, id: string): Element | null {
  // References inside a shadow root must resolve in that root first. A
  // document-level ID with the same value must not steal the reference.
  for (const element of queryElements(root)) {
    if (element.getAttribute("id") === id) return element;
  }

  const document = ownerDocument(root);
  if (document) {
    const documentElement = document.getElementById(id);
    if (documentElement) return documentElement;
  }
  return null;
}

function labelsFor(root: LocatorRoot, control: Element): Element[] {
  const labels: Element[] = [];
  const id = control.getAttribute("id");
  const document = ownerDocument(root);
  const candidates = document
    ? Array.from(new Set([...queryElements(root), ...queryElements(document)]))
    : queryElements(root);

  if (id) {
    for (const candidate of candidates) {
      if (
        candidate.localName.toLowerCase() === "label" &&
        candidate.getAttribute("for") === id
      ) {
        labels.push(candidate);
      }
    }
  }

  let current: Node | null = control;
  while (current) {
    if (
      current.nodeType === 1 &&
      (current as Element).localName.toLowerCase() === "label"
    ) {
      labels.push(current as Element);
      break;
    }

    if (current.parentNode) {
      current = current.parentNode;
      continue;
    }

    // A shadow root has no parentNode. Its host is the next semantic
    // ancestor, and open roots are the only roots visible to this module.
    if (current.nodeType === 11) {
      const host: Element | null = (current as ShadowRoot).host ?? null;
      current = host ?? null;
      continue;
    }
    current = null;
  }

  return Array.from(new Set(labels));
}

export function getExplicitLabelText(
  root: LocatorRoot,
  element: Element,
): string {
  return normalizeAccessibleText(
    labelsFor(root, element)
      .map((label) => label.textContent ?? "")
      .filter(Boolean)
      .join(" "),
  );
}

function getAriaLabelledByText(root: LocatorRoot, element: Element): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (!labelledBy) return "";

  return normalizeAccessibleText(
    labelledBy
      .split(/\s+/)
      .map((id) => findById(root, id)?.textContent ?? "")
      .filter(Boolean)
      .join(" "),
  );
}

function semanticText(element: Element): string {
  const tagName = element.localName.toLowerCase();
  if (tagName === "input") {
    const inputType = (element.getAttribute("type") ?? "text").toLowerCase();
    if (["button", "submit", "reset", "image"].includes(inputType)) {
      return normalizeAccessibleText(element.getAttribute("value"));
    }
  }

  return normalizeAccessibleText(element.textContent);
}

/**
 * Extract a deterministic accessible-ish name for locator matching.
 *
 * The inference engine intentionally follows the product's semantic
 * priority rather than browser-specific accessibility-tree internals:
 * explicit label, ARIA, semantic text, name, then placeholder/context.
 */
export function getAccessibleName(root: LocatorRoot, element: Element): string {
  const explicitLabel = getExplicitLabelText(root, element);
  if (explicitLabel) return explicitLabel;

  const ariaLabel = normalizeAccessibleText(element.getAttribute("aria-label"));
  if (ariaLabel) return ariaLabel;

  const ariaLabelledBy = getAriaLabelledByText(root, element);
  if (ariaLabelledBy) return ariaLabelledBy;

  const text = semanticText(element);
  if (text) return text;

  const name = normalizeAccessibleText(element.getAttribute("name"));
  if (name) return name;

  const placeholder = normalizeAccessibleText(
    element.getAttribute("placeholder"),
  );
  if (placeholder) return placeholder;

  return normalizeAccessibleText(element.getAttribute("title"));
}

export const extractAccessibleName = getAccessibleName;

/** Resolve an explicit or implicit ARIA role without reading clobberable DOM properties. */
export function getSemanticRole(element: Element): string | undefined {
  const explicitRole = normalizeAccessibleText(element.getAttribute("role"));
  if (explicitRole) return explicitRole.split(/\s+/)[0]?.toLocaleLowerCase();

  const tagName = element.localName.toLowerCase();
  if (tagName === "button") return "button";
  if (tagName === "a" && element.getAttribute("href") !== null) return "link";
  if (tagName === "textarea") return "textbox";
  if (tagName === "select") {
    return element.hasAttribute("multiple") ? "listbox" : "combobox";
  }
  if (tagName === "option") return "option";
  if (tagName === "form") return "form";
  if (tagName === "article") return "article";
  if (tagName === "nav") return "navigation";
  if (tagName === "main") return "main";
  if (tagName === "ul" || tagName === "ol") return "list";
  if (tagName === "li") return "listitem";
  if (tagName === "dialog") return "dialog";
  if (tagName === "img") return "img";
  if (tagName === "table") return "table";
  if (tagName === "tr") return "row";
  if (tagName === "td" || tagName === "th") return "cell";
  if (/^h[1-6]$/.test(tagName)) return "heading";

  if (tagName === "input") {
    const inputType = (element.getAttribute("type") ?? "text").toLowerCase();
    if (inputType === "checkbox") return "checkbox";
    if (inputType === "radio") return "radio";
    if (inputType === "range") return "slider";
    if (inputType === "number") return "spinbutton";
    if (["button", "submit", "reset", "image"].includes(inputType)) {
      return "button";
    }
    if (inputType !== "hidden") return "textbox";
  }

  return undefined;
}

export const getRole = getSemanticRole;

export function isFormControl(element: Element): boolean {
  const tagName = element.localName.toLowerCase();
  return tagName === "input" || tagName === "textarea" || tagName === "select";
}

export function isClickableElement(element: Element): boolean {
  const tagName = element.localName.toLowerCase();
  if (tagName === "button") return true;
  if (tagName === "a" && element.getAttribute("href") !== null) return true;
  if (tagName === "input") {
    const inputType = (element.getAttribute("type") ?? "text").toLowerCase();
    return ["button", "submit", "reset", "image", "checkbox", "radio"].includes(
      inputType,
    );
  }
  const role = getSemanticRole(element);
  return role === "button" || role === "link";
}

function appendOpenShadowElements(
  elements: Element[],
  seen: Set<Element>,
): void {
  for (const element of elements) {
    if (seen.has(element)) continue;
    seen.add(element);
    const shadowRoot = getOpenShadowRoot(element);
    if (!shadowRoot) continue;
    appendOpenShadowElements(queryElements(shadowRoot), seen);
  }
}

export function getOpenShadowRoot(element: Element): ShadowRoot | null {
  try {
    return element.shadowRoot ?? null;
  } catch {
    // Accessing a host supplied by another DOM implementation can throw.
    // Closed roots remain intentionally inaccessible.
    return null;
  }
}

/** Return light-DOM elements plus descendants of every accessible open shadow root. */
export function collectOpenShadowElements(root: LocatorRoot): Element[] {
  const elements = queryElements(root);
  const seen = new Set<Element>();
  appendOpenShadowElements(elements, seen);
  return Array.from(seen);
}

function matchesStableAttribute(
  element: Element,
  attribute: {
    name: string;
    value: string;
  },
): boolean {
  return element.getAttribute(attribute.name) === attribute.value;
}

export function contextMatches(
  element: Element,
  context: LocatorContext | undefined,
): boolean {
  if (!context) return false;

  let current: Node | null = element;
  while (current) {
    if (current.nodeType === 1) {
      const candidate = current as Element;
      if (context.role && getSemanticRole(candidate) !== context.role) {
        current = candidate.parentNode;
        continue;
      }
      if (
        context.stableAttribute &&
        !matchesStableAttribute(candidate, context.stableAttribute)
      ) {
        current = candidate.parentNode;
        continue;
      }
      if (
        context.text &&
        !normalizeAccessibleText(candidate.textContent)
          .toLocaleLowerCase()
          .includes(normalizeAccessibleText(context.text).toLocaleLowerCase())
      ) {
        current = candidate.parentNode;
        continue;
      }
      return true;
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
  return false;
}

export function describeElement(element: Element): string {
  const tagName = element.localName.toLowerCase();
  const id = element.getAttribute("id");
  const testId = element.getAttribute("data-testid");
  const name = element.getAttribute("name");
  const suffix = id
    ? `#${id}`
    : testId
      ? `[data-testid="${testId}"]`
      : name
        ? `[name="${name}"]`
        : "";
  return `<${tagName}${suffix}>`;
}

export function hostLocatorMatches(
  root: LocatorRoot,
  element: Element,
  locator: ShadowHostLocator,
): boolean {
  if (locator.role && getSemanticRole(element) !== locator.role) return false;
  if (
    locator.accessibleName &&
    getAccessibleName(root, element) !==
      normalizeAccessibleText(locator.accessibleName)
  ) {
    return false;
  }
  if (
    locator.stableAttribute &&
    !matchesStableAttribute(element, locator.stableAttribute)
  ) {
    return false;
  }
  return true;
}
