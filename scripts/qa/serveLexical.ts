import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync,mkdirSync} from 'node:fs';
import {build} from 'esbuild';
import type {SupabaseClient} from '@supabase/supabase-js';
import family from '../../server/data/familySeed.json' with {type:'json'};
import core from '../../server/data/lexicalCore.json' with {type:'json'};
import dictionary from '../../server/data/lexicalCoreDictionary.json' with {type:'json'};
import {lexicalInsertSql} from '../lib/familyImportSql.js';
import {getLexicalGraph} from '../../server/services/lexicalGraph.js';
import {lexicalGraphQuerySchema,type NetworkType} from '../../shared/lexicalContracts.js';
import {getFamilyContext,familySessionView} from '../../server/services/familyGraph.js';
import {selectFamilyCandidate} from '../../server/services/familyPolicy.js';
import {buildFamilyLesson} from '../../server/services/familyLesson.js';
const db=new PGlite(),user='00000000-0000-4000-8000-000000000001';
await db.exec('create role anon;create role authenticated;create role service_role bypassrls;');
for(const name of ['202609130001_initial_wordloop.sql','202609130002_fsrs_shanbay.sql','202609150004_study_session_state.sql','20260927143358_exact_cloze_activity_type.sql','20260929120641_captured_notes.sql','20260930043404_balanced_exercise_plans.sql','20261002024106_evidence_budget.sql','20261007053500_local_family_graph.sql','20261007095603_lexical_dictionary_entries.sql','20261008052820_lexical_root_network.sql'])await db.exec(readFileSync(`supabase/migrations/${name}`,'utf8').replace('create extension if not exists pgcrypto;',''));
const data=process.argv[2]?JSON.parse(readFileSync(process.argv[2],'utf8')):core;
const tables={morphemes:'lexical_morphemes',lexemes:'lexical_lexemes',senses:'lexical_senses',forms:'lexical_forms',relations:'lexical_relations',etymons:'lexical_etymons',etymological_links:'lexical_etymological_links',sense_relations:'lexical_sense_relations',usage_patterns:'lexical_usage_patterns',lexeme_morphemes:'lexical_lexeme_morphemes'} as const;
for(const corpus of [family,data])for(const [key,table] of Object.entries(tables))for(let i=0;i<(corpus[key]?.length??0);i+=100)await db.exec(lexicalInsertSql(table,corpus[key].slice(i,i+100)).replace(/do update set [\s\S]*;$/,'do nothing;'));
await db.exec(lexicalInsertSql('lexical_dictionary_entries',dictionary));
await db.query('insert into users(id) values($1)',[user]);
for(const word of ['circle','persuade'])await db.query('select ensure_user_word_v1($1,$2,$2,\'test\',false)',[user,word]);
await db.exec("update user_words set status='review',fsrs_reps=3,fsrs_stability=8,consecutive_correct=3,meaning_error=false,spelling_error=false,next_review_at=now()+interval '8 days'");
await db.query('insert into study_sessions(user_id,state) values($1,$2)',[user,JSON.stringify({current_word:'persuade',current_index:0,flow:{lesson_words:['persuade'],review_queue:['circle']}})]);
const rpc=async(name:string,args:any[]) => (await db.query<any>(`select ${name}(${args.map((_,i)=>`$${i+1}`).join(',')}) value`,args)).rows[0]!.value;
const adapter={rpc:async(name:string,a:any)=>({data:await rpc(name,name==='get_family_graph_v1'?[a.p_user_id,a.p_lexeme,a.p_limit]:[a.p_user_id,a.p_entity,a.p_view,a.p_types,a.p_limit]),error:null})} as unknown as SupabaseClient;
mkdirSync('.qa',{recursive:true});
await build({entryPoints:['scripts/qa/lexicalHarness.tsx'],outfile:'.qa/lexical-harness.js',bundle:true,minify:true,format:'iife',target:['es2022'],jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
const app=express();app.use(express.json());
app.get('/',(_,res)=>res.type('html').send('<!doctype html><title>WordLoop local lexical QA</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles.css"><div id="root"></div><script src="/harness.js"></script>'));
app.get('/favicon.ico',(_,res)=>res.status(204).end());
app.get('/styles.css',(_,res)=>res.sendFile(process.cwd()+'/web/dist/widget.css',{dotfiles:'allow'}));
app.get('/harness.js',(_,res)=>res.sendFile(process.cwd()+'/.qa/lexical-harness.js',{dotfiles:'allow'}));
app.get('/family.js',(_,res)=>res.sendFile(process.cwd()+'/web/dist/family.js',{dotfiles:'allow'}));
app.all(/^\/api\/web\/.*/,async(req,res)=>{try{
 if(req.headers.authorization!=='Bearer local-lexical-fixture-only')return res.status(401).json({});
 const url=new URL(req.url,'http://localhost'),p=url.pathname;
 if(p==='/api/web/lexical/graph'){const q=lexicalGraphQuerySchema.parse(Object.fromEntries(url.searchParams));return res.json(await getLexicalGraph(q.lexeme,q.view,q.relation_types===''?[]:q.relation_types?.split(',') as NetworkType[],adapter,user));}
 if(p.endsWith('/dictionary'))return res.json(dictionary.find(d=>d.lemma===url.searchParams.get('lemma'))??null);
 if(p.endsWith('/session'))return res.json(null);
 if(p.endsWith('/graph')||p.endsWith('/expand')||p.endsWith('/candidate')){const c=await getFamilyContext(url.searchParams.get('lexeme')!,adapter,user);return res.json(p.endsWith('/candidate')?selectFamilyCandidate(c.graph,c.exposures,new Date()):c.graph);}
 if(p.endsWith('/candidates')){await db.query('insert into family_candidates(user_id,lexeme_id) values($1,$2) on conflict do nothing',[user,req.body.lexeme_id]);return res.json({message:'已加入未来候选，尚未创建学习卡。'});}
 if(p.endsWith('/start')){const c=await getFamilyContext(req.body.lexeme,adapter,user),content=buildFamilyLesson(c.graph,selectFamilyCandidate(c.graph,c.exposures,new Date()));return res.json(familySessionView(await rpc('start_family_micro_v1',[user,req.body.request_id,JSON.stringify(content)])));}
 return res.status(404).json({});
}catch(e){res.status(409).json({error:{message:e instanceof Error?e.message:'Local fixture failure'}});}});
app.get('/fixture/evidence',async(_,res)=>res.json((await db.query("select (select count(*) from lexical_lexemes) lexemes,(select count(*) from lexical_sense_relations) sense_relations,(select count(*) from user_words) cards,(select count(*) from fsrs_review_logs) reviews,(select state from study_sessions limit 1) frozen,(select count(*) from family_candidates) candidates")).rows[0]));
app.get('/fixture/performance',async(_,res)=>{
 const report=[];
 for(const [entity,view] of [['circle','root'],['persuade','network'],['economic','network'],['adopt','network']] as const){const times:number[]=[];let graph:any;for(let i=0;i<25;i++){const at=performance.now();graph=await getLexicalGraph(entity,view,['SYNONYM','ANTONYM','CONTRAST','CONFUSABLE','COLLOCATION','HYPERNYM','HYPONYM'],adapter,user);times.push(performance.now()-at);}times.sort((a,b)=>a-b);report.push({entity,view,p50_ms:times[12],p95_ms:times[23],nodes:graph.nodes.length,edges:graph.edges.length,truncated:graph.truncated,bytes:Buffer.byteLength(JSON.stringify(graph))});}
 res.json(report);
});
app.listen(4328,'127.0.0.1',()=>console.log('Synthetic local graph fixture http://127.0.0.1:4328'));
