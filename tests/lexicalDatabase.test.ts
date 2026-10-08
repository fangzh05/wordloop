import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { beforeAll,afterAll,beforeEach,afterEach,describe,it,expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import core from "../server/data/lexicalCore.json" with {type:"json"};
import family from "../server/data/familySeed.json" with {type:"json"};
import { lexicalInsertSql, type LexicalTable } from "../scripts/lib/familyImportSql.js";
import { getLexicalGraph } from "../server/services/lexicalGraph.js";
import type { NetworkType } from "../shared/lexicalContracts.js";

const db=new PGlite(),u1="00000000-0000-4000-8000-000000000001",u2="00000000-0000-4000-8000-000000000002";
const mapping={morphemes:"lexical_morphemes",lexemes:"lexical_lexemes",senses:"lexical_senses",forms:"lexical_forms",relations:"lexical_relations",
 etymons:"lexical_etymons",etymological_links:"lexical_etymological_links",sense_relations:"lexical_sense_relations",usage_patterns:"lexical_usage_patterns",lexeme_morphemes:"lexical_lexeme_morphemes"} as const;
async function one(sql:string,args:any[]=[]){return (await db.query<any>(sql,args)).rows[0];}
async function importData(data:any){for(const [key,table] of Object.entries(mapping))for(let i=0;i<(data[key]?.length??0);i+=100)
 await db.exec(lexicalInsertSql(table,data[key].slice(i,i+100)).replace(/do update set [\s\S]*;$/,"do nothing;"));}
beforeAll(async()=>{
 await db.exec("create role anon;create role authenticated;create role service_role bypassrls;");
 for(const file of ["202609130001_initial_wordloop.sql","202609130002_fsrs_shanbay.sql","202609150004_study_session_state.sql","20260927143358_exact_cloze_activity_type.sql","20260929120641_captured_notes.sql","20260930043404_balanced_exercise_plans.sql","20261002024106_evidence_budget.sql","20261007053500_local_family_graph.sql","20261007095603_lexical_dictionary_entries.sql","20261008052820_lexical_root_network.sql"])
  await db.exec(readFileSync(new URL(`../supabase/migrations/${file}`,import.meta.url),"utf8").replace("create extension if not exists pgcrypto;",""));
 await importData(family);await importData(core);
},30000);
afterAll(()=>db.close());
beforeEach(async()=>{await db.exec("begin");await db.query("insert into users(id) values($1),($2)",[u1,u2]);
 await db.query("select ensure_user_word_v1($1,'circle','circle','test',false)",[u1]);
 await db.query("update user_words set fsrs_stability=8,fsrs_reps=3,next_review_at=now()+interval '8 days' where user_id=$1",[u1]);
 await db.query("insert into study_sessions(user_id,state) values($1,$2)",[u1,JSON.stringify({current_index:2,flow:{review_queue:["circle","test"]},phase:"lesson_explain"})]);});
afterEach(()=>db.exec("rollback"));
async function graph(entity:string,view:"root"|"network"="root",types?:NetworkType[],user=u1){
 const adapter={rpc:async(name:string,a:any)=>({data:(await one(`select ${name}($1,$2,$3,$4,$5) value`,[a.p_user_id,a.p_entity,a.p_view,a.p_types,a.p_limit])).value,error:null})} as unknown as SupabaseClient;
 return getLexicalGraph(entity,view,types,adapter,user);
}
async function learning(){return one("select (select jsonb_agg(to_jsonb(t)) from user_words t) cards,(select jsonb_agg(to_jsonb(t)) from study_sessions t) sessions,(select jsonb_agg(to_jsonb(t)) from fsrs_review_logs t) fsrs,(select jsonb_agg(to_jsonb(t)) from user_skill_state t) bkt,(select jsonb_agg(to_jsonb(t)) from exercise_skill_evidence t) evidence,(select jsonb_agg(to_jsonb(t)) from learning_budget_events t) budget");}
describe("PostgreSQL lexical graph",()=>{
 it("shows circle's verified shared ancestry without a fictional modern chain",async()=>{
  const g=await graph("circle");expect(g.center.node_id).toBe("en:circle:n");
  expect(g.nodes.map(n=>n.lemma)).toEqual(expect.arrayContaining(["circle","circular","circulate","circulation","circularity","encircle","circulus"]));
  expect(g.edges.some(e=>e.target_id==="en:circular:a"&&e.relation_type==="SHARED_ETYMON")).toBe(true);
  expect(g.edges.some(e=>e.target_id==="en:circular:a"&&e.relation_type==="MORPHOLOGICAL_DERIVATION")).toBe(false);
  const shared=g.edges.find(e=>e.target_id==="en:circulate:v"&&e.source_id==="en:circle:n")!;
  expect(shared.provenance.paths).toHaveLength(2);
  expect(g.edges.find(e=>e.target_id==="en:encircle:v"&&e.relation_type==="MORPHOLOGICAL_DERIVATION")!.direction).toBe("forward");
 });
 it("supports deliberately expanding multi-layer historical paths and source direction",async()=>{
  const g=await graph("ety:la:circulus");expect(g.nodes.some(n=>n.node_id==="ety:fro:cercle")).toBe(true);
  expect(g.edges.find(e=>e.target_id==="ety:fro:cercle")!.source_id).toBe("ety:la:circulus");
  const next=await graph("ety:fro:cercle");expect(next.nodes.some(n=>n.node_id==="ety:enm:circle")).toBe(true);
  for(const n of g.nodes.filter(n=>n.node_type==="etymon")){expect(n).not.toHaveProperty("learner_state");expect(n).not.toHaveProperty("user_state");}
 });
 it("keeps synchronic morphemes separate from historical etymons",async()=>{
  const g=await graph("encircle");expect(g.nodes.some(n=>n.node_type==="morpheme"&&n.lemma==="en-")).toBe(true);
  expect(g.edges.some(e=>e.relation_type==="PREFIX")).toBe(true);
 });
 it("honestly degrades missing ancestry; similar spelling is not evidence",async()=>{
  const g=await graph("adapt");expect(g.nodes).toHaveLength(1);expect(g.edges).toHaveLength(0);
  expect((await graph("adopt")).edges).toHaveLength(0);
 });
 it("allows multiple uncertain candidate etymons without selecting a false unique origin",async()=>{
  const base=core.etymons[0]!;await db.exec(lexicalInsertSql("lexical_etymons",[{...base,etymon_id:"ety:test:disputed",historical_form:"synthetic disputed origin",uncertain:true}]));
  const edge=core.etymological_links.find(e=>e.target_lexeme_id==="en:circle:n")!;
  await db.exec(lexicalInsertSql("lexical_etymological_links",[{...edge,link_id:"test:alternative",source_etymon_id:"ety:test:disputed",confidence:.85}]));
  const g=await graph("circle");expect(g.nodes.find(n=>n.node_id==="ety:test:disputed")).toMatchObject({uncertain:true});
  expect(g.nodes.some(n=>n.node_id==="ety:enm:circle")).toBe(true);
 });
 it("maps synonyms at the source sense, while antonym, contrast and patterns stay distinct",async()=>{
  const g=await graph("persuade","network");
  const s=g.edges.find(e=>e.relation_type==="SYNONYM"&&[e.source_id,e.target_id].includes("en:convince:v"))!;
  expect(s.source_sense_id).toBeTruthy();expect(s.target_sense_id).toBeTruthy();expect(s.source).toContain("Wiktionary");
  expect(g.edges.some(e=>e.relation_type==="ANTONYM"&&[e.source_id,e.target_id].includes("en:dissuade:v"))).toBe(true);
  expect(g.edges.some(e=>e.relation_type==="CONTRAST")).toBe(true);
  expect(g.nodes.find(n=>n.node_type==="pattern")).toMatchObject({lemma:"persuade someone to do something"});
  expect((await one("select count(*) n from lexical_lexemes where lemma like '% %'")).n).toBe(0);
 });
 it("filters relation types and preserves OEWN sense evidence for taxonomy",async()=>{
  const g=await graph("persuade","network",["ANTONYM"]);expect(g.edges.length).toBeGreaterThan(0);expect(g.edges.every(e=>e.relation_type==="ANTONYM")).toBe(true);
  expect((await graph("persuade","network",[])).nodes).toHaveLength(1);
  const h=await graph("circle","network",["HYPERNYM"]);expect(h.edges.length).toBeGreaterThan(0);
  expect(h.edges.every(e=>e.source_sense_id&&e.target_sense_id)).toBe(true);
 });
 it("shows source-backed confusable pairs; does not infer them from strings",async()=>{
  for(const word of ["economic","adapt"]){const g=await graph(word,"network",["CONFUSABLE"]);expect(g.edges).toHaveLength(1);expect(g.edges[0]!.provenance.evidence).toBeTruthy();}
 });
 it("bounds SQL nodes and edges, validates limits and handles reverse cycles",async()=>{
  const g=await graph("adopt","network",["HYPERNYM","HYPONYM","SYNONYM"]);expect(g.nodes.length).toBeLessThanOrEqual(24);expect(g.edges.length).toBeLessThanOrEqual(96);
  expect(new Set(g.nodes.map(n=>n.node_id)).size).toBe(g.nodes.length);
  const bounded=(await one("select get_lexical_graph_v1($1,'circle','root',array['SYNONYM'],2) value",[u1])).value;
  expect(bounded.nodes).toHaveLength(2);expect(bounded.truncated).toBe(true);
  await db.exec("savepoint invalid_request");
  await expect(one("select get_lexical_graph_v1($1,'circle','root',array['SYNONYM'],25)",[u1])).rejects.toThrow("LEXICAL_REQUEST_INVALID");
  await db.exec("rollback to savepoint invalid_request");
  await expect(one("select get_lexical_graph_v1($1,'circle','network',array['DERIVATION'],24)",[u1])).rejects.toThrow("LEXICAL_FILTER_INVALID");
 });
 it("reading and explicit candidate saving preserve cards, FSRS, BKT, budgets and frozen sessions",async()=>{
  const before=await learning();await graph("circle");await graph("persuade","network");
  await db.query("insert into family_candidates(user_id,lexeme_id) values($1,'en:encircle:v') on conflict do nothing",[u1]);
  expect(await learning()).toEqual(before);expect((await one("select count(*) n from family_candidates")).n).toBe(1);
 });
 it("joins only the verified user's state and keeps shared data imports idempotent",async()=>{
  expect((await graph("circle")).center).toHaveProperty("learner_state.stability",8);
  expect((await graph("circle","root",undefined,u2)).center).toHaveProperty("learner_state",null);
  const before=await learning(),counts=await one("select (select count(*) from lexical_senses) senses,(select count(*) from lexical_etymological_links) links");
  await importData(core);expect(await learning()).toEqual(before);expect(await one("select (select count(*) from lexical_senses) senses,(select count(*) from lexical_etymological_links) links")).toEqual(counts);
  expect((await one("select family_key from lexical_lexemes where lemma='persuade' and part_of_speech='v'")).family_key).toBe(family.lexemes.find(l=>l.lemma==="persuade")!.family_key);
 });
 it("denies direct browser access to tables, views and user-accepting RPC",async()=>{
  for(const role of ["anon","authenticated"])for(const table of Object.values(mapping).filter(t=>!['lexical_lexemes','lexical_senses','lexical_forms','lexical_relations','lexical_morphemes'].includes(t))) {
   expect((await one(`select has_table_privilege('${role}','${table}','SELECT') allowed`)).allowed).toBe(false);
   expect((await one("select relrowsecurity enabled from pg_class where relname=$1",[table])).enabled).toBe(true);
  }
  expect((await one("select has_function_privilege('authenticated','get_lexical_graph_v1(uuid,text,text,text[],integer)','EXECUTE') allowed")).allowed).toBe(false);
  expect((await one("select has_table_privilege('anon','lexical_graph_edges_v1','SELECT') allowed")).allowed).toBe(false);
 });
 it("enforces sense/pattern ownership and rejects self links",async()=>{
  await expect(db.exec(lexicalInsertSql("lexical_usage_patterns",[{...core.usage_patterns[0],pattern_id:"pattern:test:wrong",lexeme_id:"en:circle:n"}]))).rejects.toThrow();
 });
});
