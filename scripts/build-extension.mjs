import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const output = resolve(root, "dist/extension");
const inspectorOutput = resolve(output, "inspector");
rmSync(output, { recursive: true, force: true });
mkdirSync(inspectorOutput, { recursive: true });

const common = {
  bundle: true,
  sourcemap: false,
  target: "es2022",
  platform: "browser",
  logLevel: "warning",
};

await Promise.all([
  build({
    ...common,
    entryPoints: [resolve(root, "extension/service-worker/service-worker.ts")],
    outfile: resolve(output, "service-worker.js"),
    format: "esm",
  }),
  build({
    ...common,
    entryPoints: [resolve(root, "extension/content/content-script.ts")],
    outfile: resolve(output, "content.js"),
    format: "iife",
  }),
  build({
    ...common,
    entryPoints: [resolve(root, "extension/main-world/index.ts")],
    outfile: resolve(output, "main-world.js"),
    format: "iife",
  }),
  build({
    ...common,
    entryPoints: [resolve(root, "extension/inspector/inspector.ts")],
    outfile: resolve(inspectorOutput, "inspector.js"),
    format: "iife",
  }),
]);

cpSync(
  resolve(root, "extension/manifest.json"),
  resolve(output, "manifest.json"),
);
cpSync(
  resolve(root, "extension/inspector/index.html"),
  resolve(inspectorOutput, "index.html"),
);
cpSync(
  resolve(root, "extension/inspector/style.css"),
  resolve(inspectorOutput, "style.css"),
);
console.log(`Built Chrome extension in ${output}`);
