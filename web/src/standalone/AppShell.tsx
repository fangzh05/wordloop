import { useEffect, useId, useRef, useState } from "react";
import { DailyNewWordLimitEditor, type DailyNewWordLimitSaveResult } from "../components/DailyNewWordLimitEditor.js";
import { getTodayOverview } from "./apiClient.js";

export type AppSection = "today" | "study" | "capture" | "insights" | "vocabulary";
const navItems: Array<{ section: AppSection; label: string; glyph: string }> = [
  { section: "today", label: "今日", glyph: "◷" }, { section: "study", label: "学习", glyph: "→" },
  { section: "capture", label: "划词", glyph: "⌁" }, { section: "insights", label: "洞察", glyph: "↗" },
  { section: "vocabulary", label: "词库", glyph: "Aa" },
];

export function AppNavigation({ section, onNavigate }: { section: AppSection; onNavigate: (section: AppSection) => void }): React.JSX.Element {
  const items = <>{navItems.map((item) => <button key={item.section} type="button" className="app-nav-item" aria-current={section === item.section ? "page" : undefined} onClick={() => onNavigate(item.section)}><span aria-hidden="true">{item.glyph}</span><b>{item.label}</b></button>)}</>;
  return <>
    <nav className="app-navigation app-navigation-desktop" aria-label="主导航">{items}</nav>
    <nav className="app-navigation app-navigation-mobile" aria-label="主导航">{items}</nav>
  </>;
}

export type Appearance = "system" | "light" | "dark";

export function SettingsSheet({ open, onClose, appearance, onAppearanceChange, dailyLimit, busy, onSaveDailyNewWordLimit }: {
  open: boolean;
  onClose: () => void;
  appearance: Appearance;
  onAppearanceChange: (appearance: Appearance) => void;
  dailyLimit: number | null;
  busy: boolean;
  onSaveDailyNewWordLimit?: (limit: number) => Promise<DailyNewWordLimitSaveResult>;
}): React.JSX.Element | null {
  const headingId = useId();
  const [saveError, setSaveError] = useState("");
  const [targetRetention, setTargetRetention] = useState<number | null>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeHandlerRef = useRef(onClose);
  closeHandlerRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeHandlerRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(sheetRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ) ?? []);
      if (!focusable.length) { event.preventDefault(); return; }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void getTodayOverview(controller.signal).then((today) => {
      if (!controller.signal.aborted) setTargetRetention(today.target_retention);
    }).catch(() => {
      if (!controller.signal.aborted) setTargetRetention(null);
    });
    return () => controller.abort();
  }, [open]);
  if (!open) return null;
  return <div className="settings-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={sheetRef} className="settings-sheet" role="dialog" aria-modal="true" aria-labelledby={headingId} tabIndex={-1}>
      <header><div><span className="eyebrow">WordLoop</span><h2 id={headingId}>设置</h2></div><button ref={closeButtonRef} type="button" className="icon-button" aria-label="关闭设置" onClick={onClose}>×</button></header>
      <div className="settings-section"><h3>外观</h3><div className="appearance-options" role="group" aria-label="外观模式">
        {(["system", "light", "dark"] as const).map((value) => <button type="button" key={value} aria-pressed={appearance === value} onClick={() => onAppearanceChange(value)}>{value === "system" ? "跟随系统" : value === "light" ? "浅色" : "深色"}</button>)}
      </div></div>
      <div className="settings-section"><h3>每日新词目标</h3><p>降低目标不会删除已经学习的记录。</p>{dailyLimit !== null && onSaveDailyNewWordLimit ? <DailyNewWordLimitEditor limit={dailyLimit} onSave={async (limit) => { setSaveError(""); try { return await onSaveDailyNewWordLimit(limit); } catch (error) { setSaveError(error instanceof Error ? error.message : "目标保存失败，请重试。"); throw error; } }} disabled={busy} /> : <p>当前目标暂时不可读取。</p>}{saveError && <p role="alert" className="standalone-status error">{saveError}</p>}</div>
      <div className="settings-section"><h3>目标记忆率</h3><p>{targetRetention === null ? "暂时不可读取" : `${(targetRetention * 100).toFixed(0)}%`} · 只读，由当前 FSRS 调度配置决定。</p></div>
    </section>
  </div>;
}
