import { expect, type Page, test } from "@playwright/test";

const HOME = "./";

async function open(page: Page) {
  await page.goto(HOME);
  await page.waitForFunction(() => globalThis.crossOriginIsolated === true);
  await expect(page.getByTestId("save-state")).toHaveText("All changes saved");
}

/** The project.json autosave wrote, plus the peak of each stored take. */
async function saved(page: Page) {
  await expect(page.getByTestId("save-state")).toHaveText("All changes saved");
  return page.evaluate(async () => {
    const id = localStorage.getItem("tessera.lastProject")!;
    const dir = await (
      await (await navigator.storage.getDirectory()).getDirectoryHandle("projects")
    ).getDirectoryHandle(id);
    const project = JSON.parse(await (await (await dir.getFileHandle("project.json")).getFile()).text());
    const audio = await dir.getDirectoryHandle("audio");
    const peaks: Record<string, number> = {};
    for (const source of project.sources) {
      const bytes = await (
        await (await audio.getFileHandle(source.file.split("/")[1])).getFile()
      ).arrayBuffer();
      const samples = new Float32Array(bytes, 44);
      peaks[source.file] = samples.reduce((m: number, s: number) => Math.max(m, Math.abs(s)), 0);
    }
    return { project, peaks };
  });
}

test("records the microphone into a new take on an armed track", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);

  await page.getByRole("button", { name: "+ Track" }).click();
  const header = page.locator("[data-testid^=track-header-]").first();
  await header.getByRole("button", { name: "Arm for recording" }).click();
  await expect(header.getByRole("button", { name: "Arm for recording" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The armed track meters its input (the fake microphone's tone, ~0.37).
  const inputMeter = header.locator("[data-testid^=input-meter-]");
  await expect.poll(async () => Number(await inputMeter.getAttribute("aria-valuenow"))).toBeGreaterThan(0.2);

  // No count-in, so the take starts at the playhead.
  await page.getByRole("button", { name: "Recording options" }).click();
  await page.getByLabel("Count-in").selectOption("0");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByRole("button", { name: "Record", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.waitForTimeout(2_000);
  await page.getByRole("button", { name: "Record", exact: true }).click();
  await expect(page.getByRole("button", { name: "Record", exact: true })).toHaveAttribute(
    "aria-pressed",
    "false",
  );

  const { project, peaks } = await saved(page);
  const clips = project.tracks[0].clips;
  expect(clips).toHaveLength(1);
  expect(clips[0].name).toMatch(/take 1$/);
  // ~2 s of audio at the 48 kHz project rate (start/stop timing isn't exact).
  expect(clips[0].length).toBeGreaterThan(48_000);
  expect(project.sources[0].file).toMatch(/^audio\/rec-.*\.wav$/);
  expect(peaks[project.sources[0].file]).toBeGreaterThan(0.2);

  // The take plays back. Disarm first so the meter shows the track's output.
  await header.getByRole("button", { name: "Arm for recording" }).click();
  await page.getByRole("button", { name: "Return to start" }).click();
  await page.getByRole("button", { name: "Play" }).click();
  await expect
    .poll(async () =>
      Number(await header.locator("[data-testid^=track-meter-]").getAttribute("aria-valuenow")),
    )
    .toBeGreaterThan(0.2);
  await page.getByRole("button", { name: "Pause" }).click();

  // Undo removes the take; redo restores it.
  await page.keyboard.press("ControlOrMeta+z");
  expect((await saved(page)).project.tracks[0].clips).toHaveLength(0);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  expect((await saved(page)).project.tracks[0].clips).toHaveLength(1);
  expect(errors).toEqual([]);
});

test("monitoring routes the input to the output while stopped", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "+ Track" }).click();
  const header = page.locator("[data-testid^=track-header-]").first();
  await header.getByRole("button", { name: "Track options" }).click();
  // Monitoring turns on once the input has opened (asynchronously).
  await page.getByLabel("Monitor input").click();
  await expect(page.getByLabel("Monitor input")).toBeChecked();
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => Number(await page.getByTestId("master-meter").getAttribute("aria-valuenow")))
    .toBeGreaterThan(0.2);
});
