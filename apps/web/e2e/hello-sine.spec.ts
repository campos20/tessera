import { expect, test } from "@playwright/test";

test("page is cross-origin isolated", async ({ page }) => {
  await page.goto("/");
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
  await expect(page.getByTestId("diag-crossOriginIsolated")).toHaveText("true");
});

test("plays the engine-core sine through the AudioWorklet", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");

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
