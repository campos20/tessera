import { defineConfig, devices } from "@playwright/test";

// E2E_DEV=1 runs against the Vite dev server instead of the production build.
// E2E_PAGES=1 mimics GitHub Pages: served under /tessera/ without COOP/COEP headers, so
// isolation must come from public/coi-sw.js (build with BASE_PATH=/tessera/ first).
const DEV = !!process.env.E2E_DEV;
const PAGES = !!process.env.E2E_PAGES;
const PORT = DEV ? 5173 : 4173;
const BASE = PAGES ? "/tessera/" : "/";

export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}${BASE}`,
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: { args: ["--autoplay-policy=no-user-gesture-required"] },
      },
    },
  ],
  // By default tests the production build (`vite build` runs first in the e2e scripts).
  webServer: {
    command: `pnpm exec vite ${DEV ? "" : "preview "}--port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}${BASE}`,
    env: PAGES ? { BASE_PATH: BASE, NO_COI_HEADERS: "1" } : {},
    reuseExistingServer: !process.env.CI,
  },
});
