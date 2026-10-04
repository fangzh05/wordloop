import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { beforeAll, afterAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import { updateBkt, predictCorrect } from "../server/services/bkt.js";

const db = new PGlite();
const user = "00000000-0000-4000-8000-000000000001";
const exercise = "00000000-0000-4000-8000-000000000002";
beforeAll(async () => {
  await db.exec(`create role anon; create role authenticated; create role service_role;
    create table users(id uuid primary key,timezone text default 'Asia/Shanghai',daily_new_word_limit integer default 50);
    create table words(id uuid primary key,normalized_word text,display_word text);
    create table user_words(id uuid primary key,user_id uuid,word_id uuid,next_review_at timestamptz,status text,mastered boolean,first_seen_at timestamptz);
    create table attempts(id uuid primary key,user_id uuid,word_id uuid,activity_type text,session_id uuid,user_answer text,is_correct boolean,error_layer text,submission_id uuid,scope text,exercise_id uuid,plan_id uuid,skill_ids text[],skill_evidence jsonb,first_attempt boolean,hint_used boolean,answer_revealed boolean);
    create table study_sessions(id uuid,user_id uuid,state jsonb,ended_at timestamptz);
    create table daily_imports(id uuid primary key default gen_random_uuid(),user_id uuid,import_date date,source text,raw_count integer,unique(user_id,import_date,source));
    create table daily_import_words(import_id uuid,word_id uuid,position integer,unique(import_id,word_id));
    create table exercise_submission_events(user_id uuid,submission_id uuid,skill_evidence jsonb,session_id uuid,plan_id uuid,exercise_id uuid,scope text,word_id uuid,activity_type text,skill_ids text[],outcome text,result jsonb);
    create table exercise_skill_evidence(id bigint generated always as identity primary key,user_id uuid,submission_id uuid,exercise_id uuid,plan_id uuid,scope text,word_id uuid,skill_id text,outcome text,first_unprompted boolean,hint_used boolean,modified_correct boolean,answer_revealed boolean,evidence text,created_at timestamptz default now());`);
  await db.exec(readFileSync(new URL("../supabase/migrations/20261002024106_evidence_budget.sql", import.meta.url), "utf8"));
  await db.exec(readFileSync(new URL("../supabase/migrations/20261004045839_bkt_active_planner.sql", import.meta.url), "utf8"));
}, 30000);
afterAll(() => db.close());
beforeEach(async () => { await db.exec("begin"); await db.query("insert into users(id) values($1)", [user]); });
afterEach(() => db.exec("rollback"));
async function value(sql: string, args: unknown[] = []) { return (await db.query<any>(sql, args)).rows[0]; }
async function evidence(outcome = "correct", quality = "OBSERVE", submission = crypto.randomUUID()) {
  const label = { skill_id: "target_sense_retrieval", outcome, quality, quality_reason: "test", evidence_version: "evidence-v1" };
  await db.query("insert into exercise_submission_events(user_id,submission_id,skill_evidence) values($1,$2,$3)", [user, submission, JSON.stringify([label])]);
  return (await value("insert into exercise_skill_evidence(user_id,submission_id,exercise_id,skill_id,outcome) values($1,$2,$3,'target_sense_retrieval',$4) returning id", [user, submission, exercise, outcome])).id;
}
describe("real PostgreSQL evidence and budget transactions", () => {
  it("supports active mode while keeping an explicit off switch and budget unchanged", async () => {
    await db.query("insert into learning_settings(user_id,bkt_mode,daily_minutes) values($1,'active',60)", [user]);
    expect((await value("select bkt_mode,daily_minutes from learning_settings where user_id=$1", [user]))).toMatchObject({ bkt_mode: "active", daily_minutes: 60 });
    await db.query("update learning_settings set bkt_mode='off' where user_id=$1", [user]);
    expect((await value("select daily_minutes from learning_settings where user_id=$1", [user])).daily_minutes).toBe(60);
    await expect(db.query("update learning_settings set bkt_mode='invalid' where user_id=$1", [user])).rejects.toThrow();
  });
  it("records formal retrieval without confusing grammar errors with memory failure", async () => {
    await db.query("insert into words values($1,'opaque','opaque')", [exercise]);
    await db.query("insert into study_sessions values($1,$2,$3,null)", [exercise,user,JSON.stringify({ widget: 'review', current_index: 0, payload: { items: [{word:'opaque',direction:'cn_to_en',prompt:'不透明的'}] } })]);
    await db.query("insert into attempts(id,user_id,word_id,activity_type,session_id,user_answer,is_correct,error_layer) values($1,$2,$3,'review',$3,'opaque',false,'grammar')", [crypto.randomUUID(),user,exercise]);
    const r = await db.query<{outcome:string;quality:string}>("select outcome,quality from exercise_skill_evidence");
    expect(r.rows).toHaveLength(2); expect(r.rows.every(e => e.outcome==='not_assessed' && e.quality==='IGNORE')).toBe(true);
    expect((await value("select count(*)::int n from exercise_submission_events")).n).toBe(1);
  });
  it("defaults to 45 minutes and atomically rejects an over-budget task", async () => {
    expect((await value("select learning_budget_snapshot_v1($1) b", [user])).b.daily_minutes).toBe(45);
    for (let i = 0; i < 9; i++) expect((await value("select reserve_learning_budget_v1($1,$2,300,'test') ok", [user, `t${i}`])).ok).toBe(true);
    expect((await value("select reserve_learning_budget_v1($1,'overflow',8,'review') ok", [user])).ok).toBe(false);
    expect((await value("select reserve_learning_budget_v1($1,'t0',300,'test') ok", [user])).ok).toBe(true);
    expect((await value("select learning_budget_snapshot_v1($1) b", [user])).b.estimated_used_seconds).toBe(2700);
  });
  it("makes add-time retries idempotent and excludes previous-day spending", async () => {
    const key = crypto.randomUUID();
    await db.query("select set_learning_budget_v1($1,null,$2)", [user, key]);
    const b = (await value("select set_learning_budget_v1($1,null,$2) b", [user, key])).b;
    expect(b.remaining_seconds).toBe(3600);
    await db.query("insert into learning_budget_events values($1,'yesterday',current_date-1,90,'test',now())", [user]);
    expect((await value("select learning_budget_snapshot_v1($1) b", [user])).b.remaining_seconds).toBe(3600);
  });
  it("consumes one exercise once despite different submission IDs", async () => {
    const id = await evidence(); const next = updateBkt(.2, "OBSERVE", true);
    const args = [user, id, 0, next, predictCorrect(.2), "OBSERVE", true];
    expect((await value("select commit_bkt_update_v1($1,$2,$3,$4,$5,$6,$7) ok", args)).ok).toBe(true);
    expect((await value("select commit_bkt_update_v1($1,$2,$3,$4,$5,$6,$7) ok", args)).ok).toBe(true);
    const second = await evidence("correct", "LEARN_ONLY");
    await db.query("select commit_bkt_update_v1($1,$2,1,$3,$4,'LEARN_ONLY',true)", [user, second, .99, .99]);
    const state = await value("select * from user_skill_state where user_id=$1", [user]);
    expect(state.p_mastery).toBeCloseTo(next); expect(state.evidence_count).toBe(1); expect(state.learning_count).toBe(1);
  });
  it("rejects stale model revisions without consuming evidence", async () => {
    const id = await evidence();
    expect((await value("select commit_bkt_update_v1($1,$2,99,.5,.34,'OBSERVE',true) ok", [user, id])).ok).toBe(false);
    expect((await value("select count(*)::int n from skill_evidence_consumption")).n).toBe(0);
  });
  it("ignores conflicting multiword outcomes and preserves ordering on replay", async () => {
    const submission = crypto.randomUUID();
    const first = await evidence("correct", "OBSERVE", submission);
    const second = (await value("insert into exercise_skill_evidence(user_id,submission_id,exercise_id,skill_id,outcome) values($1,$2,$3,'target_sense_retrieval','incorrect') returning id", [user,submission,exercise])).id;
    expect((await value("select commit_bkt_update_v1($1,$2,0,.6,.34,'IGNORE',null) ok", [user,second])).ok).toBe(false);
    await db.query("select commit_bkt_update_v1($1,$2,0,.6,.34,'OBSERVE',true)",[user,first]);
    await db.query("select commit_bkt_update_v1($1,$2,0,.6,.34,'IGNORE',null)",[user,second]);
    expect((await value("select count(*)::int n from user_skill_state")).n).toBe(0);
    expect((await value("select count(*)::int n from skill_evidence_consumption")).n).toBe(2);
  });
  it("never lets user B consume user A evidence", async () => {
    const id = await evidence();
    await expect(db.query("select commit_bkt_update_v1($1,$2,0,.5,.34,'OBSERVE',true)", [crypto.randomUUID(), id])).rejects.toThrow("EVIDENCE_NOT_FOUND");
  });
  it("preserves due dates and blocks new admissions when overdue", async () => {
    await db.query("insert into words values($1,'opaque','opaque')", [exercise]);
    await db.query("insert into user_words values($1,$2,$1,now()-interval '2 days','review',false,now())", [exercise, user]);
    const before = await value("select next_review_at from user_words");
    const r = await value("select prepare_daily_new_words_budget_v1($1,current_date,50) b", [user]);
    expect(r.b.added).toBe(0); expect(r.b.limit).toBe(0);
    expect(await value("select next_review_at from user_words")).toEqual(before);
  });
  it("keeps all new tables inaccessible to browser roles", async () => {
    const result = await db.query<{ relname: string; relrowsecurity: boolean; allowed: boolean }>("select c.relname,c.relrowsecurity,has_table_privilege('anon',c.oid,'SELECT') allowed from pg_class c where c.relname in ('user_skill_state','bkt_updates','learning_settings','learning_budget_events','evidence_gold_labels')");
    expect(result.rows).toHaveLength(5); expect(result.rows.every(r => r.relrowsecurity && !r.allowed)).toBe(true);
  });
});
