import { expect, type Page, test } from "@playwright/test";

// Relative to baseURL, so the same tests cover sub-path deployments (GitHub Pages).
const HOME = "./";

/** On hosts without COOP/COEP headers the page reloads itself once via coi-sw.js. */
async function openIsolated(page: Page) {
  await page.goto(HOME);
  await page.waitForFunction(() => globalThis.crossOriginIsolated === true);
}

/** A 16-bit stereo WAV: a sine on the left, silence on the right. */
function sineWav(seconds: number, sampleRate = 44_100, freq = 440): Buffer {
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 16_000), i * 4);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(2, 22); // channels
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

const meterValue = async (page: Page, testId: string) =>
  Number(await page.getByTestId(testId).getAttribute("aria-valuenow"));

test("page is cross-origin isolated", async ({ page }) => {
  await openIsolated(page);
  await expect(page.getByTestId("diag-crossOriginIsolated")).toHaveText("true");
});

test("imports a file, plays it through the mixer and responds to track controls", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await openIsolated(page);

  // Long enough (> 1 s) to exercise the chunked upload to the worklet.
  await page
    .getByTestId("import")
    .setInputFiles({ name: "tone.wav", mimeType: "audio/wav", buffer: sineWav(3) });
  const track = page.getByTestId("track-1");
  await expect(track).toContainText("tone.wav");

  await page.getByRole("button", { name: "Play" }).click();
  await expect(page.getByTestId("status")).toHaveText("Playing");

  // Meters come from the WASM engine through the event ring, so non-zero values prove the
  // whole path: decode worker → worklet upload → engine mix → events.
  await expect.poll(() => meterValue(page, "master-meter")).toBeGreaterThan(0.4);
  await expect.poll(() => meterValue(page, "track-meter-1")).toBeGreaterThan(0.4);
  await expect
    .poll(async () => Number(await page.getByTestId("position").getAttribute("data-frames")))
    .toBeGreaterThan(4_800);

  await track.getByRole("button", { name: "Mute" }).click();
  await expect.poll(() => meterValue(page, "track-meter-1")).toBeLessThan(0.001);
  await track.getByRole("button", { name: "Mute" }).click();
  await expect.poll(() => meterValue(page, "track-meter-1")).toBeGreaterThan(0.4);

  await page.getByRole("button", { name: "Duplicate to 16 tracks" }).click();
  await expect(page.locator("[data-testid^=track-meter-]")).toHaveCount(16);
  await expect.poll(() => meterValue(page, "track-meter-16")).toBeGreaterThan(0.4);

  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByTestId("status")).toHaveText("Stopped");
  await expect.poll(() => meterValue(page, "master-meter")).toBeLessThan(0.001);
  expect(errors).toEqual([]);
});

test("reports undecodable files without breaking the session", async ({ page }) => {
  await openIsolated(page);
  await page
    .getByTestId("import")
    .setInputFiles({ name: "broken.wav", mimeType: "audio/wav", buffer: Buffer.from("not audio") });
  await expect(page.getByTestId("status")).toContainText("unsupported audio format");
  await page
    .getByTestId("import")
    .setInputFiles({ name: "ok.wav", mimeType: "audio/wav", buffer: sineWav(0.5) });
  await expect(page.getByTestId("track-1")).toContainText("ok.wav");
});
