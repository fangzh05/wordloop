-- Server-owned exercise plans, evidence events, and durable consolidation cadence.
-- Skill evidence is an event log; it is deliberately separate from FSRS cards.

alter table public.attempts
  add column if not exists scope text not null default 'lesson',
  add column if not exists exercise_id uuid,
  add column if not exists plan_id uuid,
  add column if not exists submission_id uuid,
  add column if not exists skill_ids text[] not null default '{}',
  add column if not exists skill_evidence jsonb not null default '[]'::jsonb,
  add column if not exists first_attempt boolean,
  add column if not exists hint_used boolean not null default false,
  add column if not exists answer_revealed boolean not null default false,
  add column if not exists active_ms integer,
  add column if not exists grading_ms integer;

alter table public.attempts drop constraint if exists attempts_scope_check;
alter table public.attempts add constraint attempts_scope_check
  check (scope in ('lesson','review','pretest','consolidation','legacy'));
alter table public.attempts drop constraint if exists attempts_active_ms_check;
alter table public.attempts add constraint attempts_active_ms_check check (active_ms is null or active_ms between 0 and 86400000);
alter table public.attempts drop constraint if exists attempts_grading_ms_check;
alter table public.attempts add constraint attempts_grading_ms_check check (grading_ms is null or grading_ms between 0 and 86400000);

update public.attempts set scope = case
  when activity_type = 'review' then 'review'
  when activity_type in ('pretest_cn_to_en','pretest_en_definition') then 'pretest'
  -- These two historical activity labels were used for both Lesson and
  -- round-end tasks, so their scope cannot be reconstructed safely.
  when activity_type in ('translation_en_to_cn','sentence') then 'legacy'
  else 'lesson' end
where scope = 'lesson';

-- Legacy RPCs still insert ordinary, Review, and Pretest attempts without a
-- scope column. Normalize these known activity families so new rows keep the
-- migration's explicit scope boundary; planned consolidation writes its scope
-- directly and is left untouched.
create or replace function public.normalize_attempt_scope_v1()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.activity_type = 'review' then
    new.scope := 'review';
  elsif new.activity_type in ('pretest_cn_to_en','pretest_en_definition') then
    new.scope := 'pretest';
  end if;
  return new;
end;
$$;
drop trigger if exists attempts_normalize_scope_v1 on public.attempts;
create trigger attempts_normalize_scope_v1
before insert or update of activity_type on public.attempts
for each row execute function public.normalize_attempt_scope_v1();

create index if not exists attempts_user_scope_created_idx
  on public.attempts(user_id, scope, created_at desc);
create unique index if not exists attempts_user_submission_unique
  on public.attempts(user_id, submission_id) where submission_id is not null;

create table if not exists public.exercise_submission_events (
  user_id uuid not null references public.users(id) on delete cascade,
  submission_id uuid not null,
  session_id uuid references public.study_sessions(id) on delete set null,
  plan_id uuid not null,
  exercise_id uuid not null,
  scope text not null check (scope in ('lesson','review','consolidation')),
  word_id uuid references public.words(id) on delete set null,
  activity_type text not null,
  error_focus text,
  skill_ids text[] not null default '{}',
  skill_evidence jsonb not null default '[]'::jsonb,
  outcome text not null check (outcome in ('correct','incorrect','revealed')),
  coverage_exception_reason text,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, submission_id)
);
create index if not exists exercise_submission_events_recent_idx
  on public.exercise_submission_events(user_id, scope, created_at desc);
create index if not exists exercise_submission_events_word_recent_idx
  on public.exercise_submission_events(user_id, word_id, created_at desc);

create table if not exists public.exercise_skill_evidence (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  submission_id uuid not null,
  exercise_id uuid not null,
  plan_id uuid not null,
  scope text not null check (scope in ('lesson','review','consolidation')),
  word_id uuid references public.words(id) on delete set null,
  skill_id text not null,
  outcome text not null check (outcome in ('correct','incorrect','partial','not_assessed')),
  first_unprompted boolean not null,
  hint_used boolean not null,
  modified_correct boolean not null,
  answer_revealed boolean not null,
  evidence text,
  created_at timestamptz not null default now(),
  unique (user_id, submission_id, skill_id, word_id),
  foreign key (user_id, submission_id)
    references public.exercise_submission_events(user_id, submission_id) on delete cascade
);
create index if not exists exercise_skill_evidence_rebuild_idx
  on public.exercise_skill_evidence(user_id, skill_id, created_at desc);

create table if not exists public.user_lesson_cadence (
  user_id uuid primary key references public.users(id) on delete cascade,
  completion_credit integer not null default 0 check (completion_credit between 0 and 9),
  rotation_cursor smallint not null default 0 check (rotation_cursor between 0 and 3),
  pending_task jsonb,
  last_reminder_task_id uuid,
  updated_at timestamptz not null default now()
);

create table if not exists public.lesson_word_completion_credits (
  user_id uuid not null references public.users(id) on delete cascade,
  local_date date not null,
  word_id uuid not null references public.words(id) on delete cascade,
  session_id uuid references public.study_sessions(id) on delete set null,
  exercise_id uuid not null,
  completion_outcome text not null check (completion_outcome in ('first_correct','modified_correct','revealed')),
  created_at timestamptz not null default now(),
  primary key (user_id, local_date, word_id)
);

alter table public.exercise_submission_events enable row level security;
alter table public.exercise_skill_evidence enable row level security;
alter table public.user_lesson_cadence enable row level security;
alter table public.lesson_word_completion_credits enable row level security;
revoke all on public.exercise_submission_events, public.exercise_skill_evidence,
  public.user_lesson_cadence, public.lesson_word_completion_credits from public, anon, authenticated;
grant select, insert, update, delete on public.exercise_submission_events, public.exercise_skill_evidence,
  public.user_lesson_cadence, public.lesson_word_completion_credits to service_role;
grant usage, select on sequence public.exercise_skill_evidence_id_seq to service_role;

create or replace function public.record_planned_submission_v1(
  p_user_id uuid,
  p_session_id uuid,
  p_expected_revision timestamptz,
  p_submission_id uuid,
  p_plan_id uuid,
  p_exercise_id uuid,
  p_scope text,
  p_normalized_word text,
  p_activity_type text,
  p_user_answer text,
  p_is_correct boolean,
  p_error_layer text,
  p_skill_ids text[],
  p_skill_evidence jsonb,
  p_first_attempt boolean,
  p_hint_used boolean,
  p_answer_revealed boolean,
  p_active_ms integer,
  p_grading_ms integer,
  p_next_state jsonb,
  p_new_words_count integer,
  p_review_words_count integer,
  p_completion_date date,
  p_cadence_candidates jsonb default '{}'::jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_session study_sessions%rowtype;
  v_word_id uuid;
  v_attempt_id uuid;
  v_cadence user_lesson_cadence%rowtype;
  v_inserted integer;
  v_outcome text;
  v_completion_outcome text;
  v_result jsonb;
  v_task jsonb;
  v_credit integer;
  v_cursor smallint;
  v_evidence jsonb;
begin
  if p_scope not in ('lesson','consolidation') then raise exception 'PLANNED_SUBMISSION_SCOPE_INVALID'; end if;
  if p_active_ms is not null and p_active_ms not between 0 and 86400000 then raise exception 'ACTIVE_MS_INVALID'; end if;
  if p_grading_ms is not null and p_grading_ms not between 0 and 86400000 then raise exception 'GRADING_MS_INVALID'; end if;
  if jsonb_typeof(p_skill_evidence) <> 'array' then raise exception 'SKILL_EVIDENCE_INVALID'; end if;

  select result into v_result from exercise_submission_events
   where user_id = p_user_id and submission_id = p_submission_id;
  if found then return v_result || jsonb_build_object('duplicate', true); end if;

  select * into v_session from study_sessions
   where id = p_session_id and user_id = p_user_id and ended_at is null for update;
  if not found then raise exception 'STALE_STUDY_STATE'; end if;
  if v_session.updated_at is distinct from p_expected_revision then raise exception 'STALE_STUDY_STATE'; end if;
  if v_session.state #>> '{payload,plan,plan_id}' is null then
    if coalesce(v_session.state #>> '{payload,activity_type}',v_session.state #>> '{payload,exercise,activity_type}')
      is distinct from p_activity_type then raise exception 'PLANNED_EXERCISE_MISMATCH'; end if;
    if (p_scope='lesson' and v_session.state->>'phase' <> 'lesson_exercise')
      or (p_scope='consolidation' and (v_session.state #>> '{payload,consolidation}') <> 'true')
    then raise exception 'PLANNED_EXERCISE_MISMATCH'; end if;
  elsif v_session.state #>> '{payload,plan,plan_id}' is distinct from p_plan_id::text
    or v_session.state #>> '{payload,plan,exercise_id}' is distinct from p_exercise_id::text
    or v_session.state #>> '{payload,plan,planned_activity_type}' is distinct from p_activity_type
    or (v_session.state #>> '{payload,plan,scope}') is distinct from p_scope
  then raise exception 'PLANNED_EXERCISE_MISMATCH'; end if;
  if p_next_state #>> '{payload,plan,plan_id}' is distinct from p_plan_id::text
    or p_next_state #>> '{payload,plan,exercise_id}' is distinct from p_exercise_id::text
  then raise exception 'PLANNED_EXERCISE_MISMATCH'; end if;
  if p_new_words_count < 0 or p_review_words_count < 0 then raise exception 'SESSION_COUNT_INVALID'; end if;

  select id into v_word_id from words where normalized_word = lower(btrim(p_normalized_word));
  if v_word_id is null then raise exception 'Word is not in the vocabulary'; end if;
  if lower(btrim(coalesce(v_session.state->>'current_word',v_session.state #>> '{payload,word}','')))
    is distinct from lower(btrim(p_normalized_word)) then raise exception 'PLANNED_WORD_MISMATCH'; end if;
  if v_session.state #>> '{payload,plan,word_id}' is not null
    and v_session.state #>> '{payload,plan,word_id}' is distinct from v_word_id::text
  then raise exception 'PLANNED_WORD_MISMATCH'; end if;

  if p_scope = 'lesson' then
    if v_session.state->>'phase' <> 'lesson_exercise' then raise exception 'STALE_STUDY_STATE'; end if;
    perform public.record_attempt_v2(p_user_id, lower(btrim(p_normalized_word)), p_session_id,
      p_activity_type, p_user_answer, p_is_correct, p_error_layer);
    select id into v_attempt_id from attempts
      where user_id=p_user_id and session_id=p_session_id and word_id=v_word_id
        and activity_type=p_activity_type and user_answer=coalesce(p_user_answer,'')
        and is_correct=p_is_correct and submission_id is null
      order by created_at desc, id desc limit 1 for update;
  else
    if v_session.state->>'phase' <> 'lesson_complete'
      or v_session.state #>> '{payload,consolidation}' <> 'true'
      or v_session.state #>> '{payload,consolidation_status}' <> 'exercise'
    then raise exception 'STALE_STUDY_STATE'; end if;
    insert into attempts(user_id,word_id,session_id,activity_type,user_answer,is_correct,error_layer,scope)
    values(p_user_id,v_word_id,p_session_id,p_activity_type,coalesce(p_user_answer,''),p_is_correct,p_error_layer,'consolidation')
    returning id into v_attempt_id;
  end if;
  if v_attempt_id is null then raise exception 'PLANNED_ATTEMPT_MISSING'; end if;
  update attempts set scope=p_scope, exercise_id=p_exercise_id, plan_id=p_plan_id,
    submission_id=p_submission_id, skill_ids=coalesce(p_skill_ids,'{}'),
    skill_evidence=p_skill_evidence, first_attempt=p_first_attempt, hint_used=coalesce(p_hint_used,false),
    answer_revealed=coalesce(p_answer_revealed,false), active_ms=p_active_ms, grading_ms=p_grading_ms
  where id=v_attempt_id;

  v_outcome := case when p_answer_revealed then 'revealed' when p_is_correct then 'correct' else 'incorrect' end;
  v_evidence := coalesce(p_skill_evidence,'[]'::jsonb);
  insert into exercise_submission_events(user_id,submission_id,session_id,plan_id,exercise_id,scope,word_id,
    activity_type,error_focus,skill_ids,skill_evidence,outcome,coverage_exception_reason,result)
  values(p_user_id,p_submission_id,p_session_id,p_plan_id,p_exercise_id,p_scope,v_word_id,p_activity_type,
    v_session.state #>> '{payload,plan,error_focus}',coalesce(p_skill_ids,'{}'),v_evidence,v_outcome,
    v_session.state #>> '{payload,plan,coverage_exception_reason}','{}'::jsonb);

  if jsonb_array_length(v_evidence) > 0 then
    insert into exercise_skill_evidence(user_id,submission_id,exercise_id,plan_id,scope,word_id,skill_id,
      outcome,first_unprompted,hint_used,modified_correct,answer_revealed,evidence)
    select p_user_id,p_submission_id,p_exercise_id,p_plan_id,p_scope,
      nullif(item->>'word_id','')::uuid,
      item->>'skill_id',item->>'outcome',coalesce((item->>'first_unprompted')::boolean,false),
      coalesce((item->>'hint_used')::boolean,false),coalesce((item->>'modified_correct')::boolean,false),
      coalesce((item->>'answer_revealed')::boolean,false),item->>'evidence'
    from jsonb_array_elements(v_evidence) item
    where item ? 'skill_id' and item ? 'outcome';
  end if;

  insert into user_lesson_cadence(user_id) values(p_user_id) on conflict(user_id) do nothing;
  select * into v_cadence from user_lesson_cadence where user_id=p_user_id for update;
  v_credit := v_cadence.completion_credit;
  v_cursor := v_cadence.rotation_cursor;
  v_task := v_cadence.pending_task;

  if p_scope='lesson' and (p_is_correct or p_answer_revealed) then
    v_completion_outcome := case when p_answer_revealed then 'revealed'
      when not p_first_attempt then 'modified_correct' else 'first_correct' end;
    insert into lesson_word_completion_credits(user_id,local_date,word_id,session_id,exercise_id,completion_outcome)
      values(p_user_id,p_completion_date,v_word_id,p_session_id,p_exercise_id,v_completion_outcome)
      on conflict do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted > 0 then
      if v_task is not null then
        v_credit := least(9,v_credit+1);
      else
        v_credit := v_credit+1;
        if v_credit >= 10 then
          v_task := p_cadence_candidates -> v_cursor::text;
          if v_task is null then raise exception 'CADENCE_PLAN_MISSING'; end if;
          v_credit := 0;
        end if;
      end if;
    end if;
  elsif p_scope='consolidation' and (p_is_correct or p_answer_revealed) then
    v_task := null;
    v_cursor := (v_cursor + 1) % 4;
  end if;

  update user_lesson_cadence set completion_credit=v_credit, rotation_cursor=v_cursor,
    pending_task=v_task, updated_at=now() where user_id=p_user_id;

  update study_sessions set state=p_next_state, updated_at=clock_timestamp(),
    new_words_count=p_new_words_count, review_words_count=p_review_words_count
  where id=p_session_id and user_id=p_user_id and ended_at is null and updated_at=p_expected_revision
  returning * into v_session;
  if not found then raise exception 'STALE_STUDY_STATE'; end if;

  v_result := jsonb_build_object('id',v_session.id,'user_id',v_session.user_id,
    'started_at',v_session.started_at,'ended_at',v_session.ended_at,'updated_at',v_session.updated_at,
    'state',v_session.state,'new_words_count',v_session.new_words_count,
    'review_words_count',v_session.review_words_count,'is_correct',p_is_correct,
    'answer_revealed',p_answer_revealed,'scope',p_scope,'cadence',jsonb_build_object(
      'completion_credit',v_credit,'rotation_cursor',v_cursor,'pending_task',v_task));
  update exercise_submission_events set result=v_result
    where user_id=p_user_id and submission_id=p_submission_id;
  return v_result;
end;
$$;

revoke all on function public.record_planned_submission_v1(uuid,uuid,timestamptz,uuid,uuid,uuid,text,text,text,text,boolean,text,text[],jsonb,boolean,boolean,boolean,integer,integer,jsonb,integer,integer,date,jsonb) from public,anon,authenticated;
grant execute on function public.record_planned_submission_v1(uuid,uuid,timestamptz,uuid,uuid,uuid,text,text,text,text,boolean,text,text[],jsonb,boolean,boolean,boolean,integer,integer,jsonb,integer,integer,date,jsonb) to service_role;
