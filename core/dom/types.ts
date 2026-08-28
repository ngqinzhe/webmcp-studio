import type {
  BlockedCapability,
  EntityReference,
  LocatorContext,
  SemanticLocator,
  ShadowHostLocator,
} from "../types";

export type DiscoveredElementKind =
  | "form"
  | "input"
  | "textarea"
  | "select"
  | "checkbox"
  | "radio"
  | "button"
  | "link"
  | "action";

export interface DiscoveredElement {
  element: Element;
  document: Document;
  framePath: number[];
  shadowPath: ShadowHostLocator[];
  kind: DiscoveredElementKind;
  controlType?: "input" | "textarea" | "select" | "checkbox" | "radio";
  role?: string;
  accessibleName?: string;
  labelText?: string;
  locator: SemanticLocator;
  context?: LocatorContext;
  entity?: EntityReference;
  form?: Element;
  disabled: boolean;
}

export interface DiscoveredForm {
  element: Element;
  document: Document;
  framePath: number[];
  shadowPath: ShadowHostLocator[];
  locator: SemanticLocator;
  accessibleName?: string;
  controls: DiscoveredElement[];
  submitControls: DiscoveredElement[];
}

export interface DiscoverySnapshot {
  rootDocument: Document;
  elements: DiscoveredElement[];
  forms: DiscoveredForm[];
  blocked: BlockedCapability[];
  /** Internal node index used to merge bounded mutation scans safely. */
  blockedElements: Map<string, Element>;
  documentsScanned: number;
  rootsScanned: number;
  elementsScanned: number;
}

export type TraversalRoot = Document | DocumentFragment | Element;

export interface TraversalOptions {
  includeFrames: boolean;
  includeShadowDom: boolean;
}
