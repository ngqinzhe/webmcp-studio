import type {
  Capability,
  CapabilityEffect,
  ExecutorDefinition,
  JSONSchema,
  SemanticLocator,
} from "../types";
import { findSemanticContext, locatorStableKey } from "../dom/locator";
import { discoverDocument } from "../dom/traverse";
import type {
  DiscoveredElement,
  DiscoveredForm,
  DiscoverySnapshot,
} from "../dom/types";
import type { ScanOptions } from "../types";
import {
  documentUrl,
  readAttribute,
  readableText,
  slugify,
  uniqueStrings,
} from "../dom/utils";
import {
  fieldNameForElement,
  inferControlSchema,
  inferFormSchema,
} from "../schema/infer";

interface FormPurpose {
  name: string;
  description: string;
  effect: CapabilityEffect;
  confidence: number;
}

export interface InferredCapabilityRecord {
  capability: Capability;
  element: Element;
}

const EMPTY_INPUT_SCHEMA: JSONSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

function clampConfidence(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function hash(value: string): string {
  let result = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(16).padStart(8, "0");
}

function capabilityId(
  name: string,
  locator: SemanticLocator,
  kind: string,
): string {
  return `inferred:${name}:${kind}:${hash(`${name}|${kind}|${locatorStableKey(locator)}`)}`;
}

function capabilitySource(
  node: DiscoveredElement | DiscoveredForm,
  nodeSignature: string,
): Capability["source"] {
  return {
    type: "inferred",
    url: documentUrl(node.document),
    framePath: [...node.framePath],
    shadowPath: node.locator.shadowPath.map((host) => ({ ...host })),
    nodeSignature,
  };
}

function schemaProperty(key: string, control: DiscoveredElement): JSONSchema {
  const schema = inferControlSchema(control.element);
  if (!schema.description && control.accessibleName)
    schema.description = `Value for ${control.accessibleName}`;
  return schema;
}

function actionText(node: DiscoveredElement): string {
  return uniqueStrings([
    node.accessibleName ?? "",
    node.labelText ?? "",
    readAttribute(node.element, "data-action") ?? "",
    readAttribute(node.element, "data-webmcp-action") ?? "",
  ]).join(" ");
}

function contextSubject(node: DiscoveredElement): string {
  const text = node.context?.text?.toLowerCase() ?? "";
  if (/(?:product|products|catalog|shop|cart|sku)/.test(text))
    return "products";
  if (/(?:article|articles|post|posts|story|stories)/.test(text))
    return "articles";
  if (/(?:user|users|account|profile)/.test(text)) return "users";
  return "items";
}

function subjectForForm(form: DiscoveredForm): string {
  const text = formText(form).toLowerCase();
  if (/(?:product|products|catalog|shop|sku)/.test(text)) return "products";
  if (/(?:article|articles|post|posts|story|stories)/.test(text))
    return "articles";
  if (/(?:user|users|account|profile)/.test(text)) return "users";
  return "products";
}

function formText(form: DiscoveredForm): string {
  const values = [
    form.accessibleName ?? "",
    readAttribute(form.element, "aria-label") ?? "",
    readAttribute(form.element, "name") ?? "",
    readAttribute(form.element, "id") ?? "",
    readAttribute(form.element, "action") ?? "",
    readableText(form.element, 260),
    ...form.controls.map((control) => control.accessibleName ?? ""),
    ...form.submitControls.map((control) => control.accessibleName ?? ""),
  ];
  return uniqueStrings(values).join(" ");
}

function hasControl(
  form: DiscoveredForm,
  predicate: (control: DiscoveredElement) => boolean,
): boolean {
  return form.controls.some(
    (control) => !control.disabled && predicate(control),
  );
}

function formPurpose(form: DiscoveredForm): FormPurpose | undefined {
  const text = formText(form);
  const lower = text.toLowerCase();
  const submitText = form.submitControls
    .map(actionText)
    .join(" ")
    .toLowerCase();
  const method = readAttribute(form.element, "method")?.toLowerCase() ?? "get";
  const hasSearchControl = hasControl(form, (control) => {
    const type = readAttribute(control.element, "type")?.toLowerCase();
    const name = (control.accessibleName ?? "").toLowerCase();
    return (
      type === "search" ||
      /(?:search|query|keyword|find)/.test(name) ||
      ["q", "query", "search"].includes(
        readAttribute(control.element, "name")?.toLowerCase() ?? "",
      )
    );
  });
  const hasFilterControl = hasControl(form, (control) => {
    const label =
      `${control.accessibleName ?? ""} ${readAttribute(control.element, "name") ?? ""}`.toLowerCase();
    return (
      control.kind === "select" ||
      control.kind === "checkbox" ||
      control.kind === "radio" ||
      /filter|category|brand|price|availability/.test(label)
    );
  });

  if (
    hasSearchControl ||
    /\b(?:search|query|find)\b/.test(`${lower} ${submitText}`)
  ) {
    const subject = subjectForForm(form);
    return {
      name: `search_${subject}`,
      description: `Search ${subject} using the page's visible search form.`,
      effect:
        method === "get" && readAttribute(form.element, "action")
          ? "navigate"
          : "read",
      confidence: hasSearchControl ? 0.9 : 0.75,
    };
  }

  if (
    /\b(?:sort|ordering|order by)\b/.test(lower) ||
    hasControl(
      form,
      (control) =>
        control.kind === "select" &&
        /sort|order/.test((control.accessibleName ?? "").toLowerCase()),
    )
  ) {
    return {
      name: "change_sort",
      description: "Change the ordering of the visible results.",
      effect: "read",
      confidence: 0.84,
    };
  }

  if (
    /\bfilter(?:s|ed|ing)?\b|category|brand|availability|price range/.test(
      lower,
    ) &&
    hasFilterControl
  ) {
    return {
      name: "filter_results",
      description: "Filter the visible results using the page's controls.",
      effect: "read",
      confidence: 0.84,
    };
  }

  if (/\b(?:contact|feedback|message|enquir(?:y|ies)|support)\b/.test(lower)) {
    return {
      name: "submit_contact_form",
      description: "Submit the visible contact form.",
      effect: "mutate",
      confidence: 0.9,
    };
  }

  if (/\b(?:sign[ -]?in|log[ -]?in|authenticate)\b/.test(lower)) {
    return {
      name: "sign_in",
      description: "Sign in using the visible form.",
      effect: "mutate",
      confidence: 0.88,
    };
  }

  if (/\b(?:checkout|place order|purchase)\b/.test(lower)) {
    return {
      name: "checkout",
      description: "Complete checkout using the visible form.",
      effect: "mutate",
      confidence: 0.88,
    };
  }

  if (/\b(?:subscribe|newsletter|mailing list)\b/.test(lower)) {
    return {
      name: "subscribe",
      description: "Subscribe using the visible form.",
      effect: "mutate",
      confidence: 0.86,
    };
  }

  const meaningfulName =
    form.accessibleName ??
    readAttribute(form.element, "name") ??
    readAttribute(form.element, "id");
  if (meaningfulName && !/^(?:form|form\d*|submit)$/i.test(meaningfulName)) {
    const subject = slugify(meaningfulName, "form");
    return {
      name: `submit_${subject}_form`,
      description: `Submit the visible ${meaningfulName} form.`,
      effect: method === "get" ? "navigate" : "mutate",
      confidence: 0.66,
    };
  }

  return undefined;
}

function nodeSignature(node: DiscoveredElement | DiscoveredForm): string {
  const tag = node.element.localName.toLowerCase();
  const name = node.accessibleName ?? "";
  const stable = node.locator.stableAttributes
    .map((attribute) => `${attribute.name}=${attribute.value}`)
    .join(",");
  return `${tag}|${name}|${stable}|frame=${node.framePath.join(".")}|shadow=${node.shadowPath.length}`;
}

function formFieldLocators(
  form: DiscoveredForm,
): Record<string, SemanticLocator> {
  const fields: Record<string, SemanticLocator> = {};
  const radioGroups = new Set<string>();
  for (const control of form.controls) {
    if (!control.controlType || control.disabled) continue;
    const type = readAttribute(control.element, "type")?.toLowerCase();
    if (type === "radio") {
      const group =
        readAttribute(control.element, "name") ??
        fieldNameForElement(control.element, "choice");
      if (radioGroups.has(group)) continue;
      radioGroups.add(group);
    }
    const key =
      type === "radio"
        ? slugify(
            readAttribute(control.element, "name") ??
              fieldNameForElement(control.element, "choice"),
            "choice",
          )
        : fieldNameForElement(control.element, control.controlType);
    if (!fields[key]) fields[key] = control.locator;
  }
  return fields;
}

function formCapability(
  form: DiscoveredForm,
  purpose: FormPurpose,
): Capability {
  const fields = formFieldLocators(form);
  const submit = form.submitControls.find(
    (control) => !control.disabled,
  )?.locator;
  const executor: Extract<ExecutorDefinition, { kind: "form" }> = {
    kind: "form",
    form: form.locator,
    fields,
    expected: { event: "submit", waitMs: 1200 },
  };
  if (submit) executor.submit = submit;
  const confidenceBoost =
    form.controls.filter(
      (control) => control.accessibleName && !control.disabled,
    ).length * 0.01;
  const capability: Capability = {
    id: capabilityId(purpose.name, form.locator, "form"),
    name: purpose.name,
    description: purpose.description,
    inputSchema: inferFormSchema(form),
    effect: purpose.effect,
    confidence: clampConfidence(
      purpose.confidence + Math.min(confidenceBoost, 0.08),
    ),
    source: capabilitySource(form, nodeSignature(form)),
    locator: form.locator,
    executor,
    enabled: true,
  };
  return capability;
}

function actionName(
  node: DiscoveredElement,
): { name: string; effect: CapabilityEffect; description: string } | undefined {
  const text = actionText(node).toLowerCase();
  const context = Boolean(node.context);
  const subject = contextSubject(node);
  const explicit =
    readAttribute(node.element, "data-webmcp-action") ??
    readAttribute(node.element, "data-action");
  const semantic = `${text} ${explicit ?? ""}`.trim();

  if (
    /(?:add|put|save)\s+(?:to|in)\s+(?:the\s+)?(?:cart|basket|bag)/.test(
      semantic,
    ) ||
    /\badd_to_cart\b/.test(semantic)
  ) {
    return {
      name: "add_to_cart",
      effect: "mutate",
      description: `Add the ${context ? "selected item" : "item"} to the cart.`,
    };
  }
  if (
    /(?:remove|delete)\s+(?:from|in)\s+(?:the\s+)?(?:cart|basket|bag)/.test(
      semantic,
    ) ||
    /\bremove_from_cart\b/.test(semantic)
  ) {
    return {
      name: "remove_from_cart",
      effect: "mutate",
      description: "Remove the selected item from the cart.",
    };
  }
  if (/\b(?:checkout|place order)\b/.test(semantic))
    return {
      name: "checkout",
      effect: "mutate",
      description: "Proceed to checkout.",
    };
  if (/\b(?:sign[ -]?in|log[ -]?in)\b/.test(semantic))
    return {
      name: "sign_in",
      effect: "mutate",
      description: "Sign in through the visible page UI.",
    };
  if (/\b(?:search|find)\b/.test(semantic))
    return {
      name: `search_${subject}`,
      effect: "read",
      description: `Search ${subject}.`,
    };
  if (/\b(?:filter|apply filters?)\b/.test(semantic))
    return {
      name: "filter_results",
      effect: "read",
      description: "Apply the visible result filters.",
    };
  if (/\b(?:sort|order by)\b/.test(semantic))
    return {
      name: "change_sort",
      effect: "read",
      description: "Change the visible result ordering.",
    };
  if (/\b(?:next|more results?|load more)\b/.test(semantic))
    return {
      name: "next_page",
      effect: "navigate",
      description: "Open the next set of results.",
    };
  if (/\b(?:previous|back)\b/.test(semantic))
    return {
      name: "previous_page",
      effect: "navigate",
      description: "Open the previous set of results.",
    };
  if (
    context &&
    /\b(?:view|open|show|details?|learn more|see)\b/.test(semantic)
  ) {
    return {
      name: "open_item",
      effect: "navigate",
      description: "Open the selected item.",
    };
  }
  if (context && node.kind === "link" && readAttribute(node.element, "href")) {
    const contextText = node.context?.text?.toLowerCase() ?? "";
    if (
      contextText &&
      semantic.includes(contextText.slice(0, Math.min(24, contextText.length)))
    ) {
      return {
        name: "open_item",
        effect: "navigate",
        description: "Open the selected item.",
      };
    }
  }
  if (/\b(?:contact|send message|send inquiry)\b/.test(semantic))
    return {
      name: "submit_contact_form",
      effect: "mutate",
      description: "Submit the visible contact interaction.",
    };
  return undefined;
}

function actionCapability(
  node: DiscoveredElement,
  descriptor: { name: string; effect: CapabilityEffect; description: string },
): Capability {
  const isLink = node.kind === "link";
  const executor: Extract<ExecutorDefinition, { kind: "action" }> = {
    kind: "action",
    action: isLink ? "navigate" : "click",
    target: node.locator,
    expected: {
      event: isLink ? "navigation" : "click",
      waitMs: isLink ? 1500 : 700,
    },
  };
  if (node.entity) executor.entity = node.entity;
  return {
    id: capabilityId(descriptor.name, node.locator, "action"),
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: EMPTY_INPUT_SCHEMA,
    effect: descriptor.effect,
    confidence: clampConfidence(
      node.accessibleName ? (node.context ? 0.91 : 0.83) : 0.68,
    ),
    source: capabilitySource(node, nodeSignature(node)),
    locator: node.locator,
    executor,
    enabled: true,
  };
}

function controlDescriptor(
  node: DiscoveredElement,
): { name: string; description: string } | undefined {
  if (!node.controlType || node.disabled) return undefined;
  const text =
    `${node.accessibleName ?? ""} ${readAttribute(node.element, "name") ?? ""} ${readAttribute(node.element, "id") ?? ""}`.toLowerCase();
  const field = fieldNameForElement(node.element, node.controlType);
  if (node.controlType === "select" && /sort|order/.test(text))
    return {
      name: "change_sort",
      description: "Change the visible result ordering.",
    };
  if (
    (node.controlType === "select" ||
      node.controlType === "checkbox" ||
      node.controlType === "radio") &&
    /filter|category|brand|price|availability|rating/.test(text)
  ) {
    return {
      name: "filter_results",
      description: "Filter the visible results.",
    };
  }
  if (node.controlType === "checkbox" && node.accessibleName)
    return {
      name: `set_${slugify(node.accessibleName, field)}`,
      description: `Set ${node.accessibleName}.`,
    };
  if (node.controlType === "radio" && node.accessibleName)
    return {
      name: `choose_${slugify(readAttribute(node.element, "name") ?? node.accessibleName, field)}`,
      description: `Choose a ${node.accessibleName} option.`,
    };
  return undefined;
}

function controlCapability(
  node: DiscoveredElement,
  descriptor: { name: string; description: string },
): Capability {
  const valueField = fieldNameForElement(
    node.element,
    node.controlType ?? "value",
  );
  const schema: JSONSchema = {
    type: "object",
    properties: { [valueField]: schemaProperty(valueField, node) },
    additionalProperties: false,
    required: [valueField],
  };
  const executor: Extract<ExecutorDefinition, { kind: "control" }> = {
    kind: "control",
    control: node.controlType ?? "input",
    target: node.locator,
    valueField,
    expected: { event: "change", waitMs: 700 },
  };
  return {
    id: capabilityId(descriptor.name, node.locator, "control"),
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: schema,
    effect: "interact",
    confidence: clampConfidence(node.accessibleName ? 0.8 : 0.62),
    source: capabilitySource(node, nodeSignature(node)),
    locator: node.locator,
    executor,
    enabled: true,
  };
}

function deduplicateCapabilityRecords(
  records: InferredCapabilityRecord[],
): InferredCapabilityRecord[] {
  const byIdentity = new Map<string, InferredCapabilityRecord>();
  for (const record of records) {
    const existing = byIdentity.get(record.capability.id);
    if (
      !existing ||
      record.capability.confidence > existing.capability.confidence
    ) {
      byIdentity.set(record.capability.id, record);
    }
  }
  return Array.from(byIdentity.values()).sort(
    (left, right) =>
      left.capability.name.localeCompare(right.capability.name) ||
      left.capability.id.localeCompare(right.capability.id),
  );
}

/**
 * Compile a discovery snapshot into user-level capabilities. DOM records are
 * kept separate from this step so graph/lifecycle consumers never need to
 * rediscover semantic meaning from raw nodes.
 */
export function inferCapabilityRecords(
  snapshot: DiscoverySnapshot,
): InferredCapabilityRecord[];
export function inferCapabilityRecords(
  document: Document,
  options?: ScanOptions,
): InferredCapabilityRecord[];
export function inferCapabilityRecords(
  source: DiscoverySnapshot | Document,
  options: ScanOptions = {},
): InferredCapabilityRecord[] {
  const snapshot = isDiscoverySnapshot(source)
    ? source
    : discoverDocument(source, {
        includeFrames: options.includeFrames ?? true,
        includeShadowDom: options.includeShadowDom ?? true,
      });
  const capabilities: InferredCapabilityRecord[] = [];
  const formsWithCapabilities = new Set<Element>();
  const usedActionNodes = new Set<Element>();

  for (const form of snapshot.forms) {
    const purpose = formPurpose(form);
    if (
      !purpose ||
      form.controls.every((control) => control.disabled || !control.controlType)
    )
      continue;
    capabilities.push({
      capability: formCapability(form, purpose),
      element: form.element,
    });
    formsWithCapabilities.add(form.element);
  }

  for (const node of snapshot.elements) {
    if (node.disabled) continue;
    const form = node.form;
    if (form && formsWithCapabilities.has(form)) {
      // A form capability owns its fields and submit action. Contextual item
      // actions remain eligible even when nested in a form.
      if (
        node.kind === "button" ||
        node.kind === "link" ||
        node.kind === "action"
      ) {
        const descriptor = actionName(node);
        if (descriptor && node.entity) {
          capabilities.push({
            capability: actionCapability(node, descriptor),
            element: node.element,
          });
          usedActionNodes.add(node.element);
        }
      }
      continue;
    }

    if (
      node.kind === "button" ||
      node.kind === "link" ||
      node.kind === "action"
    ) {
      if (usedActionNodes.has(node.element)) continue;
      const descriptor = actionName(node);
      if (descriptor) {
        capabilities.push({
          capability: actionCapability(node, descriptor),
          element: node.element,
        });
        usedActionNodes.add(node.element);
      }
      continue;
    }

    const descriptor = controlDescriptor(node);
    if (descriptor) {
      capabilities.push({
        capability: controlCapability(node, descriptor),
        element: node.element,
      });
    }
  }

  return deduplicateCapabilityRecords(capabilities);
}

export function inferCapabilities(snapshot: DiscoverySnapshot): Capability[];
export function inferCapabilities(
  document: Document,
  options?: ScanOptions,
): Capability[];
export function inferCapabilities(
  source: DiscoverySnapshot | Document,
  options: ScanOptions = {},
): Capability[] {
  const records = isDiscoverySnapshot(source)
    ? inferCapabilityRecords(source)
    : inferCapabilityRecords(source, options);
  return records.map(({ capability }) => capability);
}

function isDiscoverySnapshot(
  value: DiscoverySnapshot | Document,
): value is DiscoverySnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    "elements" in value &&
    "forms" in value &&
    "blocked" in value
  );
}

export const compileDiscoveredCapabilities = inferCapabilities;
