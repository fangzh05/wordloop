import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { LearningDashboard } from "./dashboard/LearningDashboard.js";
import { LessonWidget } from "./lesson/LessonWidget.js";
import { DictationWidget } from "./dictation/DictationWidget.js";
import { WordImport } from "./import/WordImport.js";
import { connectApp } from "./mcpBridge.js";
import { PronunciationCards } from "./pronunciation/PronunciationCards.js";
import { PretestWidget } from "./pretest/PretestWidget.js";
import { ReviewWidget } from "./review/ReviewWidget.js";
import "./styles.css";

const kind = document.querySelector<HTMLMetaElement>('meta[name="wordloop-widget"]')?.content;
const widgets: Record<string, React.JSX.Element> = {
  import: <WordImport />,
  dashboard: <LearningDashboard />,
  pronunciation: <PronunciationCards />,
  dictation: <DictationWidget />,
  pretest: <PretestWidget />,
  review: <ReviewWidget />,
  lesson: <LessonWidget />,
};

const root = document.getElementById("root");
if (!root) throw new Error("Wordloop widget root is missing.");
createRoot(root).render(<StrictMode>{widgets[kind ?? ""] ?? <p className="error-text">无法识别 WordLoop 卡片。</p>}</StrictMode>);
void connectApp();
