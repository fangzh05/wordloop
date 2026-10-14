import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildLearningCostProfile, timeObservationSchema } from "../server/services/learningTimeCalibration.js";

const db = new PGlite();
const a = "00000000-0000-4000-8000-000000000001", b = "00000000-0000-4000-8000-000000000002";
const s = "10000000-0000-4000-8000-000000000001", sb = "10000000-0000-4000-8000-000000000002";
const value = async (sql: string, args: unknown[] = []) => (await db.query<any>(sql, args)).rows[0];
beforeAll(async () => {
  await db.exec(`CREATE ROLE anonymous; CREATE ROLE authenticated; CREATE ROLE wordloop_admin;
    CREATE SCHEMA auth; CREATE FUNCTION auth.user_id() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('test.user',true),'')::uuid$$;
    CREATE TABLE users(id uuid PRIMARY KEY, timezone text);
    CREATE TABLE study_sessions(id uuid PRIMARY KEY,user_id uuid,started_at timestamptz DEFAULT now(),ended_at timestamptz,state jsonb,updated_at timestamptz DEFAULT now());
    CREATE TABLE attempts(id bigint GENERATED ALWAYS AS IDENTITY,user_id uuid,session_id uuid,activity_type text,created_at timestamptz DEFAULT now());
    CREATE TABLE fsrs_review_logs(id uuid,user_id uuid,session_id uuid,created_at timestamptz DEFAULT now());
    CREATE FUNCTION public.wordloop_authenticated_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT auth.user_id()$$;
  `);
  await db.exec(readFileSync(new URL("../neon/migrations/0006_learning_time_calibration_v2.sql", import.meta.url), "utf8"));
  await db.exec(readFileSync(new URL("../neon/migrations/0008_learning_time_prediction_errors.sql", import.meta.url), "utf8"));
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec("BEGIN");
  await db.query("INSERT INTO users VALUES($1,'Asia/Shanghai'),($2,'Asia/Shanghai')", [a,b]);
  const state = JSON.stringify({ widget:"lesson", phase:"lesson_exercise", current_index:0, retry_count:0, payload:{activity_type:"cloze"} });
  await db.query("INSERT INTO study_sessions(id,user_id,state,started_at,updated_at) VALUES($1,$2,$3::jsonb,now()-interval '2 minutes',now()-interval '1 minute'),($4,$5,$3::jsonb,now()-interval '2 minutes',now()-interval '1 minute')",[s,a,state,sb,b]);
});
afterEach(async()=>{await db.exec("ROLLBACK");});
describe("Neon time calibration migration",()=>{
  it("accepts the real Neon offset timestamp through validation and persists a finalized sample", async () => {
    await db.query("SELECT set_config('test.user',$1,true)", [a]);
    const timing = await value("SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US') || '+00:00' AS started, (now() AT TIME ZONE 'Asia/Shanghai')::date::text AS day FROM study_sessions WHERE id=$1", [s]);
    const observation = timeObservationSchema.parse({ session_id:s, phase:"lesson_exercise", index:0, retry:0, stage:"answer", phase_started_at:timing.started, local_date:timing.day, active_ms:5000, finalize:false });
    expect((await value("SELECT record_learning_time_v2($1,$2::jsonb) accepted", [a, JSON.stringify(observation)])).accepted).toBe(true);
    await db.query("UPDATE study_sessions SET state=jsonb_set(state,'{phase}','\"lesson_feedback\"'),updated_at=now() WHERE id=$1", [s]);
    expect((await value("SELECT record_learning_time_v2($1,$2::jsonb) accepted", [a, JSON.stringify({...observation, finalize:true})])).accepted).toBe(true);
    expect(await value("SELECT samples,total_ms FROM user_learning_time_daily WHERE user_id=$1", [a])).toEqual({samples:1,total_ms:5000});
  });
  it("gives two users different same-activity estimates without sharing their samples",async()=>{
    await db.query(`INSERT INTO user_learning_time_daily(user_id,local_date,activity_type,scope,stage,model_version,samples,total_ms,histogram,updated_at)
      VALUES($1,current_date,'cloze','lesson','answer','personal-time-v2-pilot',30,675000,'{"4":30}'::jsonb,now()),
            ($2,current_date,'cloze','lesson','answer','personal-time-v2-pilot',30,975000,'{"6":30}'::jsonb,now())`,[a,b]);
    await db.query("SELECT set_config('test.user',$1,true)",[a]);
    const profileA=buildLearningCostProfile((await value("SELECT user_learning_time_profile_v2($1) data",[a])).data);
    await db.query("SELECT set_config('test.user',$1,true)",[b]);
    const profileB=buildLearningCostProfile((await value("SELECT user_learning_time_profile_v2($1) data",[b])).data);
    expect(profileA.costs["lesson:cloze"]?.seconds).not.toBe(profileB.costs["lesson:cloze"]?.seconds);
    expect(profileA.costs["lesson:cloze"]?.samples).toBe(30);
    expect(profileB.costs["lesson:cloze"]?.samples).toBe(30);
  });
  it("deduplicates checkpoints and one finalized task across refreshes",async()=>{
    const day=(await value("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text AS today_local")).today_local;
    const phaseStarted=(await value("SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_at FROM study_sessions WHERE id=$1",[s])).updated_at;
    await db.query("SELECT set_config('test.user',$1,true)",[a]);
    for(const ms of [12000,12000,9000]) { const accepted=await value("SELECT record_learning_time_v2($1,$2::jsonb) accepted",[a,JSON.stringify({session_id:s,phase:"lesson_exercise",index:0,retry:0,stage:"answer",phase_started_at:phaseStarted,local_date:day,active_ms:ms,finalize:false})]); expect(accepted.accepted).toBe(true); }
    await db.query("UPDATE user_learning_time_observations SET updated_at=now()-interval '10 seconds' WHERE user_id=$1",[a]);
    await db.query("SELECT record_learning_time_v2($1,$2::jsonb)",[a,JSON.stringify({session_id:s,phase:"lesson_exercise",index:0,retry:0,stage:"answer",phase_started_at:phaseStarted,local_date:day,active_ms:18000,finalize:false})]);
    await db.query("UPDATE study_sessions SET state=jsonb_set(state,'{phase}','\"lesson_feedback\"'),updated_at=now() WHERE id=$1",[s]);
    const observation={session_id:s,phase:"lesson_exercise",index:0,retry:0,stage:"answer",phase_started_at:phaseStarted,local_date:day,active_ms:18000,finalize:true};
    await db.query("SELECT record_learning_time_v2($1,$2::jsonb)",[a,JSON.stringify(observation)]);
    await db.query("SELECT record_learning_time_v2($1,$2::jsonb)",[a,JSON.stringify(observation)]);
    const result=await value("SELECT samples,total_ms,histogram FROM user_learning_time_daily WHERE user_id=$1",[a]);
    expect(result.samples).toBe(1);expect(result.total_ms).toBe(18000);expect(result.histogram).toEqual({"3":1});
    const paired=await value("SELECT prediction_samples,predicted_total_ms,signed_error_total_ms,absolute_error_total_ms FROM user_learning_time_daily WHERE user_id=$1",[a]);
    expect(paired).toEqual({prediction_samples:1,predicted_total_ms:8000,signed_error_total_ms:10000,absolute_error_total_ms:10000});
    expect((await value("SELECT count(*) n FROM attempts")).n).toBe(0);
  });
  it("classifies pronunciation and listening recall independently and pairs one prediction each",async()=>{
    await db.query("SELECT set_config('test.user',$1,true)",[a]);
    const day=(await value("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text AS today_local")).today_local;
    const start=async()=> (await value("SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_at FROM study_sessions WHERE id=$1",[s])).updated_at as string;
    const record=async(observation:Record<string,unknown>)=> (await value("SELECT record_learning_time_v2($1,$2::jsonb) accepted",[a,JSON.stringify(observation)])).accepted;
    await db.query("UPDATE study_sessions SET state=$2::jsonb,updated_at=now()-interval '90 seconds' WHERE id=$1",[s,JSON.stringify({widget:"pretest",phase:"listen_repeat",current_index:0,retry_count:0,current_word:"apple",payload:{mode:"exercise"}})]);
    const pronunciationStart=await start();
    const pronunciation={session_id:s,phase:"listen_repeat",index:0,retry:0,stage:"answer",phase_started_at:pronunciationStart,local_date:day,active_ms:5000,finalize:false};
    expect(await record(pronunciation)).toBe(true);
    await db.query("UPDATE study_sessions SET state=$2::jsonb,updated_at=now()-interval '60 seconds' WHERE id=$1",[s,JSON.stringify({widget:"pretest",phase:"listen_recall",current_index:0,retry_count:0,current_word:"apple",payload:{mode:"exercise"}})]);
    expect(await record({...pronunciation,finalize:true})).toBe(true);
    const recallStart=await start();
    const listening={...pronunciation,phase:"listen_recall",phase_started_at:recallStart,active_ms:10000};
    expect(await record(listening)).toBe(true);
    await db.query("UPDATE study_sessions SET state=$2::jsonb,updated_at=now()-interval '30 seconds' WHERE id=$1",[s,JSON.stringify({widget:"pretest",phase:"pretest_result",current_index:0,retry_count:0,current_word:"apple",payload:{mode:"feedback"}})]);
    expect(await record({...listening,finalize:true})).toBe(true);
    const rows=await value("SELECT jsonb_object_agg(activity_type,jsonb_build_object('samples',samples,'predicted',prediction_samples,'predicted_ms',predicted_total_ms)) AS activities FROM user_learning_time_daily WHERE user_id=$1",[a]);
    expect(rows.activities).toEqual({pronunciation:{samples:1,predicted:1,predicted_ms:8000},listening_recall:{samples:1,predicted:1,predicted_ms:8000}});
  });
  it("excludes same-day timing data from deterministic prior predictions",async()=>{
    await db.query("SELECT set_config('test.user',$1,true)",[a]);
    await db.query(`INSERT INTO user_learning_time_daily(user_id,local_date,activity_type,scope,stage,samples,total_ms,histogram)
      VALUES($1,(now() AT TIME ZONE 'Asia/Shanghai')::date-1,'cloze','lesson','answer',30,3000000,'{"20":30}'::jsonb),
        ($1,(now() AT TIME ZONE 'Asia/Shanghai')::date,'cloze','lesson','answer',30,30000000,'{"100":30}'::jsonb)`,[a]);
    const today=(await value("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text AS today")).today;
    const prediction=(await value("SELECT learning_time_prior_prediction_v2($1,$2::date,'cloze','lesson','answer') AS predicted_ms",[a,today])).predicted_ms;
    expect(prediction).toBe(17600);
  });
  it("returns a user-scoped, local-day 30-day history with paired-error aggregates",async()=>{
    await db.query("SELECT set_config('test.user',$1,true)",[a]);
    const day=(await value("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text AS today_local")).today_local;
    await db.query(`INSERT INTO user_learning_time_daily(user_id,local_date,activity_type,scope,stage,samples,total_ms,histogram,prediction_samples,predicted_total_ms,signed_error_total_ms,absolute_error_total_ms)
      VALUES($1,$2,'cloze','lesson','answer',2,12000,'{"1":2}',2,10000,2000,4000)`,[a,day]);
    const history=(await value("SELECT user_learning_time_history_v2($1,30) AS history",[a])).history;
    expect(history).toHaveLength(30);
    expect(history[0]).toMatchObject({date:day,effective_seconds:12,samples:2,predicted_total_ms:10000,prediction_samples:2,signed_error_total_ms:2000,absolute_error_total_ms:4000});
    await db.query("SELECT set_config('test.user',$1,true)",[b]);
    expect((await value("SELECT user_learning_time_history_v2($1,30) AS history",[b])).history[0].samples).toBe(0);
    await expect(db.query("SELECT user_learning_time_history_v2($1,30)",[a])).rejects.toThrow("UNAUTHORIZED");
  });
  it("isolates profiles by authenticated user and rejects a mismatched subject",async()=>{
    await db.query("SELECT set_config('test.user',$1,true)",[a]);
    const day=(await value("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text AS today_local")).today_local;
    const phaseStarted=(await value("SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_at FROM study_sessions WHERE id=$1",[s])).updated_at;
    await db.query("SELECT record_learning_time_v2($1,$2::jsonb)",[a,JSON.stringify({session_id:s,phase:"lesson_exercise",index:0,retry:0,stage:"answer",phase_started_at:phaseStarted,local_date:day,active_ms:10000,finalize:false})]);
    await db.query("INSERT INTO attempts(user_id,session_id,activity_type) VALUES($1,$2,'cloze')",[a,s]);
    await db.query("UPDATE study_sessions SET state=jsonb_set(state,'{phase}','\"lesson_feedback\"'),updated_at=now() WHERE id=$1",[s]);
    await db.query("SELECT record_learning_time_v2($1,$2::jsonb)",[a,JSON.stringify({session_id:s,phase:"lesson_exercise",index:0,retry:0,stage:"answer",phase_started_at:phaseStarted,local_date:day,active_ms:10000,finalize:true})]);
    expect((await value("SELECT jsonb_array_length(user_learning_time_profile_v2($1)) n",[a])).n).toBe(1);
    await expect(db.query("SELECT user_learning_time_profile_v2($1)",[b])).rejects.toThrow("UNAUTHORIZED");
  });
  it("rejects stale phases, foreign sessions, old local days and invalid long idle intervals",async()=>{
    const day=(await value("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text AS today_local")).today_local;
    await db.query("SELECT set_config('test.user',$1,true)",[a]);
    const phaseStarted=(await value("SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_at FROM study_sessions WHERE id=$1",[s])).updated_at;
    const base={session_id:s,phase:"lesson_feedback",index:0,retry:0,stage:"feedback",phase_started_at:phaseStarted,local_date:day,active_ms:10000,finalize:true};
    const stale=await value("SELECT record_learning_time_v2($1,$2::jsonb) accepted",[a,JSON.stringify(base)]);expect(stale.accepted).toBe(false);
    const other=await value("SELECT record_learning_time_v2($1,$2::jsonb) accepted",[a,JSON.stringify({...base,session_id:sb,phase:"lesson_exercise"})]);expect(other.accepted).toBe(false);
    const old=await value("SELECT record_learning_time_v2($1,$2::jsonb) accepted",[a,JSON.stringify({...base,phase:"lesson_exercise",local_date:"2000-01-01"})]);expect(old.accepted).toBe(false);
    const long=await value("SELECT record_learning_time_v2($1,$2::jsonb) accepted",[a,JSON.stringify({...base,phase:"lesson_exercise",active_ms:600000})]);expect(long.accepted).toBe(false);
    const freshStart=(await value("SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_at FROM study_sessions WHERE id=$1",[s])).updated_at;
    await db.query("INSERT INTO attempts(user_id,session_id,activity_type) VALUES($1,$2,'review')",[a,s]);
    await db.query("UPDATE study_sessions SET updated_at=now() WHERE id=$1",[s]);
    const forged=await value("SELECT record_learning_time_v2($1,$2::jsonb) accepted",[a,JSON.stringify({...base,phase:"lesson_explain",stage:"explanation",phase_started_at:freshStart,index:99})]);
    expect(forged.accepted).toBe(false);
  });
  it("finalizes a paused answer only after a matching formal attempt was saved",async()=>{
    await db.query("SELECT set_config('test.user',$1,true)",[a]);
    const day=(await value("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text AS today_local")).today_local;
    const phaseStarted=(await value("SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_at FROM study_sessions WHERE id=$1",[s])).updated_at;
    const checkpoint={session_id:s,phase:"lesson_exercise",index:0,retry:0,stage:"answer",phase_started_at:phaseStarted,local_date:day,active_ms:12000,finalize:false};
    await db.query("SELECT record_learning_time_v2($1,$2::jsonb)",[a,JSON.stringify(checkpoint)]);
    await db.query("INSERT INTO attempts(user_id,session_id,activity_type) VALUES($1,$2,'cloze')",[a,s]);
    await db.query("UPDATE study_sessions SET state=jsonb_set(state,'{phase}','\"lesson_feedback\"'),updated_at=now() WHERE id=$1",[s]);
    const observation={...checkpoint,finalize:true};
    const accepted=await value("SELECT record_learning_time_v2($1,$2::jsonb) accepted",[a,JSON.stringify(observation)]);
    expect(accepted.accepted).toBe(true);
    expect((await value("SELECT count(*) n FROM user_learning_time_daily WHERE user_id=$1",[a])).n).toBe(1);
  });
  it("records consolidation answer and feedback separately, including a closed session",async()=>{
    await db.query("SELECT set_config('test.user',$1,true)",[a]);
    const day=(await value("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text AS today_local")).today_local;
    const consolidation=JSON.stringify({widget:"lesson",phase:"lesson_complete",current_index:0,retry_count:0,payload:{mode:"exercise",consolidation:true,consolidation_status:"exercise",consolidation_plan:{planned_activity_type:"sentence"}}});
    await db.query("UPDATE study_sessions SET state=$2::jsonb WHERE id=$1",[s,consolidation]);
    const answerStart=(await value("SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_at FROM study_sessions WHERE id=$1",[s])).updated_at;
    const answer={session_id:s,phase:"lesson_complete",index:0,retry:0,stage:"answer",phase_started_at:answerStart,local_date:day,active_ms:10000,finalize:false};
    expect((await value("SELECT record_learning_time_v2($1,$2::jsonb) accepted",[a,JSON.stringify(answer)])).accepted).toBe(true);
    await db.query("UPDATE study_sessions SET state=jsonb_set(jsonb_set(state,'{payload,mode}','\"feedback\"'),'{payload,consolidation_status}','\"feedback\"'),updated_at=now()-interval '20 seconds' WHERE id=$1",[s]);
    expect((await value("SELECT record_learning_time_v2($1,$2::jsonb) accepted",[a,JSON.stringify({...answer,finalize:true})])).accepted).toBe(true);
    const feedbackStart=(await value("SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_at FROM study_sessions WHERE id=$1",[s])).updated_at;
    const feedback={...answer,stage:"feedback",phase_started_at:feedbackStart,finalize:false};
    expect((await value("SELECT record_learning_time_v2($1,$2::jsonb) accepted",[a,JSON.stringify(feedback)])).accepted).toBe(true);
    await db.query("UPDATE study_sessions SET ended_at=now(),updated_at=now() WHERE id=$1",[s]);
    expect((await value("SELECT record_learning_time_v2($1,$2::jsonb) accepted",[a,JSON.stringify({...feedback,finalize:true})])).accepted).toBe(true);
    const stages=await value("SELECT jsonb_object_agg(stage,samples) AS stages FROM user_learning_time_daily WHERE user_id=$1",[a]);
    expect(stages.stages).toEqual({answer:1,feedback:1});
  });
  it("finalizes a prior-local-day segment at midnight without attributing it to today",async()=>{
    await db.query("SELECT set_config('test.user',$1,true)",[a]);
    const todayText=(await value("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text AS d")).d as string;
    const previous=(await value("SELECT ($1::date-1)::text AS d",[todayText])).d as string;
    const boundary=await value("SELECT $1::date::timestamp AT TIME ZONE 'Asia/Shanghai' AS start,(($1::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai') AS finish",[previous]);
    await db.query("UPDATE study_sessions SET started_at=$2::timestamptz-interval '10 minutes',updated_at=$2::timestamptz WHERE id=$1",[s,boundary.start]);
    const phaseStarted=(await value("SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_at FROM study_sessions WHERE id=$1",[s])).updated_at;
    const phaseKey=(await value("SELECT to_char($1::timestamptz AT TIME ZONE 'UTC','YYYYMMDDHH24MISSUS') AS k",[phaseStarted])).k;
    const task=`${s}:lesson_exercise:0:0:${previous}:${phaseKey}:answer`;
    await db.query("INSERT INTO user_learning_time_observations(user_id,session_id,task_key,local_date,activity_type,scope,stage,active_ms,updated_at) VALUES($1,$2,$3,$4,'cloze','lesson','answer',5000,$5::timestamptz-interval '10 seconds')",[a,s,task,previous,boundary.finish]);
    const result=await value("SELECT record_learning_time_v2($1,$2::jsonb) accepted",[a,JSON.stringify({session_id:s,phase:"lesson_exercise",index:0,retry:0,stage:"answer",phase_started_at:phaseStarted,local_date:previous,active_ms:8000,finalize:true,rollover:true})]);
    expect(result.accepted).toBe(true);
    expect((await value("SELECT samples,total_ms,local_date::text FROM user_learning_time_daily WHERE user_id=$1",[a]))).toEqual({samples:1,total_ms:8000,local_date:previous});
  });
  it("creates one personal new-word cost only after its Pretest and Lesson lifecycle completes",async()=>{
    await db.query("SELECT set_config('test.user',$1,true)",[a]);
    const day=(await value("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text AS today_local")).today_local;
    const start=async()=> (await value("SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_at FROM study_sessions WHERE id=$1",[s])).updated_at as string;
    const record=async(observation:Record<string,unknown>)=> (await value("SELECT record_learning_time_v2($1,$2::jsonb) accepted",[a,JSON.stringify(observation)])).accepted;
    await db.query("UPDATE study_sessions SET state=$2::jsonb,updated_at=now()-interval '120 seconds' WHERE id=$1",[s,JSON.stringify({widget:"pretest",phase:"pretest",current_index:0,retry_count:0,current_word:"Apple",payload:{mode:"exercise"}})]);
    const pretestStart=await start();
    const pretest={session_id:s,phase:"pretest",index:0,retry:0,stage:"answer",phase_started_at:pretestStart,local_date:day,active_ms:1000,finalize:false};
    expect(await record(pretest)).toBe(true);
    await db.query("UPDATE study_sessions SET state=$2::jsonb,updated_at=now()-interval '100 seconds' WHERE id=$1",[s,JSON.stringify({widget:"pretest",phase:"pretest_result",current_index:0,retry_count:0,current_word:"Apple",payload:{mode:"feedback"}})]);
    expect(await record({...pretest,finalize:true})).toBe(true);
    await db.query("UPDATE study_sessions SET state=$2::jsonb,updated_at=now()-interval '80 seconds' WHERE id=$1",[s,JSON.stringify({widget:"lesson",phase:"lesson_explain",current_index:0,retry_count:0,current_word:"apple",payload:{mode:"explain"}})]);
    const explainStart=await start();
    const explain={...pretest,phase:"lesson_explain",stage:"explanation",phase_started_at:explainStart};
    expect(await record(explain)).toBe(true);
    await db.query("UPDATE study_sessions SET state=$2::jsonb,updated_at=now()-interval '60 seconds' WHERE id=$1",[s,JSON.stringify({widget:"lesson",phase:"lesson_exercise",current_index:0,retry_count:0,current_word:"apple",payload:{mode:"exercise",activity_type:"cloze"}})]);
    expect(await record({...explain,finalize:true})).toBe(true);
    const answerStart=await start();
    const lessonAnswer={...pretest,phase:"lesson_exercise",stage:"answer",phase_started_at:answerStart};
    expect(await record(lessonAnswer)).toBe(true);
    await db.query("UPDATE study_sessions SET state=$2::jsonb,updated_at=now()-interval '40 seconds' WHERE id=$1",[s,JSON.stringify({widget:"lesson",phase:"lesson_feedback",current_index:0,retry_count:0,current_word:"apple",payload:{mode:"feedback",activity_type:"cloze"}})]);
    expect(await record({...lessonAnswer,finalize:true})).toBe(true);
    const feedbackStart=await start();
    const feedback={...pretest,phase:"lesson_feedback",stage:"feedback",phase_started_at:feedbackStart};
    expect(await record(feedback)).toBe(true);
    await db.query("UPDATE study_sessions SET state=$2::jsonb,updated_at=now()-interval '20 seconds' WHERE id=$1",[s,JSON.stringify({widget:"lesson",phase:"lesson_complete",current_index:0,retry_count:0,current_word:"apple",payload:{mode:"feedback"}})]);
    expect(await record({...feedback,finalize:true})).toBe(true);
    const lifecycle=await value("SELECT canonical_word,active_ms,pretest_samples,lesson_answer_samples,lesson_feedback_samples,predicted_ms FROM user_learning_time_word_lifecycle WHERE user_id=$1",[a]);
    expect(lifecycle).toEqual({canonical_word:"apple",active_ms:4000,pretest_samples:1,lesson_answer_samples:1,lesson_feedback_samples:1,predicted_ms:77000});
    const wholeWordError=await value("SELECT prediction_samples,predicted_total_ms,signed_error_total_ms,absolute_error_total_ms FROM user_learning_time_daily WHERE user_id=$1 AND activity_type='__complete_new_word__'",[a]);
    expect(wholeWordError).toEqual({prediction_samples:1,predicted_total_ms:77000,signed_error_total_ms:-73000,absolute_error_total_ms:73000});
    await db.query("SELECT set_config('test.user',$1,true)",[a]);
    const profile=await value("SELECT count(*)::integer AS rows,max((item->>'samples')::integer) AS samples FROM jsonb_array_elements(user_learning_time_profile_v2($1)) item WHERE item->>'activity_type'='__complete_new_word__'",[a]);
    expect(profile).toEqual({rows:1,samples:1});
  });
  it("allocates a completed group consolidation to each canonical word exactly once",async()=>{
    await db.query("SELECT set_config('test.user',$1,true)",[a]);
    const day=(await value("SELECT (now() AT TIME ZONE 'Asia/Shanghai')::date::text AS today_local")).today_local;
    await db.query("INSERT INTO user_learning_time_word_lifecycle(user_id,canonical_word,session_id,local_date,active_ms,pretest_samples,lesson_answer_samples,lesson_feedback_samples,predicted_ms) VALUES($1,'apple',$2,$3,10000,1,1,1,77000),($1,'banana',$2,$3,10000,1,1,1,77000)",[a,s,day]);
    await db.query("INSERT INTO user_learning_time_daily(user_id,local_date,activity_type,scope,stage,samples,total_ms,histogram,prediction_samples,predicted_total_ms,signed_error_total_ms,absolute_error_total_ms) VALUES($1,$2,'__complete_new_word__','lesson','answer',2,20000,'{\"2\":2}'::jsonb,2,154000,-134000,134000)",[a,day]);
    await db.query("UPDATE study_sessions SET state=$2::jsonb,started_at=now()-interval '5 minutes',updated_at=now()-interval '2 minutes' WHERE id=$1",[s,JSON.stringify({widget:"lesson",phase:"lesson_complete",current_index:0,retry_count:0,payload:{mode:"exercise",consolidation:true,consolidation_status:"exercise",consolidation_target_words:["Apple","banana","apple"],consolidation_plan:{planned_activity_type:"sentence"}}})]);
    const answerStart=await value("SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_at FROM study_sessions WHERE id=$1",[s]);
    const answer={session_id:s,phase:"lesson_complete",index:0,retry:0,stage:"answer",phase_started_at:answerStart.updated_at,local_date:day,active_ms:90000,finalize:false};
    expect((await value("SELECT record_learning_time_v2($1,$2::jsonb) accepted",[a,JSON.stringify(answer)])).accepted).toBe(true);
    const feedbackState={widget:"lesson",phase:"lesson_complete",current_index:0,retry_count:0,payload:{mode:"feedback",consolidation:true,consolidation_status:"feedback",consolidation_target_words:["Apple","banana","apple"],consolidation_plan:{planned_activity_type:"sentence"},feedback:{is_correct:false,reveal_answer:true}}};
    await db.query("UPDATE study_sessions SET state=$2::jsonb,updated_at=now()-interval '30 seconds' WHERE id=$1",[s,JSON.stringify(feedbackState)]);
    expect((await value("SELECT record_learning_time_v2($1,$2::jsonb) accepted",[a,JSON.stringify({...answer,finalize:true})])).accepted).toBe(true);
    const feedbackStart=await value("SELECT to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS updated_at FROM study_sessions WHERE id=$1",[s]);
    const feedback={...answer,stage:"feedback",phase_started_at:feedbackStart.updated_at,active_ms:30000,finalize:false};
    expect((await value("SELECT record_learning_time_v2($1,$2::jsonb) accepted",[a,JSON.stringify(feedback)])).accepted).toBe(true);
    await db.query("UPDATE study_sessions SET ended_at=now(),updated_at=now() WHERE id=$1",[s]);
    expect((await value("SELECT record_learning_time_v2($1,$2::jsonb) accepted",[a,JSON.stringify({...feedback,finalize:true})])).accepted).toBe(true);
    const lifecycle=await value("SELECT count(*)::integer AS words,sum(consolidation_ms)::integer AS allocated,bool_and(consolidation_sampled) AS sampled FROM user_learning_time_word_lifecycle WHERE user_id=$1",[a]);
    expect(lifecycle).toEqual({words:2,allocated:120000,sampled:true});
    const histogram=await value("SELECT samples,total_ms,histogram FROM user_learning_time_daily WHERE user_id=$1 AND activity_type='__complete_new_word__'",[a]);
    expect(histogram).toEqual({samples:2,total_ms:140000,histogram:{"2":0,"14":2}});
    const errors=await value("SELECT prediction_samples,predicted_total_ms,signed_error_total_ms,absolute_error_total_ms FROM user_learning_time_daily WHERE user_id=$1 AND activity_type='__complete_new_word__'",[a]);
    expect(errors).toEqual({prediction_samples:2,predicted_total_ms:154000,signed_error_total_ms:-14000,absolute_error_total_ms:14000});
    const profile=await value("SELECT count(*)::integer AS rows,max((item->>'samples')::integer) AS samples FROM jsonb_array_elements(user_learning_time_profile_v2($1)) item WHERE item->>'activity_type'='__complete_new_word__'",[a]);
    expect(profile).toEqual({rows:1,samples:2});
  });
});

