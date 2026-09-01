(() => {
  const CHANNEL = "webmcp-studio-preview";
  const VERSION = 1;
  const text = (value) => String(value ?? "").trim();
  const metaToken =
    document
      .querySelector('meta[name="webmcp-studio-preview-token"]')
      ?.getAttribute("content") || "";
  let token = metaToken;
  if (!token) {
    try {
      token = new URL(window.location.href).searchParams.get("token") || "";
    } catch {
      token = "";
    }
  }

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
  const loadSnapshot = (html) => {
    const root = document.getElementById("webmcp-studio-preview-root");
    if (!root || typeof html !== "string") return;
    // The server already strips executable and network-bearing markup. Parse
    // into a detached document once more so even a malformed response cannot
    // replace this trusted bridge shell or execute a fetched script.
    const parsed = new DOMParser().parseFromString(html, "text/html");
    root.replaceChildren(
      ...Array.from(parsed.body?.childNodes || []).map((node) =>
        document.importNode(node, true),
      ),
    );
    if (parsed.title) document.title = parsed.title;
  };
  const previewState = {
    visibleIds: new Set(),
    cartCount: 0,
    selectedId: "",
  };
  const argumentValue = (args, keys) => {
    if (!args || typeof args !== "object" || Array.isArray(args)) return "";
    for (const key of keys) {
      const value = args[key];
      if (value !== undefined && value !== null && String(value).trim())
        return value;
    }
    return "";
  };
  const argumentNumber = (args, keys, fallback = 1) => {
    const raw = argumentValue(args, keys);
    if (raw === "") return fallback;
    const value = Number(raw);
    return Number.isFinite(value) ? value : fallback;
  };
  const evidenceSelector = (tool) =>
    Array.isArray(tool?.evidence)
      ? tool.evidence.find((item) => item && typeof item.selector === "string")
          ?.selector || ""
      : "";
  const evidenceTarget = (tool) => {
    const selector = evidenceSelector(tool);
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
  const itemSelectors = [
    "[data-product-id]",
    "[data-product]",
    "[data-item-id]",
    "[data-item]",
    "[data-option-id]",
    "[data-option]",
    "[data-flight-id]",
    "[role=option]",
    "article",
  ];
  const firstAttribute = (element, names) => {
    for (const name of names) {
      const value = element.getAttribute(name);
      if (value && value.trim()) return value.trim();
    }
    return "";
  };
  const itemRecords = () => {
    let elements = [];
    for (const selector of itemSelectors) {
      try {
        elements = Array.from(document.querySelectorAll(selector));
      } catch {
        elements = [];
      }
      if (elements.length) break;
    }
    const seen = new Set();
    return elements.slice(0, 120).flatMap((element, index) => {
      if (seen.has(element)) return [];
      seen.add(element);
      const textContent = text(element.textContent);
      if (!textContent) return [];
      const id =
        firstAttribute(element, [
          "data-product-id",
          "data-product",
          "data-item-id",
          "data-item",
          "data-option-id",
          "data-option",
          "data-flight-id",
          "data-id",
          "id",
        ]) || `preview-item-${index + 1}`;
      const priceMatch = textContent.match(
        /(?:[$€£¥₹]\s?|(USD|SGD|EUR|GBP)\s?)(\d[\d,.]*)/i,
      );
      const price = priceMatch ? Number(priceMatch[2].replace(/,/g, "")) : null;
      return [{ element, id, text: textContent, price }];
    });
  };
  const itemValue = (record) => ({
    id: record.id,
    name: record.text.slice(0, 180),
    ...(record.price === null ? {} : { price: record.price }),
  });
  const applyMatches = (records, predicate) => {
    let changed = 0;
    const visibleIds = new Set();
    for (const record of records) {
      const matched = Boolean(predicate(record));
      if (record.element.hidden !== !matched) changed += 1;
      record.element.hidden = !matched;
      record.element.setAttribute(
        "data-webmcp-studio-preview-match",
        matched ? "true" : "false",
      );
      if (matched) visibleIds.add(record.id);
    }
    previewState.visibleIds = visibleIds;
    return {
      changed,
      visible: records.filter((record) => visibleIds.has(record.id)),
    };
  };
  const cartElement = () => {
    const selectors = [
      "#cart-count",
      "[data-cart-count]",
      "[data-testid*=cart-count]",
      "[aria-label*=cart i]",
    ];
    for (const selector of selectors) {
      try {
        const match = document.querySelector(selector);
        if (match) return match;
      } catch {
        // Safe selector fallbacks continue below.
      }
    }
    return null;
  };
  const run = (tool, args) => {
    const name = text(tool?.name) || "inferred_tool";
    const target = evidenceTarget(tool || {});
    const changedControls = setVisibleControls(args);
    const signal = (name + " " + JSON.stringify(args || {})).toLowerCase();
    let matchedElements = 0;
    let stateChanged = changedControls > 0;
    let result = {};
    if (/(search|find|query|filter|sort)/.test(signal)) {
      const records = itemRecords();
      const query = text(
        argumentValue(args, [
          "query",
          "search",
          "requirements",
          "keyword",
          "q",
        ]),
      ).toLowerCase();
      const maxPrice = argumentNumber(args, ["maxPrice", "max_price"], NaN);
      const filtered = applyMatches(records, (record) => {
        const textMatch = !query || record.text.toLowerCase().includes(query);
        const priceMatch =
          !Number.isFinite(maxPrice) ||
          record.price === null ||
          record.price <= maxPrice;
        return textMatch && priceMatch;
      });
      matchedElements = filtered.visible.length;
      stateChanged ||= filtered.changed > 0 || records.length > 0;
      const values = filtered.visible.map(itemValue);
      const key = /(option|flight|hotel|travel|itinerary)/.test(signal)
        ? "options"
        : "products";
      result = {
        [key]: values,
        query: query || null,
        ...(Number.isFinite(maxPrice) ? { maxPrice } : {}),
        resultCount: values.length,
      };
    }
    if (
      /(get|detail|view|open)/.test(signal) &&
      /(product|item|option|flight|hotel|detail)/.test(signal)
    ) {
      const records = itemRecords();
      const requestedId = text(
        argumentValue(args, [
          "productId",
          "product_id",
          "optionId",
          "option_id",
          "id",
        ]),
      ).toLowerCase();
      const selected =
        records.find((record) => record.id.toLowerCase() === requestedId) ??
        records.find((record) =>
          record.text.toLowerCase().includes(requestedId),
        ) ??
        records.find((record) => previewState.visibleIds.has(record.id)) ??
        records[0];
      if (selected) {
        previewState.selectedId = selected.id;
        stateChanged = markEvidence(selected.element, name) > 0 || stateChanged;
        const value = itemValue(selected);
        result = {
          ...(result && typeof result === "object" ? result : {}),
          product: value,
          option: value,
          productId: selected.id,
          optionId: selected.id,
        };
      }
    }
    if (/(add|cart|buy|purchase|reserve|book|checkout)/.test(signal)) {
      const requestedId = text(
        argumentValue(args, [
          "productId",
          "product_id",
          "optionId",
          "option_id",
          "id",
        ]),
      );
      const selectedId =
        requestedId ||
        previewState.selectedId ||
        [...previewState.visibleIds][0] ||
        "preview-item";
      const quantity = Math.max(
        1,
        Math.round(argumentNumber(args, ["quantity", "count"], 1)),
      );
      previewState.cartCount += quantity;
      const count = cartElement();
      if (count) count.textContent = String(previewState.cartCount);
      const targetElement = evidenceTarget(tool || {});
      if (targetElement instanceof Element) {
        targetElement.setAttribute(
          "data-webmcp-studio-preview-cart",
          "updated",
        );
        targetElement.style.outline = "2px solid rgba(233, 210, 118, .9)";
      }
      stateChanged = true;
      result = {
        ...(result && typeof result === "object" ? result : {}),
        productId: selectedId,
        quantity,
        cart: { count: previewState.cartCount },
      };
    }
    if (/(select|choose|reserve|book)/.test(signal)) {
      const selectedId = text(
        argumentValue(args, [
          "optionId",
          "option_id",
          "productId",
          "product_id",
          "id",
        ]),
      );
      const selected = itemRecords().find(
        (record) =>
          !selectedId || record.id.toLowerCase() === selectedId.toLowerCase(),
      );
      if (selected) {
        previewState.selectedId = selected.id;
        selected.element.setAttribute("aria-selected", "true");
        stateChanged = true;
        result = {
          ...(result && typeof result === "object" ? result : {}),
          optionId: selected.id,
        };
      }
    }
    if (
      /(submit|click|sign_in|subscribe|contact|next_page|previous_page)/.test(
        signal,
      )
    ) {
      const actionTarget = evidenceTarget(tool || {});
      if (actionTarget instanceof Element) {
        actionTarget.setAttribute("data-webmcp-studio-preview-action", name);
        actionTarget.style.outline = "2px solid rgba(66, 183, 136, .78)";
        stateChanged = true;
        result = {
          ...(result && typeof result === "object" ? result : {}),
          action: name,
        };
      }
    }
    markEvidence(target, name);
    if (
      /(add|cart|buy|purchase|reserve|book|select|submit|checkout|save|subscribe)/.test(
        name.toLowerCase(),
      )
    )
      statusElement().dataset.mutation = "true";
    const status = statusElement();
    status.textContent =
      "Inferred preview ran " + name + " on this safe page snapshot.";
    return {
      ok: true,
      success: true,
      status: "completed",
      toolName: name,
      stateChanged,
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
      ...result,
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

  window.addEventListener("message", (event) => {
    if (event.source !== window.parent) return;
    const data = event.data;
    if (
      !data ||
      data.channel !== CHANNEL ||
      data.version !== VERSION ||
      data.direction !== "parent-to-preview" ||
      data.type !== "load" ||
      data.token !== token ||
      typeof data.html !== "string"
    )
      return;
    loadSnapshot(data.html);
  });

  const announceReady = () => send({ type: "ready" });
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", announceReady, {
      once: true,
    });
  else announceReady();
})();
