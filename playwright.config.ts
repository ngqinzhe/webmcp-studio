import { defineConfig, devices } from "@playwright/test";

const hostedSpecSelected = process.argv.some((argument) =>
  argument.includes("hosted-studio-flow"),
);

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  // Each test launches a headed persistent Chromium context with an MV3
  // service worker. Serializing these contexts keeps Chrome's extension
  // worker/tab pairing deterministic under repeated CI runs.
  workers: 1,
  use: {
    browserName: "chromium",
    ...devices["Desktop Chrome"],
    headless: true,
    baseURL: "http://127.0.0.1:4173",
  },
  ...(hostedSpecSelected
    ? {}
    : {
        webServer: {
          command: "node scripts/serve-demo.mjs --port 4173",
          url: "http://127.0.0.1:4173/search.html",
          reuseExistingServer: true,
          timeout: 15_000,
        },
      }),
});
