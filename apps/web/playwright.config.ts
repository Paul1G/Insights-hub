import { defineConfig, devices } from "@playwright/test";

/**
 * Smoke tests (e2e/*.e2e.ts) against the real stack: the Vite dev server
 * (:5173, proxies /api) and the built backend (:8080) with a throw-away data
 * directory, using the backend's simulator connection instead of a tenant.
 *
 * Prerequisite: `pnpm --dir ../../backend build` (the backend runs from dist/).
 */
const executablePath = process.env.AGENT_BROWSER_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // The flows share one backend; run them one after another.
  workers: 1,
  reporter: "list",
  timeout: 60_000,
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    viewport: { width: 1600, height: 1000 },
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1600, height: 1000 },
        // Inside the CREATE sandbox the image ships its own Chromium.
        ...(executablePath ? { launchOptions: { executablePath, args: ["--no-sandbox"] } } : {}),
      },
    },
  ],
  webServer: [
    {
      command: "node ../../backend/dist/server.js",
      url: "http://localhost:8080/healthz",
      reuseExistingServer: !process.env.CI,
      env: { APPLICATION_DATA_DIR: "/tmp/asset-model-studio-e2e", APP_ENV: "prod" },
    },
    {
      command: "pnpm dev",
      url: "http://localhost:5173",
      reuseExistingServer: !process.env.CI,
    },
  ],
});
