import type { GraphEdge, LexicalGraph } from "../../../shared/lexicalContracts.js";
import { RELATION_LABELS } from "../../../shared/lexicalContracts.js";

function safeSource(url: unknown): string | undefined {
  if (typeof url !== "string") return;
  try { const value=new URL(url); if (value.protocol === "https:" || value.protocol === "http:") return value.href; } catch { /* Invalid evidence URL */ }
}
export function Source({ value }: { value: {source:string;source_version:string;license:string;provenance:Record<string,unknown>;confidence:number} }) {
  const url=safeSource(value.provenance.url);
  const links=new Map<string,string>();
  const collect=(entry:unknown,depth=0)=>{
    if(!entry||typeof entry!=="object"||depth>12)return;
    const item=entry as Record<string,unknown>,href=safeSource(item.url);
    if(href)links.set(href,`${new URL(href).searchParams.get("title")??"来源"} · ${typeof item.adaptation === "string"?"已核验改编":"证据"}`);
    for(const key of ["provenance","verified_path","paths","additional_sources"]) {
      const nested=item[key];if(Array.isArray(nested))nested.forEach(v=>collect(v,depth+1));else collect(nested,depth+1);
    }
  };
  collect(value.provenance);
  return <><p>{value.source} · {value.source_version} · {value.license}<br />核验置信度 {value.confidence}（编辑阈值）{url && <> · <a href={url} target="_blank" rel="noreferrer">原始来源</a></>}</p>
    <details><summary>核验记录与其他来源</summary>{[...links].slice(0,12).map(([href,label])=><p key={href}><a href={href} target="_blank" rel="noreferrer">{label}</a></p>)}<pre className="lexical-evidence">{JSON.stringify(value.provenance,null,2)}</pre></details></>;
}
export function RelationCard({ edge, graph }: { edge: GraphEdge; graph: LexicalGraph }) {
  const name=(id:string)=>{const n=graph.nodes.find(n=>n.node_id===id);return n?`${n.lemma}${n.node_type==="etymon"?` (${n.language})`:""}`:id;};
  const lookup=(id:string|null|undefined)=>graph.nodes.flatMap(n=>n.node_type==="lexeme"?n.senses:[]).find(s=>s.sense_id===id)?.definition;
  const definitions=[{label:"来源义项",definition:edge.source_definition??lookup(edge.source_sense_id)},
    {label:"目标义项",definition:edge.target_definition??lookup(edge.target_sense_id)}];
  return <article className="lexical-relation"><p><strong>{RELATION_LABELS[edge.relation_type]}</strong> · {name(edge.source_id)} {edge.direction==="forward"?"→":"↔"} {name(edge.target_id)}</p>
    <p>{edge.explanation}</p>{definitions.map(d=>d.definition?<p className="family-reason" key={d.label}>{d.label}：{d.definition}</p>:graph.view==="network"?<p className="family-reason" key={d.label}>{d.label}：未绑定精确义项</p>:null)}
    {(edge.source_sense_id||edge.target_sense_id)&&<p className="family-reason">义项 ID：{edge.source_sense_id??"未绑定"} → {edge.target_sense_id??"未绑定"}</p>}
    {edge.target_examples?.slice(0,1).map((example,i)=><blockquote key={i}>原词典例句：{example}</blockquote>)}
    <p className="family-reason">{edge.relation_type==="SYNONYM"?"仅在所列义项中相近；同一 synset 不保证句中可直接替换，需核对语体、搭配与句法。":"此关系不表示两词可互换。"}</p><Source value={edge}/></article>;
}
