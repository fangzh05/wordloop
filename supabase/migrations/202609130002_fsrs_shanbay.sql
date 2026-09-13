-- WordLoop FSRS v6 cards and one-time Shanbay vocabulary migration.
alter table public.users
  add column if not exists daily_new_word_limit integer not null default 50
  check (daily_new_word_limit between 10 and 100);

alter table public.words
  add column if not exists ipa_us text,
  add column if not exists ipa_uk text,
  add column if not exists senses jsonb not null default '[]'::jsonb,
  add column if not exists lexical_source text,
  add column if not exists lexical_updated_at timestamptz;

alter table public.user_words
  add column if not exists fsrs_stability double precision not null default 0,
  add column if not exists fsrs_difficulty double precision not null default 0,
  add column if not exists fsrs_elapsed_days integer not null default 0,
  add column if not exists fsrs_scheduled_days integer not null default 0,
  add column if not exists fsrs_learning_steps integer not null default 0,
  add column if not exists fsrs_reps integer not null default 0,
  add column if not exists fsrs_lapses integer not null default 0,
  add column if not exists fsrs_state smallint not null default 0
  check (fsrs_state between 0 and 3);

create table if not exists public.fsrs_review_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  word_id uuid not null references public.words(id) on delete cascade,
  session_id uuid references public.study_sessions(id) on delete set null,
  rating smallint not null check (rating between 1 and 4),
  state smallint not null check (state between 0 and 3),
  due timestamptz not null,
  stability double precision not null,
  difficulty double precision not null,
  elapsed_days integer not null,
  last_elapsed_days integer not null,
  scheduled_days integer not null,
  learning_steps integer not null,
  reviewed_at timestamptz not null,
  review_source text not null check (review_source in ('pretest', 'review', 'session_checkpoint')),
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.word_sources (
  user_id uuid not null references public.users(id) on delete cascade,
  word_id uuid not null references public.words(id) on delete cascade,
  source_type text not null,
  source_book_id text not null,
  source_book_name text,
  source_state text,
  source_position integer,
  imported_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, word_id, source_type, source_book_id)
);

create index if not exists user_words_fsrs_due_idx on public.user_words(user_id, next_review_at);
create index if not exists fsrs_review_logs_word_time_idx on public.fsrs_review_logs(user_id, word_id, reviewed_at desc);
create index if not exists word_sources_book_idx on public.word_sources(user_id, source_type, source_book_id);

alter table public.fsrs_review_logs enable row level security;
alter table public.word_sources enable row level security;

create or replace function public.record_attempt_v2(
  p_user_id uuid, p_normalized_word text, p_session_id uuid, p_activity_type text,
  p_user_answer text, p_is_correct boolean, p_error_layer text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user_word user_words%rowtype;
  v_layer text := null;
  v_layer_streak integer := 0;
  v_global_streak integer;
  v_correct_count integer;
  v_errors_clear boolean;
  v_mastered boolean;
  v_active_layers text[] := array[]::text[];
begin
  select uw.* into v_user_word from user_words uw join words w on w.id = uw.word_id
  where uw.user_id = p_user_id and w.normalized_word = p_normalized_word for update of uw;
  if v_user_word.id is null then raise exception 'Word is not in the user vocabulary'; end if;
  insert into attempts(user_id, word_id, session_id, activity_type, user_answer, is_correct, error_layer)
  values (p_user_id, v_user_word.word_id, p_session_id, p_activity_type, coalesce(p_user_answer, ''), p_is_correct, p_error_layer);

  if not p_is_correct then
    update user_words set wrong_count = wrong_count + 1, consecutive_correct = 0,
      status = 'review', mastered = false, last_seen_at = now() where id = v_user_word.id;
    if p_error_layer <> 'none' then
      perform wordloop_set_error_flag(v_user_word.id, p_error_layer, true);
      insert into user_word_error_progress(user_word_id, error_layer, consecutive_correct)
      values (v_user_word.id, p_error_layer, 0)
      on conflict (user_word_id, error_layer) do update set consecutive_correct = 0, updated_at = now();
    end if;
  else
    if v_user_word.meaning_error then v_active_layers := array_append(v_active_layers, 'meaning'); end if;
    if v_user_word.collocation_error then v_active_layers := array_append(v_active_layers, 'collocation'); end if;
    if v_user_word.grammar_error then v_active_layers := array_append(v_active_layers, 'grammar'); end if;
    if v_user_word.pronunciation_error then v_active_layers := array_append(v_active_layers, 'pronunciation'); end if;
    if v_user_word.spelling_error then v_active_layers := array_append(v_active_layers, 'spelling'); end if;
    if p_error_layer <> 'none' then v_layer := p_error_layer;
    elsif cardinality(v_active_layers) = 1 then v_layer := v_active_layers[1]; end if;
    update user_words set correct_count = correct_count + 1,
      consecutive_correct = consecutive_correct + 1, last_seen_at = now() where id = v_user_word.id;
    if v_layer is not null then
      insert into user_word_error_progress(user_word_id, error_layer, consecutive_correct)
      values (v_user_word.id, v_layer, 1)
      on conflict (user_word_id, error_layer) do update
      set consecutive_correct = user_word_error_progress.consecutive_correct + 1, updated_at = now()
      returning consecutive_correct into v_layer_streak;
      if v_layer_streak >= 2 then perform wordloop_set_error_flag(v_user_word.id, v_layer, false); end if;
    end if;
  end if;

  select correct_count, consecutive_correct,
    not (meaning_error or collocation_error or grammar_error or pronunciation_error or spelling_error)
  into v_correct_count, v_global_streak, v_errors_clear from user_words where id = v_user_word.id;
  v_mastered := v_correct_count >= 3 and v_global_streak >= 2 and v_errors_clear;
  update user_words set mastered = v_mastered,
    status = case when v_mastered then 'mastered' else status end where id = v_user_word.id;
  return jsonb_build_object('word', p_normalized_word, 'is_correct', p_is_correct,
    'correct_count', v_correct_count, 'consecutive_correct', v_global_streak,
    'error_layer_streak', case when v_layer is null then null else v_layer_streak end,
    'mastered', v_mastered);
end;
$$;

create or replace function public.record_review_result_v1(
  p_user_id uuid, p_normalized_word text, p_session_id uuid, p_rating smallint,
  p_source text, p_reason text, p_card jsonb, p_log jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_user_word user_words%rowtype;
begin
  select uw.* into v_user_word from user_words uw join words w on w.id = uw.word_id
  where uw.user_id = p_user_id and w.normalized_word = p_normalized_word for update of uw;
  if v_user_word.id is null then raise exception 'Word is not in the user vocabulary'; end if;
  if p_rating not between 1 and 4 then raise exception 'Invalid FSRS rating'; end if;
  if p_source not in ('pretest','review','session_checkpoint') then raise exception 'Invalid review source'; end if;
  update user_words set
    fsrs_stability = (p_card->>'fsrs_stability')::double precision,
    fsrs_difficulty = (p_card->>'fsrs_difficulty')::double precision,
    fsrs_elapsed_days = (p_card->>'fsrs_elapsed_days')::integer,
    fsrs_scheduled_days = (p_card->>'fsrs_scheduled_days')::integer,
    fsrs_learning_steps = (p_card->>'fsrs_learning_steps')::integer,
    fsrs_reps = (p_card->>'fsrs_reps')::integer,
    fsrs_lapses = (p_card->>'fsrs_lapses')::integer,
    fsrs_state = (p_card->>'fsrs_state')::smallint,
    next_review_at = (p_card->>'next_review_at')::timestamptz,
    last_reviewed_at = (p_card->>'last_reviewed_at')::timestamptz,
    mastered = case when p_rating = 1 then false else mastered end,
    status = case when p_rating = 1 then 'review' else status end
  where id = v_user_word.id;
  insert into fsrs_review_logs(user_id, word_id, session_id, rating, state, due,
    stability, difficulty, elapsed_days, last_elapsed_days, scheduled_days, learning_steps,
    reviewed_at, review_source, reason)
  values (p_user_id, v_user_word.word_id, p_session_id, p_rating, (p_log->>'state')::smallint,
    (p_log->>'due')::timestamptz, (p_log->>'stability')::double precision,
    (p_log->>'difficulty')::double precision, (p_log->>'elapsed_days')::integer,
    (p_log->>'last_elapsed_days')::integer, (p_log->>'scheduled_days')::integer,
    (p_log->>'learning_steps')::integer, (p_log->>'reviewed_at')::timestamptz, p_source, p_reason);
  return jsonb_build_object('word', p_normalized_word);
end;
$$;

create or replace function public.record_pretest_result_v2(
  p_user_id uuid, p_normalized_word text, p_result text, p_user_answer text,
  p_activity_type text, p_rating smallint, p_card jsonb, p_log jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_user_word user_words%rowtype;
begin
  if p_result not in ('known','uncertain','unknown') then raise exception 'Invalid pretest result'; end if;
  select uw.* into v_user_word from user_words uw join words w on w.id = uw.word_id
  where uw.user_id = p_user_id and w.normalized_word = p_normalized_word for update of uw;
  if v_user_word.id is null then raise exception 'Word is not in the user vocabulary'; end if;
  if v_user_word.status <> 'new' then
    return jsonb_build_object('word',p_normalized_word,'result',v_user_word.status,'persisted',true,'already_recorded',true);
  end if;
  update user_words set status = p_result, mastered = false, last_seen_at = now(),
    fsrs_stability=(p_card->>'fsrs_stability')::double precision,
    fsrs_difficulty=(p_card->>'fsrs_difficulty')::double precision,
    fsrs_elapsed_days=(p_card->>'fsrs_elapsed_days')::integer,
    fsrs_scheduled_days=(p_card->>'fsrs_scheduled_days')::integer,
    fsrs_learning_steps=(p_card->>'fsrs_learning_steps')::integer,
    fsrs_reps=(p_card->>'fsrs_reps')::integer, fsrs_lapses=(p_card->>'fsrs_lapses')::integer,
    fsrs_state=(p_card->>'fsrs_state')::smallint,
    next_review_at=(p_card->>'next_review_at')::timestamptz,
    last_reviewed_at=(p_card->>'last_reviewed_at')::timestamptz where id=v_user_word.id;
  insert into attempts(user_id,word_id,activity_type,user_answer,is_correct,error_layer)
  values(p_user_id,v_user_word.word_id,p_activity_type,coalesce(p_user_answer,''),p_result='known','none');
  insert into fsrs_review_logs(user_id,word_id,rating,state,due,stability,difficulty,
    elapsed_days,last_elapsed_days,scheduled_days,learning_steps,reviewed_at,review_source)
  values(p_user_id,v_user_word.word_id,p_rating,(p_log->>'state')::smallint,(p_log->>'due')::timestamptz,
    (p_log->>'stability')::double precision,(p_log->>'difficulty')::double precision,
    (p_log->>'elapsed_days')::integer,(p_log->>'last_elapsed_days')::integer,
    (p_log->>'scheduled_days')::integer,(p_log->>'learning_steps')::integer,
    (p_log->>'reviewed_at')::timestamptz,'pretest');
  return jsonb_build_object('word',p_normalized_word,'result',p_result,'persisted',true);
end;
$$;

create or replace function public.import_vocabulary_batch_v1(
  p_user_id uuid, p_book_id text, p_book_name text, p_items jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_item jsonb; v_word_id uuid; v_inserted integer; v_new integer := 0; v_existing integer := 0;
begin
  insert into users(id) values(p_user_id) on conflict(id) do nothing;
  for v_item in select value from jsonb_array_elements(p_items) loop
    insert into words(normalized_word,display_word,ipa_us,ipa_uk,senses,lexical_source,lexical_updated_at)
    values(v_item->>'normalized',v_item->>'display',nullif(v_item->>'ipa_us',''),nullif(v_item->>'ipa_uk',''),
      coalesce(v_item->'senses','[]'::jsonb),'shanbay',now())
    on conflict(normalized_word) do update set
      ipa_us=coalesce(excluded.ipa_us,words.ipa_us), ipa_uk=coalesce(excluded.ipa_uk,words.ipa_uk),
      senses=case when jsonb_array_length(excluded.senses)>0 then excluded.senses else words.senses end,
      lexical_source=case when excluded.ipa_us is not null or jsonb_array_length(excluded.senses)>0 then 'shanbay' else words.lexical_source end,
      lexical_updated_at=now() returning id into v_word_id;
    insert into user_words(user_id,word_id,source) values(p_user_id,v_word_id,'shanbay')
    on conflict(user_id,word_id) do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted=1 then v_new:=v_new+1; else v_existing:=v_existing+1; end if;
    insert into word_sources(user_id,word_id,source_type,source_book_id,source_book_name,source_state,source_position)
    values(p_user_id,v_word_id,'shanbay',p_book_id,p_book_name,v_item->>'source_state',(v_item->>'position')::integer)
    on conflict(user_id,word_id,source_type,source_book_id) do update set
      source_book_name=excluded.source_book_name,source_state=excluded.source_state,
      source_position=excluded.source_position,updated_at=now();
  end loop;
  return jsonb_build_object('total',jsonb_array_length(p_items),'new',v_new,'existing',v_existing);
end;
$$;

create or replace function public.prepare_daily_new_words_v1(p_user_id uuid,p_date date)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_import_id uuid; v_limit integer; v_count integer; v_remaining integer; v_start integer;
begin
  insert into users(id) values(p_user_id) on conflict(id) do nothing;
  select daily_new_word_limit into v_limit from users where id=p_user_id;
  insert into daily_imports(user_id,import_date,source,raw_count) values(p_user_id,p_date,'wordloop_pool',0)
  on conflict(user_id,import_date,source) do update set source=excluded.source returning id into v_import_id;
  select count(*),coalesce(max(position)+1,0) into v_count,v_start from daily_import_words where import_id=v_import_id;
  v_remaining := greatest(v_limit-v_count,0);
  insert into daily_import_words(import_id,word_id,position)
  select v_import_id,uw.word_id,v_start+(row_number() over(order by uw.first_seen_at,uw.id)-1)::integer
  from user_words uw where uw.user_id=p_user_id and uw.status='new'
    and not exists(select 1 from daily_import_words diw where diw.word_id=uw.word_id)
  order by uw.first_seen_at,uw.id limit v_remaining
  on conflict do nothing;
  select count(*) into v_count from daily_import_words where import_id=v_import_id;
  update daily_imports set raw_count=v_count where id=v_import_id;
  return jsonb_build_object('date',p_date,'prepared',v_count,'limit',v_limit);
end;
$$;

create or replace function public.set_daily_new_word_limit_v1(p_user_id uuid,p_limit integer)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  if p_limit not between 10 and 100 then raise exception 'Daily new word limit must be between 10 and 100'; end if;
  insert into users(id,daily_new_word_limit) values(p_user_id,p_limit)
  on conflict(id) do update set daily_new_word_limit=excluded.daily_new_word_limit;
  return jsonb_build_object('daily_new_word_limit',p_limit);
end;
$$;

revoke all on function public.record_attempt_v2(uuid,text,uuid,text,text,boolean,text) from public,anon,authenticated;
revoke all on function public.record_review_result_v1(uuid,text,uuid,smallint,text,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.record_pretest_result_v2(uuid,text,text,text,text,smallint,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.import_vocabulary_batch_v1(uuid,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.prepare_daily_new_words_v1(uuid,date) from public,anon,authenticated;
revoke all on function public.set_daily_new_word_limit_v1(uuid,integer) from public,anon,authenticated;
grant execute on function public.record_attempt_v2(uuid,text,uuid,text,text,boolean,text) to service_role;
grant execute on function public.record_review_result_v1(uuid,text,uuid,smallint,text,text,jsonb,jsonb) to service_role;
grant execute on function public.record_pretest_result_v2(uuid,text,text,text,text,smallint,jsonb,jsonb) to service_role;
grant execute on function public.import_vocabulary_batch_v1(uuid,text,text,jsonb) to service_role;
grant execute on function public.prepare_daily_new_words_v1(uuid,date) to service_role;
grant execute on function public.set_daily_new_word_limit_v1(uuid,integer) to service_role;
