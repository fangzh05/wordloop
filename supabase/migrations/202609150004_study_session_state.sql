alter table public.study_sessions
  add column if not exists state jsonb not null default '{}'::jsonb,
  add column if not exists updated_at timestamptz not null default now();

create index if not exists study_sessions_active_idx
  on public.study_sessions(user_id, started_at desc)
  where ended_at is null;
