import { TauriPlatform } from "@tessera/platform/tauri";
import { App } from "@tessera/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const platform = new TauriPlatform();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App platform={platform} />
  </StrictMode>,
);
