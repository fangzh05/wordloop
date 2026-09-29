-- WordLoop bootstrap SQL. Keep this file in migration order.
-- It is also embedded at /setup.sql by scripts/build-sites-worker.ts.

-- ===== supabase/migrations/202609130001_initial_wordloop.sql =====
create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key,
  created_at timestamptz not null default now(),
  timezone text not null default 'Asia/Shanghai'
);

create table if not exists public.words (
  id uuid primary key default gen_random_uuid(),
  normalized_word text unique not null,
  display_word text not null,
  created_at timestamptz not null default now(),
  constraint words_normalized_nonempty check (length(btrim(normalized_word)) > 0),
  constraint words_already_normalized check (normalized_word = lower(btrim(normalized_word)))
);

create table if not exists public.user_words (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  word_id uuid not null references public.words(id) on delete cascade,
  status text not null default 'new' check (status in ('new', 'known', 'uncertain', 'unknown', 'review', 'mastered')),
  source text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_reviewed_at timestamptz,
  correct_count integer not null default 0 check (correct_count >= 0),
  wrong_count integer not null default 0 check (wrong_count >= 0),
  consecutive_correct integer not null default 0 check (consecutive_correct >= 0),
  meaning_error boolean not null default false,
  collocation_error boolean not null default false,
  grammar_error boolean not null default false,
  pronunciation_error boolean not null default false,
  spelling_error boolean not null default false,
  mastered boolean not null default false,
  next_review_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, word_id)
);

create table if not exists public.daily_imports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  import_date date not null,
  source text not null,
  created_at timestamptz not null default now(),
  raw_count integer not null default 0 check (raw_count >= 0),
  unique(user_id, import_date, source)
);

create table if not exists public.daily_import_words (
  import_id uuid not null references public.daily_imports(id) on delete cascade,
  word_id uuid not null references public.words(id) on delete cascade,
  position integer not null check (position >= 0),
  primary key(import_id, word_id)
);

create table if not exists public.study_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  new_words_count integer not null default 0,
  review_words_count integer not null default 0
);

create table if not exists public.attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  word_id uuid not null references public.words(id) on delete cascade,
  session_id uuid references public.study_sessions(id) on delete set null,
  activity_type text not null check (activity_type in (
    'pretest_cn_to_en', 'pretest_en_definition', 'translation_cn_to_en',
    'translation_en_to_cn', 'cloze', 'derivation', 'listening',
    'collocation', 'sentence', 'review', 'recall'
  )),
  user_answer text not null default '',
  is_correct boolean not null,
  error_layer text not null default 'none' check (error_layer in (
    'meaning', 'collocation', 'grammar', 'pronunciation', 'spelling', 'none'
  )),
  created_at timestamptz not null default now()
);

create table if not exists public.user_word_error_progress (
  user_word_id uuid not null references public.user_words(id) on delete cascade,
  error_layer text not null check (error_layer in ('meaning', 'collocation', 'grammar', 'pronunciation', 'spelling')),
  consecutive_correct integer not null default 0 check (consecutive_correct >= 0),
  updated_at timestamptz not null default now(),
  primary key(user_word_id, error_layer)
);

create table if not exists public.difficult_sentences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  sentence text not null check (length(btrim(sentence)) > 0),
  created_at timestamptz not null default now()
);

create table if not exists public.difficult_sentence_words (
  sentence_id uuid not null references public.difficult_sentences(id) on delete cascade,
  word_id uuid not null references public.words(id) on delete cascade,
  primary key(sentence_id, word_id)
);

create index if not exists user_words_review_idx on public.user_words(user_id, mastered, next_review_at);
create index if not exists daily_imports_user_date_idx on public.daily_imports(user_id, import_date);
create index if not exists daily_import_words_order_idx on public.daily_import_words(import_id, position);
create index if not exists attempts_user_created_idx on public.attempts(user_id, created_at desc);
create index if not exists difficult_sentences_user_created_idx on public.difficult_sentences(user_id, created_at desc);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists user_words_touch_updated_at on public.user_words;
create trigger user_words_touch_updated_at before update on public.user_words
for each row execute function public.touch_updated_at();

create or replace function public.wordloop_set_error_flag(
  p_user_word_id uuid,
  p_error_layer text,
  p_value boolean
) returns void language plpgsql security definer set search_path = public as $$
begin
  if p_error_layer = 'meaning' then
    update user_words set meaning_error = p_value where id = p_user_word_id;
  elsif p_error_layer = 'collocation' then
    update user_words set collocation_error = p_value where id = p_user_word_id;
  elsif p_error_layer = 'grammar' then
    update user_words set grammar_error = p_value where id = p_user_word_id;
  elsif p_error_layer = 'pronunciation' then
    update user_words set pronunciation_error = p_value where id = p_user_word_id;
  elsif p_error_layer = 'spelling' then
    update user_words set spelling_error = p_value where id = p_user_word_id;
  end if;
end;
$$;

create or replace function public.import_words_v1(
  p_user_id uuid,
  p_words jsonb,
  p_date date,
  p_source text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_item jsonb;
  v_word_id uuid;
  v_import_id uuid;
  v_start_position integer;
  v_inserted integer;
  v_new integer := 0;
  v_existing integer := 0;
  v_total integer := jsonb_array_length(p_words);
begin
  insert into users(id) values (p_user_id) on conflict (id) do nothing;
  insert into daily_imports(user_id, import_date, source, raw_count)
  values (p_user_id, p_date, p_source, 0)
  on conflict (user_id, import_date, source) do update set source = excluded.source
  returning id into v_import_id;

  select coalesce(max(position) + 1, 0) into v_start_position
  from daily_import_words where import_id = v_import_id;

  for v_item in select value from jsonb_array_elements(p_words)
  loop
    insert into words(normalized_word, display_word)
    values (v_item->>'normalized', v_item->>'display')
    on conflict (normalized_word) do update set normalized_word = excluded.normalized_word
    returning id into v_word_id;

    insert into user_words(user_id, word_id, source)
    values (p_user_id, v_word_id, p_source)
    on conflict (user_id, word_id) do nothing;
    get diagnostics v_inserted = row_count;
    if v_inserted = 0 then
      update user_words set last_seen_at = now() where user_id = p_user_id and word_id = v_word_id;
    end if;

    if v_inserted = 1 then v_new := v_new + 1; else v_existing := v_existing + 1; end if;

    insert into daily_import_words(import_id, word_id, position)
    values (v_import_id, v_word_id, v_start_position + (v_item->>'position')::integer)
    on conflict (import_id, word_id) do nothing;
  end loop;

  update daily_imports set raw_count = (
    select count(*) from daily_import_words where import_id = v_import_id
  ) where id = v_import_id;

  return jsonb_build_object('date', p_date, 'source', p_source, 'total', v_total, 'new', v_new, 'existing', v_existing);
end;
$$;

create or replace function public.record_pretest_result_v1(
  p_user_id uuid,
  p_normalized_word text,
  p_result text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_user_word_id uuid;
begin
  if p_result not in ('known', 'uncertain', 'unknown') then raise exception 'Invalid pretest result'; end if;
  select uw.id into v_user_word_id from user_words uw join words w on w.id = uw.word_id
  where uw.user_id = p_user_id and w.normalized_word = p_normalized_word;
  if v_user_word_id is null then raise exception 'Word is not in the user vocabulary'; end if;
  update user_words set
    status = p_result,
    mastered = false,
    last_seen_at = now(),
    next_review_at = case when p_result = 'known' then now() + interval '7 days' else null end
  where id = v_user_word_id;
  return jsonb_build_object('word', p_normalized_word, 'result', p_result);
end;
$$;

create or replace function public.record_attempt_v1(
  p_user_id uuid,
  p_normalized_word text,
  p_session_id uuid,
  p_activity_type text,
  p_user_answer text,
  p_is_correct boolean,
  p_error_layer text
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_user_word user_words%rowtype;
  v_word_id uuid;
  v_layer text := null;
  v_layer_streak integer := 0;
  v_global_streak integer;
  v_correct_count integer;
  v_errors_remaining boolean;
  v_mastered boolean;
  v_active_layers text[] := array[]::text[];
begin
  select uw.* into v_user_word from user_words uw join words w on w.id = uw.word_id
  where uw.user_id = p_user_id and w.normalized_word = p_normalized_word for update of uw;
  if v_user_word.id is null then raise exception 'Word is not in the user vocabulary'; end if;
  v_word_id := v_user_word.word_id;

  insert into attempts(user_id, word_id, session_id, activity_type, user_answer, is_correct, error_layer)
  values (p_user_id, v_word_id, p_session_id, p_activity_type, coalesce(p_user_answer, ''), p_is_correct, p_error_layer);

  if not p_is_correct then
    update user_words set wrong_count = wrong_count + 1, consecutive_correct = 0,
      last_reviewed_at = now(), status = 'review', mastered = false, next_review_at = now() + interval '1 day'
    where id = v_user_word.id;
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

    v_global_streak := v_user_word.consecutive_correct + 1;
    v_correct_count := v_user_word.correct_count + 1;
    update user_words set correct_count = v_correct_count, consecutive_correct = v_global_streak,
      last_reviewed_at = now(), status = 'review', next_review_at = case
        when v_global_streak = 1 then now() + interval '3 days'
        when v_global_streak = 2 then now() + interval '7 days'
        else now() + interval '14 days' end
    where id = v_user_word.id;

    if v_layer is not null then
      insert into user_word_error_progress(user_word_id, error_layer, consecutive_correct)
      values (v_user_word.id, v_layer, 1)
      on conflict (user_word_id, error_layer) do update
      set consecutive_correct = user_word_error_progress.consecutive_correct + 1, updated_at = now()
      returning consecutive_correct into v_layer_streak;
      if v_layer_streak >= 2 then perform wordloop_set_error_flag(v_user_word.id, v_layer, false); end if;
    end if;
  end if;

  select not (meaning_error or collocation_error or grammar_error or pronunciation_error or spelling_error),
         correct_count, consecutive_correct
  into v_errors_remaining, v_correct_count, v_global_streak
  from user_words where id = v_user_word.id;
  v_mastered := v_correct_count >= 3 and v_global_streak >= 2 and v_errors_remaining;
  if v_mastered then
    update user_words set status = 'mastered', mastered = true, next_review_at = now() + interval '14 days'
    where id = v_user_word.id;
  end if;

  return jsonb_build_object(
    'word', p_normalized_word,
    'is_correct', p_is_correct,
    'status', case when v_mastered then 'mastered' else 'review' end,
    'correct_count', v_correct_count,
    'consecutive_correct', v_global_streak,
    'error_layer_streak', case when v_layer is null then null else v_layer_streak end,
    'mastered', v_mastered
  );
end;
$$;

create or replace function public.save_sentence_v1(
  p_user_id uuid,
  p_sentence text,
  p_words jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sentence_id uuid;
  v_item jsonb;
  v_word_id uuid;
  v_word_count integer := 0;
begin
  insert into users(id) values (p_user_id) on conflict (id) do nothing;
  insert into difficult_sentences(user_id, sentence) values (p_user_id, btrim(p_sentence)) returning id into v_sentence_id;
  for v_item in select value from jsonb_array_elements(p_words)
  loop
    insert into words(normalized_word, display_word) values (v_item->>'normalized', v_item->>'display')
    on conflict (normalized_word) do update set normalized_word = excluded.normalized_word returning id into v_word_id;
    insert into user_words(user_id, word_id, source) values (p_user_id, v_word_id, 'sentence_capture')
    on conflict (user_id, word_id) do update set last_seen_at = now();
    insert into difficult_sentence_words(sentence_id, word_id) values (v_sentence_id, v_word_id) on conflict do nothing;
    v_word_count := v_word_count + 1;
  end loop;
  return jsonb_build_object('id', v_sentence_id, 'sentence', btrim(p_sentence), 'extracted_words', v_word_count);
end;
$$;

alter table public.users enable row level security;
alter table public.words enable row level security;
alter table public.user_words enable row level security;
alter table public.daily_imports enable row level security;
alter table public.daily_import_words enable row level security;
alter table public.attempts enable row level security;
alter table public.study_sessions enable row level security;
alter table public.user_word_error_progress enable row level security;
alter table public.difficult_sentences enable row level security;
alter table public.difficult_sentence_words enable row level security;

revoke all on function public.import_words_v1(uuid, jsonb, date, text) from public, anon, authenticated;
revoke all on function public.wordloop_set_error_flag(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.record_pretest_result_v1(uuid, text, text) from public, anon, authenticated;
revoke all on function public.record_attempt_v1(uuid, text, uuid, text, text, boolean, text) from public, anon, authenticated;
revoke all on function public.save_sentence_v1(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.import_words_v1(uuid, jsonb, date, text) to service_role;
grant execute on function public.wordloop_set_error_flag(uuid, text, boolean) to service_role;
grant execute on function public.record_pretest_result_v1(uuid, text, text) to service_role;
grant execute on function public.record_attempt_v1(uuid, text, uuid, text, text, boolean, text) to service_role;
grant execute on function public.save_sentence_v1(uuid, text, jsonb) to service_role;


-- ===== supabase/migrations/202609130002_fsrs_shanbay.sql =====
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


-- ===== supabase/migrations/202609140003_daily_queue_ui_fix.sql =====
-- Daily queue repair and configurable daily-new-word limit.
-- Safe to run after 202609130001 + 202609130002. It intentionally preserves
-- all existing imports, attempts, FSRS cards, and error-layer state.

alter table public.users
  drop constraint if exists users_daily_new_word_limit_check;

alter table public.users
  add constraint users_daily_new_word_limit_check
  check (daily_new_word_limit between 1 and 200);

create or replace function public.set_daily_new_word_limit_v1(p_user_id uuid,p_limit integer)
returns jsonb language plpgsql security definer set search_path=public as $$
begin
  if p_limit not between 1 and 200 then
    raise exception 'Daily new word limit must be between 1 and 200';
  end if;
  insert into users(id,daily_new_word_limit) values(p_user_id,p_limit)
  on conflict(id) do update set daily_new_word_limit=excluded.daily_new_word_limit;
  return jsonb_build_object('daily_new_word_limit',p_limit);
end;
$$;

create or replace function public.prepare_daily_new_words_v1(p_user_id uuid,p_date date)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_import_id uuid;
  v_limit integer;
  v_today_assigned integer;
  v_pool_count integer;
  v_remaining integer;
  v_start integer;
  v_added integer := 0;
begin
  insert into users(id) values(p_user_id) on conflict(id) do nothing;

  select daily_new_word_limit into v_limit
  from users where id=p_user_id;

  insert into daily_imports(user_id,import_date,source,raw_count)
  values(p_user_id,p_date,'wordloop_pool',0)
  on conflict(user_id,import_date,source) do update set source=excluded.source
  returning id into v_import_id;

  -- The limit applies to the complete daily list, including queues created by
  -- older/manual imports, not just the WordLoop vocabulary-pool row.
  select count(distinct diw.word_id) into v_today_assigned
  from daily_imports di
  join daily_import_words diw on diw.import_id=di.id
  where di.user_id=p_user_id and di.import_date=p_date;

  select coalesce(max(position)+1,0), count(*) into v_start,v_pool_count
  from daily_import_words where import_id=v_import_id;

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
        -- A word scheduled yesterday remains eligible today while still new.
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

revoke all on function public.prepare_daily_new_words_v1(uuid,date) from public,anon,authenticated;
revoke all on function public.set_daily_new_word_limit_v1(uuid,integer) from public,anon,authenticated;
grant execute on function public.prepare_daily_new_words_v1(uuid,date) to service_role;
grant execute on function public.set_daily_new_word_limit_v1(uuid,integer) to service_role;


-- ===== supabase/migrations/202609150004_study_session_state.sql =====
alter table public.study_sessions
  add column if not exists state jsonb not null default '{}'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists study_sessions_active_idx
  on public.study_sessions(user_id, started_at desc)
  where ended_at is null;


-- ===== supabase/migrations/202609150005_integrity_guards.sql =====
-- WordLoop integrity guards. This migration adds no tables or scheduling
-- infrastructure; it closes the existing session and review transaction
-- boundaries in the database.

-- Keep the newest active session for each user before enforcing uniqueness.
with ranked_active as (
  select id,
    row_number() over (partition by user_id order by started_at desc, id desc) as rank
  from public.study_sessions
  where ended_at is null
)
update public.study_sessions as sessions
set ended_at = now(),
    state = '{}'::jsonb,
    updated_at = now()
from ranked_active
where sessions.id = ranked_active.id
  and ranked_active.rank > 1;

drop index if exists public.study_sessions_active_idx;
create unique index if not exists study_sessions_one_active_per_user
  on public.study_sessions(user_id)
  where ended_at is null;

create or replace function public.record_review_result_v1(
  p_user_id uuid, p_normalized_word text, p_session_id uuid, p_rating smallint,
  p_source text, p_reason text, p_card jsonb, p_log jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare v_user_word user_words%rowtype;
begin
  select uw.* into v_user_word from user_words uw join words w on w.id = uw.word_id
  where uw.user_id = p_user_id and w.normalized_word = p_normalized_word for update of uw;
  if v_user_word.id is null then raise exception 'Word is not in the user vocabulary'; end if;
  if v_user_word.next_review_at is null
     or v_user_word.next_review_at > clock_timestamp()
  then
    raise exception 'FSRS_CARD_NOT_DUE';
  end if;
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

create or replace function public.record_review_submission_v1(
  p_user_id uuid, p_normalized_word text, p_session_id uuid,
  p_user_answer text, p_is_correct boolean, p_error_layer text,
  p_rating smallint, p_card jsonb, p_log jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_attempt jsonb;
  v_review jsonb;
begin
  select public.record_attempt_v2(
    p_user_id, p_normalized_word, p_session_id, 'review',
    p_user_answer, p_is_correct, p_error_layer
  ) into v_attempt;
  select public.record_review_result_v1(
    p_user_id, p_normalized_word, p_session_id, p_rating,
    'review', null, p_card, p_log
  ) into v_review;
  return jsonb_build_object('attempt', v_attempt, 'review', v_review);
end;
$$;

revoke all on function public.record_review_result_v1(uuid,text,uuid,smallint,text,text,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.record_review_submission_v1(uuid,text,uuid,text,boolean,text,smallint,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.record_review_result_v1(uuid,text,uuid,smallint,text,text,jsonb,jsonb) to service_role;
grant execute on function public.record_review_submission_v1(uuid,text,uuid,text,boolean,text,smallint,jsonb,jsonb) to service_role;


-- ===== supabase/migrations/202609160006_performance_queries.sql =====
-- WordLoop hot-path query consolidation.
-- This migration only adds read indexes and read/aggregation RPCs. It does not
-- alter user data, scheduling state, grading, or study-session semantics.

create index if not exists user_words_active_error_idx
  on public.user_words(user_id)
  where meaning_error
     or collocation_error
     or grammar_error
     or pronunciation_error
     or spelling_error;

create index if not exists user_words_new_pool_idx
  on public.user_words(user_id, first_seen_at, id)
  where status = 'new' and mastered = false;

create or replace function public.get_today_words_v2(p_user_id uuid, p_date date)
returns table(
  word text,
  display_word text,
  status text,
  source text,
  consecutive_correct integer,
  wrong_count integer,
  mastered boolean,
  next_review_at timestamptz,
  meaning_error boolean,
  collocation_error boolean,
  grammar_error boolean,
  pronunciation_error boolean,
  spelling_error boolean,
  fsrs_stability double precision,
  fsrs_difficulty double precision,
  fsrs_scheduled_days integer,
  fsrs_state smallint,
  ipa_us text,
  ipa_uk text,
  senses jsonb
)
language sql stable set search_path = public as $$
  with canonical_rows as (
    select
      di.created_at as import_created_at,
      di.id as import_id,
      diw.position,
      diw.word_id,
      w.normalized_word,
      w.display_word,
      w.ipa_us,
      w.ipa_uk,
      w.senses,
      uw.status,
      uw.source,
      uw.consecutive_correct,
      uw.wrong_count,
      uw.mastered,
      uw.next_review_at,
      uw.meaning_error,
      uw.collocation_error,
      uw.grammar_error,
      uw.pronunciation_error,
      uw.spelling_error,
      uw.fsrs_stability,
      uw.fsrs_difficulty,
      uw.fsrs_scheduled_days,
      uw.fsrs_state,
      row_number() over (
        partition by diw.word_id
        order by di.created_at, di.id, diw.position, diw.word_id
      ) as canonical_rank
    from public.daily_imports as di
    join public.daily_import_words as diw on diw.import_id = di.id
    join public.words as w on w.id = diw.word_id
    join public.user_words as uw
      on uw.user_id = p_user_id
     and uw.word_id = diw.word_id
    where di.user_id = p_user_id
      and di.import_date = p_date
  )
  select
    normalized_word as word,
    display_word,
    status,
    source,
    consecutive_correct,
    wrong_count,
    mastered,
    next_review_at,
    meaning_error,
    collocation_error,
    grammar_error,
    pronunciation_error,
    spelling_error,
    fsrs_stability,
    fsrs_difficulty,
    fsrs_scheduled_days,
    fsrs_state,
    ipa_us,
    ipa_uk,
    coalesce(senses, '[]'::jsonb) as senses
  from canonical_rows
  where canonical_rank = 1
  order by import_created_at, import_id, position, word_id;
$$;

create or replace function public.get_review_candidates_v1(
  p_user_id uuid,
  p_now timestamptz,
  p_limit integer
)
returns table(
  word text,
  display_word text,
  status text,
  source text,
  consecutive_correct integer,
  wrong_count integer,
  mastered boolean,
  next_review_at timestamptz,
  meaning_error boolean,
  collocation_error boolean,
  grammar_error boolean,
  pronunciation_error boolean,
  spelling_error boolean,
  fsrs_stability double precision,
  fsrs_difficulty double precision,
  fsrs_scheduled_days integer,
  fsrs_state smallint,
  ipa_us text,
  ipa_uk text,
  senses jsonb
)
language sql stable set search_path = public as $$
  select
    w.normalized_word as word,
    w.display_word,
    uw.status,
    uw.source,
    uw.consecutive_correct,
    uw.wrong_count,
    uw.mastered,
    uw.next_review_at,
    uw.meaning_error,
    uw.collocation_error,
    uw.grammar_error,
    uw.pronunciation_error,
    uw.spelling_error,
    uw.fsrs_stability,
    uw.fsrs_difficulty,
    uw.fsrs_scheduled_days,
    uw.fsrs_state,
    w.ipa_us,
    w.ipa_uk,
    coalesce(w.senses, '[]'::jsonb) as senses
  from public.user_words as uw
  join public.words as w on w.id = uw.word_id
  where uw.user_id = p_user_id
    and (
      uw.meaning_error
      or uw.collocation_error
      or uw.grammar_error
      or uw.pronunciation_error
      or uw.spelling_error
      or uw.next_review_at <= p_now
    )
  order by
    case when (
      uw.meaning_error
      or uw.collocation_error
      or uw.grammar_error
      or uw.pronunciation_error
      or uw.spelling_error
    ) then 0 else 1 end,
    uw.next_review_at asc nulls last,
    w.normalized_word asc
  limit greatest(coalesce(p_limit, 0), 0);
$$;

create or replace function public.get_progress_snapshot_v1(
  p_user_id uuid,
  p_now timestamptz
)
returns jsonb
language sql stable set search_path = public as $$
  with user_settings as (
    select
      coalesce(max(u.timezone), 'Asia/Shanghai') as time_zone,
      coalesce(max(u.daily_new_word_limit), 50)::integer as daily_new_word_limit
    from public.users as u
    where u.id = p_user_id
  ),
  calendar as (
    select
      time_zone,
      daily_new_word_limit,
      (p_now at time zone time_zone)::date as today_date
    from user_settings
  ),
  today_words as (
    select distinct on (diw.word_id)
      uw.status
    from public.daily_imports as di
    join public.daily_import_words as diw on diw.import_id = di.id
    join public.user_words as uw
      on uw.user_id = p_user_id
     and uw.word_id = diw.word_id
    cross join calendar as c
    where di.user_id = p_user_id
      and di.import_date = c.today_date
    order by diw.word_id, di.created_at, di.id, diw.position, diw.word_id
  ),
  today_counts as (
    select
      count(*)::integer as total,
      count(*) filter (where status = 'known')::integer as known,
      count(*) filter (where status = 'uncertain')::integer as uncertain,
      count(*) filter (where status = 'unknown')::integer as unknown,
      count(*) filter (where status <> 'new')::integer as completed
    from today_words
  ),
  all_counts as (
    select
      count(*)::integer as total_words,
      count(*) filter (where mastered)::integer as mastered,
      (
        count(*)
        - count(*) filter (where mastered)
        - count(*) filter (where (
          meaning_error
          or collocation_error
          or grammar_error
          or pronunciation_error
          or spelling_error
        ))
      )::integer as learning,
      count(*) filter (where (
        meaning_error
        or collocation_error
        or grammar_error
        or pronunciation_error
        or spelling_error
      ))::integer as error_book
    from public.user_words
    where user_id = p_user_id
  ),
  fsrs_counts as (
    select
      count(*) filter (where uw.next_review_at <= p_now)::integer as due_now,
      count(*) filter (where uw.next_review_at is not null
        and (uw.next_review_at at time zone c.time_zone)::date <= c.today_date)::integer as due_today,
      count(*) filter (where uw.next_review_at is not null
        and (uw.next_review_at at time zone c.time_zone)::date = (c.today_date + 1))::integer as tomorrow,
      count(*) filter (where uw.next_review_at is not null
        and (uw.next_review_at at time zone c.time_zone)::date <= (c.today_date + 7))::integer as due_next_7_days,
      coalesce(round(avg(uw.fsrs_stability)::numeric, 1), 0)::double precision as average_stability
    from public.user_words as uw
    cross join calendar as c
    where uw.user_id = p_user_id
  )
  select jsonb_build_object(
    'today', jsonb_build_object(
      'total', tc.total,
      'known', tc.known,
      'uncertain', tc.uncertain,
      'unknown', tc.unknown,
      'completed', tc.completed
    ),
    'all_time', jsonb_build_object(
      'total_words', ac.total_words,
      'mastered', ac.mastered,
      'learning', ac.learning,
      'error_book', ac.error_book
    ),
    'fsrs', jsonb_build_object(
      'due_now', fc.due_now,
      'due_today', fc.due_today,
      'tomorrow', fc.tomorrow,
      'due_next_7_days', fc.due_next_7_days,
      'average_stability', fc.average_stability
    ),
    'settings', jsonb_build_object(
      'daily_new_word_limit', c.daily_new_word_limit
    )
  )
  from today_counts as tc
  cross join all_counts as ac
  cross join fsrs_counts as fc
  cross join calendar as c;
$$;

revoke all on function public.get_today_words_v2(uuid, date) from public, anon, authenticated;
revoke all on function public.get_review_candidates_v1(uuid, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.get_progress_snapshot_v1(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.get_today_words_v2(uuid, date) to service_role;
grant execute on function public.get_review_candidates_v1(uuid, timestamptz, integer) to service_role;
grant execute on function public.get_progress_snapshot_v1(uuid, timestamptz) to service_role;

-- Initial Review session snapshot selection.
-- This is deliberately due-only: active error flags alone must never gate the
-- start of a Review session. The existing (user_id, next_review_at) index from
-- migration 002 supports the indexed predicate and stable bounded read.

create or replace function public.get_due_review_candidates_v1(
  p_user_id uuid,
  p_now timestamptz,
  p_limit integer
)
returns table(
  word text,
  display_word text,
  status text,
  source text,
  consecutive_correct integer,
  wrong_count integer,
  mastered boolean,
  next_review_at timestamptz,
  meaning_error boolean,
  collocation_error boolean,
  grammar_error boolean,
  pronunciation_error boolean,
  spelling_error boolean,
  fsrs_stability double precision,
  fsrs_difficulty double precision,
  fsrs_scheduled_days integer,
  fsrs_state smallint,
  ipa_us text,
  ipa_uk text,
  senses jsonb
)
language sql stable set search_path = public as $$
  select
    w.normalized_word as word,
    w.display_word,
    uw.status,
    uw.source,
    uw.consecutive_correct,
    uw.wrong_count,
    uw.mastered,
    uw.next_review_at,
    uw.meaning_error,
    uw.collocation_error,
    uw.grammar_error,
    uw.pronunciation_error,
    uw.spelling_error,
    uw.fsrs_stability,
    uw.fsrs_difficulty,
    uw.fsrs_scheduled_days,
    uw.fsrs_state,
    w.ipa_us,
    w.ipa_uk,
    coalesce(w.senses, '[]'::jsonb) as senses
  from public.user_words as uw
  join public.words as w on w.id = uw.word_id
  where uw.user_id = p_user_id
    and uw.next_review_at is not null
    and uw.next_review_at <= p_now
  order by uw.next_review_at asc, w.normalized_word asc
  limit least(greatest(coalesce(p_limit, 0), 0), 200);
$$;

revoke all on function public.get_due_review_candidates_v1(uuid, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.get_due_review_candidates_v1(uuid, timestamptz, integer) to service_role;

-- ===== supabase/migrations/20260927143358_exact_cloze_activity_type.sql =====
-- Persist fixed-answer Lesson types and open semantic-expression exercises.
alter table public.attempts
  drop constraint if exists attempts_activity_type_check;

alter table public.attempts
  add constraint attempts_activity_type_check check (activity_type in (
    'pretest_cn_to_en', 'pretest_en_definition', 'translation_cn_to_en',
    'translation_en_to_cn', 'cloze', 'exact_cloze', 'derivation', 'listening',
    'listen_recall', 'spelling', 'word_recall', 'collocation', 'sentence',
    'semantic_expression', 'review', 'recall'
  ));

-- ===== supabase/migrations/20260929021548_formal_lesson_history.sql =====
-- Let WordLoop exclude words already visited in a formal Lesson across local
-- day boundaries, while leaving Review and Pretest history out of that set.
create or replace function public.get_formal_lesson_attempt_words_v1(
  p_user_id uuid,
  p_before timestamptz default null
)
returns table(normalized_word text)
language sql
stable
security definer
set search_path = public
as $$
  select distinct w.normalized_word
  from public.attempts a
  join public.words w on w.id = a.word_id
  where a.user_id = p_user_id
    and a.activity_type in (
      'exact_cloze', 'cloze', 'translation_cn_to_en', 'translation_en_to_cn',
      'collocation', 'derivation', 'recall', 'sentence', 'spelling',
      'word_recall', 'semantic_expression'
    )
    and (p_before is null or a.created_at < p_before);
$$;

-- If a formal Lesson happened while the card remained status='new', prevent
-- tomorrow's pool from presenting that same card as a fresh word again.
create index if not exists attempts_formal_lesson_word_idx
  on public.attempts(user_id, word_id)
  where activity_type in (
    'exact_cloze', 'cloze', 'translation_cn_to_en', 'translation_en_to_cn',
    'collocation', 'derivation', 'recall', 'sentence', 'spelling',
    'word_recall', 'semantic_expression'
  );

create or replace function public.prepare_daily_new_words_v1(p_user_id uuid,p_date date)
returns jsonb language plpgsql security definer set search_path=public as $$
declare
  v_import_id uuid;
  v_limit integer;
  v_today_assigned integer;
  v_pool_count integer;
  v_remaining integer;
  v_start integer;
  v_added integer := 0;
begin
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

revoke all on function public.prepare_daily_new_words_v1(uuid,date) from public,anon,authenticated;
grant execute on function public.prepare_daily_new_words_v1(uuid,date) to service_role;

revoke all on function public.get_formal_lesson_attempt_words_v1(uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function public.get_formal_lesson_attempt_words_v1(uuid, timestamptz)
  to service_role;

-- ===== supabase/migrations/202609290001_capture_notes.sql =====
create table if not exists public.capture_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  selected_text text not null check (length(btrim(selected_text)) > 0 and length(selected_text) <= 500),
  normalized_text text not null check (length(btrim(normalized_text)) > 0),
  selection_type text not null check (selection_type in ('word', 'phrase', 'sentence')),
  note text not null default '' check (length(note) <= 2000),
  status text not null default 'inbox' check (status in ('inbox', 'saved', 'learning', 'archived')),
  occurrence_count integer not null default 1 check (occurrence_count >= 1),
  linked_word_id uuid references public.words(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(user_id, normalized_text)
);

create table if not exists public.capture_note_occurrences (
  id uuid primary key default gen_random_uuid(),
  note_id uuid not null references public.capture_notes(id) on delete cascade,
  context_text text not null default '' check (length(context_text) <= 4000),
  source_type text not null default 'manual' check (source_type in ('lesson', 'review', 'pretest', 'dashboard', 'manual')),
  source_ref text,
  created_at timestamptz not null default now()
);

create index if not exists capture_notes_user_status_last_seen_idx
  on public.capture_notes(user_id, status, last_seen_at desc);

create index if not exists capture_note_occurrences_note_created_idx
  on public.capture_note_occurrences(note_id, created_at desc);

drop trigger if exists capture_notes_touch_updated_at on public.capture_notes;
create trigger capture_notes_touch_updated_at
before update on public.capture_notes
for each row execute function public.touch_updated_at();

alter table public.capture_notes enable row level security;
alter table public.capture_note_occurrences enable row level security;

comment on table public.capture_notes is
  'Reading capture inbox. Capturing never mutates FSRS/user_words; only explicit add-to-learning may link a learnable item.';
comment on table public.capture_note_occurrences is
  'Contexts for repeated encounters with one normalized capture note.';

-- ===== supabase/migrations/20260929120641_captured_notes.sql =====
create table public.captured_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  selected_text text not null check (length(btrim(selected_text)) between 1 and 500),
  normalized_text text not null check (length(btrim(normalized_text)) between 1 and 500),
  selection_type text not null check (selection_type in ('word', 'phrase', 'collocation', 'sentence', 'grammar')),
  note text not null default '' check (length(note) <= 500),
  status text not null default 'inbox' check (status in ('inbox', 'saved', 'dismissed', 'converted')),
  converted_user_word_id uuid references public.user_words(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, normalized_text)
);

create table public.captured_note_occurrences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  captured_note_id uuid not null,
  context_text text not null default '' check (length(context_text) <= 1200),
  source_type text not null check (source_type in ('lesson_example', 'lesson_prompt', 'review_question', 'manual')),
  source_ref text check (source_ref is null or length(source_ref) <= 256),
  source_title text check (source_title is null or length(source_title) <= 200),
  source_url text check (source_url is null or length(source_url) <= 500),
  captured_at timestamptz not null default now(),
  idempotency_key uuid not null,
  foreign key (user_id, captured_note_id)
    references public.captured_notes(user_id, id) on delete cascade,
  unique (user_id, idempotency_key)
);

create index captured_notes_user_status_updated_idx
  on public.captured_notes(user_id, status, updated_at desc, id desc);
create index captured_note_occurrences_user_note_captured_idx
  on public.captured_note_occurrences(user_id, captured_note_id, captured_at desc);

alter table public.captured_notes enable row level security;
alter table public.captured_note_occurrences enable row level security;
revoke all on public.captured_notes, public.captured_note_occurrences from public, anon, authenticated;
grant select, insert, update, delete on public.captured_notes, public.captured_note_occurrences to service_role;

-- Keep word/card insertion shared with the existing import RPC. Imports retain
-- their historical last_seen_at behavior; Capture promotions never touch an
-- existing user_words row.
create or replace function public.ensure_user_word_v1(
  p_user_id uuid,
  p_normalized_word text,
  p_display_word text,
  p_source text,
  p_touch_existing boolean
) returns table(word_id uuid, user_word_id uuid, inserted boolean)
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_word_id uuid;
  v_user_word_id uuid;
  v_inserted integer;
begin
  insert into public.words(normalized_word, display_word)
  values (p_normalized_word, p_display_word)
  on conflict (normalized_word) do update set normalized_word = excluded.normalized_word
  returning id into v_word_id;

  insert into public.user_words(user_id, word_id, source)
  values (p_user_id, v_word_id, p_source)
  on conflict (user_id, word_id) do nothing;
  get diagnostics v_inserted = row_count;

  if v_inserted = 0 and p_touch_existing then
    update public.user_words
    set last_seen_at = now()
    where user_id = p_user_id and word_id = v_word_id;
  end if;

  select id into v_user_word_id
  from public.user_words
  where user_id = p_user_id and word_id = v_word_id;

  return query select v_word_id, v_user_word_id, v_inserted = 1;
end;
$$;

create or replace function public.import_words_v1(
  p_user_id uuid,
  p_words jsonb,
  p_date date,
  p_source text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item jsonb;
  v_word_id uuid;
  v_import_id uuid;
  v_start_position integer;
  v_new integer := 0;
  v_existing integer := 0;
  v_total integer := jsonb_array_length(p_words);
  v_ensured record;
begin
  insert into public.users(id) values (p_user_id) on conflict (id) do nothing;
  insert into public.daily_imports(user_id, import_date, source, raw_count)
  values (p_user_id, p_date, p_source, 0)
  on conflict (user_id, import_date, source) do update set source = excluded.source
  returning id into v_import_id;

  select coalesce(max(position) + 1, 0) into v_start_position
  from public.daily_import_words where import_id = v_import_id;

  for v_item in select value from jsonb_array_elements(p_words)
  loop
    select * into v_ensured
    from public.ensure_user_word_v1(
      p_user_id,
      v_item->>'normalized',
      v_item->>'display',
      p_source,
      true
    );
    v_word_id := v_ensured.word_id;

    if v_ensured.inserted then v_new := v_new + 1; else v_existing := v_existing + 1; end if;

    insert into public.daily_import_words(import_id, word_id, position)
    values (v_import_id, v_word_id, v_start_position + (v_item->>'position')::integer)
    on conflict (import_id, word_id) do nothing;
  end loop;

  update public.daily_imports set raw_count = (
    select count(*) from public.daily_import_words where import_id = v_import_id
  ) where id = v_import_id;

  return jsonb_build_object('date', p_date, 'source', p_source, 'total', v_total, 'new', v_new, 'existing', v_existing);
end;
$$;

create or replace function public.create_captured_note_v1(
  p_user_id uuid,
  p_selected_text text,
  p_normalized_text text,
  p_selection_type text,
  p_note text,
  p_context_text text,
  p_source_type text,
  p_source_ref text,
  p_source_title text,
  p_source_url text,
  p_idempotency_key uuid
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_note_id uuid;
  v_occurrence_id uuid;
  v_occurrence_note_id uuid;
  v_occurrence_count integer;
begin
  insert into public.captured_notes(user_id, selected_text, normalized_text, selection_type, note)
  values (p_user_id, p_selected_text, p_normalized_text, p_selection_type, coalesce(p_note, ''))
  on conflict (user_id, normalized_text) do nothing
  returning id into v_note_id;

  if v_note_id is null then
    select id into v_note_id
    from public.captured_notes
    where user_id = p_user_id and normalized_text = p_normalized_text;
  end if;

  insert into public.captured_note_occurrences(
    user_id, captured_note_id, context_text, source_type, source_ref, source_title, source_url, idempotency_key
  ) values (
    p_user_id, v_note_id, coalesce(p_context_text, ''), p_source_type, p_source_ref, p_source_title, p_source_url, p_idempotency_key
  ) on conflict (user_id, idempotency_key) do nothing
  returning id into v_occurrence_id;

  if v_occurrence_id is null then
    select captured_note_id into v_occurrence_note_id
    from public.captured_note_occurrences
    where user_id = p_user_id and idempotency_key = p_idempotency_key;
    if v_occurrence_note_id is distinct from v_note_id then
      raise exception 'CAPTURE_IDEMPOTENCY_CONFLICT';
    end if;
  end if;

  select count(*)::integer into v_occurrence_count
  from public.captured_note_occurrences
  where user_id = p_user_id and captured_note_id = v_note_id;

  return jsonb_build_object(
    'note_id', v_note_id,
    'occurrence_count', v_occurrence_count,
    'new_occurrence', v_occurrence_id is not null
  );
end;
$$;

create or replace function public.list_captured_notes_v1(
  p_user_id uuid,
  p_status text,
  p_query text,
  p_before_updated_at timestamptz,
  p_before_id uuid,
  p_limit integer
) returns table(
  id uuid,
  selected_text text,
  normalized_text text,
  selection_type text,
  note text,
  status text,
  converted_user_word_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  occurrence_count bigint,
  occurrences jsonb
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    n.id,
    n.selected_text,
    n.normalized_text,
    n.selection_type,
    n.note,
    n.status,
    n.converted_user_word_id,
    n.created_at,
    n.updated_at,
    (
      select count(*)
      from public.captured_note_occurrences as o
      where o.user_id = p_user_id and o.captured_note_id = n.id
    ) as occurrence_count,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'context_text', recent.context_text,
        'source_type', recent.source_type,
        'source_title', recent.source_title,
        'source_url', recent.source_url,
        'captured_at', recent.captured_at
      ) order by recent.captured_at desc)
      from (
        select o.context_text, o.source_type, o.source_title, o.source_url, o.captured_at
        from public.captured_note_occurrences as o
        where o.user_id = p_user_id and o.captured_note_id = n.id
        order by o.captured_at desc
        limit 3
      ) as recent
    ), '[]'::jsonb) as occurrences
  from public.captured_notes as n
  where n.user_id = p_user_id
    and (p_status = 'all' or n.status = p_status)
    and (
      p_before_updated_at is null
      or (
        p_before_id is not null
        and (n.updated_at < p_before_updated_at or (n.updated_at = p_before_updated_at and n.id < p_before_id))
      )
    )
    and (
      coalesce(p_query, '') = ''
      or strpos(lower(n.selected_text), lower(p_query)) > 0
      or strpos(lower(n.note), lower(p_query)) > 0
      or exists (
        select 1
        from public.captured_note_occurrences as o
        where o.user_id = p_user_id
          and o.captured_note_id = n.id
          and strpos(lower(o.context_text), lower(p_query)) > 0
      )
    )
  order by n.updated_at desc, n.id desc
  limit least(greatest(coalesce(p_limit, 25), 1), 51);
$$;

create or replace function public.promote_captured_note_v1(
  p_user_id uuid,
  p_captured_note_id uuid,
  p_import_date date,
  p_display_text text
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_note public.captured_notes%rowtype;
  v_user_word_id uuid;
  v_word_id uuid;
  v_import_id uuid;
  v_position integer;
  v_ensured record;
begin
  select * into v_note
  from public.captured_notes
  where user_id = p_user_id and id = p_captured_note_id
  for update;

  if not found then raise exception 'CAPTURE_NOT_FOUND'; end if;
  if v_note.selection_type not in ('word', 'phrase', 'collocation') then
    raise exception 'CAPTURE_UNSUPPORTED_TYPE';
  end if;
  if p_display_text is null or length(btrim(p_display_text)) = 0 or length(p_display_text) > 100
    or p_display_text <> btrim(p_display_text) or lower(p_display_text) <> v_note.normalized_text then
    raise exception 'CAPTURE_TERM_INVALID';
  end if;

  if v_note.converted_user_word_id is not null then
    select id into v_user_word_id
    from public.user_words
    where user_id = p_user_id and id = v_note.converted_user_word_id;
    if not found then raise exception 'CAPTURE_LINK_INVALID'; end if;
    return jsonb_build_object(
      'note_id', v_note.id,
      'user_word_id', v_user_word_id,
      'normalized_word', v_note.normalized_text,
      'is_new', false
    );
  end if;

  select uw.id, uw.word_id into v_user_word_id, v_word_id
  from public.user_words as uw
  join public.words as w on w.id = uw.word_id
  where uw.user_id = p_user_id and w.normalized_word = v_note.normalized_text
  for update of uw;

  if found then
    update public.captured_notes
    set converted_user_word_id = v_user_word_id, status = 'converted', updated_at = now()
    where user_id = p_user_id and id = v_note.id;
    return jsonb_build_object(
      'note_id', v_note.id,
      'user_word_id', v_user_word_id,
      'normalized_word', v_note.normalized_text,
      'is_new', false
    );
  end if;

  select * into v_ensured
  from public.ensure_user_word_v1(p_user_id, v_note.normalized_text, p_display_text, 'capture', false);
  v_word_id := v_ensured.word_id;
  v_user_word_id := v_ensured.user_word_id;

  if v_ensured.inserted then
    insert into public.daily_imports(user_id, import_date, source, raw_count)
    values (p_user_id, p_import_date, 'capture', 0)
    on conflict (user_id, import_date, source) do nothing
    returning id into v_import_id;
    if v_import_id is null then
      select id into v_import_id
      from public.daily_imports
      where user_id = p_user_id and import_date = p_import_date and source = 'capture';
    end if;

    select coalesce(max(position) + 1, 0) into v_position
    from public.daily_import_words where import_id = v_import_id;
    insert into public.daily_import_words(import_id, word_id, position)
    values (v_import_id, v_word_id, v_position)
    on conflict (import_id, word_id) do nothing;
    update public.daily_imports
    set raw_count = (select count(*) from public.daily_import_words where import_id = v_import_id)
    where id = v_import_id;
  end if;

  update public.captured_notes
  set converted_user_word_id = v_user_word_id, status = 'converted', updated_at = now()
  where user_id = p_user_id and id = v_note.id;

  return jsonb_build_object(
    'note_id', v_note.id,
    'user_word_id', v_user_word_id,
    'normalized_word', v_note.normalized_text,
    'is_new', v_ensured.inserted
  );
end;
$$;

create or replace function public.captured_notes_schema_v1()
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    to_regprocedure('public.ensure_user_word_v1(uuid,text,text,text,boolean)') is not null
    and to_regprocedure('public.create_captured_note_v1(uuid,text,text,text,text,text,text,text,text,text,uuid)') is not null
    and to_regprocedure('public.list_captured_notes_v1(uuid,text,text,timestamp with time zone,uuid,integer)') is not null
    and to_regprocedure('public.promote_captured_note_v1(uuid,uuid,date,text)') is not null;
$$;

revoke all on function public.ensure_user_word_v1(uuid, text, text, text, boolean) from public, anon, authenticated;
revoke all on function public.import_words_v1(uuid, jsonb, date, text) from public, anon, authenticated;
revoke all on function public.create_captured_note_v1(uuid, text, text, text, text, text, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.list_captured_notes_v1(uuid, text, text, timestamp with time zone, uuid, integer) from public, anon, authenticated;
revoke all on function public.promote_captured_note_v1(uuid, uuid, date, text) from public, anon, authenticated;
revoke all on function public.captured_notes_schema_v1() from public, anon, authenticated;

grant execute on function public.ensure_user_word_v1(uuid, text, text, text, boolean) to service_role;
grant execute on function public.import_words_v1(uuid, jsonb, date, text) to service_role;
grant execute on function public.create_captured_note_v1(uuid, text, text, text, text, text, text, text, text, text, uuid) to service_role;
grant execute on function public.list_captured_notes_v1(uuid, text, text, timestamp with time zone, uuid, integer) to service_role;
grant execute on function public.promote_captured_note_v1(uuid, uuid, date, text) to service_role;
grant execute on function public.captured_notes_schema_v1() to service_role;


-- ===== supabase/migrations/20260929172617_captured_notes_canonical_adapter.sql =====
-- Canonical Capture source is captured_notes + captured_note_occurrences.
-- The legacy capture_* tables remain available for reconciliation and rollback.

-- These additive guards make a clean database migration chain reproducible,
-- while remaining no-ops for environments where the canonical store already exists.
create table if not exists public.captured_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  selected_text text not null check (length(btrim(selected_text)) between 1 and 500),
  normalized_text text not null check (length(btrim(normalized_text)) between 1 and 500),
  selection_type text not null check (selection_type in ('word', 'phrase', 'collocation', 'sentence', 'grammar')),
  note text not null default '' check (length(note) <= 500),
  status text not null default 'inbox' check (status in ('inbox', 'saved', 'dismissed', 'converted')),
  converted_user_word_id uuid references public.user_words(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, id),
  unique (user_id, normalized_text)
);

-- A clean chain creates both keys above. Older canonical deployments may have
-- the same globally unique IDs without the composite keys used for ownership.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.captured_notes'::regclass
      and contype in ('u', 'p')
      and conkey = array[
        (select attnum from pg_attribute where attrelid = 'public.captured_notes'::regclass and attname = 'user_id'),
        (select attnum from pg_attribute where attrelid = 'public.captured_notes'::regclass and attname = 'id')
      ]::smallint[]
  ) then
    alter table public.captured_notes
      add constraint captured_notes_user_id_id_key unique (user_id, id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.captured_notes'::regclass
      and contype in ('u', 'p')
      and conkey = array[
        (select attnum from pg_attribute where attrelid = 'public.captured_notes'::regclass and attname = 'user_id'),
        (select attnum from pg_attribute where attrelid = 'public.captured_notes'::regclass and attname = 'normalized_text')
      ]::smallint[]
  ) then
    if exists (
      select 1 from public.captured_notes
      group by user_id, normalized_text
      having count(*) > 1
    ) then
      raise exception 'CAPTURE_CANONICAL_DUPLICATE_NORMALIZED_TEXT';
    end if;
    alter table public.captured_notes
      add constraint captured_notes_user_normalized_text_key unique (user_id, normalized_text);
  end if;
end;
$$;

create table if not exists public.captured_note_occurrences (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  captured_note_id uuid not null,
  context_text text not null default '' check (length(context_text) <= 1200),
  source_type text not null check (source_type in ('lesson_example', 'lesson_prompt', 'review_question', 'manual')),
  source_ref text check (source_ref is null or length(source_ref) <= 256),
  source_title text check (source_title is null or length(source_title) <= 200),
  source_url text check (source_url is null or length(source_url) <= 500),
  captured_at timestamptz not null default now(),
  idempotency_key uuid not null,
  foreign key (user_id, captured_note_id)
    references public.captured_notes(user_id, id) on delete cascade,
  unique (user_id, idempotency_key)
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.captured_note_occurrences'::regclass
      and contype in ('u', 'p')
      and conkey = array[
        (select attnum from pg_attribute where attrelid = 'public.captured_note_occurrences'::regclass and attname = 'user_id'),
        (select attnum from pg_attribute where attrelid = 'public.captured_note_occurrences'::regclass and attname = 'idempotency_key')
      ]::smallint[]
  ) then
    if exists (
      select 1 from public.captured_note_occurrences
      group by user_id, idempotency_key
      having count(*) > 1
    ) then
      raise exception 'CAPTURE_CANONICAL_DUPLICATE_IDEMPOTENCY_KEY';
    end if;
    alter table public.captured_note_occurrences
      add constraint captured_note_occurrences_user_idempotency_key_key unique (user_id, idempotency_key);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.captured_note_occurrences'::regclass
      and contype = 'f'
      and conkey = array[
        (select attnum from pg_attribute where attrelid = 'public.captured_note_occurrences'::regclass and attname = 'user_id'),
        (select attnum from pg_attribute where attrelid = 'public.captured_note_occurrences'::regclass and attname = 'captured_note_id')
      ]::smallint[]
      and confkey = array[
        (select attnum from pg_attribute where attrelid = 'public.captured_notes'::regclass and attname = 'user_id'),
        (select attnum from pg_attribute where attrelid = 'public.captured_notes'::regclass and attname = 'id')
      ]::smallint[]
  ) then
    if exists (
      select 1 from public.captured_note_occurrences as occurrence
      left join public.captured_notes as note
        on note.user_id = occurrence.user_id and note.id = occurrence.captured_note_id
      where note.id is null
    ) then
      raise exception 'CAPTURE_CANONICAL_ORPHAN_OCCURRENCE';
    end if;
    alter table public.captured_note_occurrences
      add constraint captured_note_occurrences_user_note_fkey
      foreign key (user_id, captured_note_id) references public.captured_notes(user_id, id) on delete cascade;
  end if;
end;
$$;

create index if not exists captured_notes_user_status_updated_idx
  on public.captured_notes(user_id, status, updated_at desc, id desc);
create index if not exists captured_note_occurrences_user_note_captured_idx
  on public.captured_note_occurrences(user_id, captured_note_id, captured_at desc);
alter table public.captured_notes enable row level security;
alter table public.captured_note_occurrences enable row level security;
revoke all on public.captured_notes, public.captured_note_occurrences from public, anon, authenticated;
grant select, insert, update, delete on public.captured_notes, public.captured_note_occurrences to service_role;

create or replace function public.list_captured_notes_v1(
  p_user_id uuid,
  p_status text,
  p_query text,
  p_before_updated_at timestamptz,
  p_before_id uuid,
  p_limit integer
) returns table(
  id uuid,
  selected_text text,
  normalized_text text,
  selection_type text,
  note text,
  status text,
  converted_user_word_id uuid,
  created_at timestamptz,
  updated_at timestamptz,
  occurrence_count bigint,
  occurrences jsonb
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    n.id, n.selected_text, n.normalized_text, n.selection_type, n.note, n.status,
    n.converted_user_word_id, n.created_at, n.updated_at,
    (select count(*) from public.captured_note_occurrences as o
      where o.user_id = p_user_id and o.captured_note_id = n.id) as occurrence_count,
    coalesce((
      select jsonb_agg(jsonb_build_object(
        'context_text', recent.context_text,
        'source_type', recent.source_type,
        'source_ref', recent.source_ref,
        'source_title', recent.source_title,
        'source_url', recent.source_url,
        'captured_at', recent.captured_at
      ) order by recent.captured_at desc, recent.id desc)
      from (
        select o.id, o.context_text, o.source_type, o.source_ref, o.source_title,
          o.source_url, o.captured_at
        from public.captured_note_occurrences as o
        where o.user_id = p_user_id and o.captured_note_id = n.id
        order by o.captured_at desc, o.id desc
        limit 3
      ) as recent
    ), '[]'::jsonb) as occurrences
  from public.captured_notes as n
  where n.user_id = p_user_id
    and (p_status = 'all' or n.status = p_status)
    and (p_before_updated_at is null or
      (p_before_id is not null and (n.updated_at, n.id) < (p_before_updated_at, p_before_id)))
    and (coalesce(p_query, '') = ''
      or strpos(lower(n.selected_text), lower(p_query)) > 0
      or strpos(lower(n.note), lower(p_query)) > 0
      or exists (
        select 1 from public.captured_note_occurrences as o
        where o.user_id = p_user_id and o.captured_note_id = n.id
          and strpos(lower(o.context_text), lower(p_query)) > 0
      ))
  order by n.updated_at desc, n.id desc
  limit least(greatest(coalesce(p_limit, 25), 1), 51);
$$;

do $$
begin
  if exists (
    select 1
    from public.capture_notes as legacy
    left join public.user_words as uw
      on uw.user_id = legacy.user_id and uw.word_id = legacy.linked_word_id
    where legacy.status = 'learning'
      and (legacy.linked_word_id is null or uw.id is null)
  ) then
    raise exception 'CAPTURE_MIGRATION_UNRESOLVED_LEGACY_LINK';
  end if;
end;
$$;

-- Preserve historical text if the older writer exceeded canonical limits.
do $$
declare
  v_note_limit integer;
  v_context_limit integer;
  v_source_ref_limit integer;
begin
  select greatest(500, coalesce(max(length(note)), 0))
    into v_note_limit from public.capture_notes;
  if v_note_limit > 500 then
    alter table public.captured_notes drop constraint if exists captured_notes_note_check;
    execute format(
      'alter table public.captured_notes add constraint captured_notes_note_check check (length(note) <= %s)',
      v_note_limit
    );
  end if;

  select greatest(1200, coalesce(max(length(context_text)), 0))
    into v_context_limit from public.capture_note_occurrences;
  if v_context_limit > 1200 then
    alter table public.captured_note_occurrences drop constraint if exists captured_note_occurrences_context_text_check;
    execute format(
      'alter table public.captured_note_occurrences add constraint captured_note_occurrences_context_text_check check (length(context_text) <= %s)',
      v_context_limit
    );
  end if;

  select greatest(256, coalesce(max(length(source_ref)), 0))
    into v_source_ref_limit from public.capture_note_occurrences;
  if v_source_ref_limit > 256 then
    alter table public.captured_note_occurrences drop constraint if exists captured_note_occurrences_source_ref_check;
    execute format(
      'alter table public.captured_note_occurrences add constraint captured_note_occurrences_source_ref_check check (source_ref is null or length(source_ref) <= %s)',
      v_source_ref_limit
    );
  end if;
end;
$$;

create table if not exists public.capture_note_legacy_map (
  legacy_note_id uuid primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  captured_note_id uuid not null,
  legacy_word_id uuid,
  legacy_note text not null,
  legacy_status text not null,
  legacy_occurrence_count integer not null,
  legacy_created_at timestamptz not null,
  legacy_updated_at timestamptz not null,
  migrated_at timestamptz not null default now(),
  constraint capture_note_legacy_map_canonical_fk
    foreign key (user_id, captured_note_id)
    references public.captured_notes(user_id, id) on delete cascade
);

alter table public.capture_note_legacy_map enable row level security;
revoke all on table public.capture_note_legacy_map from public, anon, authenticated;
grant all on table public.capture_note_legacy_map to service_role;

-- Preserve each old parent ID and word_id -> user_words.id conversion for audit.
insert into public.captured_notes(
  user_id, selected_text, normalized_text, selection_type, note, status,
  converted_user_word_id, created_at, updated_at
)
select
  legacy.user_id,
  legacy.selected_text,
  legacy.normalized_text,
  legacy.selection_type,
  legacy.note,
  case
    when legacy.status = 'archived' then 'dismissed'
    when uw.id is not null then 'converted'
    else legacy.status
  end,
  uw.id,
  legacy.created_at,
  legacy.updated_at
from public.capture_notes as legacy
left join public.user_words as uw
  on uw.user_id = legacy.user_id and uw.word_id = legacy.linked_word_id
order by legacy.created_at, legacy.id
on conflict (user_id, normalized_text) do nothing;

insert into public.capture_note_legacy_map(
  legacy_note_id, user_id, captured_note_id, legacy_word_id, legacy_note,
  legacy_status, legacy_occurrence_count, legacy_created_at, legacy_updated_at
)
select
  legacy.id,
  legacy.user_id,
  canonical.id,
  legacy.linked_word_id,
  legacy.note,
  legacy.status,
  legacy.occurrence_count,
  legacy.created_at,
  legacy.updated_at
from public.capture_notes as legacy
join public.captured_notes as canonical
  on canonical.user_id = legacy.user_id
 and canonical.normalized_text = legacy.normalized_text
on conflict (legacy_note_id) do nothing;

do $$
begin
  if exists (
    select 1
    from public.capture_note_occurrences as legacy_occurrence
    join public.capture_note_legacy_map as mapping
      on mapping.legacy_note_id = legacy_occurrence.note_id
     and mapping.user_id = (select user_id from public.capture_notes where id = legacy_occurrence.note_id)
    join public.captured_note_occurrences as canonical_occurrence
      on canonical_occurrence.user_id = mapping.user_id
     and canonical_occurrence.idempotency_key = legacy_occurrence.id
    where canonical_occurrence.captured_note_id <> mapping.captured_note_id
  ) then
    raise exception 'CAPTURE_MIGRATION_OCCURRENCE_KEY_CONFLICT';
  end if;
end;
$$;

insert into public.captured_note_occurrences(
  user_id, captured_note_id, context_text, source_type, source_ref,
  source_title, source_url, captured_at, idempotency_key
)
select
  mapping.user_id,
  mapping.captured_note_id,
  legacy_occurrence.context_text,
  case legacy_occurrence.source_type
    when 'lesson' then 'lesson_example'
    when 'review' then 'review_question'
    else 'manual'
  end,
  legacy_occurrence.source_ref,
  case legacy_occurrence.source_type
    when 'pretest' then 'WordLoop · 预测试（旧来源）'
    when 'dashboard' then 'WordLoop · 今日（旧来源）'
    else null
  end,
  null,
  legacy_occurrence.created_at,
  legacy_occurrence.id
from public.capture_note_occurrences as legacy_occurrence
join public.capture_note_legacy_map as mapping
  on mapping.legacy_note_id = legacy_occurrence.note_id
on conflict (user_id, idempotency_key) do nothing;

update public.captured_notes as canonical
set updated_at = greatest(canonical.updated_at, recent.last_seen_at)
from (
  select captured_note_id, max(captured_at) as last_seen_at
  from public.captured_note_occurrences
  group by captured_note_id
) as recent
where canonical.id = recent.captured_note_id
  and recent.last_seen_at > canonical.updated_at;

create or replace function public.create_captured_note_v1(
  p_user_id uuid,
  p_selected_text text,
  p_normalized_text text,
  p_selection_type text,
  p_note text,
  p_context_text text,
  p_source_type text,
  p_source_ref text,
  p_source_title text,
  p_source_url text,
  p_idempotency_key uuid
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_note_id uuid;
  v_occurrence_id uuid;
  v_occurrence_note_id uuid;
  v_occurrence_count integer;
begin
  insert into public.captured_notes(user_id, selected_text, normalized_text, selection_type, note)
  values (p_user_id, p_selected_text, p_normalized_text, p_selection_type, coalesce(p_note, ''))
  on conflict (user_id, normalized_text) do nothing
  returning id into v_note_id;

  if v_note_id is null then
    select id into v_note_id
    from public.captured_notes
    where user_id = p_user_id and normalized_text = p_normalized_text;
  end if;

  insert into public.captured_note_occurrences(
    user_id, captured_note_id, context_text, source_type, source_ref, source_title, source_url, idempotency_key
  ) values (
    p_user_id, v_note_id, coalesce(p_context_text, ''), p_source_type, p_source_ref, p_source_title, p_source_url, p_idempotency_key
  ) on conflict (user_id, idempotency_key) do nothing
  returning id into v_occurrence_id;

  if v_occurrence_id is null then
    select captured_note_id into v_occurrence_note_id
    from public.captured_note_occurrences
    where user_id = p_user_id and idempotency_key = p_idempotency_key;
    if v_occurrence_note_id is distinct from v_note_id then
      raise exception 'CAPTURE_IDEMPOTENCY_CONFLICT';
    end if;
  else
    update public.captured_notes
    set updated_at = greatest(updated_at, clock_timestamp())
    where user_id = p_user_id and id = v_note_id;
  end if;

  select count(*)::integer into v_occurrence_count
  from public.captured_note_occurrences
  where user_id = p_user_id and captured_note_id = v_note_id;

  return jsonb_build_object(
    'note_id', v_note_id,
    'occurrence_count', v_occurrence_count,
    'new_occurrence', v_occurrence_id is not null
  );
end;
$$;

create or replace function public.promote_captured_note_v1(
  p_user_id uuid,
  p_captured_note_id uuid,
  p_import_date date,
  p_display_text text
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_note public.captured_notes%rowtype;
  v_user_word_id uuid;
  v_word_id uuid;
  v_import_id uuid;
  v_position integer;
  v_inserted integer;
begin
  select * into v_note
  from public.captured_notes
  where user_id = p_user_id and id = p_captured_note_id
  for update;

  if not found then raise exception 'CAPTURE_NOT_FOUND'; end if;
  if v_note.selection_type not in ('word', 'phrase', 'collocation') then
    raise exception 'CAPTURE_UNSUPPORTED_TYPE';
  end if;
  if p_display_text is null or length(btrim(p_display_text)) = 0 or length(p_display_text) > 100
    or p_display_text <> btrim(p_display_text) or lower(p_display_text) <> v_note.normalized_text
    or cardinality(regexp_split_to_array(btrim(p_display_text), '[[:space:]]+')) > 2 then
    raise exception 'CAPTURE_TERM_INVALID';
  end if;

  if v_note.converted_user_word_id is not null then
    select id into v_user_word_id
    from public.user_words
    where user_id = p_user_id and id = v_note.converted_user_word_id;
    if not found then raise exception 'CAPTURE_LINK_INVALID'; end if;
    return jsonb_build_object(
      'note_id', v_note.id,
      'user_word_id', v_user_word_id,
      'normalized_word', v_note.normalized_text,
      'is_new', false
    );
  end if;

  select uw.id, uw.word_id into v_user_word_id, v_word_id
  from public.user_words as uw
  join public.words as w on w.id = uw.word_id
  where uw.user_id = p_user_id and w.normalized_word = v_note.normalized_text
  for update of uw;

  if found then
    update public.captured_notes
    set converted_user_word_id = v_user_word_id, status = 'converted', updated_at = now()
    where user_id = p_user_id and id = v_note.id;
    return jsonb_build_object(
      'note_id', v_note.id,
      'user_word_id', v_user_word_id,
      'normalized_word', v_note.normalized_text,
      'is_new', false
    );
  end if;

  insert into public.words(normalized_word, display_word)
  values (v_note.normalized_text, p_display_text)
  on conflict (normalized_word) do update set normalized_word = excluded.normalized_word
  returning id into v_word_id;

  insert into public.user_words(user_id, word_id, source)
  values (p_user_id, v_word_id, 'capture')
  on conflict (user_id, word_id) do nothing;
  get diagnostics v_inserted = row_count;

  select id into v_user_word_id
  from public.user_words
  where user_id = p_user_id and word_id = v_word_id;

  if v_inserted = 1 then
    insert into public.daily_imports(user_id, import_date, source, raw_count)
    values (p_user_id, p_import_date, 'capture', 0)
    on conflict (user_id, import_date, source) do nothing
    returning id into v_import_id;

    if v_import_id is null then
      select id into v_import_id
      from public.daily_imports
      where user_id = p_user_id and import_date = p_import_date and source = 'capture'
      for update;
    end if;

    select coalesce(max(position) + 1, 0) into v_position
    from public.daily_import_words where import_id = v_import_id;
    insert into public.daily_import_words(import_id, word_id, position)
    values (v_import_id, v_word_id, v_position)
    on conflict (import_id, word_id) do nothing;
    update public.daily_imports
    set raw_count = (select count(*) from public.daily_import_words where import_id = v_import_id)
    where id = v_import_id;
  end if;

  update public.captured_notes
  set converted_user_word_id = v_user_word_id, status = 'converted', updated_at = now()
  where user_id = p_user_id and id = v_note.id;

  return jsonb_build_object(
    'note_id', v_note.id,
    'user_word_id', v_user_word_id,
    'normalized_word', v_note.normalized_text,
    'is_new', v_inserted = 1
  );
end;
$$;

revoke all on function public.create_captured_note_v1(uuid, text, text, text, text, text, text, text, text, text, uuid) from public, anon, authenticated;
revoke all on function public.list_captured_notes_v1(uuid, text, text, timestamptz, uuid, integer) from public, anon, authenticated;
revoke all on function public.promote_captured_note_v1(uuid, uuid, date, text) from public, anon, authenticated;
grant execute on function public.create_captured_note_v1(uuid, text, text, text, text, text, text, text, text, text, uuid) to service_role;
grant execute on function public.list_captured_notes_v1(uuid, text, text, timestamptz, uuid, integer) to service_role;
grant execute on function public.promote_captured_note_v1(uuid, uuid, date, text) to service_role;


-- ===== supabase/migrations/20260929172621_analytics_read_models.sql =====
-- Server-only read models for the standalone Insights pages.
-- Aggregates always receive an explicit owner and never mutate study state.

create or replace function public.list_user_vocabulary_v1(
  p_user_id uuid,
  p_query text,
  p_filters text[],
  p_before_first_seen timestamptz,
  p_before_id uuid,
  p_limit integer,
  p_as_of timestamptz
) returns table(
  id uuid,
  user_id uuid,
  word_id uuid,
  status text,
  source text,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  last_reviewed_at timestamptz,
  correct_count integer,
  wrong_count integer,
  consecutive_correct integer,
  meaning_error boolean,
  collocation_error boolean,
  grammar_error boolean,
  pronunciation_error boolean,
  spelling_error boolean,
  mastered boolean,
  next_review_at timestamptz,
  fsrs_stability double precision,
  fsrs_difficulty double precision,
  fsrs_elapsed_days integer,
  fsrs_scheduled_days integer,
  fsrs_learning_steps integer,
  fsrs_reps integer,
  fsrs_lapses integer,
  fsrs_state smallint,
  normalized_word text,
  display_word text,
  ipa_us text,
  ipa_uk text,
  senses jsonb
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    uw.id, uw.user_id, uw.word_id, uw.status, uw.source,
    uw.first_seen_at, uw.last_seen_at, uw.last_reviewed_at,
    uw.correct_count, uw.wrong_count, uw.consecutive_correct,
    uw.meaning_error, uw.collocation_error, uw.grammar_error,
    uw.pronunciation_error, uw.spelling_error, uw.mastered,
    uw.next_review_at, uw.fsrs_stability, uw.fsrs_difficulty,
    uw.fsrs_elapsed_days, uw.fsrs_scheduled_days, uw.fsrs_learning_steps,
    uw.fsrs_reps, uw.fsrs_lapses, uw.fsrs_state,
    w.normalized_word, w.display_word, w.ipa_us, w.ipa_uk,
    coalesce(w.senses, '[]'::jsonb)
  from public.user_words as uw
  join public.words as w on w.id = uw.word_id
  where uw.user_id = p_user_id
    and (coalesce(p_query, '') = '' or strpos(lower(w.normalized_word), lower(p_query)) > 0)
    and (not ('not_started' = any(coalesce(p_filters, '{}'::text[]))) or uw.status = 'new')
    and (not ('in_memory' = any(coalesce(p_filters, '{}'::text[]))) or uw.fsrs_reps > 0)
    and (not ('active_error' = any(coalesce(p_filters, '{}'::text[]))) or (
      uw.meaning_error or uw.collocation_error or uw.grammar_error
      or uw.pronunciation_error or uw.spelling_error
    ))
    and (not ('due' = any(coalesce(p_filters, '{}'::text[]))) or (
      uw.fsrs_reps > 0 and uw.next_review_at <= p_as_of
    ))
    and (p_before_first_seen is null or p_before_id is null
      or (uw.first_seen_at, uw.id) < (p_before_first_seen, p_before_id))
  order by uw.first_seen_at desc, uw.id desc
  limit least(greatest(coalesce(p_limit, 50), 1), 101);
$$;

create or replace function public.get_analytics_review_days_v1(
  p_user_id uuid,
  p_as_of timestamptz,
  p_timezone text,
  p_days integer
) returns table(
  local_date date,
  first_review_count bigint,
  eligible_count bigint,
  successes bigint,
  failures bigint,
  invalid_rating_count bigint,
  below_interval_count bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with params as (
    select
      p_user_id as user_id,
      p_as_of as as_of,
      p_timezone as timezone,
      p_days as days,
      (p_as_of at time zone p_timezone)::date as today,
      ((p_as_of at time zone p_timezone)::date - (p_days + 28)) as history_start
  ), first_formal_review as (
    select distinct on (logs.word_id, (logs.reviewed_at at time zone params.timezone)::date)
      logs.word_id,
      (logs.reviewed_at at time zone params.timezone)::date as local_date,
      logs.rating,
      logs.scheduled_days
    from public.fsrs_review_logs as logs
    cross join params
    where logs.user_id = params.user_id
      and logs.review_source = 'review'
      and logs.reviewed_at <= params.as_of
      and (logs.reviewed_at at time zone params.timezone)::date >= params.history_start
    order by logs.word_id,
      (logs.reviewed_at at time zone params.timezone)::date,
      logs.reviewed_at,
      logs.id
  ), daily as (
    select
      first_formal_review.local_date,
      count(*) as first_review_count,
      count(*) filter (
        where first_formal_review.scheduled_days >= 1
          and first_formal_review.rating between 1 and 4
      ) as eligible_count,
      count(*) filter (
        where first_formal_review.scheduled_days >= 1
          and first_formal_review.rating in (2, 3, 4)
      ) as successes,
      count(*) filter (
        where first_formal_review.scheduled_days >= 1
          and first_formal_review.rating = 1
      ) as failures,
      count(*) filter (
        where first_formal_review.rating is null
          or first_formal_review.rating not between 1 and 4
      ) as invalid_rating_count,
      count(*) filter (where first_formal_review.scheduled_days < 1) as below_interval_count
    from first_formal_review
    group by first_formal_review.local_date
  ), calendar as (
    select (series.day)::date as local_date
    from params
    cross join lateral generate_series(
      params.history_start::timestamp,
      params.today::timestamp,
      interval '1 day'
    ) as series(day)
  )
  select
    calendar.local_date,
    coalesce(daily.first_review_count, 0),
    coalesce(daily.eligible_count, 0),
    coalesce(daily.successes, 0),
    coalesce(daily.failures, 0),
    coalesce(daily.invalid_rating_count, 0),
    coalesce(daily.below_interval_count, 0)
  from calendar
  left join daily using (local_date)
  order by calendar.local_date;
$$;

create or replace function public.get_analytics_due_distribution_v1(
  p_user_id uuid,
  p_as_of timestamptz,
  p_timezone text
) returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with params as (
    select
      p_user_id as user_id,
      p_as_of as as_of,
      p_timezone as timezone,
      (p_as_of at time zone p_timezone)::date as today
  ), scheduled as (
    select
      words.next_review_at,
      (words.next_review_at at time zone params.timezone)::date as due_date,
      params.today,
      params.as_of
    from public.user_words as words
    cross join params
    where words.user_id = params.user_id
      and words.fsrs_reps > 0
      and words.next_review_at is not null
  ), future_counts as (
    select scheduled.due_date, count(*) as due_count
    from scheduled
    cross join params
    where scheduled.due_date between params.today + 1 and params.today + 30
    group by scheduled.due_date
  ), future_calendar as (
    select (series.day)::date as due_date
    from params
    cross join lateral generate_series(
      (params.today + 1)::timestamp,
      (params.today + 30)::timestamp,
      interval '1 day'
    ) as series(day)
  )
  select jsonb_build_object(
    'overdue_previous_days', coalesce(count(*) filter (where scheduled.due_date < scheduled.today), 0),
    'due_today_elapsed', coalesce(count(*) filter (
      where scheduled.due_date = scheduled.today and scheduled.next_review_at <= scheduled.as_of
    ), 0),
    'due_today_later', coalesce(count(*) filter (
      where scheduled.due_date = scheduled.today and scheduled.next_review_at > scheduled.as_of
    ), 0),
    'future_days', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', future_calendar.due_date,
        'count', coalesce(future_counts.due_count, 0)
      ) order by future_calendar.due_date)
      from future_calendar
      left join future_counts using (due_date)
    ), '[]'::jsonb),
    'future_next_7_days', coalesce((
      select sum(future_counts.due_count)
      from future_counts cross join params
      where future_counts.due_date <= params.today + 7
    ), 0),
    'future_next_30_days', coalesce((select sum(due_count) from future_counts), 0)
  )
  from scheduled;
$$;

create or replace function public.get_analytics_error_matrix_v1(
  p_user_id uuid,
  p_as_of timestamptz,
  p_timezone text,
  p_days integer
) returns table(
  activity_type text,
  error_layer text,
  error_events bigint,
  distinct_words bigint,
  activity_attempts bigint,
  determinable_attempts bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with params as (
    select
      p_user_id as user_id,
      p_as_of as as_of,
      p_timezone as timezone,
      ((p_as_of at time zone p_timezone)::date - (p_days - 1)) as first_day
  ), selected_attempts as (
    select
      attempt.activity_type,
      case
        when attempt.error_layer in ('meaning', 'collocation', 'grammar', 'pronunciation', 'spelling') then attempt.error_layer
        else 'unclassified'
      end as normalized_error_layer,
      attempt.word_id,
      attempt.is_correct
    from public.attempts as attempt
    cross join params
    where attempt.user_id = params.user_id
      and attempt.created_at <= params.as_of
      and (attempt.created_at at time zone params.timezone)::date >= params.first_day
  ), activities as (
    select distinct activity_type from selected_attempts
  ), layers as (
    select unnest(array['meaning', 'collocation', 'grammar', 'pronunciation', 'spelling', 'unclassified']::text[]) as error_layer
  ), totals as (
    select
      selected_attempts.activity_type,
      count(*) as activity_attempts,
      count(*) filter (where normalized_error_layer <> 'unclassified') as determinable_attempts
    from selected_attempts
    group by selected_attempts.activity_type
  ), errors as (
    select
      selected_attempts.activity_type,
      selected_attempts.normalized_error_layer as error_layer,
      count(*) as error_events,
      count(distinct selected_attempts.word_id) as distinct_words
    from selected_attempts
    where selected_attempts.is_correct = false
    group by selected_attempts.activity_type, selected_attempts.normalized_error_layer
  )
  select
    activities.activity_type,
    layers.error_layer,
    coalesce(errors.error_events, 0),
    coalesce(errors.distinct_words, 0),
    totals.activity_attempts,
    totals.determinable_attempts
  from activities
  cross join layers
  join totals using (activity_type)
  left join errors on errors.activity_type = activities.activity_type and errors.error_layer = layers.error_layer
  order by activities.activity_type, layers.error_layer;
$$;

create or replace function public.get_analytics_activity_v1(
  p_user_id uuid,
  p_as_of timestamptz,
  p_timezone text,
  p_days integer
) returns table(
  local_date date,
  formal_review_count bigint,
  distinct_review_words bigint,
  pretest_count bigint,
  first_introductions bigint,
  capture_count bigint,
  ordinary_attempt_count bigint,
  distinct_attempt_words bigint,
  first_formal_learning_completion bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with params as (
    select
      p_user_id as user_id,
      p_as_of as as_of,
      p_timezone as timezone,
      (p_as_of at time zone p_timezone)::date as today,
      ((p_as_of at time zone p_timezone)::date - (p_days - 1)) as first_day
  ), calendar as (
    select (series.day)::date as local_date
    from params
    cross join lateral generate_series(
      params.first_day::timestamp,
      params.today::timestamp,
      interval '1 day'
    ) as series(day)
  ), daily_reviews as (
    select
      (logs.reviewed_at at time zone params.timezone)::date as local_date,
      count(*) filter (where logs.review_source = 'review') as formal_review_count,
      count(distinct logs.word_id) filter (where logs.review_source = 'review') as distinct_review_words,
      count(*) filter (where logs.review_source = 'pretest') as pretest_count
    from public.fsrs_review_logs as logs
    cross join params
    where logs.user_id = params.user_id
      and logs.review_source in ('review', 'pretest')
      and logs.reviewed_at <= params.as_of
      and (logs.reviewed_at at time zone params.timezone)::date >= params.first_day
    group by (logs.reviewed_at at time zone params.timezone)::date
  ), first_pretest as (
    select distinct on (logs.word_id)
      logs.word_id,
      (logs.reviewed_at at time zone params.timezone)::date as local_date
    from public.fsrs_review_logs as logs
    cross join params
    where logs.user_id = params.user_id
      and logs.review_source = 'pretest'
      and logs.reviewed_at <= params.as_of
    order by logs.word_id, logs.reviewed_at, logs.id
  ), daily_introductions as (
    select first_pretest.local_date, count(*) as first_introductions
    from first_pretest cross join params
    where first_pretest.local_date between params.first_day and params.today
    group by first_pretest.local_date
  ), daily_attempts as (
    select
      (attempt.created_at at time zone params.timezone)::date as local_date,
      count(*) as ordinary_attempt_count,
      count(distinct attempt.word_id) as distinct_attempt_words
    from public.attempts as attempt
    cross join params
    where attempt.user_id = params.user_id
      and attempt.created_at <= params.as_of
      and (attempt.created_at at time zone params.timezone)::date between params.first_day and params.today
    group by (attempt.created_at at time zone params.timezone)::date
  ), daily_captures as (
    select
      (occurrence.captured_at at time zone params.timezone)::date as local_date,
      count(*) as capture_count
    from public.captured_note_occurrences as occurrence
    cross join params
    where occurrence.user_id = params.user_id
      and occurrence.captured_at <= params.as_of
      and (occurrence.captured_at at time zone params.timezone)::date between params.first_day and params.today
    group by (occurrence.captured_at at time zone params.timezone)::date
  )
  select
    calendar.local_date,
    coalesce(daily_reviews.formal_review_count, 0),
    coalesce(daily_reviews.distinct_review_words, 0),
    coalesce(daily_reviews.pretest_count, 0),
    coalesce(daily_introductions.first_introductions, 0),
    coalesce(daily_captures.capture_count, 0),
    coalesce(daily_attempts.ordinary_attempt_count, 0),
    coalesce(daily_attempts.distinct_attempt_words, 0),
    null::bigint as first_formal_learning_completion
  from calendar
  left join daily_reviews using (local_date)
  left join daily_introductions using (local_date)
  left join daily_attempts using (local_date)
  left join daily_captures using (local_date)
  order by calendar.local_date;
$$;

revoke all on function public.get_analytics_review_days_v1(uuid, timestamptz, text, integer) from public, anon, authenticated;
revoke all on function public.list_user_vocabulary_v1(uuid, text, text[], timestamptz, uuid, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.get_analytics_due_distribution_v1(uuid, timestamptz, text) from public, anon, authenticated;
revoke all on function public.get_analytics_error_matrix_v1(uuid, timestamptz, text, integer) from public, anon, authenticated;
revoke all on function public.get_analytics_activity_v1(uuid, timestamptz, text, integer) from public, anon, authenticated;
grant execute on function public.get_analytics_review_days_v1(uuid, timestamptz, text, integer) to service_role;
grant execute on function public.list_user_vocabulary_v1(uuid, text, text[], timestamptz, uuid, integer, timestamptz) to service_role;
grant execute on function public.get_analytics_due_distribution_v1(uuid, timestamptz, text) to service_role;
grant execute on function public.get_analytics_error_matrix_v1(uuid, timestamptz, text, integer) to service_role;
grant execute on function public.get_analytics_activity_v1(uuid, timestamptz, text, integer) to service_role;


-- ===== supabase/migrations/20260929184221_progress_scheduled_stability_mean.sql =====
-- Keep the legacy progress response shape, but calculate stability only from
-- cards that have entered FSRS. The new Insights API provides null for an
-- empty/invalid sample; this compatibility field remains numeric for clients.
create or replace function public.get_progress_snapshot_v1(
  p_user_id uuid,
  p_now timestamptz
)
returns jsonb
language sql stable
set search_path = public, pg_temp
as $$
  with user_settings as (
    select
      coalesce(max(u.timezone), 'Asia/Shanghai') as time_zone,
      coalesce(max(u.daily_new_word_limit), 50)::integer as daily_new_word_limit
    from public.users as u
    where u.id = p_user_id
  ),
  calendar as (
    select
      time_zone,
      daily_new_word_limit,
      (p_now at time zone time_zone)::date as today_date
    from user_settings
  ),
  today_words as (
    select distinct on (diw.word_id)
      uw.status
    from public.daily_imports as di
    join public.daily_import_words as diw on diw.import_id = di.id
    join public.user_words as uw
      on uw.user_id = p_user_id
     and uw.word_id = diw.word_id
    cross join calendar as c
    where di.user_id = p_user_id
      and di.import_date = c.today_date
    order by diw.word_id, di.created_at, di.id, diw.position, diw.word_id
  ),
  today_counts as (
    select
      count(*)::integer as total,
      count(*) filter (where status = 'known')::integer as known,
      count(*) filter (where status = 'uncertain')::integer as uncertain,
      count(*) filter (where status = 'unknown')::integer as unknown,
      count(*) filter (where status <> 'new')::integer as completed
    from today_words
  ),
  all_counts as (
    select
      count(*)::integer as total_words,
      count(*) filter (where mastered)::integer as mastered,
      (
        count(*)
        - count(*) filter (where mastered)
        - count(*) filter (where (
          meaning_error or collocation_error or grammar_error
          or pronunciation_error or spelling_error
        ))
      )::integer as learning,
      count(*) filter (where (
        meaning_error or collocation_error or grammar_error
        or pronunciation_error or spelling_error
      ))::integer as error_book
    from public.user_words
    where user_id = p_user_id
  ),
  fsrs_counts as (
    select
      count(*) filter (where uw.next_review_at <= p_now)::integer as due_now,
      count(*) filter (where uw.next_review_at is not null
        and (uw.next_review_at at time zone c.time_zone)::date <= c.today_date)::integer as due_today,
      count(*) filter (where uw.next_review_at is not null
        and (uw.next_review_at at time zone c.time_zone)::date = (c.today_date + 1))::integer as tomorrow,
      count(*) filter (where uw.next_review_at is not null
        and (uw.next_review_at at time zone c.time_zone)::date <= (c.today_date + 7))::integer as due_next_7_days,
      coalesce(round((avg(uw.fsrs_stability) filter (
        where uw.fsrs_reps > 0
          and uw.fsrs_stability > 0
          and uw.fsrs_stability < 'Infinity'::double precision
      ))::numeric, 2), 0)::double precision as average_stability
    from public.user_words as uw
    cross join calendar as c
    where uw.user_id = p_user_id
      and uw.fsrs_reps > 0
  )
  select jsonb_build_object(
    'today', jsonb_build_object(
      'total', tc.total, 'known', tc.known, 'uncertain', tc.uncertain,
      'unknown', tc.unknown, 'completed', tc.completed
    ),
    'all_time', jsonb_build_object(
      'total_words', ac.total_words, 'mastered', ac.mastered,
      'learning', ac.learning, 'error_book', ac.error_book
    ),
    'fsrs', jsonb_build_object(
      'due_now', fc.due_now, 'due_today', fc.due_today,
      'tomorrow', fc.tomorrow, 'due_next_7_days', fc.due_next_7_days,
      'average_stability', fc.average_stability
    ),
    'settings', jsonb_build_object('daily_new_word_limit', c.daily_new_word_limit)
  )
  from today_counts as tc
  cross join all_counts as ac
  cross join fsrs_counts as fc
  cross join calendar as c;
$$;

revoke all on function public.get_progress_snapshot_v1(uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.get_progress_snapshot_v1(uuid, timestamptz) to service_role;
