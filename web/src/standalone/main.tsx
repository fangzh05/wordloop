import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import StandaloneApp from "./StandaloneApp.js";

const root = document.getElementById("root");
if (root) createRoot(root).render(<StrictMode><StandaloneApp /></StrictMode>);
