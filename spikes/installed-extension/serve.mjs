import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const routes = new Map([
  ["/", [new URL("./index.html", import.meta.url), "text/html; charset=utf-8"]],
  [
    "/index.html",
    [new URL("./index.html", import.meta.url), "text/html; charset=utf-8"],
  ],
  [
    "/site.mjs",
    [new URL("./site.mjs", import.meta.url), "text/javascript; charset=utf-8"],
  ],
  [
    "/style.css",
    [
      new URL("../native-webmcp/style.css", import.meta.url),
      "text/css; charset=utf-8",
    ],
  ],
]);

const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Origin-Agent-Cluster": "?1",
  "Permissions-Policy": "tools=(self)",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; form-action 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

const server = createServer(async (request, response) => {
  if (request.method !== "GET") {
    response
      .writeHead(405, {
        ...headers,
        Allow: "GET",
        "Content-Type": "text/plain; charset=utf-8",
      })
      .end("Method not allowed");
    return;
  }

  const route = routes.get((request.url ?? "/").split("?")[0]);
  if (!route) {
    response
      .writeHead(404, {
        ...headers,
        "Content-Type": "text/plain; charset=utf-8",
      })
      .end("Not found");
    return;
  }

  try {
    const [file, contentType] = route;
    const body = await readFile(file);
    response.writeHead(200, { ...headers, "Content-Type": contentType });
    response.end(body);
  } catch (error) {
    response
      .writeHead(500, {
        ...headers,
        "Content-Type": "text/plain; charset=utf-8",
      })
      .end("Installed-extension fixture unavailable");
    console.error(error.message);
  }
});

server.on("error", (error) => {
  console.error("Installed-extension fixture server failed:", error.message);
  process.exitCode = 1;
});
server.listen(4176, "127.0.0.1", () => {
  console.log("Installed-extension fixture: http://127.0.0.1:4176/");
});
