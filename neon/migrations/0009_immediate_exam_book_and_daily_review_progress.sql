-- Switching a study book changes today's target immediately. Preserve the
-- existing queue and session snapshots, and only move the preference boundary and
-- today's target row.
CREATE OR REPLACE FUNCTION public.set_exam_book_v1(p_user_id uuid, p_book_id text)
RETURNS jsonb
LANGUAGE sql
SET search_path TO public
AS $function$
WITH
user_context AS MATERIALIZED (
  SELECT id AS user_id, (now() AT TIME ZONE timezone)::date AS local_date
    FROM public.users
   WHERE id = p_user_id
),
private_access AS MATERIALIZED (
  SELECT EXISTS (
           SELECT 1 FROM public.word_sources
            WHERE user_id = p_user_id AND source_book_id = 'ougkp'
         ) AND EXISTS (
           SELECT 1 FROM public.word_sources
            WHERE user_id = p_user_id AND source_book_id = 'athgc'
         ) AS has_private_kaoyan
),
access_check AS MATERIALIZED (
  SELECT EXISTS (
           SELECT 1 FROM public.exam_books
            WHERE id = p_book_id
              AND public.can_access_exam_book_v1(p_user_id, id)
         ) OR (
           p_book_id = 'kaoyan'
           AND (SELECT has_private_kaoyan FROM private_access)
         ) AS allowed
),
guard AS MATERIALIZED (
  SELECT context.user_id,
         context.local_date,
         private_access.has_private_kaoyan,
         CASE WHEN context.user_id IS NOT NULL THEN 1
              ELSE ('unknown-user:' || coalesce(p_user_id::text, 'null'))::integer
          END AS valid_user,
         CASE WHEN access_check.allowed THEN 1
              ELSE ('book-unavailable:' || coalesce(p_user_id::text, 'null'))::integer
          END AS valid_book
    FROM (VALUES (1)) AS singleton(value)
    LEFT JOIN user_context AS context ON true
    CROSS JOIN private_access
    CROSS JOIN access_check
),
lock_row AS MATERIALIZED (
  SELECT pg_advisory_xact_lock(hashtextextended(p_user_id::text, 482))
),
previous_book AS MATERIALIZED (
  SELECT CASE
           WHEN preference.user_id IS NULL AND guard.has_private_kaoyan THEN 'kaoyan'
           WHEN preference.effective_date > guard.local_date THEN preference.previous_book_id
           ELSE preference.book_id
         END AS previous_book_id
    FROM guard
    LEFT JOIN public.user_book_preferences AS preference
      ON preference.user_id = p_user_id
),
preference_write AS (
  INSERT INTO public.user_book_preferences(user_id, book_id, previous_book_id, effective_date)
  SELECT p_user_id, p_book_id, previous_book.previous_book_id, guard.local_date
    FROM guard
    CROSS JOIN lock_row
    CROSS JOIN previous_book
   WHERE guard.valid_user = 1 AND guard.valid_book = 1
  ON CONFLICT (user_id) DO UPDATE
    SET book_id = EXCLUDED.book_id,
        previous_book_id = EXCLUDED.previous_book_id,
        effective_date = EXCLUDED.effective_date,
        updated_at = now()
  RETURNING user_id
),
target_write AS (
  INSERT INTO public.daily_book_targets(user_id, local_date, book_id, private_kaoyan)
  SELECT p_user_id, guard.local_date, p_book_id,
         p_book_id = 'kaoyan' AND guard.has_private_kaoyan
    FROM guard
    JOIN preference_write ON true
   WHERE guard.valid_user = 1 AND guard.valid_book = 1
  ON CONFLICT (user_id, local_date) DO UPDATE
    SET book_id = EXCLUDED.book_id,
        private_kaoyan = EXCLUDED.private_kaoyan
  RETURNING local_date
)
SELECT jsonb_build_object('book_id', p_book_id, 'effective_date', target_write.local_date)
  FROM target_write
$function$;

-- Support the per-user, local-day count of completed formal review events.
CREATE INDEX IF NOT EXISTS fsrs_review_logs_user_reviewed_at_idx
  ON public.fsrs_review_logs(user_id, reviewed_at)
  WHERE review_source = 'review';
