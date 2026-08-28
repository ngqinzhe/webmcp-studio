const byId = (id) => document.getElementById(id);
let context;
let contextError = null;
try {
  context = document.modelContext;
} catch (error) {
  contextError = errorDetails(error);
}

let busy = false;
let capturedTool = null;
let capturedSummary = null;
let capturedAt = null;
let submissions = 0;
const searchForm = byId("product-search");
const formAnchor = document.createComment("synthetic search form location");
searchForm.before(formAnchor);
const marker =
  new URLSearchParams(location.search).get("marker") ||
  "tab-" +
    (typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Date.now().toString(36));
byId("tab-marker").value = marker;

function errorDetails(error) {
  return {
    name: typeof error?.name === "string" ? error.name : null,
    message: typeof error?.message === "string" ? error.message : null,
    asString: String(error),
  };
}

function displayValue(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch (error) {
    return (
      "Value is not JSON-serializable: " +
      String(error) +
      "\nString representation: " +
      String(value)
    );
  }
}

function visibleEffects() {
  return {
    tabMarker: byId("tab-marker").value,
    submissionCounter: byId("submission-count").value,
    status: byId("search-status").textContent,
    visibleQuery: byId("query")?.value ?? null,
    formPresent: Boolean(byId("product-search")),
  };
}

function describeTool(tool) {
  return {
    name: tool.name,
    origin: tool.origin,
    localWindow: tool.window === window,
    inputSchema: tool.inputSchema ?? null,
  };
}

byId("environment").textContent = displayValue({
  evidence: "Installed-extension/native-browser-API component diagnostic only",
  nativeAgentInvocation: false,
  fixtureRegistersTools: false,
  fixtureMocksApi: false,
  fixtureImportsRuntime: false,
  origin: location.origin,
  userAgent: navigator.userAgent,
  secureContext: window.isSecureContext,
  originAgentCluster: window.originAgentCluster ?? null,
  modelContextPresent: Boolean(context),
  methods: {
    getTools: typeof context?.getTools,
    executeTool: typeof context?.executeTool,
    registerTool: typeof context?.registerTool,
  },
  contextError,
});

byId("product-search").addEventListener("submit", (event) => {
  event.preventDefault();
  submissions += 1;
  byId("submission-count").value = String(submissions);
  byId("search-status").textContent =
    "Results for " +
    byId("query").value +
    " in " +
    byId("tab-marker").value +
    ".";
});

async function captureInventory() {
  if (busy) return;
  busy = true;
  capturedTool = null;
  capturedSummary = null;
  capturedAt = null;
  let inventory = [];
  let error = null;
  try {
    if (typeof context?.getTools !== "function") {
      throw new Error("Native document.modelContext.getTools is unavailable.");
    }
    const tools = await context.getTools();
    if (!Array.isArray(tools)) {
      throw new TypeError("Native getTools did not return an array.");
    }
    inventory = tools.map(describeTool);
    const matches = tools.filter(
      (tool) =>
        tool.name === "search_products" &&
        tool.origin === location.origin &&
        tool.window === window,
    );
    if (matches.length !== 1) {
      throw new Error(
        "Expected one local search_products registration; found " +
          matches.length +
          ". No descriptor was selected.",
      );
    }
    capturedTool = matches[0];
    capturedSummary = describeTool(capturedTool);
    capturedAt = new Date().toISOString();
  } catch (cause) {
    error = errorDetails(cause);
  } finally {
    busy = false;
  }
  // Render only after the native operation settles, never while it runs.
  byId("native-inventory").textContent = displayValue({
    capturedAt,
    inventory,
    captured: capturedSummary,
    error,
  });
  byId("operation-status").textContent = error
    ? "Inventory capture did not select a tool. See the exact error above."
    : "Captured the native object for this page's search_products tool.";
}

async function invokeCaptured(args, kind) {
  if (busy) return;
  busy = true;
  const before = visibleEffects();
  const startedAt = new Date().toISOString();
  const serializedArguments = JSON.stringify(args);
  let attempted = false;
  let resolved = false;
  let result;
  let error = null;
  try {
    if (!capturedTool) {
      throw new Error("Capture one matching native tool before invoking.");
    }
    if (typeof context?.executeTool !== "function") {
      throw new Error(
        "Native document.modelContext.executeTool is unavailable.",
      );
    }
    attempted = true;
    // Current Chrome guide format. Do not retry with another format or call a
    // descriptor callback, extension runtime, or direct executor.
    result = await context.executeTool(capturedTool, serializedArguments);
    resolved = true;
  } catch (cause) {
    error = errorDetails(cause);
  }
  const after = visibleEffects();
  const completedAt = new Date().toISOString();
  busy = false;

  // All diagnostic writes happen after executeTool resolves or rejects.
  byId("call-record").textContent = displayValue({
    evidence: "Page-mediated native API call; not native-agent G3 proof",
    nativeAgentInvocation: false,
    kind,
    attempted,
    apiPromiseResolved: resolved,
    startedAt,
    completedAt,
    capturedAt,
    captured: capturedSummary,
    inputFormat: "JSON string passed as executeTool's second argument",
    argumentObject: args,
    serializedSecondArgument: serializedArguments,
    returnType: resolved ? typeof result : null,
    before,
    after,
  });
  byId("raw-result").textContent = resolved
    ? displayValue(result)
    : "No native return: the call was not attempted or rejected.";
  byId("raw-error").textContent = error ? displayValue(error) : "None.";
  byId("operation-status").textContent = resolved
    ? "executeTool resolved. Check the raw return and visible effects."
    : "executeTool was not attempted or rejected. No fallback or retry occurred.";
}

byId("capture-inventory").addEventListener("click", () => {
  void captureInventory();
});
byId("invoke-query").addEventListener("click", () => {
  void invokeCaptured({ q: byId("invocation-query").value }, "query");
});
byId("invoke-empty").addEventListener("click", () => {
  void invokeCaptured({}, "empty arguments");
});
byId("remove-form").addEventListener("click", () => {
  if (busy) return;
  searchForm.remove();
});
byId("restore-form").addEventListener("click", () => {
  if (busy || searchForm.isConnected) return;
  formAnchor.after(searchForm);
});
