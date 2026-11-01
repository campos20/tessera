import { WebPlatform } from "@tessera/platform/web";
import { App } from "@tessera/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const platform = new WebPlatform();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App platform={platform} />
  </StrictMode>,
);
