-- Neon only. Preserve the existing V2 recording function and extend it by
-- replacing narrow, verified fragments so the 0007 formal-introduction guard
-- remains installed. Old observations stay unpaired and are never backfilled.
ALTER TABLE public.user_learning_time_observations
  ADD COLUMN IF NOT EXISTS predicted_ms integer CHECK(predicted_ms IS NULL OR predicted_ms BETWEEN 0 AND 600000);
ALTER TABLE public.user_learning_time_daily
  ADD COLUMN IF NOT EXISTS prediction_samples integer NOT NULL DEFAULT 0 CHECK(prediction_samples>=0),
  ADD COLUMN IF NOT EXISTS predicted_total_ms bigint NOT NULL DEFAULT 0 CHECK(predicted_total_ms>=0),
  ADD COLUMN IF NOT EXISTS signed_error_total_ms bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS absolute_error_total_ms bigint NOT NULL DEFAULT 0 CHECK(absolute_error_total_ms>=0);
ALTER TABLE public.user_learning_time_word_lifecycle
  ADD COLUMN IF NOT EXISTS predicted_ms integer CHECK(predicted_ms IS NULL OR predicted_ms BETWEEN 0 AND 600000);

CREATE OR REPLACE FUNCTION public.learning_time_activity_type_v2(p_phase text,p_scope text,p_stage text,p_lesson_activity text)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
  SELECT CASE
    WHEN p_stage='explanation' THEN 'explanation'
    WHEN p_scope='review' THEN 'review'
    WHEN p_scope='pretest' AND p_phase='listen_repeat' THEN 'pronunciation'
    WHEN p_scope='pretest' AND p_phase='listen_recall' THEN 'listening_recall'
    WHEN p_scope='pretest' THEN 'pretest_cn_to_en'
    ELSE coalesce(nullif(p_lesson_activity,''),'sentence')
  END
$$;

-- The prediction uses only this authenticated learner's compact daily
-- histograms from days before the task. It matches the TypeScript model:
-- clipped 5s-bin mean, 20-sample prior, and a 2x prior for related activities.
CREATE OR REPLACE FUNCTION public.learning_time_prior_prediction_v2(
  p_user_id uuid,p_local_date date,p_activity text,p_scope text,p_stage text
) RETURNS integer LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  fallback_ms integer; activity_family text; n14 integer; n30 integer; weighted14 numeric; weighted30 numeric;
  n integer; weighted numeric; personal numeric; bounded numeric; prior integer;
  related_n14 integer; related_n30 integer; related_weighted14 numeric; related_weighted30 numeric; related boolean:=false;
BEGIN
  IF p_user_id IS DISTINCT FROM public.wordloop_authenticated_user_id() THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  IF p_local_date IS NULL OR p_activity IS NULL OR p_scope IS NULL OR p_stage IS NULL OR p_stage NOT IN ('answer','feedback','explanation') THEN
    RAISE EXCEPTION 'INVALID_LEARNING_TIME_PREDICTION_INPUT';
  END IF;
  fallback_ms:=CASE
    WHEN p_activity='__complete_new_word__' THEN 77000
    WHEN p_stage='explanation' OR p_activity='explanation' THEN 30000
    WHEN p_stage='feedback' THEN 5000
    WHEN p_scope='consolidation' THEN 90000
    WHEN p_activity IN ('collocation','derivation') THEN 15000
    WHEN p_activity LIKE 'translation%' THEN 30000
    WHEN p_activity IN ('sentence','semantic_expression') THEN 45000
    ELSE 8000 END;
  activity_family:=CASE WHEN p_activity LIKE 'translation%' THEN 'translation'
    WHEN p_activity IN ('cloze','exact_cloze','word_recall','spelling') THEN 'recall' ELSE p_activity END;

  SELECT coalesce(sum(b.value::integer) FILTER(WHERE d.local_date>=p_local_date-14),0)::integer,
    coalesce(sum(b.value::integer),0)::integer,
    coalesce(sum(least((b.key::integer*5000+2500)::numeric,fallback_ms*3)*b.value::integer)
      FILTER(WHERE d.local_date>=p_local_date-14),0),
    coalesce(sum(least((b.key::integer*5000+2500)::numeric,fallback_ms*3)*b.value::integer),0)
    INTO n14,n30,weighted14,weighted30
    FROM public.user_learning_time_daily d CROSS JOIN LATERAL jsonb_each_text(d.histogram) b
    WHERE d.user_id=p_user_id AND d.local_date>=p_local_date-30 AND d.local_date<p_local_date
      AND d.model_version='personal-time-v2-pilot' AND d.activity_type=p_activity AND d.scope=p_scope AND d.stage=p_stage;
  IF n30=0 AND activity_family<>p_activity THEN
    related:=true;
    SELECT coalesce(sum(b.value::integer) FILTER(WHERE d.local_date>=p_local_date-14),0)::integer,
      coalesce(sum(b.value::integer),0)::integer,
      coalesce(sum(least((b.key::integer*5000+2500)::numeric,fallback_ms*3)*b.value::integer)
        FILTER(WHERE d.local_date>=p_local_date-14),0),
      coalesce(sum(least((b.key::integer*5000+2500)::numeric,fallback_ms*3)*b.value::integer),0)
      INTO related_n14,related_n30,related_weighted14,related_weighted30
      FROM public.user_learning_time_daily d CROSS JOIN LATERAL jsonb_each_text(d.histogram) b
      WHERE d.user_id=p_user_id AND d.local_date>=p_local_date-30 AND d.local_date<p_local_date
        AND d.model_version='personal-time-v2-pilot' AND d.scope=p_scope AND d.stage=p_stage
        AND (CASE WHEN d.activity_type LIKE 'translation%' THEN 'translation'
          WHEN d.activity_type IN ('cloze','exact_cloze','word_recall','spelling') THEN 'recall' ELSE d.activity_type END)=activity_family;
    n14:=related_n14; n30:=related_n30; weighted14:=related_weighted14; weighted30:=related_weighted30;
  END IF;
  IF n30=0 THEN RETURN fallback_ms; END IF;
  IF n14>=30 THEN n:=n14; weighted:=weighted14; ELSE n:=n30; weighted:=weighted30; END IF;
  IF n<=0 THEN RETURN fallback_ms; END IF;
  personal:=weighted/n;
  bounded:=greatest(fallback_ms*0.5,least(fallback_ms*3,personal));
  prior:=20*CASE WHEN related THEN 2 ELSE 1 END;
  RETURN round((n::numeric/(n+prior))*bounded+(prior::numeric/(n+prior))*fallback_ms)::integer;
END $$;

CREATE OR REPLACE FUNCTION public.user_learning_time_history_v2(p_user_id uuid,p_days integer DEFAULT 30)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE user_zone text; local_today date; result jsonb;
BEGIN
  IF p_user_id IS DISTINCT FROM public.wordloop_authenticated_user_id() THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  IF p_days IS NULL OR p_days NOT BETWEEN 7 AND 30 THEN RAISE EXCEPTION 'INVALID_LEARNING_TIME_HISTORY_RANGE'; END IF;
  SELECT coalesce(timezone,'Asia/Shanghai') INTO user_zone FROM public.users WHERE id=p_user_id;
  local_today:=(now() AT TIME ZONE coalesce(user_zone,'Asia/Shanghai'))::date;
  WITH days AS (SELECT local_today-g AS day FROM generate_series(0,p_days-1) g), totals AS (
    SELECT days.day AS date,
      coalesce(round(sum(t.total_ms) FILTER(WHERE t.activity_type<>'__complete_new_word__')/1000.0),0)::integer AS effective_seconds,
      coalesce(sum(t.samples) FILTER(WHERE t.activity_type<>'__complete_new_word__'),0)::integer AS samples,
      coalesce(sum(t.predicted_total_ms) FILTER(WHERE t.activity_type<>'__complete_new_word__'),0)::bigint AS predicted_total_ms,
      coalesce(sum(t.prediction_samples) FILTER(WHERE t.activity_type<>'__complete_new_word__'),0)::integer AS prediction_samples,
      coalesce(sum(t.signed_error_total_ms) FILTER(WHERE t.activity_type<>'__complete_new_word__'),0)::bigint AS signed_error_total_ms,
      coalesce(sum(t.absolute_error_total_ms) FILTER(WHERE t.activity_type<>'__complete_new_word__'),0)::bigint AS absolute_error_total_ms,
      coalesce(sum(t.prediction_samples) FILTER(WHERE t.activity_type='__complete_new_word__'),0)::integer AS new_word_prediction_samples,
      coalesce(sum(t.predicted_total_ms) FILTER(WHERE t.activity_type='__complete_new_word__'),0)::bigint AS new_word_predicted_total_ms,
      coalesce(sum(t.signed_error_total_ms) FILTER(WHERE t.activity_type='__complete_new_word__'),0)::bigint AS new_word_signed_error_total_ms,
      coalesce(sum(t.absolute_error_total_ms) FILTER(WHERE t.activity_type='__complete_new_word__'),0)::bigint AS new_word_absolute_error_total_ms
    FROM days LEFT JOIN public.user_learning_time_daily t ON t.user_id=p_user_id AND t.local_date=days.day
      AND t.model_version='personal-time-v2-pilot'
    GROUP BY days.day
  ) SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY date DESC),'[]'::jsonb) INTO result FROM totals t;
  RETURN result;
END $$;

DO $migration$
DECLARE function_sql text; marker text;
BEGIN
  SELECT pg_get_functiondef('public.record_learning_time_v2(uuid,jsonb)'::regprocedure) INTO function_sql;
  marker:=$old$activity := CASE WHEN stage_name='explanation' THEN 'explanation' WHEN scope_name='review' THEN 'review'
      WHEN scope_name='pretest' THEN 'pretest_cn_to_en'
      ELSE coalesce(s.state#>>'{payload,exercise,activity_type}',s.state#>>'{payload,activity_type}',s.state#>>'{payload,exercise_plan,planned_activity_type}',s.state#>>'{payload,consolidation_plan,planned_activity_type}','sentence') END;$old$;
  IF position(marker IN function_sql)=0 THEN RAISE EXCEPTION 'Learning-time activity classifier drift'; END IF;
  function_sql:=replace(function_sql,marker,$new$activity := public.learning_time_activity_type_v2(
      phase,scope_name,stage_name,coalesce(s.state#>>'{payload,exercise,activity_type}',s.state#>>'{payload,activity_type}',s.state#>>'{payload,exercise_plan,planned_activity_type}',s.state#>>'{payload,consolidation_plan,planned_activity_type}'));$new$);

  marker:=$old$INSERT INTO public.user_learning_time_observations(user_id,session_id,task_key,local_date,canonical_word,activity_type,scope,stage,active_ms)
        VALUES(p_user_id,s.id,task,day,word_key,activity,scope_name,stage_name,0) ON CONFLICT DO NOTHING;$old$;
  IF position(marker IN function_sql)=0 THEN RAISE EXCEPTION 'Learning-time observation insert drift'; END IF;
  function_sql:=replace(function_sql,marker,$new$INSERT INTO public.user_learning_time_observations(user_id,session_id,task_key,local_date,canonical_word,activity_type,scope,stage,active_ms,predicted_ms)
        VALUES(p_user_id,s.id,task,day,word_key,activity,scope_name,stage_name,0,
          public.learning_time_prior_prediction_v2(p_user_id,day,activity,scope_name,stage_name)) ON CONFLICT DO NOTHING;$new$);

  marker:=$old$    IF phase='lesson_feedback' AND scope_name='lesson' AND old.canonical_word IS NOT NULL$old$;
  IF position(marker IN function_sql)=0 THEN RAISE EXCEPTION 'Learning-time prediction aggregation drift'; END IF;
  function_sql:=replace(function_sql,marker,$new$    IF valid AND old.predicted_ms IS NOT NULL THEN
      UPDATE public.user_learning_time_daily SET prediction_samples=prediction_samples+1,
        predicted_total_ms=predicted_total_ms+old.predicted_ms,
        signed_error_total_ms=signed_error_total_ms+(duration-old.predicted_ms),
        absolute_error_total_ms=absolute_error_total_ms+abs(duration-old.predicted_ms),updated_at=now()
      WHERE user_id=p_user_id AND local_date=day AND activity_type=activity AND scope=scope_name AND stage=stage_name
        AND model_version='personal-time-v2-pilot';
    END IF;
    IF phase='lesson_feedback' AND scope_name='lesson' AND old.canonical_word IS NOT NULL$new$);

  marker:=$old$INSERT INTO public.user_learning_time_word_lifecycle(user_id,canonical_word,session_id,local_date,active_ms,pretest_samples,lesson_answer_samples,lesson_feedback_samples)
          VALUES(p_user_id,old.canonical_word,s.id,day,lifecycle_ms::integer,pretest_n,lesson_answer_n,lesson_feedback_n)$old$;
  IF position(marker IN function_sql)=0 THEN RAISE EXCEPTION 'Learning-time lifecycle insert drift'; END IF;
  function_sql:=replace(function_sql,marker,$new$INSERT INTO public.user_learning_time_word_lifecycle(user_id,canonical_word,session_id,local_date,active_ms,pretest_samples,lesson_answer_samples,lesson_feedback_samples,predicted_ms)
          VALUES(p_user_id,old.canonical_word,s.id,day,lifecycle_ms::integer,pretest_n,lesson_answer_n,lesson_feedback_n,
            public.learning_time_prior_prediction_v2(p_user_id,day,'__complete_new_word__','lesson','answer'))$new$);

  marker:=$old$    IF stage_name='feedback' AND scope_name='consolidation' AND s.state#>>'{payload,consolidation_status}'='feedback'$old$;
  IF position(marker IN function_sql)=0 THEN RAISE EXCEPTION 'Learning-time lifecycle prediction drift'; END IF;
  function_sql:=replace(function_sql,marker,$new$    IF lifecycle_inserted=1 THEN
      WITH estimate AS MATERIALIZED (SELECT public.learning_time_prior_prediction_v2(p_user_id,day,'__complete_new_word__','lesson','answer') AS predicted_ms)
      UPDATE public.user_learning_time_daily t SET prediction_samples=t.prediction_samples+1,
        predicted_total_ms=t.predicted_total_ms+estimate.predicted_ms,
        signed_error_total_ms=t.signed_error_total_ms+(lifecycle_ms-estimate.predicted_ms),
        absolute_error_total_ms=t.absolute_error_total_ms+abs(lifecycle_ms-estimate.predicted_ms),updated_at=now()
      FROM estimate WHERE t.user_id=p_user_id AND t.local_date=day AND t.activity_type='__complete_new_word__'
        AND t.scope='lesson' AND t.stage='answer' AND t.model_version='personal-time-v2-pilot';
    END IF;
    IF stage_name='feedback' AND scope_name='consolidation' AND s.state#>>'{payload,consolidation_status}'='feedback'$new$);

  marker:=$old$            UPDATE public.user_learning_time_daily SET total_ms=greatest(0,total_ms+new_lifecycle_ms-old_lifecycle_ms),updated_at=now()
                WHERE user_id=p_user_id AND local_date=life.local_date AND activity_type='__complete_new_word__'
                  AND scope='lesson' AND stage='answer' AND model_version='personal-time-v2-pilot';
            END IF;
          END IF;$old$;
  IF position(marker IN function_sql)=0 THEN RAISE EXCEPTION 'Learning-time consolidation aggregation drift'; END IF;
  function_sql:=replace(function_sql,marker,$new$            UPDATE public.user_learning_time_daily SET total_ms=greatest(0,total_ms+new_lifecycle_ms-old_lifecycle_ms),updated_at=now()
                WHERE user_id=p_user_id AND local_date=life.local_date AND activity_type='__complete_new_word__'
                  AND scope='lesson' AND stage='answer' AND model_version='personal-time-v2-pilot';
            END IF;
            IF life.predicted_ms IS NOT NULL THEN
              UPDATE public.user_learning_time_daily SET
                signed_error_total_ms=signed_error_total_ms+(new_lifecycle_ms-old_lifecycle_ms),
                absolute_error_total_ms=greatest(0,absolute_error_total_ms+abs(new_lifecycle_ms-life.predicted_ms)-abs(old_lifecycle_ms-life.predicted_ms)),
                updated_at=now()
              WHERE user_id=p_user_id AND local_date=life.local_date AND activity_type='__complete_new_word__'
                AND scope='lesson' AND stage='answer' AND model_version='personal-time-v2-pilot';
            END IF;
          END IF;$new$);
  EXECUTE function_sql;
END $migration$;

REVOKE ALL ON FUNCTION public.learning_time_activity_type_v2(text,text,text,text),
  public.learning_time_prior_prediction_v2(uuid,date,text,text,text),public.user_learning_time_history_v2(uuid,integer)
  FROM PUBLIC,anonymous;
GRANT EXECUTE ON FUNCTION public.user_learning_time_history_v2(uuid,integer) TO authenticated,wordloop_admin;
