import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from "vitest";
import seed from "../server/data/familySeed.json" with { type: "json" };
import { buildFamilyLesson } from "../server/services/familyLesson.js";
import { selectFamilyCandidate } from "../server/services/familyPolicy.js";
import { getFamilyContext } from "../server/services/familyGraph.js";
import { cardToDatabase, reviewLogToDatabase, scheduleReview } from "../server/services/fsrsScheduler.js";
import type { UserWordRow } from "../server/types.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { FamilyLesson } from "../shared/familyContracts.js";

const db = new PGlite();
const u1 = "00000000-0000-4000-8000-000000000001", u2 = "00000000-0000-4000-8000-000000000002";
const sid = "00000000-0000-4000-8000-000000000003";
const files = ["202609130001_initial_wordloop.sql","202609130002_fsrs_shanbay.sql","202609150004_study_session_state.sql","20260927143358_exact_cloze_activity_type.sql","20260929120641_captured_notes.sql","20260930043404_balanced_exercise_plans.sql","20261002024106_evidence_budget.sql","20261007053500_local_family_graph.sql"];
beforeAll(async () => {
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  for (const file of files) await db.exec(readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8").replace("create extension if not exists pgcrypto;", ""));
  // PGlite has gen_random_uuid built in; only Supabase's grant defaults differ.
  await db.exec("grant all on all tables in schema public to service_role; grant all on all sequences in schema public to service_role;");
  for (const [table, rows] of [["lexical_lexemes",seed.lexemes],["lexical_senses",seed.senses],["lexical_forms",seed.forms],["lexical_morphemes",seed.morphemes],["lexical_relations",seed.relations]] as const) {
    for (const row of rows) {
      const keys = Object.keys(row), values = Object.values(row).map((v) => typeof v === "object" && v !== null ? JSON.stringify(v) : v);
      await db.query(`insert into ${table}(${keys.join(",")}) values(${keys.map((_,i) => `$${i+1}`).join(",")})`, values);
    }
  }
}, 30000);
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec("begin");
  await db.query("insert into users(id) values($1),($2)", [u1,u2]);
  await db.query("select ensure_user_word_v1($1,'reconcile','reconcile','test',false)", [u1]);
  await db.query("update user_words set fsrs_reps=3,fsrs_stability=8,consecutive_correct=3,status='review',next_review_at=now()+interval '8 days' where user_id=$1", [u1]);
  await db.query("insert into study_sessions(id,user_id,state) values($1,$2,$3)", [sid,u1,JSON.stringify({ version:1, date:"2026-10-07", widget:"lesson",phase:"lesson_explain",current_word:"reconcile",current_index:0,retry_count:0,flow:{lesson_words:["reconcile","test"]},payload:{mode:"explain"}})]);
});
afterEach(() => db.exec("rollback"));
async function one(sql: string, args: unknown[] = []) { return (await db.query<Record<string, any>>(sql,args)).rows[0]!; }
async function context(lexeme = "reconcile", user = u1) {
  const adapter = { rpc: async (_: string, args: any) => ({ data: (await one("select get_family_graph_v1($1,$2,$3) as value",[args.p_user_id,args.p_lexeme,args.p_limit])).value, error:null }) } as unknown as SupabaseClient;
  return getFamilyContext(lexeme,adapter,user);
}
async function lesson() { const ctx=await context(); return buildFamilyLesson(ctx.graph,selectFamilyCandidate(ctx.graph,ctx.exposures,new Date())); }
async function start(content: FamilyLesson, requestId = crypto.randomUUID()) {
  return (await one("select start_family_micro_v1($1,$2,$3) as value",[u1,requestId,JSON.stringify(content)])).value;
}
async function answer(id: string,index: number,text: string,content: FamilyLesson) {
  const empty = { next_review_at:null,last_reviewed_at:null,fsrs_stability:0,fsrs_difficulty:0,fsrs_elapsed_days:0,fsrs_scheduled_days:0,fsrs_learning_steps:0,fsrs_reps:0,fsrs_lapses:0,fsrs_state:0 } as UserWordRow;
  const result=scheduleReview(empty,text.toLowerCase()===content.steps[index]!.answer.toLowerCase()?"good":"again",new Date(),false);
  return (await one("select submit_family_step_v1($1,$2,$3,$4,$5,$6) as value",[u1,id,index,text,JSON.stringify(cardToDatabase(result.card)),JSON.stringify(reviewLogToDatabase(result.log))])).value;
}
describe("real PostgreSQL Family transactions", () => {
  it("checks schema functions, adjacency indexes and every new table's RLS", async () => {
    expect((await one("select family_graph_schema_v1() as ok")).ok).toBe(true);
  });
  it("joins only the authenticated user's existing state and five layer observations", async () => {
    await db.query("insert into user_word_error_progress(user_word_id,error_layer,consecutive_correct) select id,'grammar',1 from user_words where user_id=$1",[u1]);
    const a=await context(), b=await context("reconcile",u2);
    expect(a.graph.center.user_state?.stability).toBe(8); expect(b.graph.center.user_state).toBeNull();
    expect(a.graph.center.user_state?.layers.grammar.correct_streak).toBe(1);
    expect(a.graph.center.user_state?.layers.meaning.correct_streak).toBeNull();
    expect(a.graph.nodes.find((n)=>n.lemma==="reconciliation")!.user_state).toBeNull();
  });
  it("does one-hop SQL adjacency, confidence filtering and explicit expansion", async () => {
    const g=await context("persuade");
    expect(g.graph.nodes.map(n=>n.lemma).sort()).toEqual(["persuade","persuasion","persuasive"]);
    expect((await context("persuasive")).graph.nodes.some(n=>n.lemma==="persuasively")).toBe(true);
    await db.query("update lexical_relations set confidence=.1 where target_id='en:persuasion:n'");
    expect((await context("persuade")).graph.nodes.some(n=>n.lemma==="persuasion")).toBe(false);
  });
  it("keeps future candidates separate from words, cards, queues and scheduling", async () => {
    const initial=(await one("select count(*) as n from user_words")).n;
    await db.query("insert into family_candidates(user_id,lexeme_id) values($1,'en:reconcilable:a') on conflict do nothing",[u1]);
    await context();
    expect((await one("select count(*) as n from user_words")).n).toBe(initial);
    expect((await one("select count(*) as n from fsrs_review_logs")).n).toBe(0);
    expect((await one("select count(*) as n from daily_imports")).n).toBe(0);
  });
  it("start is durable and idempotent without creating any derivative card", async () => {
    const content=await lesson(), key=crypto.randomUUID(), a=await start(content,key), b=await start(content,key);
    expect(a.id).toBe(b.id);
    expect((await one("select count(*) as n from user_words")).n).toBe(1);
    expect((await one("select count(*) as n from family_exposures")).n).toBe(1);
    expect((await one("select sum(estimated_seconds) as n from learning_budget_events")).n).toBe(120);
    expect((await one("select lexeme_id from family_candidates")).lexeme_id).toBe("en:reconcilable:a");
  });
  it("joins only a spacing guard for distant developing members, without loading their nodes", async () => {
    await db.query("select ensure_user_word_v1($1,'act','act','test',false)",[u1]);
    await db.query("update user_words set fsrs_reps=3,fsrs_stability=8,consecutive_correct=3,status='review' where word_id=(select id from words where normalized_word='act')");
    await db.query("select ensure_user_word_v1($1,'activation','activation','test',false)",[u1]);
    const ctx=await context("act");
    expect(ctx.graph.nodes.some(n=>n.lemma==='activation')).toBe(false);
    expect(ctx.graph.has_developing_member).toBe(true);
    expect(selectFamilyCandidate(ctx.graph,ctx.exposures,new Date()).eligible_now).toBe(false);
  });
  it("completes one derivative through canonical initialization and preserves frozen queue/base FSRS", async () => {
    const before=await one("select state,updated_at,new_words_count,review_words_count from study_sessions where id=$1",[sid]);
    const baseBefore=await one("select fsrs_stability,fsrs_reps,fsrs_state,next_review_at from user_words where user_id=$1",[u1]);
    const content=await lesson(), row=await start(content);
    let response:any;
    for(let i=0;i<content.steps.length;i++) response=await answer(row.id,i,content.steps[i]!.answer,content);
    expect(response.completed).toBe(true); expect(response.activated).toBe(true);
    expect((await one("select count(*) as n from user_words")).n).toBe(2);
    expect((await one("select count(*) as n from user_words uw join words w on w.id=uw.word_id where w.normalized_word='reconcilable'")).n).toBe(0);
    expect(await one("select state,updated_at,new_words_count,review_words_count from study_sessions where id=$1",[sid])).toEqual(before);
    expect(await one("select fsrs_stability,fsrs_reps,fsrs_state,next_review_at from user_words uw join words w on w.id=uw.word_id where uw.user_id=$1 and w.normalized_word='reconcile'",[u1])).toEqual(baseBefore);
    const card=await one("select uw.* from user_words uw join words w on w.id=uw.word_id where w.normalized_word='reconciliation'");
    expect(card.fsrs_reps).toBe(1); expect(new Date(card.next_review_at).getTime()).toBeGreaterThan(Date.now());
    expect((await one("select count(*) as n from fsrs_review_logs")).n).toBe(1);
    expect((await one("select count(*) as n from attempts where activity_type='collocation' and scope='consolidation'")).n).toBe(2);
  });
  it("retries a lost answer response without duplicate attempts or FSRS logs", async () => {
    const content=await lesson(), row=await start(content);
    const first=await answer(row.id,0,content.steps[0]!.answer,content);
    const retry=await answer(row.id,0,content.steps[0]!.answer,content);
    expect(retry.index).toBe(first.index);
    for(let i=1;i<content.steps.length;i++) await answer(row.id,i,content.steps[i]!.answer,content);
    await answer(row.id,content.steps.length-1,content.steps.at(-1)!.answer,content);
    expect((await one("select count(*) as n from fsrs_review_logs")).n).toBe(1);
  });
  it("initializes an incorrect derivative recall through the existing Again schedule", async () => {
    const content=await lesson(), row=await start(content);
    for(let i=0;i<content.steps.length-1;i++) await answer(row.id,i,content.steps[i]!.answer,content);
    await answer(row.id,content.steps.length-1,'wrong',content);
    expect((await one("select rating from fsrs_review_logs")).rating).toBe(1);
    const card=await one("select status,fsrs_reps,next_review_at from user_words uw join words w on w.id=uw.word_id where w.normalized_word='reconciliation'");
    expect(card.status).toBe('unknown'); expect(card.fsrs_reps).toBe(1);
    expect(new Date(card.next_review_at).getTime()).toBeGreaterThan(Date.now());
  });
  it("Stage A stabilizes only the existing base and never initializes another card", async () => {
    await db.query("update user_words set fsrs_reps=1,fsrs_stability=1 where user_id=$1",[u1]);
    const content=await lesson(), row=await start(content);
    expect(content.stage).toBe('A'); expect(content.target_id).toBeNull();
    for(let i=0;i<content.steps.length;i++) await answer(row.id,i,content.steps[i]!.answer,content);
    expect((await one("select count(*) as n from user_words")).n).toBe(1);
    expect((await one("select count(*) as n from fsrs_review_logs")).n).toBe(0);
    expect((await one("select count(*) as n from family_exposures")).n).toBe(0);
  });
  it("Stage D practices stable members without rescheduling or introducing any item", async () => {
    for(const word of ['reconciliation','reconcilable']) await db.query("select ensure_user_word_v1($1,$2,$2,'test',false)",[u1,word]);
    await db.query("update user_words set fsrs_reps=3,fsrs_stability=8,consecutive_correct=3,status='review' where user_id=$1",[u1]);
    const content=await lesson(), row=await start(content);
    expect(content.stage).toBe('D'); expect(content.target_id).toBeNull();
    for(let i=0;i<content.steps.length;i++) await answer(row.id,i,content.steps[i]!.answer,content);
    expect((await one("select count(*) as n from user_words")).n).toBe(3);
    expect((await one("select count(*) as n from user_words where fsrs_reps<>3 or fsrs_stability<>8")).n).toBe(0);
    expect((await one("select count(*) as n from fsrs_review_logs")).n).toBe(0);
  });
  it("blocks graph-aware sibling introductions even after recentering", async () => {
    const content=await lesson(), row=await start(content);
    for(let i=0;i<content.steps.length;i++) await answer(row.id,i,content.steps[i]!.answer,content);
    await db.exec("savepoint blocked");
    await expect(start({...content,target_id:'en:reconcilable:a'})).rejects.toThrow("FAMILY_SPACING_REQUIRED");
    await db.exec("rollback to savepoint blocked");
    expect((await one("select count(*) as n from user_words")).n).toBe(2);
  });
  it("does not schedule existing derivative cards on activation races", async () => {
    const content=await lesson(), row=await start(content);
    await db.query("select ensure_user_word_v1($1,'reconciliation','reconciliation','test',false)",[u1]);
    await db.query("update user_words set fsrs_reps=9,fsrs_stability=25 where word_id=(select id from words where normalized_word='reconciliation')");
    for(let i=0;i<content.steps.length;i++) await answer(row.id,i,content.steps[i]!.answer,content);
    expect((await one("select fsrs_reps from user_words where word_id=(select id from words where normalized_word='reconciliation')")).fsrs_reps).toBe(9);
    expect((await one("select count(*) as n from fsrs_review_logs")).n).toBe(0);
  });
  it("rejects cross-user session submission and direct client roles", async () => {
    const row=await start(await lesson());
    await db.exec("savepoint unauthorized");
    await expect(db.query("select submit_family_step_v1($1,$2,0,'n')",[u2,row.id])).rejects.toThrow("FAMILY_SESSION_NOT_FOUND");
    await db.exec("rollback to savepoint unauthorized");
    for(const role of ["anon","authenticated"]) {
      expect((await one(`select has_table_privilege('${role}','family_micro_sessions','SELECT') as allowed`)).allowed).toBe(false);
      expect((await one(`select has_function_privilege('${role}','get_family_graph_v1(uuid,text,integer)','EXECUTE') as allowed`)).allowed).toBe(false);
    }
  });
});
