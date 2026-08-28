import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const routes = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/studio.mjs", ["studio.mjs", "text/javascript; charset=utf-8"]],
  ["/target.html", ["target.html", "text/html; charset=utf-8"]],
  ["/target.mjs", ["target.mjs", "text/javascript; charset=utf-8"]],
  ["/style.css", ["style.css", "text/css; charset=utf-8"]],
]);
const port = Number(process.env.WEBMCP_SPIKE_PORT ?? 4174);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("WEBMCP_SPIKE_PORT must be an integer between 1 and 65535.");
}

const server = createServer(async (request, response) => {
  const route = routes.get((request.url ?? "/").split("?")[0]);
  if (request.method !== "GET" || !route) {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  try {
    const body = await readFile(new URL(route[0], import.meta.url));
    response.writeHead(200, {
      "Content-Type": route[1],
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Permissions-Policy": "tools=(self)",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    });
    response.end(body);
  } catch (error) {
    response.writeHead(500);
    response.end("Fixture file unavailable");
    console.error(error.message);
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(`Native feasibility fixture: http://127.0.0.1:${port}/`);
});
