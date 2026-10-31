import { WebPlatform } from "@tessera/platform/web";
import { Testbench } from "@tessera/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const platform = new WebPlatform();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Testbench platform={platform} />
  </StrictMode>,
);
