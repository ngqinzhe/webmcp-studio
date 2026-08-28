import type { ExpectedOutcome } from "../types";
import { collectOpenShadowElements, getOpenShadowRoot } from "../locators";
import {
  readChecked,
  readControlValue,
  readDocumentUrl,
  readNativeProperty,
  readSelectedValues,
} from "./dom";

export interface ControlSnapshot {
  tagName: string;
  type?: string;
  name?: string;
  value?: string;
  checked?: boolean;
  selectedValues?: string[];
  disabled: boolean;
}

export interface ExecutionSnapshot {
  url: string;
  title: string;
  text: string;
  state: string;
  controls: ControlSnapshot[];
  frameUrls: string[];
}

function normalizedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function readTitle(document: Document): string {
  const title = document.querySelector("title");
  return normalizedText(title?.textContent ?? "");
}

function readBodyText(document: Document): string {
  const root = document.body ?? document.documentElement;
  if (!root) return "";
  const text = readNativeProperty(root, "textContent");
  return normalizedText(
    typeof text === "string" ? text : (root.textContent ?? ""),
  );
}

function readControlSnapshot(element: Element): ControlSnapshot {
  const tagName = element.localName.toLowerCase();
  const type = element.getAttribute("type") ?? undefined;
  const name = element.getAttribute("name") ?? undefined;
  const snapshot: ControlSnapshot = {
    tagName,
    disabled:
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled")?.toLocaleLowerCase() === "true",
  };
  if (type) snapshot.type = type;
  if (name) snapshot.name = name;

  if (tagName === "select") {
    snapshot.value = readControlValue(element);
    snapshot.selectedValues = readSelectedValues(element);
  } else if (tagName === "textarea" || tagName === "input") {
    snapshot.value = readControlValue(element);
    const inputType = (type ?? "text").toLowerCase();
    if (inputType === "checkbox" || inputType === "radio") {
      snapshot.checked = readChecked(element);
    }
  }
  return snapshot;
}

function readMarkup(document: Document): string {
  const root = document.body ?? document.documentElement;
  if (!root) return "";
  const markup = readNativeProperty(root, "outerHTML");
  return typeof markup === "string" ? markup : root.outerHTML;
}

function accessibleDocuments(document: Document): Document[] {
  const documents: Document[] = [document];
  const seen = new Set<Document>(documents);
  for (let index = 0; index < documents.length; index += 1) {
    const current = documents[index];
    if (!current) continue;
    const frames = collectOpenShadowElements(current).filter((element) => {
      const tagName = element.localName.toLowerCase();
      return tagName === "iframe" || tagName === "frame";
    });
    for (const frame of frames) {
      try {
        const child = (frame as HTMLIFrameElement).contentDocument;
        if (child && !seen.has(child)) {
          seen.add(child);
          documents.push(child);
        }
      } catch {
        // Cross-origin frame documents are intentionally not inspected.
      }
    }
  }
  return documents;
}

function accessibleRoots(document: Document): Array<Document | ShadowRoot> {
  const roots: Array<Document | ShadowRoot> = [];
  for (const current of accessibleDocuments(document)) {
    roots.push(current);
    for (const element of collectOpenShadowElements(current)) {
      const shadowRoot = getOpenShadowRoot(element);
      if (shadowRoot) roots.push(shadowRoot);
    }
  }
  return roots;
}

function readDeepText(document: Document): string {
  return normalizedText(
    accessibleRoots(document)
      .map((root) => {
        const value = readNativeProperty(root, "textContent");
        return typeof value === "string" ? value : (root.textContent ?? "");
      })
      .join(" "),
  );
}

function readDeepMarkup(document: Document): string {
  return accessibleRoots(document)
    .map((root) => {
      if (root.nodeType === 9) {
        const rootElement =
          (root as Document).body ?? (root as Document).documentElement;
        if (!rootElement) return "";
        const markup = readNativeProperty(rootElement, "outerHTML");
        return typeof markup === "string" ? markup : rootElement.outerHTML;
      }
      const markup = readNativeProperty(root, "innerHTML");
      return typeof markup === "string" ? markup : (root.textContent ?? "");
    })
    .join("\u0000");
}

function readDeepControls(document: Document): ControlSnapshot[] {
  return accessibleRoots(document).flatMap((root) =>
    Array.from(root.querySelectorAll("input, textarea, select")).map(
      readControlSnapshot,
    ),
  );
}

export function snapshotPage(
  document: Document,
  urlProvider?: () => string,
): ExecutionSnapshot {
  const documents = accessibleDocuments(document);
  const controls = readDeepControls(document);
  const text = readDeepText(document) || readBodyText(document);
  const title = readTitle(document);
  const state = JSON.stringify({
    markup: `${readMarkup(document)}\u0001${readDeepMarkup(document)}`,
    controls,
    title,
    frameUrls: documents.map((current) => {
      try {
        return current.defaultView?.location?.href ?? current.URL ?? "";
      } catch {
        return "";
      }
    }),
  });

  return {
    url: urlProvider ? safeUrl(urlProvider) : readDocumentUrl(document),
    title,
    text,
    state,
    controls,
    frameUrls: documents.map((current) => {
      try {
        return current.defaultView?.location?.href ?? current.URL ?? "";
      } catch {
        return "";
      }
    }),
  };
}

function safeUrl(urlProvider: () => string): string {
  try {
    return urlProvider();
  } catch {
    return "";
  }
}

export function navigationOccurred(
  before: ExecutionSnapshot,
  after: ExecutionSnapshot,
): boolean {
  return (
    before.url !== after.url ||
    before.frameUrls.length !== after.frameUrls.length ||
    before.frameUrls.some((url, index) => url !== after.frameUrls[index])
  );
}

export function observableStateChanged(
  before: ExecutionSnapshot,
  after: ExecutionSnapshot,
): boolean {
  return (
    before.url !== after.url ||
    before.title !== after.title ||
    before.text !== after.text ||
    before.state !== after.state
  );
}

function matchesUrlPattern(url: string, pattern: string): boolean {
  if (url === pattern || url.includes(pattern)) return true;
  try {
    return new RegExp(pattern).test(url);
  } catch {
    return false;
  }
}

function matchesStateAttribute(
  document: Document,
  expression: string,
): boolean {
  const separator = expression.indexOf("=");
  if (separator < 0) {
    return Array.from(document.querySelectorAll("*")).some(
      (element) => element.getAttribute(expression) !== null,
    );
  }

  const name = expression.slice(0, separator).trim();
  const expected = expression
    .slice(separator + 1)
    .trim()
    .replace(/^['"]|['"]$/g, "");
  if (!name) return false;
  return Array.from(document.querySelectorAll("*")).some(
    (element) => element.getAttribute(name) === expected,
  );
}

/** Check explicit outcome predicates without treating an event dispatch as success. */
export function matchesExpectedOutcome(
  document: Document,
  before: ExecutionSnapshot,
  after: ExecutionSnapshot,
  expected: ExpectedOutcome,
): boolean {
  const changed = observableStateChanged(before, after);
  const navigated = navigationOccurred(before, after);

  if (expected.event === "navigation" && !navigated) return false;
  if (
    expected.urlPattern &&
    !matchesUrlPattern(after.url, expected.urlPattern)
  ) {
    return false;
  }
  if (expected.textIncludes && !after.text.includes(expected.textIncludes)) {
    return false;
  }
  if (expected.selector) {
    try {
      if (!document.querySelector(expected.selector)) return false;
    } catch {
      return false;
    }
  }
  if (
    expected.stateAttribute &&
    !matchesStateAttribute(document, expected.stateAttribute)
  ) {
    return false;
  }

  return changed;
}

export function hasExplicitOutcomePredicate(
  expected: ExpectedOutcome,
): boolean {
  return Boolean(
    expected.event === "navigation" ||
    expected.urlPattern ||
    expected.textIncludes ||
    expected.selector ||
    expected.stateAttribute,
  );
}
