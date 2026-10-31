import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// SharedArrayBuffer (engine ↔ AudioWorklet rings) requires cross-origin isolation.
// Production hosting must send the same headers (see README).
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  // Sub-path deployments such as GitHub Pages (`/tessera/`) set BASE_PATH.
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  server: { headers: crossOriginIsolation },
  // NO_COI_HEADERS=1 mimics GitHub Pages, where public/coi-sw.js must supply the headers.
  preview: { headers: process.env.NO_COI_HEADERS ? {} : crossOriginIsolation },
  worker: { format: "es" },
  build: { target: "es2022" },
});
