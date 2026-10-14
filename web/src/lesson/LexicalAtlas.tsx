import { useEffect, useRef, useState } from "react";

export type LexicalAtlasView = "family" | "root" | "network";

const VIEWS: Array<{ key: LexicalAtlasView; index: string; label: string; note: string; description: string }> = [
  {
    key: "family",
    index: "01",
    label: "词族",
    note: "MODERN DERIVATION",
    description: "展示学习卡中已有的现代派生关系；相似拼写不自动等于同源。",
  },
  {
    key: "root",
    index: "02",
    label: "词根同源",
    note: "HISTORICAL ORIGIN",
    description: "仅展示有来源证据的祖源关系；共享祖源不等于直接派生。",
  },
  {
    key: "network",
    index: "03",
    label: "语义网络",
    note: "SEMANTIC RELATIONS",
    description: "依关系类型筛选已核验关联；近义、反义与搭配不可混为一类。",
  },
];

export function LexicalAtlas({
  word,
  derivations,
  onClose,
}: {
  word: string;
  derivations: string[];
  onClose(): void;
}): React.JSX.Element {
  const [view, setView] = useState<LexicalAtlasView>("family");
  const [retrying, setRetrying] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousFocusRef.current?.focus();
    };
  }, []);

  const activeView = VIEWS.find((entry) => entry.key === view) ?? VIEWS[0]!;

  function retry(): void {
    setRetrying(true);
    window.setTimeout(() => setRetrying(false), 260);
  }

  return <div className="lexical-atlas-backdrop" role="presentation">
    <section className="lexical-atlas" role="dialog" aria-modal="true" aria-labelledby="lexical-atlas-title">
      <header className="lexical-atlas-header">
        <div className="lexical-atlas-header-copy">
          <span className="lexical-atlas-eyebrow">WORDLOOP / LEXICAL ATLAS</span>
          <h2 id="lexical-atlas-title">{word}</h2>
          <p>从一个词出发，看清词形、词源与语义之间的关系。</p>
        </div>
        <button ref={closeRef} type="button" className="button lexical-atlas-return" onClick={onClose}>返回学习</button>
      </header>

      <nav className="lexical-atlas-tabs" aria-label="图谱视图">
        {VIEWS.map((entry) => <button
          type="button"
          key={entry.key}
          aria-pressed={view === entry.key}
          onClick={() => setView(entry.key)}
        >
          <span>{entry.index}</span>
          <strong>{entry.label}</strong>
        </button>)}
      </nav>

      <div className="lexical-atlas-note" role="note">
        <span>{activeView.note}</span>
        <p>{activeView.description}</p>
      </div>

      <div className="lexical-atlas-content">
        {view === "family" ? <section aria-label="现代词族">
          {derivations.length ? <>
            <h3>常见派生</h3>
            <ul>{derivations.map((entry) => <li key={entry}>{entry}</li>)}</ul>
          </> : <p className="lexical-atlas-empty">当前学习卡没有提供已核验的现代派生词。</p>}
        </section> : <section className="lexical-atlas-unavailable" aria-live="polite">
          <p>{retrying ? "正在重试…" : "图谱暂时不可用，请确认已安装图谱迁移。"}</p>
          <button type="button" onClick={retry} disabled={retrying}>{retrying ? "重试中" : "重试"}</button>
        </section>}
      </div>
    </section>
  </div>;
}
