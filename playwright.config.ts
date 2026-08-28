import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  use: {
    browserName: "chromium",
    ...devices["Desktop Chrome"],
    headless: true,
    baseURL: "http://127.0.0.1:4173",
  },
  webServer: {
    command: "node scripts/serve-demo.mjs --port 4173",
    url: "http://127.0.0.1:4173/search.html",
    reuseExistingServer: true,
    timeout: 15_000,
  },
});
