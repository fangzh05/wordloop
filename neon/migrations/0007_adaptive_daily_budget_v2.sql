-- Adaptive Daily Study Budget V2. Additive to the existing Neon learning state.
-- Existing user limits and learning history are preserved. New accounts receive
-- a 20-word safety ceiling, while the adaptive target remains computed in TS.
ALTER TABLE public.users
  ALTER COLUMN daily_new_word_limit SET DEFAULT 20;

ALTER TABLE public.user_words
  ADD COLUMN IF NOT EXISTS formally_introduced_date date,
  ADD COLUMN IF NOT EXISTS formally_introduced_session_id uuid REFERENCES public.study_sessions(id);

ALTER TABLE public.learning_budget_days
  ADD COLUMN IF NOT EXISTS review_override boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS user_words_formal_introduction_day_idx
  ON public.user_words(user_id, formally_introduced_date)
  WHERE formally_introduced_date IS NOT NULL;

ALTER TABLE public.user_book_preferences
  ADD COLUMN IF NOT EXISTS exam_deadline date,
  ADD COLUMN IF NOT EXISTS coverage_target integer;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.user_book_preferences'::regclass
      AND conname = 'user_book_preferences_coverage_target_check'
  ) THEN
    ALTER TABLE public.user_book_preferences
      ADD CONSTRAINT user_book_preferences_coverage_target_check
      CHECK (coverage_target IS NULL OR coverage_target BETWEEN 1 AND 100000);
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.set_adaptive_exam_goal_v2(
  p_user_id uuid,
  p_exam_deadline date DEFAULT NULL,
  p_coverage_target integer DEFAULT NULL
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF p_user_id IS DISTINCT FROM public.wordloop_authenticated_user_id() THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  IF p_coverage_target IS NOT NULL AND p_coverage_target NOT BETWEEN 1 AND 100000 THEN
    RAISE EXCEPTION 'COVERAGE_TARGET_INVALID';
  END IF;
  UPDATE public.user_book_preferences
    SET exam_deadline=p_exam_deadline,
        coverage_target=p_coverage_target,
        updated_at=now()
    WHERE user_id=p_user_id;
  RETURN FOUND;
END $$;

CREATE OR REPLACE FUNCTION public.learning_budget_snapshot_v1(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  d date;
  tz text;
  minutes integer;
  extra integer;
  reserved integer;
  actual integer;
  due integer;
  overdue integer;
  outstanding_due integer;
  outstanding_overdue integer;
  young integer;
  daily_review_load numeric;
  cap integer;
  forecasts jsonb;
  enabled boolean;
  allow_review boolean;
  started integer;
  first_answers integer;
  first_correct integer;
  exam jsonb;
  time_history jsonb;
  new_word_history jsonb;
BEGIN
  IF p_user_id IS DISTINCT FROM public.wordloop_authenticated_user_id() THEN
    RAISE EXCEPTION 'UNAUTHORIZED';
  END IF;
  SELECT coalesce(timezone,'Asia/Shanghai'), daily_new_word_limit
    INTO tz,cap FROM public.users WHERE id=p_user_id;
  tz:=coalesce(tz,'Asia/Shanghai');
  d:=(now() at time zone tz)::date;
  SELECT daily_minutes,budget_enabled INTO minutes,enabled
    FROM public.learning_settings WHERE user_id=p_user_id;
  minutes:=coalesce(minutes,45); enabled:=coalesce(enabled,true);
  SELECT coalesce(bd.extra_seconds,0),coalesce(bd.review_override,false) INTO extra,allow_review
    FROM public.learning_budget_days bd WHERE bd.user_id=p_user_id AND bd.local_date=d;
  SELECT coalesce(sum(estimated_seconds),0)::integer INTO reserved
    FROM public.learning_budget_events WHERE user_id=p_user_id AND local_date=d;
  SELECT coalesce(sum(total_ms)/1000,0)::integer INTO actual
    FROM public.user_learning_time_daily
    WHERE user_id=p_user_id AND local_date=d AND model_version='personal-time-v2-pilot'
      AND activity_type<>'__complete_new_word__';
  SELECT count(*) FILTER(WHERE uw.next_review_at<=now()),
         count(*) FILTER(WHERE (uw.next_review_at AT TIME ZONE tz)::date<d)
    INTO outstanding_due,outstanding_overdue
    FROM public.user_words uw WHERE uw.user_id=p_user_id AND uw.next_review_at IS NOT NULL;
  -- A due Review already frozen by a same-day reservation is priced in
  -- `reserved`; exclude it from the planner's remaining Review estimate.
  SELECT count(*) FILTER(WHERE uw.next_review_at<=now()),
         count(*) FILTER(WHERE (uw.next_review_at AT TIME ZONE tz)::date<d)
    INTO due,overdue
    FROM public.user_words uw
    WHERE uw.user_id=p_user_id AND uw.next_review_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.learning_budget_events e
        WHERE e.user_id=p_user_id AND e.local_date=d AND e.activity_type='review'
          AND split_part(e.task_key,':',2)=uw.word_id::text
      );
  SELECT count(*) FILTER(WHERE fsrs_scheduled_days<21),
      coalesce(sum(1.0/greatest(1,fsrs_scheduled_days)),0)
    INTO young,daily_review_load FROM public.user_words
    WHERE user_id=p_user_id AND next_review_at IS NOT NULL AND fsrs_reps>0;
  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'date',day,'review_count',review_count,'review_seconds',review_count*8
    ) ORDER BY day),'[]'::jsonb)
    INTO forecasts
    FROM (
      SELECT d+i AS day,count(uw.id)::integer AS review_count
      FROM generate_series(0,14) i
      LEFT JOIN public.user_words uw
        ON uw.user_id=p_user_id
       AND (uw.next_review_at AT TIME ZONE tz)::date=d+i
       AND uw.next_review_at IS NOT NULL
      GROUP BY i
    ) f;
  WITH first_lesson AS (
    SELECT w.normalized_word,min((a.created_at AT TIME ZONE tz)::date) AS intro_date
    FROM public.attempts a JOIN public.words w ON w.id=a.word_id
    WHERE a.user_id=p_user_id AND a.scope='lesson'
    GROUP BY w.normalized_word
  ), introductions AS (
    SELECT w.normalized_word,coalesce(uw.formally_introduced_date,fl.intro_date) AS intro_date
    FROM public.user_words uw JOIN public.words w ON w.id=uw.word_id
    LEFT JOIN first_lesson fl ON fl.normalized_word=w.normalized_word
    WHERE uw.user_id=p_user_id
  ), canonical_introductions AS (
    SELECT normalized_word,min(intro_date) AS intro_date
    FROM introductions WHERE intro_date IS NOT NULL GROUP BY normalized_word
  )
  SELECT count(*) INTO started FROM canonical_introductions WHERE intro_date=d;
  SELECT count(*) FILTER(WHERE is_correct),count(*)
    INTO first_correct,first_answers
    FROM public.attempts
    WHERE user_id=p_user_id AND scope='lesson' AND first_attempt
      AND NOT coalesce(hint_used,false) AND NOT coalesce(answer_revealed,false)
      AND created_at >= now()-interval '14 days';

  SELECT coalesce(jsonb_agg(jsonb_build_object(
      'date',day,'effective_seconds',seconds,'samples',samples
    ) ORDER BY day),'[]'::jsonb)
    INTO time_history
    FROM (
      SELECT d-i AS day,
        coalesce(sum(t.total_ms)/1000,0)::integer AS seconds,
        coalesce(sum(t.samples),0)::integer AS samples
      FROM generate_series(0,13) i
      LEFT JOIN public.user_learning_time_daily t
        ON t.user_id=p_user_id AND t.local_date=d-i
       AND t.model_version='personal-time-v2-pilot'
       AND t.activity_type<>'__complete_new_word__'
      GROUP BY i
    ) h;
  WITH first_lesson AS (
    SELECT w.normalized_word,min((a.created_at AT TIME ZONE tz)::date) AS intro_date
    FROM public.attempts a JOIN public.words w ON w.id=a.word_id
    WHERE a.user_id=p_user_id AND a.scope='lesson'
    GROUP BY w.normalized_word
  ), introductions AS (
    SELECT w.normalized_word,coalesce(uw.formally_introduced_date,fl.intro_date) AS intro_date
    FROM public.user_words uw JOIN public.words w ON w.id=uw.word_id
    LEFT JOIN first_lesson fl ON fl.normalized_word=w.normalized_word
    WHERE uw.user_id=p_user_id
  ), canonical_introductions AS (
    SELECT normalized_word,min(intro_date) AS intro_date
    FROM introductions WHERE intro_date IS NOT NULL GROUP BY normalized_word
  ), daily AS (
    SELECT intro_date,count(*)::integer AS word_count FROM canonical_introductions GROUP BY intro_date
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object('date',d-i,'new_words',coalesce(daily.word_count,0)) ORDER BY d-i),'[]'::jsonb)
    INTO new_word_history
    FROM generate_series(0,13) i LEFT JOIN daily ON daily.intro_date=d-i;

  SELECT CASE WHEN pref.user_id IS NULL THEN NULL ELSE jsonb_build_object(
      'book_id',pref.book_id,
      'target_date',pref.exam_deadline,
      'coverage_target',pref.coverage_target,
      'total_unique_words',counts.total_words,
      'covered_unique_words',counts.covered_words,
      'remaining_unique_words',greatest(0,least(coalesce(pref.coverage_target,counts.total_words),counts.total_words)-counts.covered_words)
    ) END
    INTO exam
    FROM (SELECT 1) seed
    LEFT JOIN public.user_book_preferences pref
      ON pref.user_id=p_user_id
    LEFT JOIN LATERAL (
      WITH target_words AS (
        SELECT bw.normalized_word
        FROM public.exam_book_words bw
        JOIN public.exam_books b ON b.id=bw.book_id AND b.is_public AND b.is_available
        WHERE bw.book_id=pref.book_id
        UNION
        SELECT w.normalized_word
        FROM public.word_sources s
        JOIN public.words w ON w.id=s.word_id
        WHERE pref.book_id='kaoyan' AND s.user_id=p_user_id
          AND s.source_book_id IN ('ougkp','athgc')
      )
      SELECT count(*)::integer AS total_words,
        count(*) FILTER(WHERE EXISTS (
          SELECT 1 FROM public.words w
          JOIN public.user_words uw ON uw.word_id=w.id AND uw.user_id=p_user_id
          WHERE w.normalized_word=target_words.normalized_word
            AND EXISTS (SELECT 1 FROM public.attempts a
              WHERE a.user_id=p_user_id AND a.word_id=w.id AND a.scope='lesson')
        ))::integer AS covered_words
      FROM target_words
    ) counts ON pref.user_id IS NOT NULL;

  RETURN jsonb_build_object(
    'date',d,
    'daily_minutes',minutes,
    'extra_seconds',coalesce(extra,0),
    'estimated_used_seconds',greatest(coalesce(reserved,0),coalesce(actual,0)),
    'reserved_estimated_seconds',coalesce(reserved,0),
    'effective_used_seconds',coalesce(actual,0),
    'remaining_seconds',greatest(0,minutes*60+coalesce(extra,0)-greatest(coalesce(reserved,0),coalesce(actual,0))),
    'due_count',coalesce(due,0),
    'overdue_count',coalesce(overdue,0),
    'unreserved_due_count',coalesce(due,0),
    'unreserved_overdue_count',coalesce(overdue,0),
    'outstanding_due_count',coalesce(outstanding_due,0),
    'outstanding_overdue_count',coalesce(outstanding_overdue,0),
    'reserved_due_count',greatest(0,coalesce(outstanding_due,0)-coalesce(due,0)),
    'young_count',coalesce(young,0),
    'estimated_daily_review_count',coalesce(daily_review_load,0),
    'new_words_started_today',coalesce(started,0),
    'new_word_cap',coalesce(cap,20),
    'forecast',forecasts,
    'first_answer_samples',coalesce(first_answers,0),
    'first_answer_correct_ratio',CASE WHEN coalesce(first_answers,0)>0 THEN first_correct::numeric/first_answers ELSE NULL END,
    'time_history',time_history,
    'new_word_history',new_word_history,
    'exam_goal',exam,
    'cost_version','adaptive-daily-budget-v2',
    'enabled',enabled
    ,'review_override',coalesce(allow_review,false)
  );
END $$;

-- Keep the legacy V1 allocator intact for flag-off and old Worker rollback.
-- V2 gets the same queue/exam behavior under a versioned internal RPC, with
-- the service's cumulative target as its only time-cost admission limit.
DO $$
DECLARE
  function_sql text;
  old_block text := $old$  v_budget := public.learning_budget_snapshot_v1(p_user_id);
  if (v_budget->>'enabled')::boolean then
    v_limit := least(v_limit,greatest(0,p_budget_limit));
    if (v_budget->>'overdue_count')::integer>0 then
      v_limit:=least(v_limit,coalesce((v_budget->>'new_words_started_today')::integer,0)
        +floor(greatest(0,(v_budget->>'remaining_seconds')::integer)/77.0)::integer);
    else v_limit:=least(v_limit, coalesce((v_budget->>'new_words_started_today')::integer,0)+floor(greatest(0,(v_budget->>'remaining_seconds')::integer-(v_budget->>'due_count')::integer*8)/77.0)::integer); end if;
  end if;
$old$;
  new_block text := $new$  v_budget := public.learning_budget_snapshot_v1(p_user_id);
  if (v_budget->>'enabled')::boolean then
    if (v_budget->>'date')::date IS DISTINCT FROM p_date then
      -- A cross-day frozen queue remains readable, but cannot admit a new word.
      v_limit := v_today_assigned;
    else
      v_limit := least(coalesce(v_limit,20),greatest(0,p_budget_limit));
    end if;
  else
    v_limit := least(coalesce(v_limit,20),greatest(0,p_budget_limit));
  end if;
$new$;
BEGIN
  SELECT pg_get_functiondef('public.prepare_daily_new_words_budget_v1(uuid,date,integer)'::regprocedure)
    INTO function_sql;
  function_sql:=replace(function_sql,E'\r\n',E'\n');
  IF position(old_block IN function_sql)=0 THEN
    RAISE EXCEPTION 'Adaptive budget migration could not find the expected allocator guard; review live function before applying';
  END IF;
  function_sql:=replace(function_sql,old_block,new_block);
  function_sql:=replace(function_sql,
    'FUNCTION public.prepare_daily_new_words_budget_v1(',
    'FUNCTION public.prepare_daily_new_words_budget_v2(');
  function_sql:=regexp_replace(function_sql,E'\nbegin\n',E'\nbegin\n  IF p_user_id IS DISTINCT FROM public.wordloop_authenticated_user_id() THEN RAISE EXCEPTION ''UNAUTHORIZED''; END IF;\n','i');
  IF position('UNAUTHORIZED' IN function_sql)=0 THEN
    RAISE EXCEPTION 'Adaptive allocator migration could not install the authenticated user guard';
  END IF;
  EXECUTE function_sql;
END $$;

-- Count a canonical word only on its first formal Lesson submission. Pretest,
-- queue hydration, retries, captures and dictionary lookups do not write it.
DO $$
DECLARE
  function_sql text;
  marker text := $marker$where id=v_attempt_id;

  v_outcome := case when p_answer_revealed then 'revealed' when p_is_correct then 'correct' else 'incorrect' end;$marker$;
  insertion text := $insert$where id=v_attempt_id;
  if p_scope='lesson' then
    update public.user_words uw
      set formally_introduced_date=(now() at time zone coalesce(u.timezone,'Asia/Shanghai'))::date,
          formally_introduced_session_id=p_session_id
      from public.users u
      where uw.user_id=p_user_id AND uw.word_id=v_word_id AND u.id=p_user_id
        AND uw.formally_introduced_date IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.attempts prior
          WHERE prior.user_id=p_user_id AND prior.word_id=v_word_id
            AND prior.scope='lesson' AND prior.id<>v_attempt_id);
  end if;

  v_outcome := case when p_answer_revealed then 'revealed' when p_is_correct then 'correct' else 'incorrect' end;$insert$;
BEGIN
  SELECT pg_get_functiondef('public.record_planned_submission_v1(uuid,uuid,timestamp with time zone,uuid,uuid,uuid,text,text,text,text,boolean,text,text[],jsonb,boolean,boolean,boolean,integer,integer,jsonb,integer,integer,date,jsonb)'::regprocedure)
    INTO function_sql;
  function_sql:=replace(function_sql,E'\r\n',E'\n');
  IF position(marker IN function_sql)=0 THEN
    RAISE EXCEPTION 'Adaptive budget migration could not find the expected Lesson attempt insertion; review live function before applying';
  END IF;
  function_sql:=replace(function_sql,marker,insertion);
  EXECUTE function_sql;
END $$;

CREATE OR REPLACE FUNCTION public.enable_daily_review_v2(p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE day date;
BEGIN
  IF p_user_id IS DISTINCT FROM public.wordloop_authenticated_user_id() THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  SELECT (now() AT TIME ZONE coalesce(timezone,'Asia/Shanghai'))::date INTO day FROM public.users WHERE id=p_user_id;
  INSERT INTO public.learning_budget_days(user_id,local_date,review_override) VALUES(p_user_id,day,true)
    ON CONFLICT(user_id,local_date) DO UPDATE SET review_override=true;
  RETURN true;
END $$;

DO $$
DECLARE function_sql text; marker text;
BEGIN
  SELECT pg_get_functiondef('public.reserve_learning_budget_v1(uuid,text,integer,text)'::regprocedure) INTO function_sql;
  marker:=$old$if (b->>'enabled')::boolean and (b->>'remaining_seconds')::integer<p_seconds then return false; end if;$old$;
  IF position(marker IN function_sql)=0 THEN RAISE EXCEPTION 'Reserve budget function drift'; END IF;
  EXECUTE replace(function_sql,marker,$new$if (b->>'enabled')::boolean and (b->>'remaining_seconds')::integer<p_seconds
    and not (p_activity='review' and coalesce((b->>'review_override')::boolean,false)) then return false; end if;$new$);

  SELECT pg_get_functiondef('public.set_learning_budget_v1(uuid,integer,text)'::regprocedure) INTO function_sql;
  marker:='extra_seconds=extra_seconds+900';
  IF position(marker IN function_sql)=0 THEN RAISE EXCEPTION 'Extend budget function drift'; END IF;
  EXECUTE replace(function_sql,marker,$new$extra_seconds=extra_seconds+case
    when p_add_key ~* '^group:[0-9a-f-]{36}:[0-9]{1,4}$' then least(3600,greatest(60,split_part(p_add_key,':',3)::integer))
    else 900 end$new$);

  SELECT pg_get_functiondef('public.submit_family_step_v1(uuid,uuid,integer,text,jsonb,jsonb)'::regprocedure) INTO function_sql;
  function_sql:=replace(function_sql,E'\r\n',E'\n');
  marker:=$old$    if v_new then
      if p_card is null or p_log is null then raise exception 'FAMILY_INITIALIZATION_REQUIRED'; end if;$old$;
  IF position(marker IN function_sql)=0 THEN RAISE EXCEPTION 'Family activation function drift'; END IF;
  function_sql:=replace(function_sql,marker,$new$    if v_new then
      if ((v_row.lesson ? 'new_word_budget_admitted')
          and coalesce((v_row.lesson->>'new_word_budget_admitted')::boolean,false) is not true)
        or coalesce((public.learning_budget_snapshot_v1(p_user_id)->>'new_words_started_today')::integer,0)
          >= coalesce((select daily_new_word_limit from public.users where id=p_user_id),20) then
        raise exception 'FAMILY_BUDGET_REACHED';
      end if;
      if p_card is null or p_log is null then raise exception 'FAMILY_INITIALIZATION_REQUIRED'; end if;$new$);
  IF position('new_word_budget_admitted' IN function_sql)=0
     OR position('learning_budget_snapshot_v1' IN function_sql)=0 THEN
    RAISE EXCEPTION 'Adaptive Family admission guard was not installed';
  END IF;
  EXECUTE function_sql;

  marker:=$old$      perform record_pretest_result_v2(p_user_id,v_target.lemma,case when v_ok then 'known' else 'unknown' end,
        p_answer,'pretest_cn_to_en',(case when v_ok then 3 else 1 end)::smallint,p_card,p_log);$old$;
  IF position(marker IN function_sql)=0 THEN RAISE EXCEPTION 'Family activation record function drift'; END IF;
  EXECUTE replace(function_sql,marker,$new$      perform record_pretest_result_v2(p_user_id,v_target.lemma,case when v_ok then 'known' else 'unknown' end,
        p_answer,'pretest_cn_to_en',(case when v_ok then 3 else 1 end)::smallint,p_card,p_log);
      update public.user_words set
        formally_introduced_date=(now() at time zone coalesce((select timezone from public.users where id=p_user_id),'Asia/Shanghai'))::date,
        formally_introduced_session_id=v_row.study_session_id
        where user_id=p_user_id and word_id=v_ensured.word_id and formally_introduced_date is null;$new$);

  SELECT pg_get_functiondef('public.record_learning_time_v2(uuid,jsonb)'::regprocedure) INTO function_sql;
  marker:='IF pretest_n>0 AND lesson_answer_n>0 AND lesson_feedback_n>0 AND lifecycle_ms BETWEEN 750 AND 600000 THEN';
  IF position(marker IN function_sql)=0 THEN RAISE EXCEPTION 'Lifecycle time function drift'; END IF;
  EXECUTE replace(function_sql,marker,$new$IF pretest_n>0 AND lesson_answer_n>0 AND lesson_feedback_n>0 AND lifecycle_ms BETWEEN 750 AND 600000
      AND EXISTS(SELECT 1 FROM public.user_words uw JOIN public.words w ON w.id=uw.word_id
        WHERE uw.user_id=p_user_id AND w.normalized_word=old.canonical_word AND uw.formally_introduced_session_id=s.id) THEN$new$);
END $$;

CREATE INDEX IF NOT EXISTS attempts_first_lesson_answer_idx
  ON public.attempts(user_id,created_at)
  WHERE scope='lesson' AND first_attempt AND NOT coalesce(hint_used,false) AND NOT coalesce(answer_revealed,false);
CREATE INDEX IF NOT EXISTS attempts_first_lesson_word_idx
  ON public.attempts(user_id,word_id,created_at,id)
  WHERE scope='lesson';
CREATE INDEX IF NOT EXISTS learning_budget_reserved_review_idx
  ON public.learning_budget_events(user_id,local_date,task_key)
  WHERE activity_type='review';

REVOKE ALL ON FUNCTION public.set_adaptive_exam_goal_v2(uuid,date,integer) FROM PUBLIC,anonymous;
GRANT EXECUTE ON FUNCTION public.set_adaptive_exam_goal_v2(uuid,date,integer) TO authenticated,wordloop_admin;
REVOKE ALL ON FUNCTION public.learning_budget_snapshot_v1(uuid) FROM PUBLIC,anonymous;
GRANT EXECUTE ON FUNCTION public.learning_budget_snapshot_v1(uuid) TO authenticated,wordloop_admin;
REVOKE ALL ON FUNCTION public.enable_daily_review_v2(uuid) FROM PUBLIC,anonymous;
GRANT EXECUTE ON FUNCTION public.enable_daily_review_v2(uuid) TO authenticated,wordloop_admin;
REVOKE ALL ON FUNCTION public.prepare_daily_new_words_budget_v2(uuid,date,integer) FROM PUBLIC,anonymous,authenticated,wordloop_admin;
GRANT EXECUTE ON FUNCTION public.prepare_daily_new_words_budget_v2(uuid,date,integer) TO authenticated,wordloop_admin;
