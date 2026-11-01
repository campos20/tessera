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

test("page is cross-origin isolated and the first visit creates exactly one project", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  expect(await page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);
  // On hosts that need coi-sw.js the page reloads once; the app must not boot before that.
  await page.getByRole("button", { name: /Untitled/ }).click();
  await expect(page.locator(".menu-project")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("create, edit, save, reload and keep editing a project", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);

  // Name the project.
  await page.getByRole("button", { name: /Untitled/ }).click();
  await page.getByLabel("Project name").fill("Acceptance Song");
  await page.getByLabel("Project name").press("Enter");
  await expect(page.getByTestId("project-name")).toHaveText("Acceptance Song");

  // Import audio → a track with one 6 s clip at 0.
  await page
    .getByTestId("import")
    .setInputFiles({ name: "Lead.wav", mimeType: "audio/wav", buffer: sineWav(6) });
  const lane = page.locator("[data-testid^=lane-]").first();
  await expect(page.locator("[data-testid^=track-header-]")).toHaveCount(1);
  await expect(page.locator("[data-testid^=track-header-]").first()).toContainText("Lead");
  let project = await saved(page);
  expect(project.tracks[0]!.clips).toEqual([
    expect.objectContaining({ start: 0, length: 288_000, offset: 0 }),
  ]);

  // Drag the clip 100 px right: snaps to 120000 frames (2.5 s).
  const from = await at(lane, 120, 50);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 50, from.y, { steps: 5 });
  await page.mouse.move(from.x + 101, from.y, { steps: 5 });
  await page.mouse.up();
  project = await saved(page);
  expect(project.tracks[0]!.clips[0]!.start).toBe(120_000);

  // Move the playhead (ruler click) and split the selected clip there.
  const ruler = page.getByTestId("ruler");
  const split = await at(ruler, 216_000 / FRAMES_PER_PX, 15);
  await page.mouse.click(split.x, split.y);
  await page.keyboard.press("s");
  project = await saved(page);
  expect(project.tracks[0]!.clips).toEqual([
    expect.objectContaining({ start: 120_000, length: 96_000, offset: 0 }),
    expect.objectContaining({ start: 216_000, length: 192_000, offset: 96_000 }),
  ]);

  // Undo and redo the split.
  await page.keyboard.press("ControlOrMeta+z");
  expect((await saved(page)).tracks[0]!.clips).toHaveLength(1);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  expect((await saved(page)).tracks[0]!.clips).toHaveLength(2);

  // Reload: the project, its edits and its audio come back.
  await page.reload();
  await open(page);
  await expect(page.getByTestId("project-name")).toHaveText("Acceptance Song");
  await expect(page.locator("[data-testid^=track-header-]").first()).toContainText("Lead");
  await expect(page.getByTestId("busy")).toHaveCount(0);
  const inClip = await at(page.getByTestId("ruler"), 180_000 / FRAMES_PER_PX, 15);
  await page.mouse.click(inClip.x, inClip.y);
  await page.getByRole("button", { name: "Play" }).click();
  await expect.poll(() => masterPeak(page)).toBeGreaterThan(0.4);
  await page.getByRole("button", { name: "Pause" }).click();

  // Keep editing: select the second clip and delete it.
  const second = await at(lane, 216_000 / FRAMES_PER_PX + 60, 50);
  await page.mouse.click(second.x, second.y);
  await page.keyboard.press("Delete");
  project = await saved(page);
  expect(project.tracks[0]!.clips).toEqual([expect.objectContaining({ start: 120_000, length: 96_000 })]);
  expect(errors).toEqual([]);
});

test("exports a .tessera file and imports it as a new project", async ({ page }, testInfo) => {
  await open(page);
  await page
    .getByTestId("import")
    .setInputFiles({ name: "Keys.wav", mimeType: "audio/wav", buffer: sineWav(2) });
  await expect(page.locator("[data-testid^=track-header-]")).toHaveCount(1);
  await saved(page);

  await page.getByRole("button", { name: /Untitled/ }).click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Export .tessera…" }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("Untitled.tessera");
  const archive = testInfo.outputPath("export.tessera");
  await download.saveAs(archive);

  // Start over, then import the archive.
  await page.getByRole("button", { name: /Untitled/ }).click();
  await page.getByRole("menuitem", { name: "New project" }).click();
  await expect(page.locator("[data-testid^=track-header-]")).toHaveCount(0);
  await page.getByRole("button", { name: /Untitled/ }).click();
  await page.getByTestId("import-archive").setInputFiles(archive);
  await expect(page.locator("[data-testid^=track-header-]").first()).toContainText("Keys");
  await expect(page.getByTestId("busy")).toHaveCount(0);

  await page.getByRole("button", { name: "Play" }).click();
  await expect.poll(() => masterPeak(page)).toBeGreaterThan(0.4);
  await page.getByRole("button", { name: "Pause" }).click();
  // Three projects now: the original, the empty one, and the imported copy.
  await page.getByRole("button", { name: /Untitled/ }).click();
  await expect(page.locator(".menu-project")).toHaveCount(3);
});

test("reports undecodable files without breaking the session", async ({ page }) => {
  await open(page);
  await page
    .getByTestId("import")
    .setInputFiles({ name: "broken.wav", mimeType: "audio/wav", buffer: Buffer.from("not audio") });
  await expect(page.getByTestId("error")).toContainText("unsupported audio format");
  await page
    .getByTestId("import")
    .setInputFiles({ name: "ok.wav", mimeType: "audio/wav", buffer: sineWav(0.5) });
  await expect(page.locator("[data-testid^=track-header-]").first()).toContainText("ok");
});

/** A 16-bit mono 44.1 kHz WAV singing A3, C4 and E4 with short gaps between them. */
function melodyWav(sampleRate = 44_100): Buffer {
  const notes: [number, number, number][] = [
    [0.1, 0.7, 220],
    [0.8, 1.4, 261.63],
    [1.5, 2.1, 329.63],
  ];
  const frames = Math.round(2.4 * sampleRate);
  const data = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) {
    const t = i / sampleRate;
    const note = notes.find(([a, b]) => t >= a && t < b);
    const v = note ? Math.sin(2 * Math.PI * note[2] * t) * 12_000 : 0;
    data.writeInt16LE(Math.round(v), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

interface SavedNote {
  id: number;
  center: number;
  shift: number;
}

const savedNotes = async (page: Page): Promise<SavedNote[]> =>
  ((await saved(page)).tracks[0]!.clips[0] as unknown as { tune: { notes: SavedNote[] } | null }).tune
    ?.notes ?? [];

test("edits pitch in Tune, plays the result, undoes and survives a reload", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  await page
    .getByTestId("import")
    .setInputFiles({ name: "Vocal.wav", mimeType: "audio/wav", buffer: melodyWav() });
  const lane = page.locator("[data-testid^=lane-]").first();
  await expect(page.locator("[data-testid^=track-header-]")).toHaveCount(1);

  // Double-click the clip: Tune analyzes it and shows its three notes.
  const clip = await at(lane, 40, 50);
  await page.mouse.dblclick(clip.x, clip.y);
  const editor = page.getByTestId("tune-editor");
  await expect(editor).toBeVisible();
  let notes = await savedNotes(page);
  expect(notes.map((n) => Math.round(n.center))).toEqual([57, 60, 64]);
  expect(notes.every((n) => n.shift === 0)).toBe(true);

  // Select every note and raise them a semitone.
  const canvas = page.getByTestId("tune-canvas");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ArrowUp");
  await expect
    .poll(async () => (await savedNotes(page)).map((n) => Math.round(n.center + n.shift)))
    .toEqual([58, 61, 65]);

  // The tuned result plays (rendered regions are in the engine), and so does the A/B original.
  await expect(page.getByTestId("busy")).toHaveCount(0);
  await page.getByRole("button", { name: "Play" }).click();
  await expect.poll(() => masterPeak(page)).toBeGreaterThan(0.2);
  await page.getByRole("button", { name: "Pause" }).click();
  await editor.getByRole("button", { name: /A\/B/ }).click();
  await expect(editor.getByRole("button", { name: /A\/B/ })).toHaveAttribute("aria-pressed", "true");
  await editor.getByRole("button", { name: /A\/B/ }).click();

  // Undo restores the sung pitch; redo brings the edit back.
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await savedNotes(page)).every((n) => n.shift === 0)).toBe(true);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(async () => (await savedNotes(page)).every((n) => n.shift !== 0)).toBe(true);

  // Close, reload: the edits are saved and the clip still plays tuned.
  await editor.getByRole("button", { name: "Close Tune" }).click();
  await expect(editor).toHaveCount(0);
  await page.reload();
  await open(page);
  await expect(page.getByTestId("busy")).toHaveCount(0);
  notes = await savedNotes(page);
  expect(notes.map((n) => Math.round(n.center + n.shift))).toEqual([58, 61, 65]);
  await page.getByRole("button", { name: "Play" }).click();
  await expect.poll(() => masterPeak(page)).toBeGreaterThan(0.2);
  await page.getByRole("button", { name: "Pause" }).click();
  expect(errors).toEqual([]);
});
