import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AuthGate } from "./AuthGate.js";

const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><AuthGate /></StrictMode>);
