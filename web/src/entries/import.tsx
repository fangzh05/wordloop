import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WordImport } from "../import/WordImport.js";
import { connectApp } from "../mcpBridge.js";

const root = document.getElementById("root");
if (!root) throw new Error("Wordloop widget root is missing.");

createRoot(root).render(
  <StrictMode>
    <WordImport />
  </StrictMode>,
);

void connectApp();
