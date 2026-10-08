import { useEffect, useRef, useState } from "react";
import type { GraphEdge, LexicalGraph, NetworkGroup, NetworkType } from "../../../shared/lexicalContracts.js";
import { NETWORK_TYPES, RELATION_LABELS } from "../../../shared/lexicalContracts.js";
import { request } from "../standalone/apiClient.js";
import { Button } from "../components/Button.js";
import { FamilyMiniCard, loadEngine } from "./FamilyPanel.js";
import { RelationCard, Source } from "./LexicalEvidence.js";
import type { FamilyEngine } from "./familyEngine.js";

const FILTERS: Array<[string,NetworkType[]]> = [["近义",["SYNONYM"]],["反义",["ANTONYM"]],["对比",["CONTRAST"]],
  ["易混",["CONFUSABLE"]],["搭配",["COLLOCATION"]],["上下位",["HYPERNYM","HYPONYM"]]];
type Selection={entity:string;sense?:string;scope:"sense"|"unscoped";offset:number;includeFolded?:boolean;evidenceOffset?:number};

/** Only the preview is condensed. Cards retain every returned sense pair and its evidence. */
export function networkPreview(graph:LexicalGraph,limit:number):LexicalGraph {
  const groups=graph.network?.groups.slice(0,limit)??[];
  const representatives=new Map<string,string>();
  for(const group of groups)for(const id of group.node_ids)representatives.set(id,group.node_ids[0]!);
  const ids=new Set([graph.center.node_id,...representatives.values()]);
  return {...graph,nodes:graph.nodes.filter(n=>ids.has(n.node_id)),edges:graph.edges.filter(e=>
    groups.some(g=>g.edge_ids.includes(e.relation_id))).map(e=>({...e,source_id:representatives.get(e.source_id)??e.source_id,
      target_id:representatives.get(e.target_id)??e.target_id}))};
}

export function SenseNetworkExplorer({word,contextSenseId}:{word:string;contextSenseId?:string}) {
  const [choice,setChoice]=useState<Selection>({entity:word,scope:"sense",offset:0,sense:contextSenseId});
  const [types,setTypes]=useState<NetworkType[]>(["SYNONYM","ANTONYM","CONTRAST","COLLOCATION"]);
  const [graph,setGraph]=useState<LexicalGraph|null>(null),[selected,setSelected]=useState("");
  const [busy,setBusy]=useState(false),[error,setError]=useState(""),[message,setMessage]=useState("");
  const [saving,setSaving]=useState(false);
  const [retry,setRetry]=useState(0),[previewLimit,setPreviewLimit]=useState(4);
  const canvas=useRef<HTMLDivElement>(null),engine=useRef<FamilyEngine|null>(null),current=useRef(graph);
  current.current=graph;
  const mounted=useRef(true);
  const initialContext=useRef({word,contextSenseId});
  const callbacks=useRef({select:(id:string)=>setSelected(id),recenter:(id:string)=>recenter(id),candidate:(id:string)=>void save(id)});
  callbacks.current={select:setSelected,recenter,candidate:id=>void save(id)};
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;engine.current?.destroy();engine.current=null;};},[]);
  useEffect(()=>{
    if(initialContext.current.word===word&&initialContext.current.contextSenseId===contextSenseId)return;
    initialContext.current={word,contextSenseId};setChoice({entity:word,scope:"sense",offset:0,sense:contextSenseId});
  },[word,contextSenseId]);
  useEffect(()=>{
    let cancelled=false;const abort=new AbortController();setBusy(true);setError("");setMessage("");
    const q=new URLSearchParams({lexeme:choice.entity,view:"network",version:"2",depth:"1",relation_types:types.join(","),
      scope:choice.scope,offset:String(choice.offset),limit:"8",include_folded:String(choice.includeFolded??false),evidence_offset:String(choice.evidenceOffset??0)});
    if(choice.sense)q.set("sense_id",choice.sense);
    void request<LexicalGraph>(`/api/web/lexical/graph?${q}`,{signal:abort.signal}).then(next=>{
      if(cancelled)return;setGraph(next);setSelected(next.center.node_id);
    }).catch(e=>{if(!cancelled){setGraph(null);setError(e instanceof Error?e.message:"加载失败。");}})
      .finally(()=>{if(!cancelled)setBusy(false);});
    return()=>{cancelled=true;abort.abort();};
  },[choice,types,retry]);
  useEffect(()=>{
    if(!canvas.current||!graph||busy)return;
    const element=canvas.current;let cancelled=false;
    const update=()=>{
      const limit=element.clientWidth<500?4:8;setPreviewLimit(limit);
      const next=networkPreview(graph,limit);
      if(engine.current)engine.current.update(next);
      else engine.current=window.WordLoopFamilyEngine!(element,next,{select:id=>callbacks.current.select(id),
        selectEdge:id=>callbacks.current.select(id),recenter:id=>callbacks.current.recenter(id),candidate:id=>callbacks.current.candidate(id)});
    };
    const observer=new ResizeObserver(()=>{if(!cancelled&&window.WordLoopFamilyEngine)update();});observer.observe(element);
    void loadEngine().then(()=>{if(!cancelled)update();}).catch(e=>{if(!cancelled)setError(e.message);});
    return()=>{cancelled=true;observer.disconnect();engine.current?.destroy();engine.current=null;};
  },[graph,busy]);
  function recenter(id:string) {
    const g=current.current;if(!g||g.nodes.find(n=>n.node_id===id)?.node_type!=="lexeme")return;
    const senses=new Set(g.edges.filter(e=>e.source_id===id||e.target_id===id).map(e=>e.source_id===id?e.source_sense_id:e.target_sense_id).filter(Boolean));
    setChoice({entity:id,scope:"sense",offset:0,sense:senses.size===1?[...senses][0]!:undefined});
  }
  async function save(id:string) {
    if(busy||saving||current.current?.nodes.find(n=>n.node_id===id)?.node_type!=="lexeme")return;
    setSaving(true);setError("");
    try{const r=await request<{message:string}>("/api/web/family/candidates",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({lexeme_id:id})});if(mounted.current)setMessage(r.message);}
    catch(e){if(mounted.current)setError(e instanceof Error?e.message:"保存失败。");}
    finally{if(mounted.current)setSaving(false);}
  }
  const meta=graph?.network,center=graph?.center,option=meta?.lexeme_options.find(o=>o.lexeme_id===center?.node_id);
  const sense=option?.senses.find(s=>s.sense_id===meta?.selected_sense_id);
  const node=graph?.nodes.find(n=>n.node_id===selected);
  const chosenEdge=graph?.edges.find(e=>e.relation_id===selected);
  const edges=(group:NetworkGroup)=>graph?.edges.filter(e=>group.edge_ids.includes(e.relation_id))??[];
  const groupLabel=(group:NetworkGroup)=>group.node_ids.map(id=>graph?.nodes.find(n=>n.node_id===id)?.lemma??id).join(" / ");
  const chooseSense=(id:string)=>setChoice({entity:center!.node_id,scope:"sense",offset:0,sense:id});
  const definition=(edge:GraphEdge,id:string)=>edge.source_id===id?edge.source_definition:edge.target_definition;
  return <section className="sense-network" aria-label="语义网络图谱" aria-busy={busy}>
    {graph&&meta&&<section className="network-selection" aria-label="词性与义项选择">
      <label>词性<select aria-label="词性" disabled={busy} value={center!.node_id} onChange={e=>setChoice({entity:e.target.value,scope:"sense",offset:0})}>
        {meta.lexeme_options.map(o=><option key={o.lexeme_id} value={o.lexeme_id}>{o.lemma} · {o.part_of_speech}.</option>)}</select></label>
      <label>当前义项<select aria-label="当前义项" disabled={busy} value={meta.scope==="unscoped"?"unscoped":meta.selected_sense_id??""} onChange={e=>e.target.value==="unscoped"?
        setChoice({entity:center!.node_id,scope:"unscoped",offset:0}):chooseSense(e.target.value)}>
        {option?.senses.map((s,i)=><option value={s.sense_id} key={s.sense_id}>{i+1}. {s.verified_definition_zh??s.definition}</option>)}
        <option value="unscoped">词条级审核关系（未绑定义项）</option>
      </select></label>
      <h3>{center!.lemma} {option?.part_of_speech}.</h3>
      {sense?<><p className="network-definition">{sense.verified_definition_zh}</p><p className="network-definition">{sense.definition}</p>
        {sense.verified_definition_zh&&sense.annotation?<Source value={sense.annotation}/>:<p className="family-reason">暂无已核验中文义项</p>}
        {Array.isArray(sense.provenance?.example_sentences)&&<div className="network-examples"><p>原词典例句（可能使用同义词）</p>{(sense.provenance.example_sentences as string[]).slice(0,2).map((example,i)=><blockquote key={i}>{example}</blockquote>)}</div>}
      </>:<p>词条级关系尚未绑定精确义项，不据此推导可互换性。</p>}
      <p className="family-reason">{contextSenseId===meta.selected_sense_id?"当前学习义项已通过服务端词条归属核验。":contextSenseId?"已手动切换义项。":
        "当前学习上下文未提供可核验的 sense ID；默认按词性、审核优先级和义项 ID 排序，不代表最常用义项。可手动切换。"}</p>
      <details><summary>排序依据</summary><p className="family-reason">{meta.ordering}</p></details>
    </section>}
    <nav className="lexical-filters" aria-label="语义关系过滤">{FILTERS.map(([label,group])=><button type="button" key={label} aria-pressed={group.every(t=>types.includes(t))}
      onClick={()=>{setChoice(old=>({...old,offset:0,evidenceOffset:0}));setTypes(old=>group.every(t=>old.includes(t))?old.filter(t=>!group.includes(t)):[...new Set([...old,...group])]);}}>{label}</button>)}</nav>
    {(busy||saving)&&<p role="status">{saving?"正在保存未来候选…":"正在加载…"}</p>}{error&&<p role="alert">{error} <Button onClick={()=>setRetry(v=>v+1)}>重试</Button></p>}{message&&<p role="status">{message}</p>}
    {graph&&meta&&!busy&&<>
      <section className="network-preview" aria-label="当前义项网络">
        <p className="family-reason">当前义项的一跳关系 · 图中最多 {previewLimit} 个重点词条，完整关系见下方卡片。虚线节点边框仅表示未学习。</p>
        {graph.edges.length===0&&<p>暂无所选类型的已核验关系。</p>}
        <div ref={canvas} className="family-canvas network-canvas" aria-label="局部词汇知识图"/>
        <Button className="secondary" onClick={()=>engine.current?.fit()}>适合窗口</Button>
        <nav className="family-node-list" aria-label="图谱节点">{meta.groups.map(g=><button key={g.group_id} type="button" aria-pressed={g.node_ids.includes(selected)} onClick={()=>setSelected(g.node_ids[0]!)}>{groupLabel(g)}</button>)}</nav>
        <details className="family-help"><summary>操作提示</summary><p>点击节点或边查看义项和证据；双击词条切换中心。拖动调整位置、双指缩放；长按现代英语词可明确加入未来候选。展开以新的中心显示一跳，不混合多个中心的义项。</p></details>
      </section>
      {chosenEdge&&<RelationCard edge={chosenEdge} graph={graph}/>}
      <section className="network-groups" aria-label="义项关系详情">{NETWORK_TYPES.map(type=>{
        const groups=meta.groups.filter(g=>edges(g).some(e=>e.relation_type===type));return groups.length?<section key={type}><h3>{RELATION_LABELS[type]}</h3>{groups.map(group=>{
          const target=graph.nodes.find(n=>n.node_id===group.node_ids[0]);const evidence=edges(group).filter(e=>e.relation_type===type);return <article key={group.group_id} className="network-card" data-network-group={group.group_id}>
            <h4><button type="button" onClick={()=>setSelected(group.node_ids[0]!)}>{groupLabel(group)}</button> <span className="part-of-speech">{target?.node_type==="lexeme"?`${target.part_of_speech}.`:"搭配"}</span></h4>
            {group.variants.map(v=><p key={v.lexeme_id} className="family-reason">{graph.nodes.find(n=>n.node_id===v.lexeme_id)?.lemma??v.lexeme_id} · {v.label}拼写（{v.source}）</p>)}
            {evidence.map(edge=><div key={edge.relation_id} className="network-sense-pair"><p><strong>{RELATION_LABELS[edge.relation_type]}</strong></p>
              <p>{definition(edge,group.node_ids.find(id=>id===edge.source_id||id===edge.target_id)??group.node_ids[0]!)??"尚无精确目标义项"}</p>
              <p>{edge.explanation}</p>
              <p className="family-reason">{edge.relation_type==="SYNONYM"?"义项相近；替换须核对语体、搭配与句法，词典未保证直接互换。":"不表示两词可以互换。"}</p>
              <details><summary>来源义项、目标义项与词典证据</summary><RelationCard edge={edge} graph={graph}/></details></div>)}
            {target?.node_type==="lexeme"&&<Button className="secondary" onClick={()=>recenter(target.node_id)}>以此义项展开一跳</Button>}
          </article>;})}</section>:null;
      })}</section>
      <nav className="family-actions" aria-label="更多关系">
        {choice.offset>0&&<Button className="secondary" onClick={()=>setChoice(old=>({...old,offset:Math.max(0,old.offset-8),evidenceOffset:0}))}>上一页关系</Button>}
        {meta.next_offset!==null&&<Button className="secondary" onClick={()=>setChoice(old=>({...old,offset:meta.next_offset!,evidenceOffset:0}))}>更多关系（共 {meta.total_groups} 组）</Button>}
        {!!choice.evidenceOffset&&<Button className="secondary" onClick={()=>setChoice(old=>({...old,evidenceOffset:Math.max(0,old.evidenceOffset!-96)}))}>上一页证据</Button>}
        {meta.next_evidence_offset!==null&&<Button className="secondary" onClick={()=>setChoice(old=>({...old,evidenceOffset:meta.next_evidence_offset!}))}>更多来源证据</Button>}
        {meta.folded_count>0&&<Button className="secondary" onClick={()=>setChoice(old=>({...old,offset:0,evidenceOffset:0,includeFolded:!old.includeFolded}))}>{choice.includeFolded?"折叠宽泛近义词":`查看宽泛近义词（${meta.folded_count}）`}</Button>}
        {meta.scope==="sense"&&meta.unscoped_count>0&&<Button className="secondary" onClick={()=>setChoice({entity:center!.node_id,scope:"unscoped",offset:0})}>词条级审核关系（{meta.unscoped_count}）</Button>}
      </nav>
      {node?.node_type==="lexeme"&&<section className="network-overview" aria-label="词条概览"><h3>词条概览 · 中文释义未绑定当前义项</h3><FamilyMiniCard node={node}/>
        <div className="family-actions"><Button className="secondary" onClick={()=>recenter(node.node_id)}>设为中心</Button><Button className="secondary" disabled={saving} onClick={()=>void save(node.node_id)}>加入未来候选</Button></div>
      </section>}
    </>}
  </section>;
}
