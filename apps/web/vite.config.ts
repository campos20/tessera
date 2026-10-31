import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// SharedArrayBuffer (engine ↔ AudioWorklet rings) requires cross-origin isolation.
// Production hosting must send the same headers (see README).
const crossOriginIsolation = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  plugins: [react()],
  server: { headers: crossOriginIsolation },
  preview: { headers: crossOriginIsolation },
  worker: { format: "es" },
  build: { target: "es2022" },
});
