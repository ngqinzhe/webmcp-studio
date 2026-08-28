(function () {
  const tools = new Map();
  const native = location.pathname.endsWith("/native.html");
  if (native) {
    tools.set("search_products", {
      name: "search_products",
      description: "A native page-provided product search.",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
      execute: async function () {
        return { native: true };
      },
    });
  }
  const context = {
    provideTool: function (tool) {
      if (!tool || !tool.name) throw new Error("Tool name is required");
      if (native && tool.name === "search_products")
        throw new Error("native tool conflict");
      tools.set(tool.name, tool);
      return true;
    },
    provideTools: function (items) {
      for (const item of items || []) this.provideTool(item);
      return true;
    },
    updateTool: function (tool) {
      tools.set(tool.name, tool);
      return true;
    },
    unregisterTool: function (name) {
      tools.delete(name);
      return true;
    },
    getTools: function () {
      return Array.from(tools.values());
    },
    getToolsForDemo: function () {
      return Array.from(tools.values());
    },
  };
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: context,
  });
  window.demoModelContext = context;
  window.demoState = { cart: 0, lastSearch: "" };
})();
