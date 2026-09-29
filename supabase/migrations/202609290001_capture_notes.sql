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
