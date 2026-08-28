const byId = (id) => document.getElementById(id);
const context = document.modelContext;
const history = [];
let agentEditsAllowed = true;
let revision = 0;
let draft = {
  fixtureOnly: true,
  tool: {
    name: "search_catalog",
    nodes: [
      { id: "search", kind: "dom", label: "Submit the search form" },
      { id: "result", kind: "return", label: "Return the search status" },
    ],
  },
};

function snapshot() {
  return structuredClone({ revision, agentEditsAllowed, ...draft });
}

function log(source, action, result) {
  const row = document.createElement("li");
  row.textContent = JSON.stringify({ source, action, revision, result });
  byId("events").append(row);
}

function render() {
  byId("revision").value = String(revision);
  byId("tool-name").value = draft.tool.name;
  byId("project").textContent = JSON.stringify(snapshot(), null, 2);
  byId("flow").replaceChildren(
    ...draft.tool.nodes.map((node) => {
      const row = document.createElement("li");
      row.textContent = `${node.id} · ${node.kind} · ${node.label}`;
      return row;
    }),
  );
  byId("undo").disabled = history.length === 0;
  byId("revoke").disabled = !agentEditsAllowed;
}

function edit(input, source) {
  let error;
  if (source === "native" && !agentEditsAllowed) {
    error = "agent_edits_revoked";
  } else if (
    !input ||
    !Number.isInteger(input.expectedRevision) ||
    input.expectedRevision !== revision
  ) {
    error = "revision_conflict";
  } else if (input.kind !== "rename_tool" && input.kind !== "insert_wait") {
    error = "invalid_edit";
  } else if (
    typeof input.value !== "string" ||
    !input.value.trim() ||
    input.value.length > 64 ||
    (input.kind === "rename_tool" && !/^[a-z][a-z0-9_]*$/.test(input.value))
  ) {
    error = "invalid_value";
  }
  if (error) {
    const result = { ok: false, error, currentRevision: revision };
    log(source, "edit_draft", result);
    return result;
  }
  history.push(structuredClone(draft));
  if (input.kind === "rename_tool") {
    draft.tool.name = input.value;
  } else {
    draft.tool.nodes.splice(-1, 0, {
      id: `wait-${revision + 1}`,
      kind: "wait",
      label: input.value.trim(),
    });
  }
  revision += 1;
  render();
  byId("edit-status").textContent =
    `Revision ${revision} updated by ${source}.`;
  const result = { ok: true, project: snapshot() };
  log(source, "edit_draft", result);
  return result;
}

byId("rename-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const result = edit(
    {
      expectedRevision: revision,
      kind: "rename_tool",
      value: byId("tool-name").value,
    },
    "ui",
  );
  if (!result.ok) byId("edit-status").textContent = result.error;
});
byId("add-wait").addEventListener("click", () => {
  edit(
    {
      expectedRevision: revision,
      kind: "insert_wait",
      value: "Wait for visible search results",
    },
    "ui",
  );
});
byId("undo").addEventListener("click", () => {
  if (history.length === 0) return;
  draft = history.pop();
  revision += 1;
  render();
  byId("edit-status").textContent =
    `Undid the last edit; revision ${revision}.`;
  log("ui", "undo", { ok: true });
});
byId("revoke").addEventListener("click", () => {
  agentEditsAllowed = false;
  revision += 1;
  render();
  byId("edit-status").textContent = "Agent draft edits are revoked.";
  log("ui", "revoke_agent_edits", { ok: true });
});

byId("environment").textContent = JSON.stringify(
  {
    origin: location.origin,
    userAgent: navigator.userAgent,
    secureContext: window.isSecureContext,
    topLevel: window.top === window,
    modelContextPresent: Boolean(context),
    registerTool: typeof context?.registerTool,
    unregisterTool: typeof context?.unregisterTool,
    apiMockedByFixture: false,
    extensionBridgeImplemented: false,
  },
  null,
  2,
);
render();

const emptyInput = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
const tools = [
  {
    name: "studio_get_guide",
    description:
      "Read this local feasibility fixture's guide, next step, and blockers. Does not edit anything or access other websites.",
    inputSchema: emptyInput,
    annotations: { readOnlyHint: true },
    execute: async () => {
      const result = {
        fixtureOnly: true,
        nextStep: agentEditsAllowed
          ? "Read the current draft, then edit it with its expected revision."
          : "Agent editing is revoked. Keep the draft read-only until the human starts a new experiment.",
        blockers: [
          ...(!agentEditsAllowed ? ["Agent draft edits are revoked."] : []),
          "The ChatGPT account/app setup has not been verified by this fixture.",
          "No selected-tab extension bridge is implemented in this fixture.",
          "This fixture does not perform discovery or activate website tools.",
        ],
        revision,
        agentEditsAllowed,
      };
      log("native", "get_guide", result);
      return result;
    },
  },
  {
    name: "studio_get_project",
    description:
      "Read the current local shared draft, including UI edits, revision, and whether agent edits are allowed. No network access.",
    inputSchema: emptyInput,
    annotations: { readOnlyHint: true },
    execute: async () => {
      const result = snapshot();
      log("native", "get_project", result);
      return result;
    },
  },
  {
    name: "studio_edit_draft",
    description:
      "Rename the local draft tool or insert a wait node before its return node. Requires the current expectedRevision. Edits are visible and undoable; nothing is activated and no target website is accessed.",
    inputSchema: {
      type: "object",
      properties: {
        expectedRevision: { type: "integer", minimum: 0 },
        kind: { type: "string", enum: ["rename_tool", "insert_wait"] },
        value: { type: "string", minLength: 1, maxLength: 64 },
      },
      required: ["expectedRevision", "kind", "value"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    execute: async (input) => edit(input, "native"),
  },
];

if (typeof context?.registerTool !== "function") {
  byId("native-status").textContent =
    "UNSUPPORTED: native document.modelContext.registerTool is unavailable. No fallback or mock was installed.";
} else {
  try {
    for (const tool of tools) await context.registerTool(tool);
    byId("native-status").textContent =
      "Registered 3 tools with the browser-provided API. Registration alone is not invocation proof.";
  } catch (error) {
    byId("native-status").textContent = `Registration failed: ${error.message}`;
  }
}
