// Dated audit probes, not native-browser or installed-extension proof.
// All actions, credentials, transport, and server reads below are synthetic.
// Exit 1 means at least one audited unsafe behavior is still observable.
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname, normalize, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const root = fileURLToPath(new URL("../../", import.meta.url));
const sources = [
  "extension/service-worker/service-worker.ts",
  "core/execution/execute.ts",
  "scripts/serve-demo.mjs",
];

async function loadSource(entryPoint) {
  const result = await build({
    entryPoints: [resolve(root, entryPoint)],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    target: "es2022",
  });
  return import(
    "data:text/javascript;base64," +
      Buffer.from(result.outputFiles[0].text).toString("base64")
  );
}

async function checkUncertainActionRetry() {
  let onMessage;
  let actionCount = 0;
  const injectionWorlds = [];
  globalThis.chrome = {
    action: { onClicked: { addListener() {} } },
    runtime: {
      onMessage: {
        addListener(listener) {
          onMessage = listener;
        },
      },
    },
    tabs: {
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
      async sendMessage() {
        actionCount += 1;
        if (actionCount === 1) {
          throw new Error("Message port closed after the action took effect");
        }
        return {
          ok: true,
          result: {
            success: true,
            status: "completed",
            urlBefore: "https://fixture.test",
            urlAfter: "https://fixture.test",
            navigationOccurred: false,
            stateChanged: true,
            warnings: [],
          },
        };
      },
    },
    scripting: {
      async executeScript(options) {
        injectionWorlds.push(options.world);
        return [];
      },
    },
  };
  try {
    await loadSource("extension/service-worker/service-worker.ts");
    const response = await new Promise((done) =>
      onMessage(
        {
          type: "polyfill:invoke",
          tabId: 11,
          capabilityId: "synthetic-counted-action",
          args: {},
        },
        {
          id: "our-extension",
          url: "chrome-extension://our-extension/inspector/index.html?tabId=11",
        },
        done,
      ),
    );
    return {
      condition:
        "A mocked first delivery takes effect, then rejects; reinjection succeeds and the retry remains actionable.",
      actionCount,
      injectionWorlds,
      finalOk: response.ok,
      findingObserved: actionCount > 1,
    };
  } finally {
    delete globalThis.chrome;
  }
}

async function checkSensitiveRead() {
  const { executeCapability } = await loadSource("core/execution/execute.ts");
  const dom = new JSDOM(
    '<label for="account-password">Account password</label>' +
      '<input id="account-password" type="password" value="synthetic-secret-sentinel">',
    { url: "https://fixture.test/account" },
  );
  const locator = {
    framePath: [],
    shadowPath: [],
    stableAttributes: [{ name: "id", value: "account-password" }],
    fallbacks: [],
  };
  const capability = {
    id: "read-password",
    name: "read_password",
    description: "Synthetic read probe.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    effect: "read",
    confidence: 1,
    source: {
      type: "adapter",
      url: "https://fixture.test/account",
      framePath: [],
      shadowPath: [],
    },
    locator,
    executor: { kind: "read", target: locator, expected: {} },
  };
  try {
    const result = await executeCapability(
      capability,
      {},
      {
        document: dom.window.document,
      },
    );
    const returnedSyntheticSecret =
      result.result?.value === "synthetic-secret-sentinel";
    return {
      condition:
        "An explicit read capability targets a synthetic password input in jsdom. This does not demonstrate automatic scanning or native exfiltration.",
      success: result.success,
      status: result.status,
      returnedSyntheticSecret,
      findingObserved: returnedSyntheticSecret,
    };
  } finally {
    dom.window.close();
  }
}

async function checkDemoServerPaths() {
  const sourcePath = resolve(root, "scripts/serve-demo.mjs");
  const source = readFileSync(sourcePath, "utf8");
  let handler;
  let reads = [];
  const context = {
    createServer(fn) {
      handler = fn;
      return { listen() {} };
    },
    async readFile(file) {
      reads.push(file);
      return Buffer.from("synthetic-public-content");
    },
    extname,
    normalize,
    resolve,
    fixtureModuleUrl: pathToFileURL(sourcePath).href,
    URL,
    process: { argv: ["node", "fixture"] },
    console,
  };
  runInNewContext(
    source
      .replace(/^import [^\n]*;\n/gm, "")
      .replaceAll("import.meta.url", "fixtureModuleUrl"),
    context,
  );
  const requests = [];
  for (const requestUrl of [
    "/index.html",
    "/%E0%A4%A",
    "/..%2fsite-audit%2fprobe.txt",
  ]) {
    reads = [];
    let status = null;
    let error = null;
    const response = {
      writeHead(value) {
        status = value;
        return this;
      },
      end() {},
    };
    try {
      await handler({ url: requestUrl, method: "GET" }, response);
    } catch (cause) {
      error = { name: cause.name, message: cause.message };
    }
    requests.push({
      requestUrl,
      status,
      error,
      attemptedReads: reads.map((file) => relative(root, file)),
    });
  }
  const malformedRequestRejectedOutsideHandler =
    requests[1].error?.name === "URIError";
  const siblingPrefixAccepted = requests[2].attemptedReads.includes(
    "demo/site-audit/probe.txt",
  );
  return {
    condition:
      "Actual request-handler source with mocked readFile/createServer; no HTTP listener, sibling file, or real outside-root read is created.",
    requests,
    malformedRequestRejectedOutsideHandler,
    siblingPrefixAccepted,
    findingObserved:
      malformedRequestRejectedOutsideHandler || siblingPrefixAccepted,
  };
}

const record = {
  scope:
    "Source-level synthetic audit probes only; not live browser, installed MV3, native agent, or complete security verification.",
  node: process.version,
  dependencyVersions: Object.fromEntries(
    ["esbuild", "jsdom"].map((name) => [
      name,
      JSON.parse(
        readFileSync(
          resolve(root, "node_modules", name, "package.json"),
          "utf8",
        ),
      ).version,
    ]),
  ),
  sourceSha256: Object.fromEntries(
    sources.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(resolve(root, file)))
        .digest("hex"),
    ]),
  ),
  checks: {
    uncertainActionRetry: await checkUncertainActionRetry(),
    sensitiveRead: await checkSensitiveRead(),
    demoServerPaths: await checkDemoServerPaths(),
  },
};
process.stdout.write(JSON.stringify(record, null, 2) + "\n");
process.exitCode = Object.values(record.checks).some(
  (check) => check.findingObserved,
)
  ? 1
  : 0;
