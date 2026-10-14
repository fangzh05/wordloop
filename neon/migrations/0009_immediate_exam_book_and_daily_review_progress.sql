-- Switching a study book changes today's target immediately. Preserve the
-- existing queue and session snapshots, and only move the preference boundary and
-- today's target row.
CREATE OR REPLACE FUNCTION public.set_exam_book_v1(p_user_id uuid, p_book_id text)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path TO public
AS $function$
DECLARE
  d date;
  old text;
  private_book boolean;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text, 482));

  SELECT (now() AT TIME ZONE timezone)::date
    INTO d
    FROM public.users
   WHERE id = p_user_id;
  IF d IS NULL THEN RAISE EXCEPTION 'Unknown user'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.exam_books
     WHERE id = p_book_id
       AND public.can_access_exam_book_v1(p_user_id, id)
  ) AND NOT (
    p_book_id = 'kaoyan'
    AND EXISTS (SELECT 1 FROM public.word_sources WHERE user_id = p_user_id AND source_book_id = 'ougkp')
    AND EXISTS (SELECT 1 FROM public.word_sources WHERE user_id = p_user_id AND source_book_id = 'athgc')
  ) THEN
    RAISE EXCEPTION 'Book unavailable';
  END IF;

  SELECT CASE WHEN effective_date > d THEN previous_book_id ELSE book_id END
    INTO old
    FROM public.user_book_preferences
   WHERE user_id = p_user_id;
  IF NOT FOUND
     AND EXISTS (SELECT 1 FROM public.word_sources WHERE user_id = p_user_id AND source_book_id = 'ougkp')
     AND EXISTS (SELECT 1 FROM public.word_sources WHERE user_id = p_user_id AND source_book_id = 'athgc') THEN
    old := 'kaoyan';
  END IF;

  private_book := p_book_id = 'kaoyan'
    AND EXISTS (SELECT 1 FROM public.word_sources WHERE user_id = p_user_id AND source_book_id = 'ougkp')
    AND EXISTS (SELECT 1 FROM public.word_sources WHERE user_id = p_user_id AND source_book_id = 'athgc');

  INSERT INTO public.user_book_preferences(user_id, book_id, previous_book_id, effective_date)
  VALUES (p_user_id, p_book_id, old, d)
  ON CONFLICT (user_id) DO UPDATE
    SET book_id = EXCLUDED.book_id,
        previous_book_id = EXCLUDED.previous_book_id,
        effective_date = EXCLUDED.effective_date,
        updated_at = now();

  INSERT INTO public.daily_book_targets(user_id, local_date, book_id, private_kaoyan)
  VALUES (p_user_id, d, p_book_id, private_book)
  ON CONFLICT (user_id, local_date) DO UPDATE
    SET book_id = EXCLUDED.book_id,
        private_kaoyan = EXCLUDED.private_kaoyan;

  RETURN jsonb_build_object('book_id', p_book_id, 'effective_date', d);
END;
$function$;

-- Preferences dated in the future were created by the old next-day selector.
-- Move those targets to each user's local today and refresh today's cached target.
WITH changed AS (
  UPDATE public.user_book_preferences AS preference
     SET effective_date = (now() AT TIME ZONE COALESCE(user_row.timezone, 'Asia/Shanghai'))::date,
         updated_at = now()
    FROM public.users AS user_row
   WHERE preference.user_id = user_row.id
     AND preference.effective_date > (now() AT TIME ZONE COALESCE(user_row.timezone, 'Asia/Shanghai'))::date
  RETURNING preference.user_id, preference.book_id
)
INSERT INTO public.daily_book_targets(user_id, local_date, book_id, private_kaoyan)
SELECT changed.user_id,
       (now() AT TIME ZONE COALESCE(user_row.timezone, 'Asia/Shanghai'))::date,
       changed.book_id,
       changed.book_id = 'kaoyan'
         AND EXISTS (SELECT 1 FROM public.word_sources WHERE user_id = changed.user_id AND source_book_id = 'ougkp')
         AND EXISTS (SELECT 1 FROM public.word_sources WHERE user_id = changed.user_id AND source_book_id = 'athgc')
  FROM changed
  JOIN public.users AS user_row ON user_row.id = changed.user_id
ON CONFLICT (user_id, local_date) DO UPDATE
  SET book_id = EXCLUDED.book_id,
      private_kaoyan = EXCLUDED.private_kaoyan;

-- Support the per-user, local-day count of completed formal review events.
CREATE INDEX IF NOT EXISTS fsrs_review_logs_user_reviewed_at_idx
  ON public.fsrs_review_logs(user_id, reviewed_at)
  WHERE review_source = 'review';
