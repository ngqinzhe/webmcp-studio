import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const server = createServer(async (request, response) => {
  if (request.method !== "GET") {
    response.writeHead(405).end("Method not allowed");
    return;
  }
  const path = (request.url ?? "/").split("?")[0];
  try {
    let body;
    let contentType;
    if (path === "/" || path === "/index.html") {
      body = await readFile(new URL("./index.html", import.meta.url));
      contentType = "text/html; charset=utf-8";
    } else if (path === "/style.css") {
      body = await readFile(
        new URL("../native-webmcp/style.css", import.meta.url),
      );
      contentType = "text/css; charset=utf-8";
    } else if (path === "/runtime.js") {
      const result = await build({
        entryPoints: [fileURLToPath(new URL("./runtime.ts", import.meta.url))],
        bundle: true,
        platform: "browser",
        target: "es2022",
        format: "esm",
        write: false,
        logLevel: "warning",
      });
      body = result.outputFiles[0].contents;
      contentType = "text/javascript; charset=utf-8";
    } else {
      response.writeHead(404).end("Not found");
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Origin-Agent-Cluster": "?1",
      "Permissions-Policy": "tools=(self)",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(body);
  } catch (error) {
    response.writeHead(500).end("Runtime fixture unavailable");
    console.error(error.message);
  }
});
server.listen(4175, "127.0.0.1", () => {
  console.log("Native runtime fixture: http://127.0.0.1:4175/");
});
