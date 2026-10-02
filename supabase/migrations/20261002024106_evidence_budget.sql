-- Additive evidence and budget state; historical evidence is deliberately unversioned.
alter table public.exercise_skill_evidence add column quality text not null default 'IGNORE' check (quality in ('OBSERVE','LEARN_ONLY','IGNORE')),
 add column quality_reason text not null default 'legacy_unverified', add column evidence_version text;
create table public.user_skill_state (
 user_id uuid not null references public.users(id) on delete cascade, skill_id text not null,
 p_mastery double precision not null default 0.2 check(p_mastery between 0 and 1),
 evidence_count integer not null default 0, learning_count integer not null default 0,
 bkt_version text not null default 'fixed-v1', revision integer not null default 0,
 last_observed_at timestamptz, updated_at timestamptz not null default now(), primary key(user_id,skill_id,bkt_version));
create table public.skill_evidence_consumption (
 evidence_id bigint primary key references public.exercise_skill_evidence(id) on delete cascade,
 user_id uuid not null references public.users(id) on delete cascade, created_at timestamptz not null default now());
create table public.bkt_updates (
 user_id uuid not null references public.users(id) on delete cascade, exercise_id uuid not null, skill_id text not null,
 bkt_version text not null, quality text not null, correct boolean, prediction double precision not null,
 before_mastery double precision not null, after_mastery double precision not null,
 created_at timestamptz not null default now(), primary key(user_id,exercise_id,skill_id,bkt_version));
create index bkt_updates_recent_idx on public.bkt_updates(user_id,created_at desc);
create table public.learning_settings (
 user_id uuid primary key references public.users(id) on delete cascade,
 daily_minutes integer not null default 45 check(daily_minutes between 5 and 240),
 budget_enabled boolean not null default true, bkt_mode text not null default 'shadow' check(bkt_mode in ('off','shadow')));
create table public.learning_budget_days (
 user_id uuid not null references public.users(id) on delete cascade, local_date date not null,
 extra_seconds integer not null default 0, primary key(user_id,local_date));
create table public.learning_budget_events (
 user_id uuid not null references public.users(id) on delete cascade, task_key text not null,
 local_date date not null, estimated_seconds integer not null check(estimated_seconds between 0 and 300),
 activity_type text not null, created_at timestamptz not null default now(), primary key(user_id,task_key));
create index learning_budget_day_idx on public.learning_budget_events(user_id,local_date);
create table public.evidence_gold_labels (
 user_id uuid not null references public.users(id) on delete cascade,
 evidence_id bigint not null references public.exercise_skill_evidence(id) on delete cascade,
 outcome text not null check(outcome in ('correct','incorrect','partial','not_assessed')),
 error_label text not null default 'none' check(error_label in ('none','meaning','collocation','grammar','spelling','pronunciation')),
 reviewed_at timestamptz not null default now(), primary key(user_id,evidence_id));
-- All access stays behind the existing authenticated server boundary.
do $$ declare t text; begin
 foreach t in array array['user_skill_state','skill_evidence_consumption','bkt_updates','learning_settings','learning_budget_days','learning_budget_events','evidence_gold_labels'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant all on public.%I to service_role',t);
 end loop;
end $$;
create function public.normalize_evidence_insert_v1() returns trigger language plpgsql set search_path=public as $$
declare v jsonb; begin
 select item into v from public.exercise_submission_events e cross join lateral jsonb_array_elements(e.skill_evidence) item
 where e.user_id=new.user_id and e.submission_id=new.submission_id and item->>'skill_id'=new.skill_id
 and (item->>'word_id') is not distinct from new.word_id::text limit 1;
 if v->>'evidence_version'='evidence-v1' then
 new.evidence_version := 'evidence-v1'; new.quality := coalesce(v->>'quality','IGNORE');
 new.quality_reason := coalesce(v->>'quality_reason','missing_quality');
 end if;
 return new;
end $$;
create trigger evidence_quality_before_insert before insert on public.exercise_skill_evidence
 for each row execute function public.normalize_evidence_insert_v1();

create function public.pending_skill_evidence_v1(p_user_id uuid) returns setof public.exercise_skill_evidence
 language sql stable set search_path=public as $$
 select e.* from public.exercise_skill_evidence e where e.user_id=p_user_id and e.evidence_version='evidence-v1'
 and not exists(select 1 from public.skill_evidence_consumption c where c.evidence_id=e.id)
 order by e.id limit 16;
$$;
create function public.commit_bkt_update_v1(p_user_id uuid,p_evidence_id bigint,p_expected_revision integer,
 p_next double precision,p_prediction double precision,p_quality text,p_correct boolean) returns boolean
 language plpgsql set search_path=public as $$
declare e public.exercise_skill_evidence%rowtype; s public.user_skill_state%rowtype; begin
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,481));
 select * into e from public.exercise_skill_evidence where id=p_evidence_id and user_id=p_user_id;
 if not found then raise exception 'EVIDENCE_NOT_FOUND'; end if;
 if exists(select 1 from public.skill_evidence_consumption where evidence_id=e.id) then return true; end if;
 if exists(select 1 from public.exercise_skill_evidence older where older.user_id=p_user_id and older.skill_id=e.skill_id and older.evidence_version='evidence-v1' and older.id<e.id and not exists(select 1 from public.skill_evidence_consumption c where c.evidence_id=older.id)) then return false; end if;
 if p_next is null or p_prediction is null or not(p_prediction between 0 and 1) or p_quality is null or p_quality not in ('OBSERVE','LEARN_ONLY','IGNORE') or not(p_next between 0 and 1) then raise exception 'BKT_INVALID'; end if;
 if p_quality <> 'IGNORE' and p_quality is distinct from e.quality then raise exception 'BKT_QUALITY_MISMATCH'; end if;
 if exists(select 1 from public.exercise_skill_evidence peer where peer.user_id=p_user_id and peer.submission_id=e.submission_id and peer.skill_id=e.skill_id and peer.outcome<>e.outcome) then p_quality:='IGNORE'; end if;
 if p_quality='IGNORE' or exists(select 1 from public.bkt_updates where user_id=p_user_id and exercise_id=e.exercise_id and skill_id=e.skill_id and bkt_version='fixed-v1') then
 insert into public.skill_evidence_consumption(evidence_id,user_id) values(e.id,p_user_id) on conflict do nothing; return true;
 end if;
 insert into public.user_skill_state(user_id,skill_id) values(p_user_id,e.skill_id) on conflict do nothing;
 select * into s from public.user_skill_state where user_id=p_user_id and skill_id=e.skill_id and bkt_version='fixed-v1' for update;
 if s.revision<>p_expected_revision then return false; end if;
 insert into public.bkt_updates(user_id,exercise_id,skill_id,bkt_version,quality,correct,prediction,before_mastery,after_mastery)
 values(p_user_id,e.exercise_id,e.skill_id,'fixed-v1',p_quality,p_correct,p_prediction,s.p_mastery,p_next);
 update public.user_skill_state set p_mastery=p_next, revision=revision+1,
 evidence_count=evidence_count+case when p_quality='OBSERVE' then 1 else 0 end,learning_count=learning_count+1,
 last_observed_at=case when p_quality='OBSERVE' then e.created_at else last_observed_at end, updated_at=now()
 where user_id=p_user_id and skill_id=e.skill_id and bkt_version='fixed-v1';
 insert into public.skill_evidence_consumption(evidence_id,user_id) values(e.id,p_user_id);
 return true;
end $$;

create function public.learning_budget_snapshot_v1(p_user_id uuid) returns jsonb language plpgsql set search_path=public as $$
declare d date; tz text; minutes integer; extra integer; used integer; due integer; overdue integer; cap integer; forecasts jsonb; enabled boolean;
begin
 select coalesce(timezone,'Asia/Shanghai'),daily_new_word_limit into tz,cap from public.users where id=p_user_id;
 tz:=coalesce(tz,'Asia/Shanghai');d:=(now() at time zone tz)::date;
 select daily_minutes,budget_enabled into minutes,enabled from public.learning_settings where user_id=p_user_id;
 minutes:=coalesce(minutes,45); enabled:=coalesce(enabled,true);
 select coalesce(extra_seconds,0) into extra from public.learning_budget_days where user_id=p_user_id and local_date=d;
 select coalesce(sum(estimated_seconds),0) into used from public.learning_budget_events where user_id=p_user_id and local_date=d;
 select count(*) filter(where next_review_at<=now()),count(*) filter(where (next_review_at at time zone tz)::date<d) into due,overdue
 from public.user_words where user_id=p_user_id and next_review_at is not null;
 select jsonb_agg(jsonb_build_object('date',day,'review_seconds',seconds) order by day) into forecasts from (
 select d+i as day, count(uw.id)*8 as seconds from generate_series(0,6) i left join public.user_words uw
 on uw.user_id=p_user_id and (uw.next_review_at at time zone tz)::date=d+i group by i) x;
 return jsonb_build_object('date',d,'daily_minutes',minutes,'extra_seconds',coalesce(extra,0),'estimated_used_seconds',used,
 'remaining_seconds',greatest(0,minutes*60+coalesce(extra,0)-used),'due_count',due,'overdue_count',overdue,
 'new_word_cap',coalesce(cap,50),'forecast',forecasts,'cost_version','static-v1','enabled',enabled);
end $$;

create function public.reserve_learning_budget_v1(p_user_id uuid,p_task_key text,p_seconds integer,p_activity text) returns boolean
 language plpgsql set search_path=public as $$
declare b jsonb; begin
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,482));
 if exists(select 1 from public.learning_budget_events where user_id=p_user_id and task_key=p_task_key) then return true; end if;
 b:=public.learning_budget_snapshot_v1(p_user_id);
 if (b->>'enabled')::boolean and (b->>'remaining_seconds')::integer<p_seconds then return false; end if;
 insert into public.learning_budget_events(user_id,task_key,local_date,estimated_seconds,activity_type)
 values(p_user_id,p_task_key,(b->>'date')::date,p_seconds,p_activity);
 return true;
end $$;
create function public.set_learning_budget_v1(p_user_id uuid,p_minutes integer default null,p_add_key text default null) returns jsonb
 language plpgsql set search_path=public as $$
declare b jsonb; inserted integer; begin
 perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,482));
 if p_minutes is not null then
 insert into public.learning_settings(user_id,daily_minutes) values(p_user_id,p_minutes)
 on conflict(user_id) do update set daily_minutes=excluded.daily_minutes;
 end if;
 b:=public.learning_budget_snapshot_v1(p_user_id);
 if p_add_key is not null then
 -- Marker consumes no study time; unique id makes network retries idempotent.
 insert into public.learning_budget_days(user_id,local_date) values(p_user_id,(b->>'date')::date) on conflict do nothing;
 insert into public.learning_budget_events(user_id,task_key,local_date,estimated_seconds,activity_type)
 values(p_user_id,'extra:'||p_add_key,(b->>'date')::date,0,'budget_extra') on conflict do nothing;
 get diagnostics inserted=row_count;
 if inserted>0 then update public.learning_budget_days set extra_seconds=extra_seconds+900 where user_id=p_user_id and local_date=(b->>'date')::date; end if;
 end if;
 return public.learning_budget_snapshot_v1(p_user_id);
end $$;
do $$ declare r record; begin
 for r in select oid::regprocedure as f from pg_proc where pronamespace='public'::regnamespace and proname in ('normalize_evidence_insert_v1','pending_skill_evidence_v1','commit_bkt_update_v1','learning_budget_snapshot_v1','reserve_learning_budget_v1','set_learning_budget_v1') loop
 execute format('revoke all on function %s from public,anon,authenticated',r.f);
 execute format('grant execute on function %s to service_role',r.f);
 end loop;
end $$;

create or replace function public.prepare_daily_new_words_budget_v1(p_user_id uuid,p_date date,p_budget_limit integer default 200)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_import_id uuid;
  v_limit integer;
  v_today_assigned integer;
  v_pool_count integer;
  v_remaining integer;
  v_start integer;
  v_added integer := 0;
  v_budget jsonb;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text,482));
  insert into users(id) values(p_user_id) on conflict(id) do nothing;

  select daily_new_word_limit into v_limit
  from users where id=p_user_id;

  insert into daily_imports(user_id,import_date,source,raw_count)
  values(p_user_id,p_date,'wordloop_pool',0)
  on conflict(user_id,import_date,source) do update set source=excluded.source
  returning id into v_import_id;

  select count(distinct diw.word_id) into v_today_assigned
  from daily_imports di
  join daily_import_words diw on diw.import_id=di.id
  where di.user_id=p_user_id and di.import_date=p_date;

  select coalesce(max(position)+1,0), count(*) into v_start,v_pool_count
  from daily_import_words where import_id=v_import_id;

  v_budget := public.learning_budget_snapshot_v1(p_user_id);
  if (v_budget->>'enabled')::boolean then
    v_limit := least(v_limit,greatest(0,p_budget_limit));
    if (v_budget->>'overdue_count')::integer>0 then v_limit:=0;
    else v_limit:=least(v_limit, floor(greatest(0,(v_budget->>'remaining_seconds')::integer-(v_budget->>'due_count')::integer*8)/77.0)::integer); end if;
  end if;
  v_remaining := greatest(v_limit-v_today_assigned,0);

  if v_remaining > 0 then
    insert into daily_import_words(import_id,word_id,position)
    select v_import_id, candidates.word_id,
      v_start + (row_number() over(order by candidates.first_seen_at,candidates.id)-1)::integer
    from (
      select uw.id,uw.word_id,uw.first_seen_at
      from user_words uw
      where uw.user_id=p_user_id
        and uw.status='new'
        and uw.mastered=false
        and not exists (
          select 1
          from attempts a
          where a.user_id=uw.user_id
            and a.word_id=uw.word_id
            and a.activity_type in (
              'exact_cloze', 'cloze', 'translation_cn_to_en', 'translation_en_to_cn',
              'collocation', 'derivation', 'recall', 'sentence', 'spelling',
              'word_recall', 'semantic_expression'
            )
        )
        and not exists (
          select 1
          from daily_imports di
          join daily_import_words diw on diw.import_id=di.id
          where di.user_id=p_user_id
            and di.import_date=p_date
            and diw.word_id=uw.word_id
        )
      order by uw.first_seen_at,uw.id
      limit v_remaining
    ) candidates
    on conflict do nothing;
    get diagnostics v_added = row_count;
  end if;

  select count(distinct diw.word_id) into v_today_assigned
  from daily_imports di
  join daily_import_words diw on diw.import_id=di.id
  where di.user_id=p_user_id and di.import_date=p_date;

  select count(*) into v_pool_count
  from daily_import_words where import_id=v_import_id;
  update daily_imports set raw_count=v_pool_count where id=v_import_id;

  return jsonb_build_object(
    'date',p_date,
    'prepared',v_today_assigned,
    'added',v_added,
    'limit',v_limit
  );
end;
$$;


create or replace function public.prepare_daily_new_words_v1(p_user_id uuid,p_date date) returns jsonb language sql set search_path=public as $$
 select public.prepare_daily_new_words_budget_v1(p_user_id,p_date,200);
$$;
revoke all on function public.prepare_daily_new_words_budget_v1(uuid,date,integer) from public,anon,authenticated;
grant execute on function public.prepare_daily_new_words_budget_v1(uuid,date,integer) to service_role;

create function public.get_due_review_states_v1(p_user_id uuid,p_now timestamptz,p_offset integer default 0)
 returns table(state jsonb,word jsonb) language sql stable set search_path=public as $$
 select to_jsonb(uw),to_jsonb(w) from public.user_words uw join public.words w on w.id=uw.word_id
 where uw.user_id=p_user_id and uw.next_review_at<=p_now order by uw.id offset greatest(0,p_offset) limit 1000;
$$;
revoke all on function public.get_due_review_states_v1(uuid,timestamptz,integer) from public,anon,authenticated;
grant execute on function public.get_due_review_states_v1(uuid,timestamptz,integer) to service_role;

create index evidence_gold_evidence_idx on public.evidence_gold_labels(evidence_id);
create index skill_consumption_user_idx on public.skill_evidence_consumption(user_id);
create index evidence_pending_idx on public.exercise_skill_evidence(user_id,id) where evidence_version='evidence-v1';
create table public.tutor_shadow_decisions (
 user_id uuid not null references public.users(id) on delete cascade, plan_id uuid not null,
 actual_activity text not null,suggested_activity text not null,reason text not null,signals jsonb not null,
 created_at timestamptz not null default now(),primary key(user_id,plan_id));
alter table public.tutor_shadow_decisions enable row level security;
revoke all on public.tutor_shadow_decisions from public,anon,authenticated;
grant all on public.tutor_shadow_decisions to service_role;

-- Formal review evidence is created in the same transaction as its attempt and FSRS write.
create function public.record_formal_review_evidence_v1() returns trigger language plpgsql set search_path=public as $$
declare st jsonb; item jsonb; labels jsonb; skill text; outcome text; q text;
begin
 if new.activity_type<>'review' then return new; end if;
 select state into st from public.study_sessions where id=new.session_id and user_id=new.user_id and ended_at is null;
 item:=st #> array['payload','items',coalesce(st->>'current_index','0')];
 if st->>'widget'<>'review' or item is null then return new; end if;
 if not exists(select 1 from public.words where id=new.word_id and normalized_word=lower(item->>'word')) then return new; end if;
 skill:=case when item->>'direction'='en_definition' then 'target_sense_comprehension' else 'target_sense_retrieval' end;
 outcome:=case when new.error_layer in ('grammar','collocation','pronunciation') then 'not_assessed'
   when new.error_layer='spelling' then 'not_assessed' when new.is_correct then 'correct' else 'incorrect' end;
 q:=case when outcome='not_assessed' then 'IGNORE' else 'OBSERVE' end;
 labels:=jsonb_build_array(jsonb_build_object('skill_id',skill,'word_id',new.word_id,'outcome',outcome,'quality',q,
 'quality_reason','formal_retrieval','evidence_version','evidence-v1','first_unprompted',true,'hint_used',false,'modified_correct',false,'answer_revealed',false));
 if coalesce(item->>'direction','cn_to_en')='cn_to_en' then
 labels:=labels||jsonb_build_array(jsonb_build_object('skill_id','target_word_spelling','word_id',new.word_id,
 'outcome',case when new.error_layer='spelling' then 'incorrect' when new.is_correct then 'correct' else 'not_assessed' end,
 'quality',case when new.error_layer='spelling' or new.is_correct then 'OBSERVE' else 'IGNORE' end,
 'quality_reason','formal_spelling','evidence_version','evidence-v1','first_unprompted',true,'hint_used',false,'modified_correct',false,'answer_revealed',false));
 end if;
 insert into public.exercise_submission_events(user_id,submission_id,session_id,plan_id,exercise_id,scope,word_id,activity_type,skill_ids,skill_evidence,outcome,result)
 values(new.user_id,new.id,new.session_id,new.id,new.id,'review',new.word_id,'word_recall',
 array(select x->>'skill_id' from jsonb_array_elements(labels) x),labels,case when new.is_correct then 'correct' else 'incorrect' end,
 jsonb_build_object('state',jsonb_build_object('payload',jsonb_build_object('prompt',coalesce(item->>'prompt',item->>'meaning_zh',item->>'word')))));
 insert into public.exercise_skill_evidence(user_id,submission_id,exercise_id,plan_id,scope,word_id,skill_id,outcome,first_unprompted,hint_used,modified_correct,answer_revealed)
 select new.user_id,new.id,new.id,new.id,'review',new.word_id,x->>'skill_id',x->>'outcome',true,false,false,false from jsonb_array_elements(labels) x;
 update public.attempts set submission_id=new.id,exercise_id=new.id,plan_id=new.id,scope='review',skill_evidence=labels,
 skill_ids=array(select x->>'skill_id' from jsonb_array_elements(labels) x),first_attempt=true where id=new.id;
 return new;
end $$;
create trigger formal_review_evidence_after_insert after insert on public.attempts for each row execute function public.record_formal_review_evidence_v1();
revoke all on function public.record_formal_review_evidence_v1() from public,anon,authenticated;
grant execute on function public.record_formal_review_evidence_v1() to service_role;
