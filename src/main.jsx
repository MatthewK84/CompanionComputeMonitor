import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import EdgeTelemetryConsole from "./EdgeTelemetryConsole.jsx";

const container = document.getElementById("root");
if (container === null) {
  throw new Error("Root container #root not found");
}
createRoot(container).render(
  <StrictMode>
    <EdgeTelemetryConsole />
  </StrictMode>
);
