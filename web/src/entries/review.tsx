import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ReviewWidget } from "../review/ReviewWidget.js";
import { connectApp } from "../mcpBridge.js";

const root = document.getElementById("root");
if (!root) throw new Error("Wordloop widget root is missing.");

createRoot(root).render(
  <StrictMode>
    <ReviewWidget />
  </StrictMode>,
);

void connectApp();
