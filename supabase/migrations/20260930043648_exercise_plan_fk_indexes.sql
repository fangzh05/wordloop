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
