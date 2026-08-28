import type {
  Capability,
  EntityReference,
  ExecutorDefinition,
  JSONSchema,
  LocatorContext,
  SemanticLocator,
  StableAttribute,
} from "../core/types";
import { defineAdapter } from "../sdk";
import type { AdapterDefinition } from "../sdk";

const PRODUCT_ROLES = new Set(["article", "listitem", "product", "card"]);
const ADD_TO_CART_RE =
  /(?:add|put)(?:\s+this|\s+the)?(?:\s+item)?\s+to\s+(?:the\s+)?(?:shopping\s+)?(?:cart|bag|basket)|add\s+to\s+(?:the\s+)?(?:cart|bag|basket)|\b(?:buy\s+now|purchase)\b/;
const OPEN_PRODUCT_RE =
  /(?:open|view|show|see|select|details?|product|item|learn\s+more)/;

export interface EcommerceProductCardAdapterOptions {
  /** Restrict the adapter to these hostnames and their subdomains. */
  readonly hostnames?: readonly string[];
}

function actionOf(
  capability: Capability,
): Extract<ExecutorDefinition, { kind: "action" }> | null {
  return capability.executor.kind === "action" ? capability.executor : null;
}

function entityOf(capability: Capability): EntityReference | undefined {
  return actionOf(capability)?.entity;
}

function normalise(value: string | undefined): string {
  return (value ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function productTextOf(capability: Capability): string | undefined {
  const contextText = capability.locator.context?.text?.trim();
  const entityText = entityOf(capability)?.text?.trim();
  const candidate = entityText || contextText;
  if (!candidate) return undefined;
  return candidate.replace(/\s+/g, " ").slice(0, 120);
}

function productRoleOf(capability: Capability): string | undefined {
  const role = capability.locator.context?.role ?? entityOf(capability)?.role;
  return role?.trim().toLowerCase();
}

export function hasProductCardContext(capability: Capability): boolean {
  const role = productRoleOf(capability);
  if (role && (PRODUCT_ROLES.has(role) || role.includes("product")))
    return true;
  return Boolean(
    productTextOf(capability) &&
    (capability.locator.context?.stableAttribute ||
      entityOf(capability)?.stableAttribute),
  );
}

export function isCartCapability(capability: Capability): boolean {
  const action = actionOf(capability);
  if (!action) return false;
  const text = normalise(
    [
      capability.name,
      capability.description,
      action.target.accessibleName,
      action.target.labelText,
    ]
      .filter((value): value is string => Boolean(value))
      .join(" "),
  );
  return ADD_TO_CART_RE.test(text);
}

function isProductNavigationCapability(capability: Capability): boolean {
  const action = actionOf(capability);
  if (
    !action ||
    action.action !== "navigate" ||
    !hasProductCardContext(capability)
  ) {
    return false;
  }
  return (
    OPEN_PRODUCT_RE.test(normalise(capability.name)) ||
    Boolean(productTextOf(capability))
  );
}

function isProductCapability(capability: Capability): boolean {
  return (
    hasProductCardContext(capability) &&
    (isCartCapability(capability) || isProductNavigationCapability(capability))
  );
}

function emptyArgumentsSchema(description: string): JSONSchema {
  return {
    type: "object",
    properties: {},
    additionalProperties: false,
    description,
  };
}

function contextualSchema(
  capability: Capability,
  description: string,
): JSONSchema {
  const base =
    capability.inputSchema.type === "object"
      ? { ...capability.inputSchema }
      : emptyArgumentsSchema(description);
  const schema: JSONSchema = { ...base, description };
  if (schema.additionalProperties === undefined)
    schema.additionalProperties = false;
  return schema;
}

function pushStableAttribute(
  attributes: StableAttribute[],
  attribute: StableAttribute | undefined,
): void {
  if (!attribute) return;
  if (
    attributes.some(
      (candidate) =>
        candidate.name === attribute.name &&
        candidate.value === attribute.value,
    )
  ) {
    return;
  }
  attributes.push({ ...attribute });
}

export function contextualProductLocator(
  capability: Capability,
): SemanticLocator {
  const action = actionOf(capability);
  const entity = entityOf(capability);
  const base = action?.target ?? capability.locator;
  const productText = productTextOf(capability);
  const role = base.context?.role ?? entity?.role;
  const text = base.context?.text ?? productText;
  const stableAttribute =
    base.context?.stableAttribute ?? entity?.stableAttribute;
  const context: LocatorContext = {
    ...(role ? { role } : {}),
    ...(text ? { text } : {}),
    ...(stableAttribute ? { stableAttribute } : {}),
  };
  const stableAttributes = base.stableAttributes.map((attribute) => ({
    ...attribute,
  }));
  pushStableAttribute(stableAttributes, entity?.stableAttribute);
  const fallbacks = base.fallbacks.map((fallback) => ({ ...fallback }));
  if (!fallbacks.some((fallback) => fallback.relation === "context-action")) {
    fallbacks.push({
      kind: "relationship",
      description: "Resolve the action within its product-card context",
      relation: "context-action",
    });
  }
  return {
    ...base,
    ...(Object.keys(context).length > 0 ? { context } : {}),
    relationship: "context-action",
    stableAttributes,
    fallbacks,
  };
}

function productDescription(
  capability: Capability,
  verb: "add" | "open",
): string {
  const product = productTextOf(capability);
  if (verb === "add") {
    return product
      ? `Add ${product} to the shopping cart.`
      : "Add the selected product to the shopping cart.";
  }
  return product
    ? `Open the product page for ${product}.`
    : "Open the selected product page.";
}

function discoveredProductPageCapability(capability: Capability): Capability {
  const action = actionOf(capability);
  if (!action)
    throw new Error("Product page discovery requires an action executor");
  const description = productDescription(capability, "open");
  const locator = contextualProductLocator(capability);
  const source = {
    ...capability.source,
    nodeSignature: `${capability.source.nodeSignature ?? capability.id}:open-product`,
  };
  const executor: ExecutorDefinition = {
    kind: "action",
    action: "navigate",
    target: locator,
    expected: { ...action.expected, event: "navigation" },
    ...(action.entity ? { entity: { ...action.entity } } : {}),
  };
  return {
    ...capability,
    id: `${capability.id}:open-product`,
    name: "open_product",
    description,
    inputSchema: emptyArgumentsSchema(description),
    effect: "navigate",
    confidence: Math.min(1, capability.confidence + 0.06),
    source,
    locator,
    executor,
  };
}

function hostnameMatches(
  hostname: string,
  patterns: readonly string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return true;
  const normalisedHostname = hostname.toLowerCase();
  return patterns.some((pattern) => {
    const normalisedPattern = pattern
      .trim()
      .toLowerCase()
      .replace(/^\.+|\.+$/g, "");
    return (
      normalisedPattern.length > 0 &&
      (normalisedHostname === normalisedPattern ||
        normalisedHostname.endsWith(`.${normalisedPattern}`))
    );
  });
}

export function createEcommerceProductCardAdapter(
  options: EcommerceProductCardAdapterOptions = {},
): AdapterDefinition {
  return defineAdapter({
    id: "ecommerce-product-card",
    name: "Ecommerce product cards",
    match: ({ graph }) =>
      hostnameMatches(graph.page.hostname, options.hostnames) &&
      Object.values(graph.capabilities).some(isProductCapability),
    discover: ({ capabilities }) => {
      const existingNames = new Set(
        capabilities.map((capability) => normalise(capability.name)),
      );
      if (existingNames.has("open product")) return [];
      return capabilities
        .filter(isProductNavigationCapability)
        .map(discoveredProductPageCapability);
    },
    override: ({ capability }) => {
      if (!isCartCapability(capability) || !hasProductCardContext(capability))
        return undefined;
      const description = productDescription(capability, "add");
      return {
        name: "add_to_cart",
        description,
        inputSchema: contextualSchema(capability, description),
        locator: contextualProductLocator(capability),
        confidence: Math.min(1, capability.confidence + 0.08),
      };
    },
    suppress: ({ capability, capabilities }) => {
      if (capability.source.type === "native") return false;
      if (!isCartCapability(capability) || hasProductCardContext(capability))
        return false;
      return capabilities.some(
        (candidate) =>
          candidate.id !== capability.id && hasProductCardContext(candidate),
      );
    },
  });
}

export const ecommerceProductCardAdapter = createEcommerceProductCardAdapter();
export const ecommerceAdapter = ecommerceProductCardAdapter;
