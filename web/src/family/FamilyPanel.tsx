import { useEffect, useRef, useState } from "react";
import type { FamilyCandidate, FamilyGraph, FamilyNode, FamilySessionView,LexicalDictionaryEntry } from "../../../shared/familyContracts.js";
import { FAMILY_VISIBLE_LIMIT } from "../../../shared/familyContracts.js";
import { request } from "../standalone/apiClient.js";
import type { FamilyEngine } from "./familyEngine.js";
import { Button } from "../components/Button.js";

import { LexicalExplorer } from "./LexicalExplorer.js";
import type { GraphView } from "../../../shared/lexicalContracts.js";

let engineLoad: Promise<void> | null = null;
declare const __FAMILY_ASSET_VERSION__: string;
export function loadEngine(): Promise<void> {
  if (window.WordLoopFamilyEngine) return Promise.resolve();
  if (!engineLoad) engineLoad = new Promise((resolve, reject) => {
    const script = document.createElement("script"); script.src = `/family.js?v=${typeof __FAMILY_ASSET_VERSION__ === "string" ? __FAMILY_ASSET_VERSION__ : "dev"}`; script.async = true;
    script.onload = () => resolve(); script.onerror = () => { engineLoad = null; script.remove(); reject(new Error("关系图加载失败，请重试。")); };
    document.head.append(script);
  });
  return engineLoad;
}
export function mergeFamilyGraph(current: FamilyGraph, next: FamilyGraph): FamilyGraph {
  const nodes = new Map(current.nodes.map((n) => [n.lexeme_id, n]));
  for (const n of next.nodes) if (nodes.has(n.lexeme_id) || nodes.size < FAMILY_VISIBLE_LIMIT) nodes.set(n.lexeme_id, n);
  const edges = new Map(current.edges.map((e) => [e.relation_id, e]));
  for (const e of next.edges) if (nodes.has(e.source_id) && nodes.has(e.target_id)) edges.set(e.relation_id, e);
  return { ...current, nodes: [...nodes.values()], edges: [...edges.values()], truncated: current.truncated || next.truncated || current.nodes.length + next.nodes.length > FAMILY_VISIBLE_LIMIT };
}
export function FamilyEntry({ word, disabled = false, contextSenseId }: { word: string; disabled?: boolean; contextSenseId?: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  return <><Button type="button" className="secondary family-entry" disabled={disabled} onClick={(event) => { trigger.current = event.currentTarget; setOpen(true); }}>词族</Button>
    {open && <FamilyPanel initialWord={word} contextSenseId={contextSenseId} onClose={() => { setOpen(false); requestAnimationFrame(() => trigger.current?.focus()); }} />}</>;
}
export function FamilyMiniCard({ node }: { node: FamilyNode }) {
  const [dictionary,setDictionary]=useState<LexicalDictionaryEntry|null>(node.dictionary??null);
  const [dictionaryStatus,setDictionaryStatus]=useState(node.dictionary===undefined?"loading":"ready");
  const [dictionaryRetry,setDictionaryRetry]=useState(0);
  useEffect(()=>{
    let cancelled=false;setDictionary(node.dictionary??null);
    if(node.dictionary!==undefined){setDictionaryStatus("ready");return;}
    setDictionaryStatus("loading");
    void request<LexicalDictionaryEntry|null>(`/api/web/family/dictionary?lemma=${encodeURIComponent(node.lemma)}`,{})
      .then(value=>{if(!cancelled){setDictionary(value);setDictionaryStatus("ready");}})
      .catch(()=>{if(!cancelled)setDictionaryStatus("error");});
    return ()=>{cancelled=true;};
  },[node.lemma,node.dictionary,dictionaryRetry]);
  const posLabels:Record<string,string>={n:"n. 名词",v:"v. 动词",a:"adj. 形容词",r:"adv. 副词"};
  const layerLabels = { meaning: "词义", spelling: "拼写", pronunciation: "发音", collocation: "搭配", grammar: "语法" };
  const stateLabel = ({ known: "已熟悉", uncertain: "待巩固", unknown: "学习中", new: "待学习", review: "复习中" } as Record<string, string>)[node.user_state?.status ?? ""] ?? "学习中";
  return <div className="family-mini-card"><h3>{node.lemma} <span className="part-of-speech">{posLabels[node.part_of_speech]??node.part_of_speech}</span></h3>
    {(node.forms.some(f=>f.pronunciation)||dictionary?.phonetic) && <p className="family-pronunciation">{node.forms.find(f=>f.pronunciation)?.pronunciation??dictionary?.phonetic}</p>}
    {dictionaryStatus==="loading"&&<p role="status" className="family-reason">正在加载中文词典释义…</p>}
    {dictionaryStatus==="error"&&<p className="family-reason">词典暂时不可用。<Button className="secondary" onClick={()=>setDictionaryRetry(n=>n+1)}>重试释义</Button></p>}
    {dictionary && <section className="family-dictionary" aria-label="词典释义与词性"><h4>词典释义</h4>
      <dl>{dictionary.parts_of_speech.map((gloss,index)=><div key={index}><dt>{gloss.label||"补充释义"}</dt><dd>{gloss.definition_zh??gloss.definition_en}{!gloss.definition_zh&&gloss.definition_en&&<span className="family-reason"> · 暂无中文释义</span>}</dd></div>)}</dl>
      <p className="family-dictionary-source">来源：<a href="https://github.com/skywind3000/ECDICT" target="_blank" rel="noreferrer">{dictionary.source}</a> · {dictionary.license}</p>
    </section>}
    {dictionaryStatus==="ready"&&!dictionary?.chinese_translation&&<p className="family-reason">公开词典暂未收录中文释义，可查看英文释义。</p>}
    {(node.senses.length>0||dictionary?.english_definition)&&<details className="family-english-definitions"><summary>英文释义</summary>
      {dictionary?.english_definition&&<><h4>ECDICT · 词条释义</h4><p className="family-dictionary-english">{dictionary.english_definition}</p></>}
      {node.senses.length>0&&<><h4>来源词义 · {posLabels[node.part_of_speech]??node.part_of_speech}</h4><ol>{node.senses.map(s=><li key={s.sense_id}>{s.definition}</li>)}</ol></>}
    </details>}
    <p className="family-reason">{node.reason}</p>
    {!node.user_state ? <p className="family-learning-label">未学习 · Unlearned</p> : <details className="family-learning-state"><summary>学习状态 · {stateLabel}</summary>
      <p className="family-reason">记忆稳定度 {node.user_state.stability.toFixed(1)} 天</p>
      {node.user_state.next_review_at && <p className="family-reason">下次复习：{new Date(node.user_state.next_review_at).toLocaleString()}</p>}
      <dl className="family-layers">{(["meaning", "spelling", "pronunciation", "collocation", "grammar"] as const).map((layer) => {
        const evidence = node.user_state!.layers[layer];
        return <div key={layer}><dt>{layerLabels[layer]}</dt><dd>{evidence.needs_practice ? "需要练习" : evidence.correct_streak === null ? "尚无分层证据" : `连续正确 ${evidence.correct_streak} 次`}</dd></div>;
      })}</dl></details>}
  </div>;
}
export function FamilyPanel({ initialWord, onClose, contextSenseId }: { initialWord: string; onClose(): void; contextSenseId?: string }) {
  const [view, setView] = useState<GraphView>("family");
  const dialogRef = useRef<HTMLDialogElement>(null), canvasRef = useRef<HTMLDivElement>(null), engineRef = useRef<FamilyEngine | null>(null);
  const [graph, setGraph] = useState<FamilyGraph | null>(null), [selectedId, setSelectedId] = useState<string | null>(null);
  const [decision, setDecision] = useState<FamilyCandidate | null>(null), [micro, setMicro] = useState<FamilySessionView | null>(null);
  const [pending, setPending] = useState<FamilySessionView | null>(null);
  const [answer, setAnswer] = useState(""), [feedbackOpen, setFeedbackOpen] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [message, setMessage] = useState("");
  const [startError,setStartError]=useState(""),[starting,setStarting]=useState(false);
  const requestId = useRef(crypto.randomUUID()), epoch = useRef(0), alive = useRef(true);
  const graphRef = useRef(graph); graphRef.current = graph;
  const controls = useRef({ select: setSelectedId, recenter: (id: string) => void load(id), candidate: (id: string) => void saveCandidate(id) });
  controls.current = { select: setSelectedId, recenter: (id) => void load(id), candidate: (id) => void saveCandidate(id) };
  useEffect(() => {
    alive.current = true;
    dialogRef.current?.showModal();
    void load(initialWord);
    return () => { alive.current = false; epoch.current++; engineRef.current?.destroy(); engineRef.current = null; };
  }, []);
  useEffect(() => { if (graph && !micro && view === "family") engineRef.current?.update(graph); }, [graph, micro, view]);
  useEffect(()=>{if(micro)dialogRef.current?.scrollTo({top:0});},[micro?.id]);
  // Canvas unmounts during a micro-session; rebuild only when returning to graph.
  useEffect(() => {
    if (micro || view !== "family") { engineRef.current?.destroy(); engineRef.current = null; return; }
    if (!graph || !canvasRef.current || engineRef.current) return;
    let cancelled = false;
    void loadEngine().then(() => {
      if (cancelled || !canvasRef.current || !graphRef.current) return;
      engineRef.current = window.WordLoopFamilyEngine!(canvasRef.current, graphRef.current, {
        select: (id) => controls.current.select(id), recenter: (id) => controls.current.recenter(id), candidate: (id) => controls.current.candidate(id),
      });
    }).catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [graph, micro, view]);
  async function load(lexeme: string) {
    if (busy) return;
    const version = ++epoch.current;
    setBusy(true); setError("");setStartError("");
    try {
      const [next, candidate, unfinished] = await Promise.all([
        request<FamilyGraph>(`/api/web/family/graph?lexeme=${encodeURIComponent(lexeme)}&depth=1`, {}),
        request<FamilyCandidate>(`/api/web/family/candidate?lexeme=${encodeURIComponent(lexeme)}`, {}),
        request<FamilySessionView | null>("/api/web/family/session", {}),
      ]);
      if (!alive.current || version !== epoch.current) return;
      setGraph(next); setSelectedId(next.center.lexeme_id); setDecision(candidate); setPending(unfinished); requestId.current = crypto.randomUUID();
    } catch (e) { if (alive.current && version === epoch.current) setError(e instanceof Error ? e.message : "加载失败。"); }
    finally { if (alive.current && version === epoch.current) setBusy(false); }
  }
  async function expand(id: string) {
    if (busy) return; setBusy(true); setError("");
    try { const next = await request<FamilyGraph>(`/api/web/family/expand?lexeme=${encodeURIComponent(id)}&depth=1`, {});
      if (alive.current) setGraph((old) => old ? mergeFamilyGraph(old, next) : next);
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "展开失败。"); }
    finally { if (alive.current) setBusy(false); }
  }
  async function saveCandidate(id: string) {
    if (busy) return; setBusy(true); setError("");
    try { const result = await request<{ message: string }>("/api/web/family/candidates", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lexeme_id: id }) });
      if (alive.current) { setMessage(result.message); setSelectedId(id); }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "保存失败。"); }
    finally { if (alive.current) setBusy(false); }
  }
  async function start() {
    if (!graph || busy) return; setBusy(true);setStarting(true);setStartError("");
    try {
      const next = await request<FamilySessionView>("/api/web/family/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lexeme: graph.center.lexeme_id, request_id: requestId.current }) });
      if (alive.current) { setMicro(next); setFeedbackOpen(false); setAnswer(""); }
    } catch (e) { if (alive.current) setStartError(e instanceof Error ? e.message : "练习未开始，请重试。"); }
    finally { if (alive.current) {setBusy(false);setStarting(false);} }
  }
  async function submit() {
    if (!micro || busy || !answer.trim()) return; setBusy(true); setError("");
    try {
      const next = await request<FamilySessionView>("/api/web/family/answer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ session_id: micro.id, index: micro.index, answer }) });
      if (alive.current) { setMicro(next); setFeedbackOpen(true); setAnswer(""); }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : "提交失败。"); }
    finally { if (alive.current) setBusy(false); }
  }
  const selected = graph?.nodes.find((n) => n.lexeme_id === selectedId);
  return <dialog ref={dialogRef} className="family-dialog" aria-labelledby="family-title" onCancel={(e) => { e.preventDefault(); onClose(); }}>
    <header className="family-header"><div><span className="eyebrow">词汇知识图谱</span><h2 id="family-title">{micro ? "词族短练习" : graph?.center.lemma ?? initialWord}</h2></div>
      <Button type="button" className="secondary" onClick={onClose}>返回学习</Button></header>
    {!micro && <nav className="lexical-view-tabs" aria-label="图谱视图">{([['family','词族'],['root','词根同源'],['network','语义网络']] as const).map(([key,label]) => <button type="button" key={key} aria-pressed={view===key} onClick={()=>setView(key)}>{label}</button>)}</nav>}
    {view !== "family" && !micro ? <LexicalExplorer key={view} view={view} word={graph?.center.lemma ?? initialWord}
      contextSenseId={!graph||graph.center.lemma===initialWord.trim().toLowerCase()||graph.center.lexeme_id===initialWord?contextSenseId:undefined}/> : <>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {busy && <p role="status">正在处理…</p>}
    {micro ? <section className="family-micro">
      <div className="family-micro-progress"><span>短练习</span><span>{Math.min(micro.index + 1, micro.total)} / {micro.total}</span></div>
      <div className="pretest-progress" role="progressbar" aria-label="词族练习进度" aria-valuemin={0} aria-valuemax={micro.total} aria-valuenow={micro.index}><span style={{ width: `${micro.index / micro.total * 100}%` }} /></div>
      <p className="family-reason">{micro.explanation}</p>
      {feedbackOpen && micro.feedback ? <><p>{micro.feedback.is_correct ? "正确" : "再留意这个形式"}：{micro.feedback.answer}</p><p>{micro.feedback.explanation}</p>
        {!micro.completed && <Button onClick={() => setFeedbackOpen(false)}>下一步</Button>}</>
        : !micro.completed && micro.step && <form onSubmit={(e) => { e.preventDefault(); void submit(); }}><p>{micro.step.prompt}</p><label htmlFor="family-answer">你的答案</label><input id="family-answer" className="answer-input" autoComplete="off" autoCapitalize="off" spellCheck={false} value={answer} onChange={(e) => setAnswer(e.target.value)} autoFocus />
          <Button type="submit" disabled={busy || !answer.trim()}>提交</Button></form>}
      {micro.completed && <><p>{micro.activated ? "已完成。本次只引入一个派生词，后续测试由现有 FSRS 安排。" : "已完成。继续原来的学习流程。"}</p>
        <Button onClick={() => { setMicro(null); if (graph) void load(graph.center.lexeme_id); }}>回到词族</Button></>}
      <p className="family-reason">随时返回学习；再次打开词族可恢复未完成的短练习。</p>
    </section> : graph && <>
      <div className="family-content"><section className="family-graph-pane" aria-label="词族关系">
      <p className="family-reason">一跳派生关系 · 点击查看，按需展开</p>
      <div ref={canvasRef} className="family-canvas" aria-label="局部形态派生词族图" />
      <Button className="secondary" onClick={()=>engineRef.current?.fit()}>适合窗口</Button>
      <nav className="family-node-list" aria-label="词族节点">{graph.nodes.map((n) => <button type="button" key={n.lexeme_id} aria-pressed={n.lexeme_id === selectedId} onClick={() => setSelectedId(n.lexeme_id)}>{n.lemma}</button>)}</nav>
      {graph.truncated && <p>已限制可见节点数量；切换中心查看其他分支。</p>}
      <details className="family-help"><summary>操作提示</summary><p>拖动调整位置，双指缩放。双击节点切换中心，长按加入未来候选；也可使用词卡下方的按钮。</p></details>
      </section><section className="family-detail-pane" aria-label="词卡与短练习">
      {selected && <><FamilyMiniCard node={selected} /><div className="family-actions">
        <Button className="secondary" disabled={busy} onClick={() => void load(selected.lexeme_id)}>设为中心</Button>
        <Button className="secondary" disabled={busy || graph.nodes.length >= FAMILY_VISIBLE_LIMIT} onClick={() => void expand(selected.lexeme_id)}>展开一跳</Button>
        <Button className="secondary" disabled={busy} onClick={() => void saveCandidate(selected.lexeme_id)}>加入未来候选</Button>
      </div></>}
      {decision && <section className="family-recommendation"><p>{decision.reason}</p>
        {pending ? <Button disabled={busy} onClick={() => { setMicro(pending); setFeedbackOpen(false); }}>恢复 {pending.base} 的词族练习</Button>
          : <Button disabled={busy || !graph.center.user_state || (!decision.eligible_now && decision.stage !== "A")} onClick={() => void start()}>{starting ? "正在启动短练习…" : decision.stage === "A" ? "先巩固当前词 · 约 2 分钟" : decision.stage === "D" ? "词族语境辨析 · 约 2 分钟" : "学习这个词族 · 约 2 分钟"}</Button>}
          {startError&&<p role="alert" className="family-start-error">{startError}</p>}
      </section>}
      <details className="family-sources"><summary>关系来源与许可</summary>{graph.edges.map((e) => <p key={e.relation_id}>{e.source} {e.source_version} · {e.license} · 置信度 {e.confidence}<br />{e.morphology}
        {typeof e.provenance.url === "string" && <a href={e.provenance.url} target="_blank" rel="noreferrer">查看来源</a>}</p>)}</details>
      </section></div>
    </>}
    {!graph && !busy && <Button onClick={() => void load(initialWord)}>重试</Button>}
  </>}
  </dialog>;
}
