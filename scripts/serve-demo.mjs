import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, normalize, resolve } from "node:path";

const root = resolve(new URL("../demo/site", import.meta.url).pathname);
const portArgument = process.argv.indexOf("--port");
const port = portArgument >= 0 ? Number(process.argv[portArgument + 1]) : 4173;
const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
};

const server = createServer(async (request, response) => {
  const requestPath = decodeURIComponent(
    (request.url ?? "/").split("?")[0] ?? "/",
  );
  const relative =
    requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const file = normalize(resolve(root, relative));
  if (!file.startsWith(root)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  try {
    const body = await readFile(file);
    response.writeHead(200, {
      "content-type": contentTypes[extname(file)] ?? "application/octet-stream",
      "cache-control": "no-store",
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, "127.0.0.1", () =>
  console.log(`Demo pages: http://127.0.0.1:${port}/`),
);
