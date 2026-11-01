import { WebPlatform } from "@tessera/platform/web";
import { App, Testbench } from "@tessera/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const platform = new WebPlatform();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* M2 in progress: `?view=shell` previews the new DAW shell; the testbench stays the default until it is wired up. */}
    {new URLSearchParams(location.search).get("view") === "shell" ? (
      <App platform={platform} />
    ) : (
      <Testbench platform={platform} />
    )}
  </StrictMode>,
);
