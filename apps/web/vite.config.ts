import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react-swc";
import path from "path";

const base = process.env.REACT_BASE || "/";

// https://vitejs.dev/config/
export default defineConfig({
  base,
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    allowedHosts: true,
    // Dev only: in production nginx routes /api/* to the Node backend. This
    // proxy gives the same relative-URL behaviour under `pnpm dev`, so the
    // app (and agent-browser visual checks) can hit a backend on :8080
    // without code changes. Harmless if there is no backend yet.
    proxy: {
      "/api": "http://localhost:8080",
    },
  },
  // Pre-bundle deps that tests import lazily, so Vitest's browser mode does
  // not reload mid-run when Vite discovers them.
  optimizeDeps: {
    include: [
      "zod",
      "dexie",
      "dexie-react-hooks",
      "immer",
      "zustand",
      "@tanstack/react-virtual",
      "react",
      "react-dom",
      "react-router",
      "vitest-browser-react",
      "@siemens/ix-react",
      "@siemens/ix-icons/icons",
      "exceljs",
      "jspdf",
      "jspdf-autotable",
      "ag-grid-react",
      "ag-grid-community",
    ],
  },
  resolve: {
    alias: [
      {
        find: "@",
        replacement: path.resolve(__dirname, "src"),
      },
    ],
  },
  test: {
    setupFiles: "./src/setupTests.ts",
    // Vitest's own browser mode — a separate, independently uncapped path
    // the Playwright CI flag above doesn't touch. Same CREATE_SANDBOX
    // scoping as playwright.config.ts: capped only inside the sandbox.
    maxWorkers: process.env.CREATE_SANDBOX === "1" ? 1 : undefined,
    browser: {
      enabled: true,
      provider: "playwright",
      headless: true,
      // Inside the CREATE sandbox the image ships its own Chromium; use it
      // instead of Playwright's download cache when the path is provided.
      instances: [
        {
          browser: "chromium",
          ...(process.env.AGENT_BROWSER_EXECUTABLE_PATH
            ? {
                launch: {
                  executablePath: process.env.AGENT_BROWSER_EXECUTABLE_PATH,
                  args: ["--no-sandbox"],
                },
              }
            : {}),
        },
      ],
    },
  },
});
