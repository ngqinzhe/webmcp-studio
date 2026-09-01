(() => {
  const CHANNEL = "webmcp-studio-preview";
  const VERSION = 1;
  const text = (value) => String(value ?? "").trim();
  const token =
    document
      .querySelector('meta[name="webmcp-studio-preview-token"]')
      ?.getAttribute("content") || "";

  if (!token || !window.parent) return;

  const send = (message) =>
    window.parent.postMessage(
      {
        channel: CHANNEL,
        version: VERSION,
        direction: "preview-to-parent",
        token,
        ...message,
      },
      "*",
    );
  const controls = () =>
    Array.from(document.querySelectorAll("input, select, textarea"));
  const evidenceTarget = (tool) => {
    const selector = Array.isArray(tool?.evidence)
      ? tool.evidence.find((item) => item && typeof item.selector === "string")
          ?.selector
      : "";
    if (selector) {
      try {
        const match = document.querySelector(selector);
        if (match) return match;
      } catch {
        // A malformed external selector is evidence only, not executable code.
      }
    }
    return document.body;
  };
  const controlFor = (key) =>
    controls().find(
      (control) =>
        control.getAttribute("name") === key ||
        control.id === key ||
        control.getAttribute("aria-label") === key ||
        control.getAttribute("placeholder") === key,
    );
  const setVisibleControls = (args) => {
    let changed = 0;
    if (!args || typeof args !== "object" || Array.isArray(args))
      return changed;
    for (const [key, value] of Object.entries(args)) {
      const control = controlFor(key);
      if (!control) continue;
      const inputType = (control.getAttribute("type") || "").toLowerCase();
      if (inputType === "checkbox" || inputType === "radio") {
        const checked = Boolean(value);
        if (control.checked !== checked) changed += 1;
        control.checked = checked;
      } else {
        const next = String(value ?? "");
        if (control.value !== next) changed += 1;
        control.value = next;
      }
      control.dispatchEvent(new Event("input", { bubbles: true }));
      control.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return changed;
  };
  const statusElement = () => {
    let node = document.getElementById("webmcp-studio-preview-status");
    if (node) return node;
    node = document.createElement("div");
    node.id = "webmcp-studio-preview-status";
    node.setAttribute("role", "status");
    node.style.display = "block";
    node.style.margin = "12px";
    node.style.padding = "11px 13px";
    node.style.border = "1px solid rgba(66, 183, 136, .55)";
    node.style.borderRadius = "9px";
    node.style.background = "rgba(66, 183, 136, .14)";
    node.style.color = "#b7f5d7";
    node.style.font = "600 13px/1.4 system-ui, sans-serif";
    (document.body || document.documentElement).prepend(node);
    return node;
  };
  const markEvidence = (target, name) => {
    if (!(target instanceof Element)) return 0;
    target.setAttribute("data-webmcp-studio-preview-tool", name);
    target.style.outline = "2px solid rgba(66, 183, 136, .78)";
    target.style.outlineOffset = "3px";
    target.style.borderRadius = "6px";
    return 1;
  };
  const run = (tool, args) => {
    const name = text(tool?.name) || "inferred_tool";
    const target = evidenceTarget(tool || {});
    const changedControls = setVisibleControls(args);
    const signal = (name + " " + JSON.stringify(args || {})).toLowerCase();
    let matchedElements = 0;
    if (/(search|find|query|filter|sort)/.test(signal)) {
      const query = text(
        args &&
          (args.query || args.search || args.requirements || args.keyword),
      ).toLowerCase();
      const cards = Array.from(
        document.querySelectorAll(
          "article, li, [role=option], [data-product], [data-item], [data-testid]",
        ),
      );
      for (const card of cards.slice(0, 120)) {
        const matches =
          !query || text(card.textContent).toLowerCase().includes(query);
        card.setAttribute(
          "data-webmcp-studio-preview-match",
          matches ? "true" : "false",
        );
        if (matches) matchedElements += 1;
      }
    }
    markEvidence(target, name);
    const mutation =
      /(add|cart|buy|purchase|reserve|book|select|submit|checkout|save|subscribe)/.test(
        name.toLowerCase(),
      );
    if (mutation) statusElement().dataset.mutation = "true";
    const status = statusElement();
    status.textContent =
      "Inferred preview ran " + name + " on this safe page snapshot.";
    return {
      ok: true,
      success: true,
      status: "completed",
      toolName: name,
      stateChanged: true,
      navigationOccurred: false,
      preview: true,
      changedControls,
      matchedElements,
      evidenceTarget:
        target instanceof Element
          ? target.id || target.tagName.toLowerCase()
          : "document",
      warnings: [],
      message:
        "The Studio-owned snapshot visibly reflects the inferred action.",
    };
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (
      !data ||
      data.channel !== CHANNEL ||
      data.version !== VERSION ||
      data.direction !== "parent-to-preview" ||
      data.type !== "invoke" ||
      data.token !== token
    )
      return;
    try {
      send({
        type: "result",
        requestId: text(data.requestId),
        toolName: text(data.toolName),
        result: run(data.tool || {}, data.args || {}),
      });
    } catch (error) {
      send({
        type: "error",
        requestId: text(data.requestId),
        toolName: text(data.toolName),
        error: {
          code: "execution_failed",
          message:
            error instanceof Error
              ? error.message
              : "The inferred preview action failed.",
        },
      });
    }
  });

  const announceReady = () => send({ type: "ready" });
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", announceReady, {
      once: true,
    });
  else announceReady();
})();
