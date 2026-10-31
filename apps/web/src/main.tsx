import { WebPlatform } from "@tessera/platform/web";
import { HelloSine } from "@tessera/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const platform = new WebPlatform();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HelloSine platform={platform} />
  </StrictMode>,
);
