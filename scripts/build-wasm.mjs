// Builds the browser WASM modules and copies them where WebPlatform imports them:
// engine-wasm (AudioWorklet) and media-wasm (decode worker).
import { execFileSync } from "node:child_process";
import { copyFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(
  "cargo",
  [
    "build",
    "-p",
    "engine-wasm",
    "-p",
    "media-wasm",
    "--target",
    "wasm32-unknown-unknown",
    "--profile",
    "wasm",
  ],
  { cwd: root, stdio: "inherit" },
);
for (const [crate, name] of [
  ["engine_wasm", "engine.wasm"],
  ["media_wasm", "media.wasm"],
]) {
  const src = join(root, `target/wasm32-unknown-unknown/wasm/${crate}.wasm`);
  const dst = join(root, "packages/platform/src/web", name);
  copyFileSync(src, dst);
  console.log(`${name}: ${(statSync(dst).size / 1024).toFixed(1)} KiB -> ${dst}`);
}
