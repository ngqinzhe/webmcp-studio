document.getElementById("page-instance").value = crypto.randomUUID();
document.getElementById("environment").textContent = JSON.stringify(
  {
    origin: location.origin,
    userAgent: navigator.userAgent,
    secureContext: window.isSecureContext,
    modelContextPresent: Boolean(document.modelContext),
    registerTool: typeof document.modelContext?.registerTool,
    toolsRegisteredByPage: 0,
    apiMockedByFixture: false,
  },
  null,
  2,
);
document
  .getElementById("product-search")
  .addEventListener("submit", (event) => {
    event.preventDefault();
    const query = new FormData(event.currentTarget).get("q");
    const marker = document.getElementById("page-marker").value;
    document.getElementById("search-status").textContent =
      `Results for ${query}; tab marker: ${marker}.`;
  });
