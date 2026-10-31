import { defineConfig, devices } from "@playwright/test";

// E2E_DEV=1 runs against the Vite dev server instead of the production build.
const DEV = !!process.env.E2E_DEV;
const PORT = DEV ? 5173 : 4173;

export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
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
  // By default tests the production build (`vite build` runs first in the e2e script).
  webServer: {
    command: `pnpm exec vite ${DEV ? "" : "preview "}--port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
  },
});
