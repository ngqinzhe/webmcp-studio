import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4177;
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
const entryPoint = resolve(dist, "index.html");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".xml": "application/xml; charset=utf-8",
};

const COMMON_HEADERS = {
  "Cache-Control": "no-store",
  "Permissions-Policy": "tools=(self)",
  "Origin-Agent-Cluster": "?1",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
};

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function isReadableFile(path) {
  try {
    await access(path, constants.R_OK);
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function buildHostedOutput() {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(npmCommand, ["run", "build:hosted"], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    throw new Error(
      `Hosted build could not start: ${result.error.message}. Run "npm install" in ${root}, then run "npm run build:hosted" and retry.`,
    );
  }
  if (result.status !== 0) {
    const reason = result.signal
      ? `terminated by ${result.signal}`
      : `exited with code ${String(result.status)}`;
    throw new Error(
      `Hosted build failed (${reason}). Run "npm run build:hosted" from ${root} to see the full error, then retry the hosted server.`,
    );
  }
}

async function ensureHostedOutput() {
  if (await isReadableFile(entryPoint)) return;

  console.log(`Hosted output is missing at ${entryPoint}; building it now.`);
  buildHostedOutput();

  if (!(await isReadableFile(entryPoint))) {
    throw new Error(
      `Hosted build completed without creating ${entryPoint}. Run "npm run build:hosted" from ${root} and verify that the build emits dist/index.html.`,
    );
  }
}

function configuredHost() {
  const host = process.env.HOST?.trim() || DEFAULT_HOST;
  if (!host)
    throw new Error("HOST must be a non-empty hostname or IP address.");
  return host;
}

function configuredPort() {
  const rawPort = process.env.PORT ?? String(DEFAULT_PORT);
  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }
  return port;
}

function isInside(rootPath, candidatePath) {
  const pathFromRoot = relative(rootPath, candidatePath);
  return (
    pathFromRoot === "" ||
    (!isAbsolute(pathFromRoot) &&
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`))
  );
}

function requestPath(requestUrl) {
  try {
    const url = new URL(requestUrl ?? "/", "http://webmcp-studio.local");
    const pathname = decodeURIComponent(url.pathname);
    if (!pathname.startsWith("/") || pathname.includes("\\")) return null;
    if (pathname.includes("\0")) return null;
    return pathname;
  } catch {
    return null;
  }
}

function sendResponse(request, response, status, headers, body = "") {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
  response.writeHead(status, {
    ...COMMON_HEADERS,
    ...headers,
    "Content-Length": String(payload.byteLength),
  });
  response.end(request.method === "HEAD" ? undefined : payload);
}

function sendText(request, response, status, message, headers = {}) {
  sendResponse(
    request,
    response,
    status,
    { "Content-Type": "text/plain; charset=utf-8", ...headers },
    message,
  );
}

function errorCode(error) {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
}

async function serveRequest(request, response, distRoot, realDistRoot) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendText(request, response, 405, "Method Not Allowed", {
      Allow: "GET, HEAD",
    });
    return;
  }

  const pathname = requestPath(request.url);
  if (pathname === null) {
    sendText(request, response, 400, "Bad Request");
    return;
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidatePath = resolve(distRoot, relativePath);
  if (!isInside(distRoot, candidatePath)) {
    sendText(request, response, 403, "Forbidden");
    return;
  }

  try {
    // Resolve symlinks before reading so a file under dist cannot expose a
    // path outside the published tree.
    const publishedPath = await realpath(candidatePath);
    if (!isInside(realDistRoot, publishedPath)) {
      sendText(request, response, 403, "Forbidden");
      return;
    }
    if (!(await stat(publishedPath)).isFile()) {
      sendText(request, response, 404, "Not Found");
      return;
    }

    const body = await readFile(publishedPath);
    sendResponse(
      request,
      response,
      200,
      {
        "Content-Type":
          MIME_TYPES[extname(publishedPath).toLowerCase()] ??
          "application/octet-stream",
      },
      body,
    );
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      sendText(request, response, 404, "Not Found");
      return;
    }
    console.error(`Unable to serve ${pathname}: ${errorMessage(error)}`);
    sendText(request, response, 500, "Internal Server Error");
  }
}

function endpointHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

async function start() {
  await ensureHostedOutput();
  const realDistRoot = await realpath(dist);
  const host = configuredHost();
  const port = configuredPort();
  const server = createServer((request, response) => {
    void serveRequest(request, response, realDistRoot, realDistRoot).catch(
      (error) => {
        console.error(`Hosted request failed: ${errorMessage(error)}`);
        if (!response.writableEnded)
          sendText(request, response, 500, "Internal Server Error");
      },
    );
  });

  await new Promise((resolveReady, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveReady();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port });
  }).catch((error) => {
    if (error?.code === "EADDRINUSE") {
      throw new Error(
        `Hosted server could not bind to ${host}:${String(port)} because the address is already in use. Set HOST and PORT to another address and retry.`,
      );
    }
    throw new Error(`Hosted server could not start: ${errorMessage(error)}.`);
  });
  server.on("error", (error) => {
    console.error(`Hosted server error: ${errorMessage(error)}`);
  });

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down hosted server.`);
    server.close((error) => {
      if (error) {
        console.error(`Hosted server shutdown failed: ${errorMessage(error)}`);
        process.exitCode = 1;
      }
    });
    server.closeIdleConnections?.();
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  const address = server.address();
  const boundPort =
    address && typeof address === "object" ? address.port : port;
  console.log(
    `WebMCP Studio: http://${endpointHost(host)}:${String(boundPort)}/`,
  );
}

start().catch((error) => {
  console.error(`Unable to serve hosted WebMCP Studio: ${errorMessage(error)}`);
  process.exitCode = 1;
});
