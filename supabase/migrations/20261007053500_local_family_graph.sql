-- Lexical knowledge only. The canonical learning card remains user_words.
-- Qualify the shared initializer's columns. Its TABLE output word_id otherwise
-- conflicts with ON CONFLICT / WHERE column references in fresh PostgreSQL.
create or replace function public.ensure_user_word_v1(
  p_user_id uuid,p_normalized_word text,p_display_word text,p_source text,p_touch_existing boolean
) returns table(word_id uuid,user_word_id uuid,inserted boolean)
language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_word_id uuid; v_user_word_id uuid; v_inserted integer;
begin
  insert into public.words(normalized_word,display_word) values(p_normalized_word,p_display_word)
    on conflict(normalized_word) do update set normalized_word=excluded.normalized_word returning id into v_word_id;
  insert into public.user_words(user_id,word_id,source) values(p_user_id,v_word_id,p_source)
    on conflict on constraint user_words_user_id_word_id_key do nothing;
  get diagnostics v_inserted=row_count;
  if v_inserted=0 and p_touch_existing then
    update public.user_words uw set last_seen_at=now() where uw.user_id=p_user_id and uw.word_id=v_word_id;
  end if;
  select uw.id into v_user_word_id from public.user_words uw where uw.user_id=p_user_id and uw.word_id=v_word_id;
  return query select v_word_id,v_user_word_id,v_inserted=1;
end $$;
create table public.lexical_lexemes (
  lexeme_id text primary key,
  lemma text not null,
  language text not null default 'en' check(language = 'en'),
  part_of_speech text not null check(part_of_speech in ('n','v','a','r')),
  frequency_band integer check(frequency_band between 1 and 6),
  utility_score double precision not null check(utility_score between 0 and 1),
  exam_relevance double precision not null default 0.5 check(exam_relevance between 0 and 1),
  family_key text not null,
  check(lemma = lower(btrim(lemma)) and lemma ~ '^[a-z]+([-''][a-z]+)*$'),
  check(lexeme_id = language || ':' || lemma || ':' || part_of_speech),
  unique(language,lemma,part_of_speech)
);
create index lexical_lexemes_family_idx on public.lexical_lexemes(family_key);
create table public.lexical_senses (
  sense_id text primary key, lexeme_id text not null references public.lexical_lexemes on delete cascade,
  definition text not null check(length(definition) <= 1000), synset_id text, register text,
  source text not null, source_version text not null, license text not null, provenance jsonb not null
);
create index lexical_senses_lexeme_idx on public.lexical_senses(lexeme_id);
create table public.lexical_forms (
  form_id text primary key, lexeme_id text not null references public.lexical_lexemes on delete cascade,
  surface_form text not null, form_type text not null check(form_type in ('lemma','inflection')),
  pronunciation text, source text not null, source_version text not null, license text not null, provenance jsonb not null,
  unique(lexeme_id,surface_form,form_type)
);
create index lexical_forms_lexeme_idx on public.lexical_forms(lexeme_id);
create table public.lexical_morphemes (
  morpheme_id text primary key, surface text not null,
  type text not null check(type in ('prefix','root','suffix')), meaning text not null
);
create table public.lexical_relations (
  relation_id text primary key,
  source_id text not null references public.lexical_lexemes on delete cascade,
  target_id text not null references public.lexical_lexemes on delete cascade,
  relation_type text not null check(relation_type in ('DERIVATION','INFLECTION','SYNONYM','ANTONYM','CONTRAST','COLLOCATION','CONFUSABLE','HYPERNYM','HYPONYM')),
  direction text not null check(direction in ('forward','undirected')),
  source text not null check(length(btrim(source)) > 0),
  source_version text not null check(length(btrim(source_version)) > 0),
  license text not null check(length(btrim(license)) > 0),
  provenance jsonb not null check(jsonb_typeof(provenance) = 'object' and provenance <> '{}'),
  confidence double precision not null check(confidence between 0 and 1),
  transparency double precision not null check(transparency between 0 and 1),
  interference_risk double precision not null check(interference_risk between 0 and 1),
  morphology text, morpheme_id text references public.lexical_morphemes,
  check(source_id <> target_id), unique(source_id,target_id,relation_type,source,source_version)
);
create index lexical_relations_source_type_idx on public.lexical_relations(source_id,relation_type,confidence);
create index lexical_relations_target_type_idx on public.lexical_relations(target_id,relation_type,confidence);
-- Preference / introduction history, not cards or a review scheduler.
create table public.family_candidates (
  user_id uuid not null references public.users on delete cascade,
  lexeme_id text not null references public.lexical_lexemes,
  created_at timestamptz not null default now(), primary key(user_id,lexeme_id)
);
create table public.family_exposures (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users on delete cascade,
  base_id text not null references public.lexical_lexemes, target_id text references public.lexical_lexemes,
  family_key text not null, introduced_at timestamptz not null default now()
);
create index family_exposures_user_family_idx on public.family_exposures(user_id,family_key,introduced_at desc);
-- A short Deep Loop transcript linked to the existing study session. No mastery / due fields.
create table public.family_micro_sessions (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references public.users on delete cascade,
  study_session_id uuid not null references public.study_sessions on delete cascade,
  request_id uuid not null, lesson jsonb not null, index integer not null default 0,
  feedback jsonb, responses jsonb not null default '[]', completed boolean not null default false,
  activated boolean not null default false, created_at timestamptz not null default now(),
  unique(user_id,request_id), check(index between 0 and 8), check(jsonb_array_length(lesson->'steps') between 1 and 8)
);
create index family_micro_sessions_user_study_idx on public.family_micro_sessions(user_id,study_session_id,created_at desc);

-- All access uses verified WordLoop web identity through service-role server code.
do $$ declare t text; begin
  foreach t in array array['lexical_lexemes','lexical_senses','lexical_forms','lexical_morphemes','lexical_relations','family_candidates','family_exposures','family_micro_sessions'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public, anon, authenticated',t);
    execute format('grant select,insert,update,delete on public.%I to service_role',t);
  end loop;
end $$;

create function public.get_family_graph_v1(p_user_id uuid,p_lexeme text,p_limit integer default 24)
returns jsonb language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare v_center lexical_lexemes%rowtype; v_ids text[]; v_edges jsonb; v_nodes jsonb; v_total integer;
begin
  if p_limit < 1 or p_limit > 24 then raise exception 'FAMILY_LIMIT_INVALID'; end if;
  select * into v_center from lexical_lexemes
    where lexeme_id=p_lexeme or lemma=lower(btrim(p_lexeme))
    order by (lexeme_id=p_lexeme) desc, case part_of_speech when 'v' then 0 when 'n' then 1 else 2 end,lexeme_id limit 1;
  if v_center.lexeme_id is null then return null; end if;
  select count(distinct neighbour) into v_total from (
    select case when source_id=v_center.lexeme_id then target_id else source_id end neighbour
    from lexical_relations where relation_type='DERIVATION' and confidence>=0.85
      and (source_id=v_center.lexeme_id or target_id=v_center.lexeme_id)
  ) a;
  select array_prepend(v_center.lexeme_id,coalesce(array_agg(lexeme_id),'{}')) into v_ids from (
    select l.lexeme_id from lexical_lexemes l join (
      select target_id as neighbour from lexical_relations where source_id=v_center.lexeme_id and relation_type='DERIVATION' and confidence>=0.85
      union
      select source_id as neighbour from lexical_relations where target_id=v_center.lexeme_id and relation_type='DERIVATION' and confidence>=0.85
    ) adjacent on adjacent.neighbour=l.lexeme_id
    where l.lexeme_id<>v_center.lexeme_id order by l.utility_score desc,l.lexeme_id limit p_limit-1
  ) n;
  select coalesce(jsonb_agg(to_jsonb(r) order by relation_id),'[]') into v_edges from lexical_relations r
    where relation_type='DERIVATION' and confidence>=0.85 and source_id=any(v_ids) and target_id=any(v_ids)
    and (source_id=v_center.lexeme_id or target_id=v_center.lexeme_id);
  select jsonb_agg(to_jsonb(l) || jsonb_build_object(
    'senses',(select coalesce(jsonb_agg(to_jsonb(s)),'[]') from (select * from lexical_senses where lexeme_id=l.lexeme_id order by sense_id limit 8) s),
    'forms',(select coalesce(jsonb_agg(to_jsonb(f)),'[]') from (select * from lexical_forms where lexeme_id=l.lexeme_id order by form_id limit 4) f),
    'user_state',case when uw.id is null then null else jsonb_build_object(
      'status',uw.status,'stability',uw.fsrs_stability,'reps',uw.fsrs_reps,'consecutive_correct',uw.consecutive_correct,
      'next_review_at',uw.next_review_at,
      'error_layers',to_jsonb(array_remove(array[
        case when uw.meaning_error then 'meaning' end, case when uw.spelling_error then 'spelling' end,
        case when uw.pronunciation_error then 'pronunciation' end,case when uw.collocation_error then 'collocation' end,
        case when uw.grammar_error then 'grammar' end],null)),
      'layers',(select jsonb_object_agg(layer,jsonb_build_object('needs_practice',
        case layer when 'meaning' then uw.meaning_error when 'spelling' then uw.spelling_error
          when 'pronunciation' then uw.pronunciation_error when 'collocation' then uw.collocation_error else uw.grammar_error end,
        'correct_streak',p.consecutive_correct)) from unnest(array['meaning','spelling','pronunciation','collocation','grammar']) layer
        left join user_word_error_progress p on p.user_word_id=uw.id and p.error_layer=layer)
    ) end) order by l.lexeme_id) into v_nodes
  from lexical_lexemes l left join words w on w.normalized_word=l.lemma
    left join user_words uw on uw.word_id=w.id and uw.user_id=p_user_id
  where l.lexeme_id=any(v_ids);
  return jsonb_build_object('center_id',v_center.lexeme_id,'nodes',v_nodes,'edges',v_edges,'truncated',v_total>p_limit-1,
    'has_developing_member',exists(select 1 from lexical_lexemes l join words w on w.normalized_word=l.lemma
      join user_words uw on uw.word_id=w.id where uw.user_id=p_user_id and l.family_key=v_center.family_key and l.lexeme_id<>v_center.lexeme_id
      and not(uw.fsrs_reps>=2 and uw.fsrs_stability>=3 and uw.consecutive_correct>=2 and not uw.meaning_error and not uw.spelling_error and uw.status<>'new')),
    'exposures',(select coalesce(jsonb_agg(to_jsonb(e)),'[]') from (
      select base_id,target_id,family_key,introduced_at from family_exposures where user_id=p_user_id and family_key=v_center.family_key order by introduced_at desc limit 100) e));
end $$;

create function public.start_family_micro_v1(p_user_id uuid,p_request_id uuid,p_lesson jsonb)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_active study_sessions%rowtype; v_row family_micro_sessions%rowtype; v_base lexical_lexemes%rowtype;
  v_target lexical_lexemes%rowtype; v_stage text:=p_lesson->>'stage';
begin
  -- Serializes same-user introductions even through different graph centers.
  perform 1 from users where id=p_user_id for update;
  select * into v_row from family_micro_sessions where user_id=p_user_id and request_id=p_request_id;
  if v_row.id is not null then return to_jsonb(v_row); end if;
  select * into v_active from study_sessions where user_id=p_user_id and ended_at is null order by started_at desc limit 1 for update;
  if v_active.id is null then raise exception 'FAMILY_STUDY_REQUIRED'; end if;
  select * into v_base from lexical_lexemes where lexeme_id=p_lesson->>'base_id';
  if not exists(select 1 from user_words uw join words w on w.id=uw.word_id where uw.user_id=p_user_id and w.normalized_word=v_base.lemma) then raise exception 'FAMILY_STUDY_REQUIRED'; end if;
  select * into v_row from family_micro_sessions where user_id=p_user_id and study_session_id=v_active.id and not completed order by created_at desc limit 1;
  if v_row.id is not null then
    if v_row.lesson->>'base_id' = v_base.lexeme_id then return to_jsonb(v_row); end if;
    raise exception 'FAMILY_SESSION_PENDING';
  end if;
  if v_stage <> 'A' then
    if not exists(select 1 from user_words uw join words w on w.id=uw.word_id where uw.user_id=p_user_id
      and w.normalized_word=v_base.lemma and uw.fsrs_reps>=2 and uw.fsrs_stability>=3
      and uw.consecutive_correct>=2 and not uw.meaning_error and not uw.spelling_error and uw.status<>'new') then raise exception 'FAMILY_BASE_UNSTABLE'; end if;
    if exists(select 1 from family_exposures where user_id=p_user_id and family_key=v_base.family_key and introduced_at>now()-interval '3 days') then raise exception 'FAMILY_SPACING_REQUIRED'; end if;
  end if;
  if v_stage in ('B','C') then
    select * into v_target from lexical_lexemes where lexeme_id=p_lesson->>'target_id';
    if v_target.lexeme_id is null or not exists(select 1 from lexical_relations where relation_type='DERIVATION' and confidence>=0.85
      and ((source_id=v_base.lexeme_id and target_id=v_target.lexeme_id) or (target_id=v_base.lexeme_id and source_id=v_target.lexeme_id))) then raise exception 'FAMILY_RELATION_UNVERIFIED'; end if;
    if exists(select 1 from lexical_lexemes l join words w on w.normalized_word=l.lemma join user_words uw on uw.word_id=w.id
      where uw.user_id=p_user_id and l.family_key=v_base.family_key and l.lexeme_id<>v_base.lexeme_id
      and not(uw.fsrs_reps>=2 and uw.fsrs_stability>=3 and uw.consecutive_correct>=2 and not uw.meaning_error and not uw.spelling_error and uw.status<>'new')) then raise exception 'FAMILY_SPACING_REQUIRED'; end if;
    if exists(select 1 from words w join user_words uw on uw.word_id=w.id where uw.user_id=p_user_id and w.normalized_word=v_target.lemma) then raise exception 'FAMILY_ALREADY_LEARNED'; end if;
  elsif v_stage='D' then
    if (select count(*) from lexical_lexemes l join words w on w.normalized_word=l.lemma join user_words uw on uw.word_id=w.id
      where uw.user_id=p_user_id and l.family_key=v_base.family_key and l.lexeme_id<>v_base.lexeme_id
      and uw.fsrs_reps>=2 and uw.fsrs_stability>=3 and uw.consecutive_correct>=2 and not uw.meaning_error and not uw.spelling_error and uw.status<>'new') < 2 then raise exception 'FAMILY_CONTRAST_NOT_READY'; end if;
  elsif v_stage<>'A' then
    raise exception 'FAMILY_STAGE_INVALID';
  end if;
  -- Use the existing daily learning budget; one reservation covers the whole micro-session.
  if not reserve_learning_budget_v1(p_user_id,'family:'||p_request_id::text,120,'derivation') then raise exception 'FAMILY_BUDGET_REACHED'; end if;
  insert into family_micro_sessions(user_id,study_session_id,request_id,lesson)
    values(p_user_id,v_active.id,p_request_id,p_lesson) returning * into v_row;
  if v_stage<>'A' then
    insert into family_exposures(user_id,base_id,target_id,family_key) values(p_user_id,v_base.lexeme_id,v_target.lexeme_id,v_base.family_key);
  end if;
  if v_stage in ('B','C') then
    -- Save only a bounded local set for spaced future introduction. This is
    -- preference/history storage; it never creates another vocabulary card.
    insert into family_candidates(user_id,lexeme_id)
      select p_user_id,l.lexeme_id from lexical_lexemes l
      where l.lexeme_id<>v_target.lexeme_id and exists(select 1 from lexical_relations r
        where r.source_id=v_base.lexeme_id and r.target_id=l.lexeme_id and r.relation_type='DERIVATION' and r.confidence>=0.85)
      and not exists(select 1 from words w join user_words uw on uw.word_id=w.id where uw.user_id=p_user_id and w.normalized_word=l.lemma)
      order by l.utility_score desc,l.lexeme_id limit 23 on conflict do nothing;
  end if;
  return to_jsonb(v_row);
end $$;

create function public.submit_family_step_v1(p_user_id uuid,p_session_id uuid,p_index integer,p_answer text,p_card jsonb default null,p_log jsonb default null)
returns jsonb language plpgsql security invoker set search_path=public,pg_temp as $$
declare v_row family_micro_sessions%rowtype; v_step jsonb; v_ok boolean; v_word text; v_ensured record;
  v_word_id uuid; v_existing_attempts uuid[]; v_target lexical_lexemes%rowtype; v_new boolean:=false;
begin
  perform 1 from users where id=p_user_id for update;
  select * into v_row from family_micro_sessions where id=p_session_id and user_id=p_user_id for update;
  if v_row.id is null then raise exception 'FAMILY_SESSION_NOT_FOUND'; end if;
  if v_row.completed then return to_jsonb(v_row); end if;
  if p_index<v_row.index then return to_jsonb(v_row); end if; -- Retry after lost response.
  if p_index<>v_row.index then raise exception 'FAMILY_STEP_STALE'; end if;
  if not exists(select 1 from study_sessions where id=v_row.study_session_id and user_id=p_user_id and ended_at is null) then raise exception 'FAMILY_STUDY_REQUIRED'; end if;
  v_step:=(v_row.lesson->'steps')->p_index;
  v_ok:=lower(btrim(p_answer))=lower(btrim(v_step->>'answer'));
  select lemma into v_word from lexical_lexemes where lexeme_id=v_step->>'target_id';
  -- Only existing cards receive ordinary practice evidence. An unactivated
  -- derivative's transcript stays here until explicit completion/activation.
  select w.id into v_word_id from words w join user_words uw on uw.word_id=w.id where uw.user_id=p_user_id and w.normalized_word=v_word;
  if v_word_id is not null then
    perform 1 from user_words where user_id=p_user_id and word_id=v_word_id for update;
    select coalesce(array_agg(id),'{}') into v_existing_attempts from attempts where user_id=p_user_id and word_id=v_word_id and session_id=v_row.study_session_id;
    perform record_attempt_v2(p_user_id,v_word,v_row.study_session_id,v_step->>'activity_type',p_answer,v_ok,
      case when v_ok then 'none' else v_step->>'error_layer' end);
    -- Attribute the inserted attempt to consolidation; never mark a Lesson cursor complete.
    update attempts set scope='consolidation' where user_id=p_user_id and word_id=v_word_id and session_id=v_row.study_session_id
      and not(id=any(v_existing_attempts));
  end if;
  update family_micro_sessions set index=index+1,
    feedback=jsonb_build_object('is_correct',v_ok,'answer',v_step->>'answer','explanation',v_step->>'explanation'),
    responses=responses||jsonb_build_array(jsonb_build_object('answer',p_answer,'is_correct',v_ok)),
    completed=index+1>=jsonb_array_length(lesson->'steps') where id=v_row.id returning * into v_row;
  if v_row.completed and v_row.lesson->>'stage' in ('B','C') then
    select * into v_target from lexical_lexemes where lexeme_id=v_row.lesson->>'target_id';
    -- One item, using canonical vocabulary initialization. Existing cards are preserved.
    select * into v_ensured from ensure_user_word_v1(p_user_id,v_target.lemma,v_target.lemma,'family_micro',false);
    v_new:=v_ensured.inserted;
    if v_new then
      if p_card is null or p_log is null then raise exception 'FAMILY_INITIALIZATION_REQUIRED'; end if;
      -- Existing Pretest scheduling contract computes its card in the server.
      -- The final step is unprompted derivative recall, never an invented review.
      perform record_pretest_result_v2(p_user_id,v_target.lemma,case when v_ok then 'known' else 'unknown' end,
        p_answer,'pretest_cn_to_en',(case when v_ok then 3 else 1 end)::smallint,p_card,p_log);
      update words set senses=case when coalesce(jsonb_array_length(senses),0)=0 then
        jsonb_build_array(jsonb_build_object('pos',v_target.part_of_speech,'definition_cn',
          v_row.lesson->>'target_meaning_zh')) else senses end
        where id=v_ensured.word_id;
      update family_micro_sessions set activated=true where id=v_row.id returning * into v_row;
      delete from family_candidates where user_id=p_user_id and lexeme_id=v_target.lexeme_id;
    end if;
  end if;
  return to_jsonb(v_row);
end $$;

revoke all on function public.get_family_graph_v1(uuid,text,integer),public.start_family_micro_v1(uuid,uuid,jsonb),public.submit_family_step_v1(uuid,uuid,integer,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.get_family_graph_v1(uuid,text,integer),public.start_family_micro_v1(uuid,uuid,jsonb),public.submit_family_step_v1(uuid,uuid,integer,text,jsonb,jsonb) to service_role;

create function public.family_graph_schema_v1() returns boolean language sql stable security invoker set search_path=public,pg_temp as $$
  select to_regprocedure('public.get_family_graph_v1(uuid,text,integer)') is not null
    and to_regprocedure('public.start_family_micro_v1(uuid,uuid,jsonb)') is not null
    and to_regprocedure('public.submit_family_step_v1(uuid,uuid,integer,text,jsonb,jsonb)') is not null
    and to_regclass('public.lexical_relations_source_type_idx') is not null
    and to_regclass('public.lexical_relations_target_type_idx') is not null
    and (select count(*)=8 and bool_and(relrowsecurity) from pg_class where oid in (
      'public.lexical_lexemes'::regclass,'public.lexical_senses'::regclass,'public.lexical_forms'::regclass,
      'public.lexical_morphemes'::regclass,'public.lexical_relations'::regclass,'public.family_candidates'::regclass,
      'public.family_exposures'::regclass,'public.family_micro_sessions'::regclass));
$$;
revoke all on function public.family_graph_schema_v1() from public,anon,authenticated;
grant execute on function public.family_graph_schema_v1() to service_role;
