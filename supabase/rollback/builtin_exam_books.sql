-- Non-destructive rollback: restore the captured LIVE allocator and hide books.
-- Keep all personal preferences and lazily enrolled cards for data preservation.
begin;
drop function public.prepare_daily_new_words_budget_v1(uuid,date,integer);
alter function public.prepare_daily_new_words_pre_exam_v1(uuid,date,integer) rename to prepare_daily_new_words_budget_v1;
update public.exam_books set is_public=false,is_available=false;
commit;
-- Roll back the application commit too. Do not delete any words/user_words,
-- daily tasks, sessions, review logs, dictionary entries or private sources.
