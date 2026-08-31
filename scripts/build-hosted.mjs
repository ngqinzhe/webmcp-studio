import { build } from "esbuild";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = resolve(root, "dist");
const hosted = resolve(root, "hosted");
const demo = resolve(root, "demo/site");
const hostedTargets = resolve(hosted, "targets");
const indexSource = resolve(hosted, "index.html");
const stylesSource = resolve(hosted, "styles.css");
const studioSource = resolve(hosted, "studio.ts");
const hostingSource = resolve(root, ".openai/hosting.json");
const externalDiscoverySource = resolve(root, "scripts/external-discovery.mjs");

for (const path of [indexSource, stylesSource, demo, externalDiscoverySource]) {
  if (!existsSync(path)) throw new Error(`Missing hosted build input: ${path}`);
}

function prepareTargetHtml(source, scriptPath) {
  // The target prototypes predate the typed TargetRuntime. Keep their visual
  // markup, but never ship both runtimes: the production target must have one
  // executable bridge and one honest native-registration attempt.
  const withoutInlineScripts = source.replace(
    /\s*<script\b(?![^>]*\btype=["']module["'])[^>]*>[\s\S]*?<\/script>/gi,
    "",
  );
  const moduleTag = `    <script type="module" src="${scriptPath}"></script>`;
  return withoutInlineScripts.replace("</body>", `${moduleTag}\n  </body>`);
}

// The hosted archive is intentionally an allowlist-shaped output. The
// optional extension and legacy demo fixtures are built separately and must
// never be accidentally published beside the judge-facing Studio.
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// The hosted shell refers to stable controlled-target URLs. Prefer dedicated
// hosted targets, with the existing deterministic fixtures as a fallback while
// either target is still being integrated.
const targets = resolve(dist, "targets");
mkdirSync(targets, { recursive: true });
for (const [target, fallback] of [
  ["commerce", "shop.html"],
  ["travel", "search.html"],
]) {
  const dedicated = resolve(hostedTargets, `${target}.html`);
  const source = readFileSync(
    existsSync(dedicated) ? dedicated : resolve(demo, fallback),
    "utf8",
  );
  writeFileSync(
    resolve(targets, `${target}.html`),
    prepareTargetHtml(source, `/assets/${target}.js`),
  );
}

let index = readFileSync(indexSource, "utf8");
if (existsSync(studioSource)) {
  mkdirSync(resolve(dist, "assets"), { recursive: true });
  await build({
    bundle: true,
    entryPoints: [studioSource],
    outfile: resolve(dist, "assets/studio.js"),
    format: "esm",
    platform: "browser",
    sourcemap: false,
    target: "es2022",
    logLevel: "warning",
  });

  for (const target of ["commerce", "travel"]) {
    const targetEntry = resolve(hostedTargets, `${target}.ts`);
    if (existsSync(targetEntry)) {
      await build({
        bundle: true,
        entryPoints: [targetEntry],
        outfile: resolve(dist, `assets/${target}.js`),
        format: "esm",
        platform: "browser",
        sourcemap: false,
        target: "es2022",
        logLevel: "warning",
      });
    }
  }
} else {
  // A future hosted/studio.ts can use the existing module tag unchanged. For
  // now omit it from the emitted shell instead of shipping a broken request.
  index = index.replace(
    /^\s*<script type="module" src="\/assets\/studio\.js"><\/script>\s*$/m,
    "",
  );
}

cpSync(stylesSource, resolve(dist, "styles.css"));
writeFileSync(resolve(dist, "index.html"), index);

const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'self'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-src 'self' https:",
  "Permissions-Policy": "tools=(self)",
  "Origin-Agent-Cluster": "?1",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "SAMEORIGIN",
  "Cross-Origin-Resource-Policy": "same-origin",
};

const server = resolve(dist, "server");
mkdirSync(server, { recursive: true });
cpSync(externalDiscoverySource, resolve(server, "external-discovery.mjs"));
if (existsSync(hostingSource)) {
  mkdirSync(resolve(dist, ".openai"), { recursive: true });
  cpSync(hostingSource, resolve(dist, ".openai/hosting.json"));
}

const hostedAssets = [
  ["index.html", "text/html; charset=utf-8"],
  ["styles.css", "text/css; charset=utf-8"],
  ["assets/studio.js", "text/javascript; charset=utf-8"],
  ["assets/commerce.js", "text/javascript; charset=utf-8"],
  ["assets/travel.js", "text/javascript; charset=utf-8"],
  ["targets/commerce.html", "text/html; charset=utf-8"],
  ["targets/travel.html", "text/html; charset=utf-8"],
];
const embeddedAssets = Object.fromEntries(
  hostedAssets
    .filter(([relativePath]) => existsSync(resolve(dist, relativePath)))
    .map(([relativePath, contentType]) => [
      `/${relativePath}`,
      {
        contentType,
        body: readFileSync(resolve(dist, relativePath), "utf8"),
      },
    ]),
);
writeFileSync(
  resolve(server, "index.js"),
  `import { handleExternalDiscovery } from "./external-discovery.mjs";

const SECURITY_HEADERS = ${JSON.stringify(securityHeaders, null, 2)};
const EMBEDDED_ASSETS = ${JSON.stringify(embeddedAssets)};

function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function embeddedAssetResponse(request) {
  const pathname = new URL(request.url).pathname;
  const asset = EMBEDDED_ASSETS[pathname === "/" ? "/index.html" : pathname];
  if (!asset) return null;
  return withSecurityHeaders(
    new Response(request.method === "HEAD" ? null : asset.body, {
      status: 200,
      headers: { "Content-Type": asset.contentType },
    }),
  );
}

export default {
  async fetch(request, env) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/analyze-external") {
      return withSecurityHeaders(await handleExternalDiscovery(request));
    }
    const embedded = embeddedAssetResponse(request);
    if (embedded) return embedded;
    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      const response = await env.ASSETS.fetch(request);
      return withSecurityHeaders(response);
    }
    return withSecurityHeaders(new Response("Not Found", { status: 404 }));
  },
};
`,
);

console.log(
  `Built hosted site in ${dist} (${existsSync(studioSource) ? "Studio bundled" : "static shell; hosted/studio.ts not present"})`,
);
