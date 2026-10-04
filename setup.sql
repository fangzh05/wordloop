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


alter table public.study_sessions
  add column if not exists state jsonb not null default '{}'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists study_sessions_active_idx
  on public.study_sessions(user_id, started_at desc)
  where ended_at is null;


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


-- Cover the new foreign keys reported by the post-migration Supabase advisor.
create index if not exists exercise_skill_evidence_word_idx
  on public.exercise_skill_evidence(word_id);
create index if not exists exercise_submission_events_session_idx
  on public.exercise_submission_events(session_id);
create index if not exists exercise_submission_events_word_idx
  on public.exercise_submission_events(word_id);
create index if not exists lesson_word_completion_credits_session_idx
  on public.lesson_word_completion_credits(session_id);
create index if not exists lesson_word_completion_credits_word_idx
  on public.lesson_word_completion_credits(word_id);


-- Attribute consolidation submissions to their planned target while retaining the frozen Lesson cursor.
CREATE OR REPLACE FUNCTION public.record_planned_submission_v1(p_user_id uuid, p_session_id uuid, p_expected_revision timestamp with time zone, p_submission_id uuid, p_plan_id uuid, p_exercise_id uuid, p_scope text, p_normalized_word text, p_activity_type text, p_user_answer text, p_is_correct boolean, p_error_layer text, p_skill_ids text[], p_skill_evidence jsonb, p_first_attempt boolean, p_hint_used boolean, p_answer_revealed boolean, p_active_ms integer, p_grading_ms integer, p_next_state jsonb, p_new_words_count integer, p_review_words_count integer, p_completion_date date, p_cadence_candidates jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- The Lesson cursor remains at the final queue word. A consolidation plan
  -- may train a different word; attribute its attempt and evidence to that target.
  if p_scope = 'consolidation' and v_session.state #>> '{payload,plan,word_id}' is not null then
    select id into v_word_id from words
      where id::text = v_session.state #>> '{payload,plan,word_id}';
    if v_word_id is null or not coalesce(
      (v_session.state #> '{payload,plan,target_word_ids}') ? v_word_id::text, false)
    then raise exception 'PLANNED_WORD_MISMATCH'; end if;
  end if;
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
$function$


-- Independent FSRS scheduling for explicitly enabled Capture notes.
-- This migration never writes words, user_words, daily queues, attempts,
-- review logs, or study sessions.

create table if not exists public.note_review_states (
  user_id uuid not null references public.users(id) on delete cascade,
  captured_note_id uuid not null,
  enabled boolean not null default false,
  card jsonb not null check (jsonb_typeof(card) = 'object'),
  due timestamptz not null,
  revision bigint not null default 0 check (revision >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, captured_note_id),
  foreign key (user_id, captured_note_id)
    references public.captured_notes(user_id, id) on delete cascade
);

create table if not exists public.note_review_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  captured_note_id uuid not null,
  idempotency_key uuid not null,
  expected_revision bigint not null check (expected_revision >= 0),
  expected_note_updated_at timestamptz not null,
  rating text not null check (rating in ('again', 'good')),
  request_payload jsonb not null check (jsonb_typeof(request_payload) = 'object'),
  server_time timestamptz not null,
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key),
  foreign key (user_id, captured_note_id)
    references public.captured_notes(user_id, id) on delete cascade
);

create index if not exists note_review_states_user_due_idx
  on public.note_review_states(user_id, due asc, captured_note_id asc)
  where enabled = true;
create index if not exists note_review_events_user_note_created_idx
  on public.note_review_events(user_id, captured_note_id, created_at desc);

alter table public.note_review_states enable row level security;
alter table public.note_review_events enable row level security;
revoke all on public.note_review_states, public.note_review_events from public, anon, authenticated;
grant select, insert, update, delete on public.note_review_states, public.note_review_events to service_role;

create or replace function public.list_note_review_candidates_v1(
  p_user_id uuid,
  p_now timestamptz,
  p_limit integer
) returns table(
  note_id uuid,
  selected_text text,
  note text,
  note_updated_at timestamptz,
  due timestamptz,
  revision bigint,
  latest_context_text text,
  latest_source_type text,
  latest_source_title text,
  latest_source_url text,
  latest_captured_at timestamptz,
  total_count bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    n.id,
    n.selected_text,
    n.note,
    n.updated_at,
    s.due,
    s.revision,
    latest.context_text,
    latest.source_type,
    latest.source_title,
    latest.source_url,
    latest.captured_at,
    count(*) over () as total_count
  from public.note_review_states as s
  join public.captured_notes as n
    on n.user_id = s.user_id and n.id = s.captured_note_id
  left join lateral (
    select o.context_text, o.source_type, o.source_title, o.source_url, o.captured_at
    from public.captured_note_occurrences as o
    where o.user_id = n.user_id and o.captured_note_id = n.id
    order by o.captured_at desc, o.id desc
    limit 1
  ) as latest on true
  where s.user_id = p_user_id
    and s.enabled
    and s.due <= p_now
    and n.status in ('inbox', 'saved')
    and n.converted_user_word_id is null
    and length(btrim(n.note)) > 0
  order by s.due asc, n.id asc
  limit least(greatest(coalesce(p_limit, 10), 1), 10);
$$;

create or replace function public.set_note_review_enabled_v1(
  p_user_id uuid,
  p_captured_note_id uuid,
  p_enabled boolean,
  p_initial_card jsonb,
  p_now timestamptz
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_note public.captured_notes%rowtype;
  v_state public.note_review_states%rowtype;
  v_initial_due timestamptz;
begin
  select * into v_note
  from public.captured_notes
  where user_id = p_user_id and id = p_captured_note_id
  for update;

  if not found then raise exception 'NOTE_REVIEW_NOT_FOUND'; end if;

  if p_enabled and (v_note.status not in ('inbox', 'saved') or v_note.converted_user_word_id is not null) then
    raise exception 'NOTE_REVIEW_NOT_ELIGIBLE';
  end if;
  if p_enabled and length(btrim(v_note.note)) = 0 then
    raise exception 'NOTE_REVIEW_NOTE_EMPTY';
  end if;

  select * into v_state
  from public.note_review_states
  where user_id = p_user_id and captured_note_id = p_captured_note_id
  for update;

  if not found then
    if not p_enabled then
      return jsonb_build_object(
        'note_id', p_captured_note_id,
        'enabled', false,
        'due', null,
        'revision', null,
        'card', null
      );
    end if;
    if p_initial_card is null or jsonb_typeof(p_initial_card) <> 'object' or not (p_initial_card ? 'due') then
      raise exception 'NOTE_REVIEW_INVALID_CARD';
    end if;
    v_initial_due := (p_initial_card->>'due')::timestamptz;
    insert into public.note_review_states(
      user_id, captured_note_id, enabled, card, due, revision, created_at, updated_at
    ) values (
      p_user_id, p_captured_note_id, true, p_initial_card, v_initial_due, 0, p_now, p_now
    ) returning * into v_state;
  elsif v_state.enabled is distinct from p_enabled then
    update public.note_review_states
    set enabled = p_enabled, revision = v_state.revision + 1, updated_at = p_now
    where user_id = p_user_id and captured_note_id = p_captured_note_id
    returning * into v_state;
  end if;

  return jsonb_build_object(
    'note_id', v_state.captured_note_id,
    'enabled', v_state.enabled,
    'due', v_state.due,
    'revision', v_state.revision,
    'card', v_state.card
  );
end;
$$;

create or replace function public.record_note_review_rating_v1(
  p_user_id uuid,
  p_captured_note_id uuid,
  p_rating text,
  p_expected_revision bigint,
  p_expected_note_updated_at timestamptz,
  p_idempotency_key uuid,
  p_request_payload jsonb,
  p_next_card jsonb,
  p_server_time timestamptz
) returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_event public.note_review_events%rowtype;
  v_note public.captured_notes%rowtype;
  v_state public.note_review_states%rowtype;
  v_result jsonb;
  v_due timestamptz;
begin
  if p_rating not in ('again', 'good') then raise exception 'NOTE_REVIEW_INVALID_RATING'; end if;

  select * into v_event
  from public.note_review_events
  where user_id = p_user_id and idempotency_key = p_idempotency_key;
  if found then
    if v_event.captured_note_id is distinct from p_captured_note_id
      or v_event.request_payload <> p_request_payload then
      raise exception 'NOTE_REVIEW_IDEMPOTENCY_CONFLICT';
    end if;
    return v_event.result || jsonb_build_object('replayed', true);
  end if;

  select * into v_note
  from public.captured_notes
  where user_id = p_user_id and id = p_captured_note_id
  for update;
  if not found then raise exception 'NOTE_REVIEW_NOT_FOUND'; end if;

  -- Recheck after waiting for the note lock so two simultaneous requests with
  -- the same key replay the committed result instead of racing the revision.
  select * into v_event
  from public.note_review_events
  where user_id = p_user_id and idempotency_key = p_idempotency_key
  for update;
  if found then
    if v_event.captured_note_id is distinct from p_captured_note_id
      or v_event.request_payload <> p_request_payload then
      raise exception 'NOTE_REVIEW_IDEMPOTENCY_CONFLICT';
    end if;
    return v_event.result || jsonb_build_object('replayed', true);
  end if;

  select * into v_state
  from public.note_review_states
  where user_id = p_user_id and captured_note_id = p_captured_note_id
  for update;
  if not found then raise exception 'NOTE_REVIEW_NOT_ELIGIBLE'; end if;
  if not v_state.enabled
    or v_note.status not in ('inbox', 'saved')
    or v_note.converted_user_word_id is not null
    or length(btrim(v_note.note)) = 0 then
    raise exception 'NOTE_REVIEW_NOT_ELIGIBLE';
  end if;
  if v_state.revision <> p_expected_revision then raise exception 'NOTE_REVIEW_REVISION_CONFLICT'; end if;
  if v_note.updated_at is distinct from p_expected_note_updated_at then raise exception 'NOTE_REVIEW_CONTENT_CHANGED'; end if;
  if v_state.due > p_server_time then raise exception 'NOTE_REVIEW_NOT_DUE'; end if;
  if p_next_card is null
    or jsonb_typeof(p_next_card) <> 'object'
    or not (p_next_card ? 'due')
    or not (p_next_card ? 'stability')
    or not (p_next_card ? 'difficulty')
    or not (p_next_card ? 'elapsed_days')
    or not (p_next_card ? 'scheduled_days')
    or not (p_next_card ? 'learning_steps')
    or not (p_next_card ? 'reps')
    or not (p_next_card ? 'lapses')
    or not (p_next_card ? 'state') then
    raise exception 'NOTE_REVIEW_INVALID_CARD';
  end if;

  v_due := (p_next_card->>'due')::timestamptz;
  update public.note_review_states
  set card = p_next_card,
      due = v_due,
      revision = v_state.revision + 1,
      updated_at = p_server_time
  where user_id = p_user_id and captured_note_id = p_captured_note_id;

  v_result := jsonb_build_object(
    'note_id', p_captured_note_id,
    'enabled', true,
    'due', v_due,
    'revision', v_state.revision + 1,
    'card', p_next_card,
    'rating', p_rating,
    'server_time', p_server_time
  );

  insert into public.note_review_events(
    user_id, captured_note_id, idempotency_key, expected_revision,
    expected_note_updated_at, rating, request_payload, server_time, result
  ) values (
    p_user_id, p_captured_note_id, p_idempotency_key, p_expected_revision,
    p_expected_note_updated_at, p_rating, p_request_payload, p_server_time, v_result
  );

  return v_result;
end;
$$;

create or replace function public.note_review_schema_v1()
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select to_regclass('public.note_review_states') is not null
    and to_regclass('public.note_review_events') is not null
    and to_regprocedure('public.list_note_review_candidates_v1(uuid,timestamptz,integer)') is not null
    and to_regprocedure('public.set_note_review_enabled_v1(uuid,uuid,boolean,jsonb,timestamptz)') is not null
    and to_regprocedure('public.record_note_review_rating_v1(uuid,uuid,text,bigint,timestamptz,uuid,jsonb,jsonb,timestamptz)') is not null;
$$;

revoke all on function public.list_note_review_candidates_v1(uuid, timestamptz, integer) from public, anon, authenticated;
revoke all on function public.set_note_review_enabled_v1(uuid, uuid, boolean, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.record_note_review_rating_v1(uuid, uuid, text, bigint, timestamptz, uuid, jsonb, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function public.note_review_schema_v1() from public, anon, authenticated;
grant execute on function public.list_note_review_candidates_v1(uuid, timestamptz, integer) to service_role;
grant execute on function public.set_note_review_enabled_v1(uuid, uuid, boolean, jsonb, timestamptz) to service_role;
grant execute on function public.record_note_review_rating_v1(uuid, uuid, text, bigint, timestamptz, uuid, jsonb, jsonb, timestamptz) to service_role;
grant execute on function public.note_review_schema_v1() to service_role;


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

-- BKT active planner mode
-- Enable the additional mode without changing budget settings, evidence, or FSRS.
alter table public.learning_settings drop constraint learning_settings_bkt_mode_check;
alter table public.learning_settings add constraint learning_settings_bkt_mode_check
  check (bkt_mode in ('off','shadow','active'));

-- Fresh rows retain the shadow default. Activate a learner explicitly after deployment.

-- Finish each immutable Review snapshot before handing off to learning.
-- Preserve the existing budget, FSRS cards, learning history and assignment lock.
create or replace function public.learning_budget_snapshot_v1(p_user_id uuid) returns jsonb language plpgsql set search_path=public as $$
declare d date; tz text; minutes integer; extra integer; used integer; due integer; overdue integer; cap integer; forecasts jsonb; enabled boolean; started integer;
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
 select count(*) into started from (
 select word_id,min(reviewed_at) as first_pretest from public.fsrs_review_logs
 where user_id=p_user_id and review_source='pretest' group by word_id
 ) firsts where (first_pretest at time zone tz)::date=d;
 return jsonb_build_object('date',d,'daily_minutes',minutes,'extra_seconds',coalesce(extra,0),'estimated_used_seconds',used,
 'remaining_seconds',greatest(0,minutes*60+coalesce(extra,0)-used),'due_count',due,'overdue_count',overdue,
 'new_words_started_today',started,'new_word_cap',coalesce(cap,50),'forecast',forecasts,'cost_version','static-v1','enabled',enabled);
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
    if (v_budget->>'overdue_count')::integer>0 then
      v_limit:=least(v_limit,6,coalesce((v_budget->>'new_words_started_today')::integer,0)
        +floor(greatest(0,(v_budget->>'remaining_seconds')::integer)/77.0)::integer);
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
