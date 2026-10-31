import { expect, type Page, test } from "@playwright/test";

// Relative to baseURL, so the same tests cover sub-path deployments (GitHub Pages).
const HOME = "./";

/** On hosts without COOP/COEP headers the page reloads itself once via coi-sw.js. */
async function openIsolated(page: Page) {
  await page.goto(HOME);
  await page.waitForFunction(() => globalThis.crossOriginIsolated === true);
}

test("page is cross-origin isolated", async ({ page }) => {
  await openIsolated(page);
  await expect(page.getByTestId("diag-crossOriginIsolated")).toHaveText("true");
});

test("plays the engine-core sine through the AudioWorklet", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openIsolated(page);

  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByTestId("status")).toHaveText("Status: playing");
  await expect(page.getByTestId("diag-sampleRate")).toHaveText("48000");

  // The meter is fed by the WASM engine's peak, so a non-zero value proves audio flows
  // main thread → SAB ring → worklet → engine-wasm → output.
  const meter = page.getByTestId("peak");
  await expect.poll(async () => Number(await meter.getAttribute("aria-valuenow"))).toBeGreaterThan(0.15);

  await page.getByRole("button", { name: "Stop" }).click();
  await expect.poll(async () => Number(await meter.getAttribute("aria-valuenow"))).toBeLessThan(0.01);
  expect(errors).toEqual([]);
});
