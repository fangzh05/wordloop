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
