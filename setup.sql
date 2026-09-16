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


