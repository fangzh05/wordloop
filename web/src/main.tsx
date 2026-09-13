import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LearningDashboard } from "./dashboard/LearningDashboard.js";
import { DictationWidget } from "./dictation/DictationWidget.js";
import { WordImport } from "./import/WordImport.js";
import { connectApp } from "./mcpBridge.js";
import { PronunciationCards } from "./pronunciation/PronunciationCards.js";
import { PretestWidget } from "./pretest/PretestWidget.js";
import "./styles.css";

const kind = document.querySelector<HTMLMetaElement>('meta[name="wordloop-widget"]')?.content;
const widgets: Record<string, React.JSX.Element> = {
  import: <WordImport />,
  dashboard: <LearningDashboard />,
  pronunciation: <PronunciationCards />,
  dictation: <DictationWidget />,
  pretest: <PretestWidget />,
};

const root = document.getElementById("root");
if (!root) throw new Error("Wordloop root element is missing.");
createRoot(root).render(<StrictMode>{widgets[kind ?? ""] ?? <p className="error-text">Unknown Wordloop widget.</p>}</StrictMode>);
void connectApp();
