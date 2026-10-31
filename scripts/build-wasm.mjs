// Builds crates/engine-wasm for the browser and copies it where WebPlatform imports it.
import { execFileSync } from "node:child_process";
import { copyFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(
  "cargo",
  ["build", "-p", "engine-wasm", "--target", "wasm32-unknown-unknown", "--profile", "wasm"],
  { cwd: root, stdio: "inherit" },
);
const src = join(root, "target/wasm32-unknown-unknown/wasm/engine_wasm.wasm");
const dst = join(root, "packages/platform/src/web/engine.wasm");
copyFileSync(src, dst);
console.log(`engine.wasm: ${(statSync(dst).size / 1024).toFixed(1)} KiB -> ${dst}`);
