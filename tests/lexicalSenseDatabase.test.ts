import {PGlite} from "@electric-sql/pglite";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import type {SupabaseClient} from "@supabase/supabase-js";
import {buildNetworkCorpus} from "../scripts/lib/networkCorpus.js";
import {lexicalInsertSql} from "../scripts/lib/familyImportSql.js";
import {getLexicalGraph} from "../server/services/lexicalGraph.js";
import {NETWORK_TYPES,type NetworkQuery} from "../shared/lexicalContracts.js";
import family from "../server/data/familySeed.json" with {type:"json"};
import core from "../server/data/lexicalCore.json" with {type:"json"};
import manifest from "./data/oewn-bear-bearing-2025.manifest.json" with {type:"json"};
const xml=readFileSync(new URL("./data/oewn-bear-bearing-2025.xml",import.meta.url),"utf8");
const corpus=buildNetworkCorpus(xml,["bear","bearing"],{etymons:[],etymological_links:[],senses:[],sense_relations:[],usage_patterns:[],lexeme_morphemes:[],spelling_pairs:[["harbor","harbour"]]});
const db=new PGlite(),u1="00000000-0000-4000-8000-000000000001",u2="00000000-0000-4000-8000-000000000002";
const mapping={morphemes:"lexical_morphemes",lexemes:"lexical_lexemes",senses:"lexical_senses",forms:"lexical_forms",relations:"lexical_relations",
 etymons:"lexical_etymons",etymological_links:"lexical_etymological_links",sense_relations:"lexical_sense_relations",usage_patterns:"lexical_usage_patterns",lexeme_morphemes:"lexical_lexeme_morphemes",spelling_variants:"lexical_spelling_variants"} as const;
async function one(sql:string,args:unknown[]=[]){return (await db.query<Record<string,any>>(sql,args)).rows[0]!;}
const adapter={rpc:async(name:string,a:any)=>{try{return {data:(await one(`select ${name}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) value`,
 [a.p_user_id,a.p_entity,a.p_types,a.p_pos,a.p_sense_id,a.p_scope,a.p_offset,a.p_limit,a.p_include_folded,a.p_evidence_offset])).value,error:null};}catch(e){return{data:null,error:{message:(e as Error).message}};}}} as unknown as SupabaseClient;
const graph=(word:string,options:NetworkQuery={},user=u1,types=[...NETWORK_TYPES])=>getLexicalGraph(word,"network",types,adapter,user,{version:2,...options});
beforeAll(async()=>{
 await db.exec("create role anon;create role authenticated;create role service_role bypassrls;");
 for(const file of ["202609130001_initial_wordloop.sql","202609130002_fsrs_shanbay.sql","202609150004_study_session_state.sql","20260927143358_exact_cloze_activity_type.sql","20260929120641_captured_notes.sql","20260930043404_balanced_exercise_plans.sql","20261002024106_evidence_budget.sql","20261007053500_local_family_graph.sql","20261007095603_lexical_dictionary_entries.sql","20261008052820_lexical_root_network.sql","20261008093933_lexical_sense_network_v2.sql"])
  await db.exec(readFileSync(new URL(`../supabase/migrations/${file}`,import.meta.url),"utf8").replace("create extension if not exists pgcrypto;",""));
 for(const data of [family,core,corpus])for(const [key,table] of Object.entries(mapping)){
  const rows=(data as any)[key]??[];for(let i=0;i<rows.length;i+=100)await db.exec(lexicalInsertSql(table,rows.slice(i,i+100)).replace(/do update set [\s\S]*;$/,"do nothing;"));
 }
 await db.query("insert into users(id) values($1),($2)",[u1,u2]);
 await db.query("select ensure_user_word_v1($1,'bear','bear','test',false)",[u1]);
 await db.query("update user_words set meaning_error=true,fsrs_stability=8,fsrs_reps=3,next_review_at=now()+interval '8 days' where user_id=$1",[u1]);
 await db.query("insert into user_word_error_progress(user_word_id,error_layer,consecutive_correct) select id,'meaning',1 from user_words where user_id=$1",[u1]);
 await db.query("insert into user_skill_state(user_id,skill_id,p_mastery,evidence_count,revision) values($1,'target_sense_retrieval',0.63,4,2)",[u1]);
 await db.query("insert into learning_budget_events(user_id,task_key,local_date,estimated_seconds,activity_type) values($1,'synthetic-existing-exercise',current_date,90,'word_recall')",[u1]);
 await db.query("insert into study_sessions(user_id,state) values($1,$2)",[u1,JSON.stringify({current_index:2,phase:"lesson_explain",flow:{lesson_words:["bear"],review_queue:["bearing"]}})]);
},30000);
afterAll(()=>db.close());
const sid=(word:string,definition:string)=>corpus.senses.find(s=>s.lexeme_id===word&&s.definition.includes(definition))!.sense_id;
const adjacent=(g:Awaited<ReturnType<typeof graph>>)=>g.nodes.filter(n=>n.node_id!==g.center.node_id).map(n=>n.lemma);
async function learning(){return one("select (select jsonb_agg(to_jsonb(t)) from user_words t) cards,(select jsonb_agg(to_jsonb(t)) from study_sessions t) sessions,(select jsonb_agg(to_jsonb(t)) from fsrs_review_logs t) fsrs,(select jsonb_agg(to_jsonb(t)) from user_skill_state t) bkt,(select jsonb_agg(to_jsonb(t)) from user_word_error_progress t) errors,(select jsonb_agg(to_jsonb(t)) from exercise_skill_evidence t) evidence,(select jsonb_agg(to_jsonb(t)) from learning_budget_events t) budget");}
describe("sense-first PostgreSQL network using pinned public OEWN 2025",()=>{
 it("folds broad do/have synonyms without losing the requested sense or dictionary records",async()=>{
  for(const text of ["cause to be born","behave in a certain manner"]){
   const sense=sid("en:bear:v",text),g=await graph("en:bear:v",{sense_id:sense},u1,["SYNONYM"]);
   expect(adjacent(g)).not.toContain("have");expect(adjacent(g)).not.toContain("do");
   const full=await graph("en:bear:v",{sense_id:sense,include_folded:true},u1,["SYNONYM"]);
   expect(g.network!.folded_count).toBeGreaterThan(0);expect(full.network!.total_groups).toBeGreaterThan(g.network!.total_groups);
  }
 });
 it("pins the complete public fixture rather than inventing passing relations",()=>{
  expect(createHash("sha256").update(xml).digest("hex")).toBe(manifest.fixture_sha256);
  expect(manifest.upstream_sha256).toBe("6f49adeec174ab3092169fb25cf4a925226b63975a5d29a691a5dff88f0673b2");
  expect(corpus.lexemes.length).toBeGreaterThan(100);expect(corpus.sense_relations.length).toBeGreaterThan(2000);
  expect(corpus.senses.filter(s=>s.lexeme_id==="en:bear:v")).toHaveLength(14);
 });
 it("exposes both POS choices and all senses without silent verb preference",async()=>{
  const g=await graph("bear");expect(g.center).toHaveProperty("part_of_speech","n");
  expect(g.network!.lexeme_options.map(o=>o.part_of_speech)).toEqual(["n","v"]);
  expect(g.network!.lexeme_options.find(o=>o.part_of_speech==="v")!.senses).toHaveLength(14);
  expect((await graph("bear",{pos:"v"})).center).toHaveProperty("node_id","en:bear:v");
  expect((await graph("bear",{sense_id:sid("en:bear:v","put up with")})).center).toHaveProperty("node_id","en:bear:v");
 });
 it.each(["cause to be born","put up with","expenses or debts","behave in a certain manner","be pregnant with"])("filters bear precisely before ranking: %s",async definition=>{
  const sense=sid("en:bear:v",definition),g=await graph("en:bear:v",{sense_id:sense});
  expect(g.network!.groups.length).toBeLessThanOrEqual(8);expect(g.nodes.length).toBeLessThanOrEqual(17);
  expect(g.edges.length).toBeGreaterThan(0);expect(g.edges.every(e=>e.source_id===g.center.node_id?e.source_sense_id===sense:e.target_sense_id===sense)).toBe(true);
  expect(g.edges.every(e=>e.source_definition&&e.target_definition)).toBe(true);
  if(definition==="put up with")expect(adjacent(g)).not.toEqual(expect.arrayContaining(["birth","gestate","harbor","behave"]));
 });
 it("separates bearing manner, posture, direction, mechanical and heraldic senses and retains charge",async()=>{
  for(const definition of ["dignified manner","bearing one's body","direction or path","heraldry","rotating support"]){
   const sense=sid("en:bearing:n",definition),g=await graph("en:bearing:n",{sense_id:sense},u1,["SYNONYM"]);
   expect(g.edges.every(e=>e.source_id===g.center.node_id?e.source_sense_id===sense:e.target_sense_id===sense)).toBe(true);
   if(definition==="heraldry")expect(adjacent(g)).toContain("charge");else expect(adjacent(g)).not.toContain("charge");
  }
 });
 it("pages after stable sorting, retains all original one-hop relations and separates evidence",async()=>{
  const sense=sid("en:bear:v","put up with"),first=await graph("en:bear:v",{sense_id:sense},u1,["SYNONYM"]);
  expect(first).toEqual(await graph("en:bear:v",{sense_id:sense},u1,["SYNONYM"]));
  const collected=[...first.edges];let offset=first.network!.next_offset;
  while(offset!==null){const next=await graph("en:bear:v",{sense_id:sense,offset},u1,["SYNONYM"]);collected.push(...next.edges);offset=next.network!.next_offset;}
  const raw=await one("select count(*) n from lexical_graph_edges_v1 where view='network' and relation_type='SYNONYM' and (source_sense_id=$1 or target_sense_id=$1)",[sense]);
  expect(collected).toHaveLength(raw.n);expect(new Set(collected.map(e=>e.relation_id)).size).toBe(collected.length);
  expect(first.network!.groups).toHaveLength(8);expect(first.network!.next_offset).toBe(8);
 });
 it("merges only reviewed same-POS/synset spelling pairs and retains both canonical IDs and evidence",async()=>{
  const g=await graph("en:bear:v",{sense_id:sid("en:bear:v","maintain")},u1,["SYNONYM"]);
  const variant=g.network!.groups.find(g=>g.node_ids.includes("en:harbor:v"))!;
  expect(variant.node_ids).toEqual(["en:harbor:v","en:harbour:v"]);expect(variant.variants.map(v=>v.label)).toEqual(["美式","英式"]);
  expect(g.edges.filter(e=>variant.edge_ids.includes(e.relation_id))).toHaveLength(2);
  expect(g.nodes.filter(n=>variant.node_ids.includes(n.node_id))).toHaveLength(2);
 });
 it("preserves reviewed persuade/convince/dissuade, contrast, patterns and confusables in their actual scope",async()=>{
  for(const word of ["persuade","economic","adapt"]){
   const initial=await graph(word);const options=initial.network!.lexeme_options;
   const all=[];for(const option of options)for(const s of option.senses)all.push(...(await graph(option.lexeme_id,{sense_id:s.sense_id})).edges);
   all.push(...(await graph(initial.center.node_id,{scope:"unscoped"})).edges);
   if(word==="persuade")for(const type of ["SYNONYM","ANTONYM","CONTRAST","COLLOCATION"])expect(all.some(e=>e.relation_type===type)).toBe(true);
   else expect(all.some(e=>e.relation_type==="CONFUSABLE")).toBe(true);
  }
 });
 it("returns a center-only empty filter and rejects unknown/non-owned sense, POS, limits and recursion",async()=>{
  const g=await graph("en:bear:v",{},u1,[]);expect(g.nodes).toHaveLength(1);expect(g.edges).toHaveLength(0);expect(g.network!.next_offset).toBeNull();
  for(const options of [{sense_id:"unknown"},{sense_id:sid("en:bearing:n","heraldry")},{pos:"r"},{limit:9},{offset:-1}])
   await expect(graph("en:bear:v",options)).rejects.toMatchObject({status:400});
 });
 it("does not alter any learning state through reading, paging, changing senses or centers",async()=>{
  const before=await learning();for(const w of ["bear","bearing","persuade","adapt"]){const g=await graph(w);for(const s of g.network!.lexeme_options.flatMap(o=>o.senses))await graph(s.lexeme_id,{sense_id:s.sense_id});}
  expect(before.bkt).toHaveLength(1);expect(before.errors).toHaveLength(1);expect(before.budget).toHaveLength(1);
  expect(await learning()).toEqual(before);
  expect((await graph("bear",{},u1)).center).toHaveProperty("learner_state.stability",8);
  expect((await graph("bear",{},u2)).center).toHaveProperty("learner_state",null);
 });
 it("keeps V2 and variant evidence service-only with RLS enabled",async()=>{
  for(const role of ["anon","authenticated"]){
   expect((await one(`select has_function_privilege('${role}','get_lexical_graph_v2(uuid,text,text[],text,text,text,integer,integer,boolean,integer)','EXECUTE') allowed`)).allowed).toBe(false);
   expect((await one(`select has_table_privilege('${role}','lexical_spelling_variants','SELECT') allowed`)).allowed).toBe(false);
  }
  expect((await one("select relrowsecurity enabled from pg_class where relname='lexical_spelling_variants'")).enabled).toBe(true);
  expect((await one("select relrowsecurity enabled from pg_class where relname='lexical_sense_annotations'")).enabled).toBe(true);
 });
 it("ranks verified relation evidence before node truncation and retains corroborating sources",async()=>{
  await db.exec("begin");try{
   const sense=sid("en:bear:v","put up with"),g=await graph("en:bear:v",{sense_id:sense},u1,["SYNONYM"]);
   const last=await graph("en:bear:v",{sense_id:sense,offset:8},u1,["SYNONYM"]);const e=last.edges[0]!;
   const raw=(await one("select to_jsonb(r) value from lexical_sense_relations r where relation_id=$1",[e.relation_id])).value;
   await db.exec(lexicalInsertSql("lexical_sense_relations",[{...raw,relation_id:"reviewed:test:ranking",source:"Synthetic corroboration test",provenance:{test_only:true,url:"https://example.com/reviewed-test"}}]));
   const ranked=await graph("en:bear:v",{sense_id:sense,limit:1},u1,["SYNONYM"]);
   expect(ranked.network!.groups[0]!.node_ids).toEqual(last.network!.groups[0]!.node_ids);
   expect(ranked.edges).toHaveLength(1);expect(ranked.edges[0]!.provenance.additional_sources).toHaveLength(1);
   expect(g.network!.groups[0]!.node_ids).not.toEqual(ranked.network!.groups[0]!.node_ids);
  }finally{await db.exec("rollback");}
 });
 it("preserves excess evidence through a separate bounded evidence page",async()=>{
  await db.exec("begin");try{
   const sense=sid("en:bear:v","put up with"),g=await graph("en:bear:v",{sense_id:sense},u1,["SYNONYM"]);
   const raw=(await one("select to_jsonb(r) value from lexical_sense_relations r where relation_id=$1",[g.edges[0]!.relation_id])).value;
   const copies=Array.from({length:100},(_,i)=>({...raw,relation_id:`reviewed:test:${String(i).padStart(3,"0")}`,source:`Synthetic source ${i}`,provenance:{test_only:true,index:i}}));
   await db.exec(lexicalInsertSql("lexical_sense_relations",copies));
   const page=await graph("en:bear:v",{sense_id:sense,limit:1},u1,["SYNONYM"]);
   expect(page.network!.next_evidence_offset).toBe(96);expect(page.truncated).toBe(true);
   const next=await graph("en:bear:v",{sense_id:sense,limit:1,evidence_offset:96},u1,["SYNONYM"]);
   expect(next.network!.next_evidence_offset).toBeNull();
   const count=(e:typeof page.edges[number])=>1+((e.provenance.additional_sources as unknown[]|undefined)?.length??0);
   expect(page.edges.reduce((n,e)=>n+count(e),0)+next.edges.reduce((n,e)=>n+count(e),0)).toBe(101);
  }finally{await db.exec("rollback");}
 });
 it("rejects cross-sense spelling merges and supports reviewed sense annotation without lemma translation leakage",async()=>{
  await db.exec("begin");try{
   const pair=corpus.spelling_variants[0]!;
   await db.exec("savepoint invalid_variant");
   await expect(db.exec(lexicalInsertSql("lexical_spelling_variants",[{...pair,variant_id:"test:invalid",first_sense_id:sid("en:bear:v","cause to be born"),second_sense_id:sid("en:bearing:n","heraldry")}]))).rejects.toThrow();
   await db.exec("rollback to savepoint invalid_variant");
   const sense=sid("en:bear:v","put up with");
   await db.query("insert into lexical_sense_annotations(sense_id,definition_zh,editorial_priority,reviewer,source,source_version,license,provenance,confidence) values($1,'Synthetic approved translation test',10,'test reviewer','test fixture','1','test only','{\"test_only\":true}',0.95)",[sense]);
   const g=await graph("en:bear:v");expect(g.network!.selected_sense_id).toBe(sense);
   const s=g.network!.lexeme_options.find(o=>o.lexeme_id==="en:bear:v")!.senses.find(s=>s.sense_id===sense)!;
   expect(s.verified_definition_zh).toBe("Synthetic approved translation test");expect(s.annotation).toHaveProperty("source","test fixture");
   expect(g.network!.lexeme_options.flatMap(o=>o.senses).filter(s=>s.verified_definition_zh)).toHaveLength(1);
  }finally{await db.exec("rollback");}
 });
});
