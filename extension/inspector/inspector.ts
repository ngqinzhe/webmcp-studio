import type {
  ExtensionMessage,
  ExtensionResponse,
} from "../../core/bridge-protocol";
import type {
  Capability,
  CapabilityGraph,
  ExecutionResult,
  InspectorState,
  JsonValue,
} from "../../core/types";

type ExtensionCommand = Exclude<
  ExtensionMessage,
  { type: "polyfill:state-update" }
>;

const tabId = (() => {
  const value = new URLSearchParams(window.location.search).get("tabId");
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
})();

function requiredElement<T extends Element>(selector: string): T {
  const node = document.querySelector<T>(selector);
  if (!node) throw new Error(`Inspector markup is missing ${selector}.`);
  return node;
}

const refs = {
  connection: requiredElement<HTMLElement>("#connection-state"),
  pageTitle: requiredElement<HTMLElement>("#page-title"),
  pageUrl: requiredElement<HTMLElement>("#page-url"),
  enabled: requiredElement<HTMLInputElement>("#enabled"),
  webmcpState: requiredElement<HTMLElement>("#webmcp-state"),
  webmcpMethods: requiredElement<HTMLElement>("#webmcp-methods"),
  nativeCount: requiredElement<HTMLElement>("#native-count"),
  inferredCount: requiredElement<HTMLElement>("#inferred-count"),
  adapterCount: requiredElement<HTMLElement>("#adapter-count"),
  blockedCount: requiredElement<HTMLElement>("#blocked-count"),
  capabilityList: requiredElement<HTMLElement>("#capability-list"),
  capabilityDetail: requiredElement<HTMLElement>("#capability-detail"),
  arguments: requiredElement<HTMLTextAreaElement>("#arguments"),
  invokeHelp: requiredElement<HTMLElement>("#invoke-help"),
  invoke: requiredElement<HTMLButtonElement>("#invoke"),
  export: requiredElement<HTMLButtonElement>("#export"),
  result: requiredElement<HTMLElement>("#execution-result"),
  graphToggle: requiredElement<HTMLButtonElement>("#graph-toggle"),
  graphJson: requiredElement<HTMLElement>("#graph-json"),
  nativeTools: requiredElement<HTMLElement>("#native-tools"),
  rescan: requiredElement<HTMLButtonElement>("#rescan"),
};

let state: InspectorState | null = null;
let selectedCapabilityId: string | null = null;
let graphVisible = false;
let transportError: { label: string; detail: string } | null = null;
let invocationError: string | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function isJsonPrimitive(
  value: unknown,
): value is string | number | boolean | null {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function isJsonValue(
  value: unknown,
  ancestors = new Set<object>(),
): value is JsonValue {
  if (isJsonPrimitive(value)) return true;
  if (!value || typeof value !== "object" || ancestors.has(value)) return false;

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, nextAncestors));
  }
  return Object.values(value).every((item) => isJsonValue(item, nextAncestors));
}

function optionalString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === "string";
}

function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean {
  return record[key] === undefined || typeof record[key] === "boolean";
}

function optionalFiniteNumber(
  record: Record<string, unknown>,
  key: string,
): boolean {
  return record[key] === undefined || isFiniteNumber(record[key]);
}

function optionalNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
): boolean {
  return record[key] === undefined || isNonNegativeInteger(record[key]);
}

function isSchemaType(value: unknown): boolean {
  return (
    value === "string" ||
    value === "number" ||
    value === "integer" ||
    value === "boolean" ||
    value === "object" ||
    value === "array" ||
    value === "null"
  );
}

function isJsonSchema(
  value: unknown,
  ancestors = new Set<object>(),
): value is Capability["inputSchema"] {
  if (!isRecord(value) || ancestors.has(value)) return false;
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);

  if (
    !optionalString(value, "$schema") ||
    !optionalString(value, "title") ||
    !optionalString(value, "description") ||
    !optionalString(value, "format")
  ) {
    return false;
  }
  if (
    value.type !== undefined &&
    !(
      isSchemaType(value.type) ||
      (Array.isArray(value.type) && value.type.every(isSchemaType))
    )
  ) {
    return false;
  }
  if (
    value.enum !== undefined &&
    (!Array.isArray(value.enum) || !value.enum.every(isJsonPrimitive))
  ) {
    return false;
  }
  if (
    value.properties !== undefined &&
    (!isRecord(value.properties) ||
      !Object.values(value.properties).every((item) =>
        isJsonSchema(item, nextAncestors),
      ))
  ) {
    return false;
  }
  if (value.required !== undefined && !isStringArray(value.required)) {
    return false;
  }
  if (value.items !== undefined && !isJsonSchema(value.items, nextAncestors)) {
    return false;
  }
  if (
    value.additionalProperties !== undefined &&
    typeof value.additionalProperties !== "boolean" &&
    !isJsonSchema(value.additionalProperties, nextAncestors)
  ) {
    return false;
  }
  if (
    !optionalFiniteNumber(value, "minimum") ||
    !optionalFiniteNumber(value, "maximum") ||
    !optionalFiniteNumber(value, "minLength") ||
    !optionalFiniteNumber(value, "maxLength")
  ) {
    return false;
  }
  return (
    (value.pattern === undefined || typeof value.pattern === "string") &&
    (value.default === undefined || isJsonPrimitive(value.default))
  );
}

function isFramePath(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isNonNegativeInteger);
}

function isStableAttribute(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    typeof value.value === "string"
  );
}

function isShadowHostLocator(value: unknown): boolean {
  return (
    isRecord(value) &&
    optionalString(value, "role") &&
    optionalString(value, "accessibleName") &&
    (value.stableAttribute === undefined ||
      isStableAttribute(value.stableAttribute)) &&
    optionalString(value, "selector") &&
    optionalNonNegativeInteger(value, "index")
  );
}

function isLocatorContext(value: unknown): boolean {
  return (
    isRecord(value) &&
    optionalString(value, "role") &&
    optionalString(value, "text") &&
    (value.stableAttribute === undefined ||
      isStableAttribute(value.stableAttribute))
  );
}

function isRelationship(value: unknown): boolean {
  return (
    value === "form-control" ||
    value === "form-submit" ||
    value === "context-action" ||
    value === "labelled-control"
  );
}

function isLocatorFallback(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.kind === "role" ||
      value.kind === "label" ||
      value.kind === "stable-attribute" ||
      value.kind === "relationship" ||
      value.kind === "css") &&
    typeof value.description === "string" &&
    optionalString(value, "role") &&
    optionalString(value, "accessibleName") &&
    optionalString(value, "labelText") &&
    (value.stableAttribute === undefined ||
      isStableAttribute(value.stableAttribute)) &&
    optionalString(value, "selector") &&
    (value.relation === undefined || isRelationship(value.relation))
  );
}

function isSemanticLocator(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFramePath(value.framePath) &&
    Array.isArray(value.shadowPath) &&
    value.shadowPath.every(isShadowHostLocator) &&
    optionalString(value, "role") &&
    optionalString(value, "accessibleName") &&
    optionalString(value, "labelText") &&
    (value.context === undefined || isLocatorContext(value.context)) &&
    Array.isArray(value.stableAttributes) &&
    value.stableAttributes.every(isStableAttribute) &&
    (value.relationship === undefined || isRelationship(value.relationship)) &&
    Array.isArray(value.fallbacks) &&
    value.fallbacks.every(isLocatorFallback)
  );
}

function isExpectedOutcome(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const event = value.event;
  return (
    (event === undefined ||
      event === "navigation" ||
      event === "input" ||
      event === "change" ||
      event === "submit" ||
      event === "click") &&
    optionalString(value, "urlPattern") &&
    optionalString(value, "textIncludes") &&
    optionalString(value, "selector") &&
    optionalString(value, "stateAttribute") &&
    optionalFiniteNumber(value, "waitMs")
  );
}

function isEntityReference(value: unknown): boolean {
  return (
    isRecord(value) &&
    optionalString(value, "role") &&
    optionalString(value, "text") &&
    (value.stableAttribute === undefined ||
      isStableAttribute(value.stableAttribute))
  );
}

function isExecutor(value: unknown): boolean {
  if (!isRecord(value) || !isExpectedOutcome(value.expected)) return false;
  switch (value.kind) {
    case "form":
      return (
        isSemanticLocator(value.form) &&
        isRecord(value.fields) &&
        Object.values(value.fields).every(isSemanticLocator) &&
        (value.submit === undefined || isSemanticLocator(value.submit))
      );
    case "control":
      return (
        (value.control === "input" ||
          value.control === "textarea" ||
          value.control === "select" ||
          value.control === "checkbox" ||
          value.control === "radio") &&
        isSemanticLocator(value.target) &&
        typeof value.valueField === "string"
      );
    case "action":
      return (
        (value.action === "click" || value.action === "navigate") &&
        isSemanticLocator(value.target) &&
        (value.entity === undefined || isEntityReference(value.entity))
      );
    case "read":
      return isSemanticLocator(value.target);
    default:
      return false;
  }
}

function isCapabilitySource(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.type === "native" ||
      value.type === "inferred" ||
      value.type === "adapter") &&
    typeof value.url === "string" &&
    isFramePath(value.framePath) &&
    Array.isArray(value.shadowPath) &&
    value.shadowPath.every(isShadowHostLocator) &&
    optionalString(value, "nodeSignature") &&
    optionalString(value, "reason") &&
    optionalString(value, "adapterId")
  );
}

function isCapability(value: unknown): value is Capability {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    isJsonSchema(value.inputSchema) &&
    (value.effect === "read" ||
      value.effect === "navigate" ||
      value.effect === "interact" ||
      value.effect === "mutate") &&
    isFiniteNumber(value.confidence) &&
    value.confidence >= 0 &&
    value.confidence <= 1 &&
    isCapabilitySource(value.source) &&
    isSemanticLocator(value.locator) &&
    isExecutor(value.executor) &&
    optionalBoolean(value, "enabled") &&
    optionalString(value, "nativeEquivalent")
  );
}

function isCapabilityPage(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.url === "string" &&
    typeof value.title === "string" &&
    typeof value.origin === "string" &&
    typeof value.hostname === "string"
  );
}

function isBlockedCapability(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    (value.reason === "cross_origin_blocked" ||
      value.reason === "permission_blocked" ||
      value.reason === "webmcp_unavailable" ||
      value.reason === "unsupported_control") &&
    typeof value.detail === "string" &&
    isFramePath(value.framePath)
  );
}

function isCapabilityGraph(value: unknown): value is CapabilityGraph {
  return (
    isRecord(value) &&
    value.version === 1 &&
    isCapabilityPage(value.page) &&
    isFiniteNumber(value.generatedAt) &&
    isRecord(value.capabilities) &&
    Object.values(value.capabilities).every(isCapability) &&
    Array.isArray(value.blocked) &&
    value.blocked.every(isBlockedCapability)
  );
}

function isNativeTool(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    optionalString(value, "description") &&
    (value.inputSchema === undefined || isJsonSchema(value.inputSchema))
  );
}

function isWebMcpStatus(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.available === "boolean" &&
    isStringArray(value.apiMethods) &&
    Array.isArray(value.nativeTools) &&
    value.nativeTools.every(isNativeTool) &&
    isStringArray(value.registered) &&
    Array.isArray(value.rejected) &&
    value.rejected.every(
      (entry) =>
        isRecord(entry) &&
        typeof entry.name === "string" &&
        typeof entry.message === "string",
    )
  );
}

function isExecutionFailureCode(value: unknown): boolean {
  return (
    value === "target_not_found" ||
    value === "ambiguous_target" ||
    value === "validation_failed" ||
    value === "no_observable_change" ||
    value === "cross_origin_blocked" ||
    value === "permission_blocked" ||
    value === "webmcp_unavailable" ||
    value === "execution_timeout" ||
    value === "unsupported_control" ||
    value === "invalid_arguments" ||
    value === "registration_rejected"
  );
}

function isExecutionError(value: unknown): boolean {
  return (
    isRecord(value) &&
    isExecutionFailureCode(value.code) &&
    typeof value.message === "string" &&
    (value.details === undefined ||
      (isRecord(value.details) &&
        Object.values(value.details).every((item) => isJsonValue(item))))
  );
}

function isExecutionResult(value: unknown): value is ExecutionResult {
  return (
    isRecord(value) &&
    typeof value.success === "boolean" &&
    (value.status === "completed" || isExecutionFailureCode(value.status)) &&
    typeof value.urlBefore === "string" &&
    typeof value.urlAfter === "string" &&
    typeof value.navigationOccurred === "boolean" &&
    typeof value.stateChanged === "boolean" &&
    isStringArray(value.warnings) &&
    optionalString(value, "matchedTarget") &&
    (value.result === undefined || isJsonValue(value.result)) &&
    (value.error === undefined || isExecutionError(value.error))
  );
}

function isInspectorState(value: unknown): value is InspectorState {
  if (!isRecord(value)) return false;
  return (
    (value.graph === null || isCapabilityGraph(value.graph)) &&
    isWebMcpStatus(value.webmcp) &&
    (value.lastExecution === null ||
      (isRecord(value.lastExecution) &&
        typeof value.lastExecution.capabilityId === "string" &&
        isExecutionResult(value.lastExecution.result))) &&
    typeof value.enabled === "boolean" &&
    isFiniteNumber(value.updatedAt)
  );
}

function isStateUpdate(
  value: unknown,
): value is Extract<ExtensionMessage, { type: "polyfill:state-update" }> {
  return (
    isRecord(value) &&
    value.type === "polyfill:state-update" &&
    isInspectorState(value.state)
  );
}

function isExtensionResponse(value: unknown): value is ExtensionResponse {
  if (!isRecord(value)) return false;
  if (value.ok === false) {
    return (
      typeof value.error === "string" &&
      !["state", "graph", "result", "started"].some((key) => key in value)
    );
  }
  if (value.ok !== true) return false;
  if ("error" in value) return false;

  const variants = ["state", "graph", "result", "started"].filter(
    (key) => key in value,
  );
  if (variants.length !== 1) return false;
  switch (variants[0]) {
    case "state":
      return isInspectorState(value.state);
    case "graph":
      return value.graph === null || isCapabilityGraph(value.graph);
    case "result":
      return isExecutionResult(value.result);
    case "started":
      return value.started === true;
    default:
      return false;
  }
}

function cloneForDisplay(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneForDisplay);
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) result[key] = cloneForDisplay(value[key]);
    }
    return result;
  }
  return value;
}

function json(value: unknown): string {
  try {
    const serialized = JSON.stringify(cloneForDisplay(value), null, 2);
    return serialized === undefined
      ? "Unable to serialize this value."
      : serialized;
  } catch {
    return "Unable to serialize this value.";
  }
}

function text(node: HTMLElement, value: string): void {
  node.textContent = value;
}

function setTransportError(label: string, detail: string): void {
  transportError = { label, detail };
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const created = document.createElement(tag);
  if (className) created.className = className;
  return created;
}

function pill(label: string, className: string): HTMLSpanElement {
  const node = element("span", `origin-pill ${className}`);
  node.textContent = label;
  return node;
}

function effectPill(effect: Capability["effect"]): HTMLSpanElement {
  return pill(effect, `effect-pill effect-${effect}`);
}

function currentGraph(): CapabilityGraph | null {
  return state?.graph ?? null;
}

function selectedCapability(): Capability | null {
  const graph = currentGraph();
  return selectedCapabilityId && graph
    ? (graph.capabilities[selectedCapabilityId] ?? null)
    : null;
}

function registrationLabel(capability: Capability): {
  label: string;
  className: string;
} {
  const status = state?.webmcp;
  if (!status) return { label: "Unknown", className: "muted" };
  if (
    status.nativeTools.some(
      (tool) => tool.name.toLowerCase() === capability.name.toLowerCase(),
    )
  )
    return { label: "Native equivalent", className: "origin-native" };
  if (status.registered.includes(capability.name))
    return { label: "Registered", className: "origin-inferred" };
  const rejection = status.rejected.find(
    (candidate) => candidate.name === capability.name,
  );
  if (rejection) return { label: "Rejected", className: "error" };
  if (!state?.enabled) return { label: "Disabled", className: "muted" };
  return { label: "Not registered", className: "muted" };
}

function detailJson(parent: HTMLElement, label: string, value: unknown): void {
  const section = element("div", "detail-section");
  const heading = element("div", "detail-label");
  heading.textContent = label;
  const pre = element("pre", "json-view");
  pre.textContent = json(value);
  section.append(heading, pre);
  parent.append(section);
}

function renderDetail(): void {
  const capability = selectedCapability();
  if (!capability) {
    const empty = element("div", "empty-state large");
    empty.textContent = state?.graph
      ? "Select a capability to inspect its contract."
      : "The page has not produced a capability graph yet.";
    refs.capabilityDetail.replaceChildren(empty);
    refs.invoke.disabled = true;
    refs.export.disabled = !Boolean(state?.graph);
    refs.invokeHelp.textContent =
      "Choose a capability above, then provide JSON arguments.";
    return;
  }

  const root = element("div");
  const header = element("div", "detail-header");
  const title = element("h2");
  title.textContent = capability.name;
  const description = element("p", "detail-description");
  description.textContent = capability.description;
  const meta = element("div", "detail-meta");
  const sourceClass =
    capability.source.type === "adapter"
      ? "origin-adapter"
      : capability.source.type === "native"
        ? "origin-native"
        : "origin-inferred";
  meta.append(
    pill(capability.source.type, sourceClass),
    effectPill(capability.effect),
  );
  const confidence = element("span", "confidence");
  confidence.textContent = `${Math.round(capability.confidence * 100)}% confidence`;
  meta.append(confidence);
  header.append(title, description, meta);
  root.append(header);

  const registration = registrationLabel(capability);
  const registrationSection = element("div", "detail-section");
  const registrationLabelNode = element("div", "detail-label");
  registrationLabelNode.textContent = "Registration";
  const registrationValue = element(
    "div",
    `status-chip ${registration.className}`,
  );
  registrationValue.textContent = registration.label;
  registrationSection.append(registrationLabelNode, registrationValue);
  const rejection = state?.webmcp.rejected.find(
    (candidate) => candidate.name === capability.name,
  );
  if (rejection) {
    const reason = element("p", "muted-copy");
    reason.textContent = rejection.message;
    registrationSection.append(reason);
  }
  root.append(registrationSection);
  detailJson(root, "JSON Schema", capability.inputSchema);
  detailJson(root, "Semantic locator and fallbacks", capability.locator);
  detailJson(root, "Executor", capability.executor);
  detailJson(root, "Source", capability.source);
  refs.capabilityDetail.replaceChildren(root);

  refs.invoke.disabled = !state?.enabled;
  refs.export.disabled = false;
  refs.invokeHelp.textContent = state?.enabled
    ? `Invocation executes ${capability.name} through the page's visible UI.`
    : "Enable inferred tools to invoke this capability.";
}

function renderList(): void {
  const graph = currentGraph();
  if (!graph || Object.keys(graph.capabilities).length === 0) {
    const empty = element("div", "empty-state");
    empty.textContent = "No meaningful capabilities discovered yet.";
    refs.capabilityList.replaceChildren(empty);
    selectedCapabilityId = null;
    return;
  }
  const capabilities = Object.values(graph.capabilities).sort(
    (left, right) =>
      left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
  if (!selectedCapabilityId || !graph.capabilities[selectedCapabilityId])
    selectedCapabilityId = capabilities[0]?.id ?? null;
  const buttons = capabilities.map((capability) => {
    const button = element(
      "button",
      `capability-item${capability.id === selectedCapabilityId ? " selected" : ""}`,
    );
    button.type = "button";
    button.addEventListener("click", () => {
      selectedCapabilityId = capability.id;
      render();
    });
    const top = element("div", "capability-item-top");
    const name = element("span", "capability-name");
    name.textContent = capability.name;
    const origin =
      capability.source.type === "adapter"
        ? "origin-adapter"
        : capability.source.type === "native"
          ? "origin-native"
          : "origin-inferred";
    top.append(
      name,
      pill(capability.source.type, origin),
      effectPill(capability.effect),
    );
    const confidence = element("span", "confidence");
    confidence.textContent = `${Math.round(capability.confidence * 100)}%`;
    top.append(confidence);
    const description = element("span", "capability-description");
    description.textContent = capability.description;
    button.append(top, description);
    return button;
  });
  refs.capabilityList.replaceChildren(...buttons);
}

function renderNativeTools(): void {
  const tools = state?.webmcp.nativeTools ?? [];
  if (tools.length === 0) {
    refs.nativeTools.replaceChildren();
    return;
  }
  const heading = element("div", "detail-label");
  heading.textContent = "Native WebMCP tools";
  const nodes = tools.map((tool) => {
    const item = element("div", "native-tool");
    const name = element("strong");
    name.textContent = tool.name;
    const description = element("span");
    description.textContent = tool.description || "Provided by the page.";
    item.append(name, description);
    return item;
  });
  refs.nativeTools.replaceChildren(heading, ...nodes);
}

function renderResult(): void {
  if (invocationError) {
    refs.result.className = "result-box failure";
    refs.result.textContent = invocationError;
    return;
  }
  const last = state?.lastExecution;
  refs.result.className = `result-box${last?.result.success ? " success" : last ? " failure" : " muted-copy"}`;
  if (!last) {
    refs.result.textContent = "No invocation yet.";
    return;
  }
  refs.result.textContent = json(last.result);
}

function renderGraphJson(): void {
  refs.graphJson.textContent = json(currentGraph());
  refs.graphJson.classList.toggle("hidden", !graphVisible);
  refs.graphToggle.textContent = graphVisible ? "Hide JSON" : "Show JSON";
}

function render(): void {
  const graph = currentGraph();
  const page = graph?.page;
  text(refs.pageTitle, page?.title || page?.hostname || "Waiting for a page");
  text(
    refs.pageUrl,
    transportError?.detail ||
      page?.url ||
      "Activate the extension on a browser tab to inspect its visible UI.",
  );
  refs.enabled.checked = state?.enabled ?? true;
  const webmcp = state?.webmcp;
  text(refs.webmcpState, webmcp?.available ? "Available" : "Unavailable");
  refs.webmcpState.style.color = webmcp?.available
    ? "var(--green)"
    : "var(--orange)";
  text(
    refs.webmcpMethods,
    webmcp?.apiMethods.length
      ? webmcp.apiMethods.join(", ")
      : "document.modelContext not detected",
  );
  text(refs.nativeCount, String(webmcp?.nativeTools.length ?? 0));
  const capabilities = graph ? Object.values(graph.capabilities) : [];
  text(
    refs.inferredCount,
    String(
      capabilities.filter((capability) => capability.source.type === "inferred")
        .length,
    ),
  );
  text(
    refs.adapterCount,
    String(
      capabilities.filter((capability) => capability.source.type === "adapter")
        .length,
    ),
  );
  text(refs.blockedCount, `${graph?.blocked.length ?? 0} blocked`);
  refs.connection.className = `status-chip ${transportError ? "error" : state ? "" : "muted"}`;
  refs.connection.textContent =
    transportError?.label || (state ? "Live page" : "Connecting");
  renderList();
  renderDetail();
  renderNativeTools();
  renderResult();
  renderGraphJson();
}

async function send(message: ExtensionCommand): Promise<ExtensionResponse> {
  try {
    const response: unknown = await chrome.runtime.sendMessage(message);
    if (!isExtensionResponse(response))
      return {
        ok: false,
        error: "The service worker returned an invalid response.",
      };
    return response;
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function withTabId(message: ExtensionCommand): ExtensionCommand {
  return tabId === undefined ? message : { ...message, tabId };
}

async function loadState(): Promise<void> {
  const response = await send(withTabId({ type: "polyfill:get-state" }));
  if (response.ok && "state" in response) {
    state = response.state;
    transportError = null;
  } else if (!response.ok) {
    setTransportError("Page unavailable", response.error);
  } else {
    setTransportError(
      "Invalid state",
      "The service worker returned an unexpected state response.",
    );
  }
  render();
}

async function rescan(): Promise<void> {
  refs.rescan.disabled = true;
  refs.rescan.textContent = "Scanning…";
  try {
    const response = await send(withTabId({ type: "polyfill:rescan" }));
    if (!response.ok) {
      setTransportError("Rescan failed", response.error);
    } else if (!("started" in response)) {
      setTransportError(
        "Rescan failed",
        "The service worker returned an unexpected rescan response.",
      );
    }
    await loadState();
  } finally {
    refs.rescan.disabled = false;
    refs.rescan.textContent = "Rescan page";
  }
}

async function toggleEnabled(): Promise<void> {
  const response = await send(
    withTabId({ type: "polyfill:set-enabled", enabled: refs.enabled.checked }),
  );
  if (response.ok && "state" in response) {
    state = response.state;
    transportError = null;
  } else if (!response.ok) {
    setTransportError("Update failed", response.error);
  } else {
    setTransportError(
      "Update failed",
      "The service worker returned an unexpected state response.",
    );
  }
  render();
}

async function invoke(): Promise<void> {
  const capability = selectedCapability();
  if (!capability) return;
  let args: unknown;
  try {
    const parsed: unknown = JSON.parse(refs.arguments.value);
    if (!isJsonValue(parsed))
      throw new Error("Arguments must contain JSON values only.");
    args = parsed;
  } catch (error) {
    invocationError = `Arguments are not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
    renderResult();
    return;
  }
  invocationError = null;
  refs.invoke.disabled = true;
  refs.invoke.textContent = "Invoking…";
  try {
    const response = await send(
      withTabId({ type: "polyfill:invoke", capabilityId: capability.id, args }),
    );
    if (response.ok && "result" in response) {
      state = state
        ? {
            ...state,
            lastExecution: {
              capabilityId: capability.id,
              result: response.result,
            },
            updatedAt: Date.now(),
          }
        : state;
    } else if (!response.ok) {
      invocationError = response.error;
    } else {
      invocationError =
        "The service worker returned an unexpected invocation response.";
    }
    render();
  } finally {
    refs.invoke.textContent = "Invoke selected tool";
  }
}

function adapterSeed(graph: CapabilityGraph): Record<string, unknown> {
  const capabilities = Object.values(graph.capabilities)
    .filter((capability) => capability.source.type !== "native")
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
    )
    .map((capability) => ({
      id: capability.id,
      name: capability.name,
      description: capability.description,
      effect: capability.effect,
      inputSchema: capability.inputSchema,
      locator: capability.locator,
      source: {
        framePath: capability.source.framePath,
        shadowPath: capability.source.shadowPath,
        nodeSignature: capability.source.nodeSignature,
      },
    }));
  return {
    format: "webmcp-studio-adapter-seed",
    version: 1,
    page: { origin: graph.page.origin, hostname: graph.page.hostname },
    capabilities,
  };
}

function exportAdapter(): void {
  const graph = currentGraph();
  if (!graph) return;
  const body = `${json(adapterSeed(graph))}\n`;
  const blob = new Blob([body], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = element("a");
  anchor.href = url;
  anchor.download = `${graph.page.hostname || "page"}-webmcp-adapter-seed.json`;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

refs.rescan.addEventListener("click", () => void rescan());
refs.enabled.addEventListener("change", () => void toggleEnabled());
refs.invoke.addEventListener("click", () => void invoke());
refs.export.addEventListener("click", exportAdapter);
refs.graphToggle.addEventListener("click", () => {
  graphVisible = !graphVisible;
  renderGraphJson();
});
chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isStateUpdate(message)) return;
  state = message.state;
  transportError = null;
  render();
});

void loadState();
