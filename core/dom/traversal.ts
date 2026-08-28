import {
  getAccessibleName,
  getRole,
  getStableAttributes,
} from "./accessibility";
import type {
  BlockedCapability,
  ScanOptions,
  ShadowHostLocator,
} from "../types";

export type DomContainer = Document | ShadowRoot;

export interface DomRoot {
  root: DomContainer;
  document: Document;
  framePath: number[];
  shadowPath: ShadowHostLocator[];
  url: string;
}

export interface TraversalResult {
  roots: DomRoot[];
  blockedFrames: BlockedCapability[];
}

function hostLocator(host: Element, index: number): ShadowHostLocator {
  const stable = getStableAttributes(host)[0];
  const escape = (value: string): string => {
    const css = (globalThis as { CSS?: { escape?: (value: string) => string } })
      .CSS;
    return css?.escape
      ? css.escape(value)
      : value.replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character}`);
  };
  const locator: ShadowHostLocator = { index };
  const role = getRole(host);
  const accessibleName = getAccessibleName(host);
  const selector = stable
    ? `[${stable.name}="${escape(stable.value)}"]`
    : undefined;
  if (role) locator.role = role;
  if (accessibleName) locator.accessibleName = accessibleName;
  if (stable) locator.stableAttribute = stable;
  if (selector) locator.selector = selector;
  return locator;
}

function documentUrl(document: Document): string {
  try {
    return document.location?.href ?? "";
  } catch {
    return "";
  }
}

function frameOriginAllowed(
  frame: HTMLIFrameElement,
  owner: Document,
): boolean {
  const src = frame.getAttribute("src");
  if (!src || src === "about:blank") return true;
  try {
    const target = new URL(src, owner.location.href);
    return target.origin === owner.location.origin;
  } catch {
    return false;
  }
}

export function traverseDom(
  document: Document,
  options: ScanOptions = {},
): TraversalResult {
  const roots: DomRoot[] = [];
  const blockedFrames: BlockedCapability[] = [];
  const includeFrames = options.includeFrames !== false;
  const includeShadow = options.includeShadowDom !== false;
  const seenDocuments = new Set<Document>();

  const visit = (
    root: DomContainer,
    ownerDocument: Document,
    framePath: number[],
    shadowPath: ShadowHostLocator[],
  ): void => {
    roots.push({
      root,
      document: ownerDocument,
      framePath,
      shadowPath,
      url: documentUrl(ownerDocument),
    });

    if (root instanceof Document && seenDocuments.has(root)) return;
    if (root instanceof Document) seenDocuments.add(root);

    const elements = Array.from(root.querySelectorAll("*"));
    if (includeShadow) {
      elements.forEach((element, index) => {
        const shadow = element.shadowRoot;
        if (shadow)
          visit(shadow, ownerDocument, framePath, [
            ...shadowPath,
            hostLocator(element, index),
          ]);
      });
    }

    if (!includeFrames) return;
    const frames = Array.from(root.querySelectorAll("iframe,frame"));
    frames.forEach((frame, index) => {
      const iframe = frame as HTMLIFrameElement;
      let child: Document | null = null;
      try {
        child = iframe.contentDocument;
      } catch {
        child = null;
      }
      if (child) {
        visit(child, child, [...framePath, index], shadowPath);
      } else if (!frameOriginAllowed(iframe, ownerDocument)) {
        blockedFrames.push({
          id: `blocked-frame-${[...framePath, index].join("-") || "root"}`,
          name: "iframe_capabilities",
          reason: "cross_origin_blocked",
          detail: `Cross-origin iframe at index ${index} cannot be inspected by this page context.`,
          framePath: [...framePath, index],
        });
      }
    });
  };

  visit(document, document, [], []);
  return { roots, blockedFrames };
}
