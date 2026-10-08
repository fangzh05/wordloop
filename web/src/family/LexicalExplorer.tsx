import { useEffect, useRef, useState } from "react";
import type { KnowledgeNode, LexicalGraph } from "../../../shared/lexicalContracts.js";
import { FAMILY_VISIBLE_LIMIT } from "../../../shared/familyContracts.js";
import { request } from "../standalone/apiClient.js";
import { Button } from "../components/Button.js";
import { FamilyMiniCard, loadEngine } from "./FamilyPanel.js";
import type { FamilyEngine } from "./familyEngine.js";
import { SenseNetworkExplorer } from "./SenseNetworkExplorer.js";
import {Source,RelationCard} from "./LexicalEvidence.js";

export function mergeLexicalGraph(current: LexicalGraph, next: LexicalGraph): LexicalGraph {
  if (current.view !== next.view || current.view === "network") return next;
  const all = new Map(current.nodes.map(n=>[n.node_id,n]));
  for (const n of next.nodes) if (all.has(n.node_id) || all.size < FAMILY_VISIBLE_LIMIT) all.set(n.node_id,n);
  const edges = new Map(current.edges.map(e=>[e.relation_id,e]));
  for (const e of next.edges) if (all.has(e.source_id) && all.has(e.target_id) && edges.size < 160) edges.set(e.relation_id,e);
  return {...current,nodes:[...all.values()],edges:[...edges.values()],
    truncated:current.truncated||next.truncated||next.nodes.some(n=>!all.has(n.node_id))||next.edges.some(e=>!edges.has(e.relation_id))};
}
function KnowledgeCard({ node }: { node: KnowledgeNode }) {
  return <div className="family-mini-card"><h3>{node.lemma}</h3><p className="part-of-speech">{node.node_type === "etymon" ? `历史词源 · ${node.language}` : node.node_type === "pattern" ? "句法搭配" : "同步构词成分"}</p>
    <p>{node.gloss}</p>{node.period && <p>{node.period}</p>}{node.explanation!==node.gloss&&<p>{node.explanation}</p>}
    {node.uncertain && <p role="note">来源存在不确定性；这是候选解释，不是唯一确定词源。</p>}
    {node.example && <p>{node.example}</p>}<Source value={node}/></div>;
}
export function LexicalExplorer({view,word,contextSenseId}:{view:"root"|"network";word:string;contextSenseId?:string}) {
  return view==="network"?<SenseNetworkExplorer word={word} contextSenseId={contextSenseId}/>:<RootExplorer word={word}/>;
}
function RootExplorer({word}:{word:string}) {
  const view="root";
  const [graph,setGraph]=useState<LexicalGraph|null>(null),[selected,setSelected]=useState("");
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");
  const canvas=useRef<HTMLDivElement>(null),engine=useRef<FamilyEngine|null>(null),epoch=useRef(0),alive=useRef(true);
  const graphRef=useRef(graph);graphRef.current=graph;
  const controls=useRef({load:(id:string)=>void load(id),save:(id:string)=>void save(id)});
  controls.current={load:id=>void load(id),save:id=>void save(id)};
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;epoch.current++;engine.current?.destroy();engine.current=null;};},[]);
  useEffect(()=>{void load(word);},[word]);
  useEffect(()=>{
    if(!graph||!canvas.current)return;
    if(engine.current){engine.current.update(graph);return;}
    let cancelled=false;
    void loadEngine().then(()=>{if(!cancelled&&canvas.current&&graphRef.current)engine.current=window.WordLoopFamilyEngine!(canvas.current,graphRef.current,{
      select:setSelected,recenter:id=>{const n=graphRef.current?.nodes.find(n=>n.node_id===id);if(n?.node_type==="lexeme"||n?.node_type==="etymon")controls.current.load(id);},candidate:id=>controls.current.save(id),
    });}).catch(e=>{if(!cancelled)setError(e.message);});
    return()=>{cancelled=true;};
  },[graph]);
  async function load(id:string,expand=false) {
    const version=++epoch.current;setBusy(true);setError("");setMessage("");
    // Clear old data immediately on a filter change; a stale response cannot restore it.
    if(!expand){engine.current?.destroy();engine.current=null;setGraph(null);}
    try {
      const next=await request<LexicalGraph>(`/api/web/lexical/graph?lexeme=${encodeURIComponent(id)}&view=${view}&depth=1`,{});
      if(!alive.current||version!==epoch.current)return;
      setGraph(old=>expand&&old?mergeLexicalGraph(old,next):next);if(!expand)setSelected(next.center.node_id);
    }catch(e){if(alive.current&&version===epoch.current)setError(e instanceof Error?e.message:"加载失败。");}
    finally{if(alive.current&&version===epoch.current)setBusy(false);}
  }
  async function save(id:string) {
    if(busy||graphRef.current?.nodes.find(n=>n.node_id===id)?.node_type!=="lexeme")return;
    setBusy(true);setError("");
    try{const r=await request<{message:string}>("/api/web/family/candidates",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({lexeme_id:id})});if(alive.current)setMessage(r.message);}
    catch(e){if(alive.current)setError(e instanceof Error?e.message:"保存失败。");}finally{if(alive.current)setBusy(false);}
  }
  const node=graph?.nodes.find(n=>n.node_id===selected);
  return <section aria-label="词根同源图谱">
    {busy&&<p role="status">正在加载…</p>}{error&&<p role="alert">{error} <button onClick={()=>void load(word)}>重试</button></p>}{message&&<p role="status">{message}</p>}
    {graph&&<div className="family-content"><section className="family-graph-pane"><p className="family-reason">一跳关系 · 方框是历史词源；共同祖源不表示直接派生</p>
      {graph.edges.length===0&&<p>暂无已核验的词源关系</p>}
      <div ref={canvas} className="family-canvas" aria-label="局部词汇知识图"/>
      <Button className="secondary" onClick={()=>engine.current?.fit()}>适合窗口</Button>
      <nav className="family-node-list" aria-label="图谱节点">{graph.nodes.map(n=><button type="button" key={n.node_id} aria-pressed={n.node_id===selected} onClick={()=>setSelected(n.node_id)}>{n.lemma}{n.node_type==="etymon"?` · ${n.language}`:n.node_type==="pattern"?" · 搭配":""}</button>)}</nav>
      {graph.truncated&&<p>已限制节点或关系数量；切换中心查看其他分支。</p>}
      <details className="family-help"><summary>操作提示</summary><p>点击查看；双击词条或词源设为中心；明确展开下一跳。拖动调整位置，双指缩放。长按现代英语词可加入未来候选。</p></details>
    </section><section className="family-detail-pane" aria-label="词条与关系详情">
      {node&&<>{node.node_type==="lexeme"?<FamilyMiniCard node={node}/>:<KnowledgeCard node={node}/>}
        {(node.node_type==="lexeme"||node.node_type==="etymon")&&<div className="family-actions"><Button className="secondary" disabled={busy} onClick={()=>void load(node.node_id)}>设为中心</Button><Button className="secondary" disabled={busy||graph.nodes.length>=40} onClick={()=>void load(node.node_id,true)}>展开一跳</Button>{node.node_type==="lexeme"&&<Button className="secondary" disabled={busy} onClick={()=>void save(node.node_id)}>加入未来候选</Button>}</div>}
        <details open className="family-sources"><summary>主要关系与来源</summary>{graph.edges.filter(e=>e.source_id===node.node_id||e.target_id===node.node_id).map(e=><RelationCard edge={e} graph={graph} key={e.relation_id}/>)}</details>
      </>}
    </section></div>}
  </section>;
}
