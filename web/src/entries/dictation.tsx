import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { DictationWidget } from "../dictation/DictationWidget.js";
import { connectApp } from "../mcpBridge.js";

const root = document.getElementById("root");
if (!root) throw new Error("Wordloop widget root is missing.");

createRoot(root).render(
  <StrictMode>
    <DictationWidget />
  </StrictMode>,
);

void connectApp();
