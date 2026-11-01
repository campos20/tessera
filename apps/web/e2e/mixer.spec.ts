import { expect, type Locator, type Page, test } from "@playwright/test";

// Relative to baseURL, so the same tests cover sub-path deployments (GitHub Pages).
const HOME = "./";

/** On hosts without COOP/COEP headers the page reloads itself once via coi-sw.js. */
async function open(page: Page) {
  await page.goto(HOME);
  await page.waitForFunction(() => globalThis.crossOriginIsolated === true);
  await expect(page.getByTestId("save-state")).toHaveText("All changes saved");
}

/** A 16-bit stereo 44.1 kHz WAV holding a 440 Hz sine. */
function sineWav(seconds: number, sampleRate = 44_100): Buffer {
  const frames = Math.round(seconds * sampleRate);
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 16_000);
    data.writeInt16LE(v, i * 4);
    data.writeInt16LE(v, i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

interface SavedClip {
  start: number;
  length: number;
  offset: number;
}

/** The project.json autosave wrote to the browser's private file system. */
async function saved(page: Page): Promise<{ name: string; tracks: { name: string; clips: SavedClip[] }[] }> {
  await expect(page.getByTestId("save-state")).toHaveText("All changes saved");
  return page.evaluate(async () => {
    const id = localStorage.getItem("tessera.lastProject")!;
    const dir = await (
      await (await navigator.storage.getDirectory()).getDirectoryHandle("projects")
    ).getDirectoryHandle(id);
    return JSON.parse(await (await (await dir.getFileHandle("project.json")).getFile()).text());
  });
}

const masterPeak = async (page: Page) =>
  Number(await page.getByTestId("master-meter").getAttribute("aria-valuenow"));

/** Clicks at lane-local coordinates (lanes start at timeline frame 0 with the default zoom). */
async function at(locator: Locator, x: number, y: number) {
  const box = (await locator.boundingBox())!;
  return { x: box.x + x, y: box.y + y };
}

// Default zoom: 1200 project frames per px; snapping grid at this zoom: eighth notes = 10 px.
const FRAMES_PER_PX = 1200;

interface SavedTrack {
  inserts: { kind: string }[];
  automation: { target: { kind: string }; points: { frame: number; value: number }[] }[];
}

const savedTrack = async (page: Page) => (await saved(page)).tracks[0] as unknown as SavedTrack;

/** Plays from `frame` for a moment and returns the loudest master peak seen. */
async function loudestFrom(page: Page, frame: number) {
  const ruler = page.getByTestId("ruler");
  const at2 = await at(ruler, frame / FRAMES_PER_PX, 15);
  await page.mouse.click(at2.x, at2.y);
  await page.getByRole("button", { name: "Play" }).click();
  let loudest = 0;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(50);
    loudest = Math.max(loudest, await masterPeak(page));
  }
  await page.getByRole("button", { name: "Pause" }).click();
  return loudest;
}

test("adds an EQ insert, automates volume, hears it, undoes and reloads", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await page
    .getByTestId("import")
    .setInputFiles({ name: "Lead.wav", mimeType: "audio/wav", buffer: sineWav(6) });
  await expect(page.locator("[data-testid^=track-header-]")).toHaveCount(1);

  // Mixer: add an EQ to the track; its editor opens.
  await page.getByRole("button", { name: "Mixer" }).click();
  const mixer = page.getByTestId("mixer");
  await expect(mixer).toBeVisible();
  await mixer.getByLabel("Add effect on Lead").selectOption("eq");
  await expect(page.getByRole("dialog", { name: "EQ settings" })).toBeVisible();
  await expect(page.getByTestId("eq-curve")).toBeVisible();
  expect((await savedTrack(page)).inserts.map((d) => d.kind)).toEqual(["eq"]);
  await page.getByRole("button", { name: "Close device" }).click();

  // Show a volume lane (it starts flat at the fader's value) and pull it down to silence.
  await page.getByRole("button", { name: "Track options" }).click();
  await page.getByLabel("Show automation").selectOption({ label: "Volume" });
  const lane = page.locator("[data-testid^=lane-automation-]").first();
  await expect(lane).toBeVisible();
  const box = (await lane.boundingBox())!;
  await page.mouse.click(box.x + 12_000 / FRAMES_PER_PX, box.y + box.height - 2);
  let track = await savedTrack(page);
  expect(track.automation[0]!.points.length).toBe(2);
  expect(track.automation[0]!.points[1]!.value).toBeLessThan(0.01);

  // From 2 s on the automation holds the track silent.
  expect(await loudestFrom(page, 96_000)).toBeLessThan(0.02);

  // Undo the point: the track plays at full level again. Redo brings the silence back.
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await savedTrack(page)).automation[0]!.points.length).toBe(1);
  expect(await loudestFrom(page, 96_000)).toBeGreaterThan(0.4);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(async () => (await savedTrack(page)).automation[0]!.points.length).toBe(2);

  // Reload: the insert and the automation are saved, and still apply.
  await page.reload();
  await open(page);
  await expect(page.getByTestId("busy")).toHaveCount(0);
  track = await savedTrack(page);
  expect(track.inserts.map((d) => d.kind)).toEqual(["eq"]);
  expect(track.automation[0]!.points.length).toBe(2);
  expect(await loudestFrom(page, 96_000)).toBeLessThan(0.02);
  expect(await loudestFrom(page, 0)).toBeGreaterThan(0.3);
  expect(errors).toEqual([]);
});

test("routes a track through a bus with a reverb send", async ({ page }) => {
  await open(page);
  await page
    .getByTestId("import")
    .setInputFiles({ name: "Vox.wav", mimeType: "audio/wav", buffer: sineWav(4) });
  await expect(page.locator("[data-testid^=track-header-]")).toHaveCount(1);
  await page.getByRole("button", { name: "Mixer" }).click();
  const mixer = page.getByTestId("mixer");
  await mixer.getByRole("button", { name: "+ Bus" }).click();
  await expect(page.locator("[data-testid^=track-header-]")).toHaveCount(2);
  await mixer.getByLabel("Add effect on Bus 1").selectOption("reverb");
  await page.getByRole("button", { name: "Close device" }).click();
  await mixer.getByLabel("Add send on Vox").selectOption({ label: "Bus 1" });
  await expect(mixer.getByRole("slider", { name: "Send to Bus 1" })).toBeVisible();
  // Route the track itself into the bus too, then mute the bus: everything goes quiet.
  await mixer.getByLabel("Vox output").selectOption({ label: "Bus 1" });
  expect(await loudestFrom(page, 0)).toBeGreaterThan(0.3);
  await mixer.getByLabel("Mute Bus 1").click();
  expect(await loudestFrom(page, 0)).toBeLessThan(0.02);
  const project = await saved(page);
  const [vox, bus] = project.tracks as unknown as {
    id: number;
    kind: string;
    output: number | null;
    sends: { target: number }[];
  }[];
  expect(bus!.kind).toBe("bus");
  expect(vox!.output).toBe(bus!.id);
  expect(vox!.sends.map((s) => s.target)).toEqual([bus!.id]);
});
