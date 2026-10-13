-- Neon only. Additive telemetry; never updates attempts, FSRS, BKT or sessions.
CREATE TABLE IF NOT EXISTS public.user_learning_time_observations (
  user_id uuid NOT NULL REFERENCES public.users(id),
  session_id uuid NOT NULL REFERENCES public.study_sessions(id),
  task_key text NOT NULL,
  local_date date NOT NULL,
  canonical_word text CHECK(canonical_word IS NULL OR canonical_word=lower(btrim(canonical_word))),
  activity_type text NOT NULL,
  scope text NOT NULL,
  stage text NOT NULL CHECK(stage IN ('answer','feedback','explanation')),
  active_ms integer NOT NULL CHECK(active_ms BETWEEN 0 AND 600000),
  finalized boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,task_key)
);
CREATE TABLE IF NOT EXISTS public.user_learning_time_daily (
  user_id uuid NOT NULL REFERENCES public.users(id),
  local_date date NOT NULL,
  activity_type text NOT NULL,
  scope text NOT NULL,
  stage text NOT NULL,
  model_version text NOT NULL DEFAULT 'personal-time-v2-pilot',
  samples integer NOT NULL DEFAULT 0,
  total_ms bigint NOT NULL DEFAULT 0,
  histogram jsonb NOT NULL DEFAULT '{}',
  anomaly_count integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,local_date,activity_type,scope,stage,model_version)
);
CREATE TABLE IF NOT EXISTS public.user_learning_time_word_lifecycle (
  user_id uuid NOT NULL REFERENCES public.users(id),
  canonical_word text NOT NULL CHECK(canonical_word=lower(btrim(canonical_word))),
  session_id uuid NOT NULL REFERENCES public.study_sessions(id),
  local_date date NOT NULL,
  active_ms integer NOT NULL CHECK(active_ms BETWEEN 750 AND 600000),
  consolidation_ms integer NOT NULL DEFAULT 0 CHECK(consolidation_ms BETWEEN 0 AND 600000),
  consolidation_sampled boolean NOT NULL DEFAULT false,
  pretest_samples integer NOT NULL CHECK(pretest_samples>0),
  lesson_answer_samples integer NOT NULL CHECK(lesson_answer_samples>0),
  lesson_feedback_samples integer NOT NULL CHECK(lesson_feedback_samples>0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(user_id,canonical_word)
);
CREATE INDEX IF NOT EXISTS user_learning_time_observations_word_idx
  ON public.user_learning_time_observations(user_id,session_id,canonical_word)
  WHERE canonical_word IS NOT NULL;
CREATE INDEX IF NOT EXISTS user_learning_time_word_lifecycle_date_idx
  ON public.user_learning_time_word_lifecycle(user_id,local_date);
ALTER TABLE public.user_learning_time_word_lifecycle
  ADD COLUMN IF NOT EXISTS consolidation_ms integer NOT NULL DEFAULT 0 CHECK(consolidation_ms BETWEEN 0 AND 600000);
ALTER TABLE public.user_learning_time_word_lifecycle
  ADD COLUMN IF NOT EXISTS consolidation_sampled boolean NOT NULL DEFAULT false;
ALTER TABLE public.user_learning_time_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_learning_time_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_learning_time_word_lifecycle ENABLE ROW LEVEL SECURITY;
CREATE POLICY time_observations_owner ON public.user_learning_time_observations USING(user_id=public.wordloop_authenticated_user_id());
CREATE POLICY time_daily_owner ON public.user_learning_time_daily USING(user_id=public.wordloop_authenticated_user_id());
CREATE POLICY time_word_lifecycle_owner ON public.user_learning_time_word_lifecycle USING(user_id=public.wordloop_authenticated_user_id());
REVOKE ALL ON public.user_learning_time_observations,public.user_learning_time_daily,public.user_learning_time_word_lifecycle FROM PUBLIC,anonymous,authenticated,wordloop_admin;
GRANT SELECT ON public.user_learning_time_observations,public.user_learning_time_daily TO authenticated,wordloop_admin;

CREATE OR REPLACE FUNCTION public.record_learning_time_v2(p_user_id uuid,p_observation jsonb)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  s public.study_sessions; old public.user_learning_time_observations;
  phase text; activity text; scope_name text; stage_name text; actual_stage text; task text; phase_started timestamptz; state_matches boolean;
  day date; zone text; duration integer; bucket text; valid boolean; phase_key text; feedback_evidence boolean; local_today date; day_start timestamptz; day_end timestamptz; rollover boolean;
  word_key text; pretest_n integer; lesson_answer_n integer; lesson_feedback_n integer; lifecycle_ms bigint; lifecycle_inserted integer;
  consolidation_total bigint; target_count integer; life public.user_learning_time_word_lifecycle;
  old_lifecycle_ms integer; new_lifecycle_ms integer; old_bucket text; new_bucket text; old_bucket_count integer; new_bucket_count integer;
BEGIN
  IF p_user_id IS DISTINCT FROM public.wordloop_authenticated_user_id() THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  IF jsonb_typeof(p_observation) IS DISTINCT FROM 'object'
    OR coalesce(p_observation->>'session_id','') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    OR length(coalesce(p_observation->>'phase','')) NOT BETWEEN 1 AND 50
    OR coalesce(p_observation->>'index','') !~ '^(0|[1-9][0-9]{0,2})$'
    OR coalesce(p_observation->>'retry','') !~ '^(0|[1-9][0-9]{0,2})$'
    OR coalesce(p_observation->>'stage','') NOT IN ('answer','feedback','explanation')
    OR coalesce(p_observation->>'active_ms','') !~ '^(0|[1-9][0-9]{0,5})$'
    OR coalesce(p_observation->>'finalize','') NOT IN ('true','false')
    OR coalesce(p_observation->>'rollover','false') NOT IN ('true','false')
    OR coalesce(p_observation->>'local_date','') !~ '^\d{4}-\d{2}-\d{2}$'
    OR coalesce(p_observation->>'phase_started_at','') !~ '^\d{4}-\d{2}-\d{2}T'
    OR (p_observation->>'index')::integer > 500
    OR (p_observation->>'retry')::integer > 100
    OR (p_observation->>'active_ms')::integer > 600000 THEN RETURN false; END IF;
  BEGIN
    phase_started := (p_observation->>'phase_started_at')::timestamptz;
    day := (p_observation->>'local_date')::date;
  EXCEPTION WHEN others THEN RETURN false;
  END;
  SELECT * INTO s FROM public.study_sessions WHERE id=(p_observation->>'session_id')::uuid AND user_id=p_user_id;
  IF NOT FOUND THEN RETURN false; END IF;
  phase := p_observation->>'phase';
  stage_name := p_observation->>'stage';
  duration := (p_observation->>'active_ms')::integer;
  SELECT coalesce(timezone,'Asia/Shanghai') INTO zone FROM public.users WHERE id=p_user_id;
  local_today := (now() AT TIME ZONE coalesce(zone,'Asia/Shanghai'))::date;
  rollover := coalesce((p_observation->>'rollover')::boolean,false);
  IF phase_started<s.started_at OR phase_started>now()
    OR (day IS DISTINCT FROM local_today AND NOT (rollover AND (p_observation->>'finalize')='true' AND day=local_today-1)) THEN RETURN false; END IF;
  day_start := day::timestamp AT TIME ZONE coalesce(zone,'Asia/Shanghai');
  day_end := (day+1)::timestamp AT TIME ZONE coalesce(zone,'Asia/Shanghai');
  phase_key := to_char(phase_started AT TIME ZONE 'UTC','YYYYMMDDHH24MISSUS');
  task := s.id::text||':'||phase||':'||(p_observation->>'index')||':'||(p_observation->>'retry')||':'||day::text||':'||phase_key||':'||stage_name;
  state_matches := phase IS NOT DISTINCT FROM s.state->>'phase'
    AND (p_observation->>'index')::integer IS NOT DISTINCT FROM (s.state->>'current_index')::integer
    AND (p_observation->>'retry')::integer IS NOT DISTINCT FROM coalesce((s.state->>'retry_count')::integer,0)
    AND abs(extract(epoch FROM (s.updated_at-phase_started))) <= 1
    AND (phase NOT LIKE '%complete' OR (phase='review_complete' AND s.state->>'widget'='review') OR (phase='lesson_complete' AND s.state#>>'{payload,consolidation}'='true' AND s.state#>>'{payload,consolidation_status}' IN ('exercise','feedback')));
  scope_name := CASE WHEN s.state->>'widget'='review' THEN 'review' WHEN s.state->>'widget'='pretest' THEN 'pretest' WHEN s.state#>>'{payload,consolidation}'='true' THEN 'consolidation' ELSE 'lesson' END;
  actual_stage := CASE WHEN phase='lesson_explain' THEN 'explanation' WHEN phase LIKE '%feedback%' OR phase='pretest_result' OR s.state#>>'{payload,mode}'='feedback' OR phase='review_complete' THEN 'feedback' ELSE 'answer' END;
  feedback_evidence := scope_name='review' AND stage_name='feedback' AND EXISTS(
    SELECT 1 FROM public.attempts a WHERE a.user_id=p_user_id AND a.session_id=s.id AND a.activity_type='review' AND a.created_at>=s.updated_at-interval '10 seconds'
    UNION ALL SELECT 1 FROM public.fsrs_review_logs l WHERE l.user_id=p_user_id AND l.session_id=s.id AND l.created_at>=s.updated_at-interval '10 seconds'
  );
  IF s.ended_at IS NOT NULL THEN
    IF (p_observation->>'finalize') IS DISTINCT FROM 'true' THEN RETURN false; END IF;
    SELECT * INTO old FROM public.user_learning_time_observations WHERE user_id=p_user_id AND task_key=task FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    IF old.finalized THEN RETURN true; END IF;
    IF s.ended_at < phase_started THEN RETURN false; END IF;
    activity := old.activity_type; scope_name := old.scope; stage_name := old.stage; word_key := old.canonical_word;
  ELSIF state_matches THEN
    IF stage_name IS DISTINCT FROM actual_stage AND NOT feedback_evidence THEN RETURN false; END IF;
    word_key := nullif(lower(btrim(coalesce(s.state->>'current_word',''))),'');
    IF scope_name NOT IN ('pretest','lesson') THEN word_key := NULL; END IF;
    activity := CASE WHEN stage_name='explanation' THEN 'explanation' WHEN scope_name='review' THEN 'review'
      WHEN scope_name='pretest' THEN 'pretest_cn_to_en'
      ELSE coalesce(s.state#>>'{payload,exercise,activity_type}',s.state#>>'{payload,activity_type}',s.state#>>'{payload,exercise_plan,planned_activity_type}',s.state#>>'{payload,consolidation_plan,planned_activity_type}','sentence') END;
    SELECT * INTO old FROM public.user_learning_time_observations WHERE user_id=p_user_id AND task_key=task FOR UPDATE;
    IF NOT FOUND THEN
      IF (p_observation->>'finalize')='true' AND s.updated_at<=phase_started+interval '1 second' AND NOT feedback_evidence THEN RETURN false; END IF;
      INSERT INTO public.user_learning_time_observations(user_id,session_id,task_key,local_date,canonical_word,activity_type,scope,stage,active_ms)
        VALUES(p_user_id,s.id,task,day,word_key,activity,scope_name,stage_name,0) ON CONFLICT DO NOTHING;
      SELECT * INTO old FROM public.user_learning_time_observations WHERE user_id=p_user_id AND task_key=task FOR UPDATE;
    END IF;
  ELSE
    IF (p_observation->>'finalize') IS DISTINCT FROM 'true' THEN RETURN false; END IF;
    SELECT * INTO old FROM public.user_learning_time_observations WHERE user_id=p_user_id AND task_key=task FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    IF old.finalized THEN RETURN true; END IF;
    IF s.updated_at <= phase_started THEN RETURN false; END IF;
    -- The pre-action checkpoint froze the activity/scope/stage while the phase
    -- was current. Finalization after a successful transition reuses that row.
    activity := old.activity_type; scope_name := old.scope; stage_name := old.stage; word_key := old.canonical_word;
  END IF;
  IF duration>greatest(0,extract(epoch FROM(least(now(),day_end)-greatest(phase_started,day_start)))*1000)+1000 THEN RETURN false; END IF;
  -- The matching-state branch creates the initial row; stale/ended states can
  -- only reach here through an existing, unfinalized pre-action checkpoint.
  IF old.finalized THEN RETURN true; END IF;
  IF duration > (CASE
    WHEN old.active_ms=0 THEN greatest(0,extract(epoch FROM (least(now(),day_end)-greatest(phase_started,day_start)))*1000)::integer
    ELSE old.active_ms + greatest(0,extract(epoch FROM (least(now(),day_end)-old.updated_at))*1000)::integer
  END) + 1000 THEN RETURN false; END IF;
  duration := greatest(old.active_ms,duration);
  UPDATE public.user_learning_time_observations SET active_ms=duration,finalized=(p_observation->>'finalize')='true',updated_at=now() WHERE user_id=p_user_id AND task_key=task;
  IF coalesce((p_observation->>'finalize')::boolean,false) THEN
    valid := duration BETWEEN 250 AND 300000;
    bucket := least(119,duration/5000)::text;
    INSERT INTO public.user_learning_time_daily(user_id,local_date,activity_type,scope,stage,samples,total_ms,histogram,anomaly_count)
      VALUES(p_user_id,day,activity,scope_name,stage_name,CASE WHEN valid THEN 1 ELSE 0 END,CASE WHEN valid THEN duration ELSE 0 END,
        CASE WHEN valid THEN jsonb_build_object(bucket,1) ELSE '{}'::jsonb END,CASE WHEN valid THEN 0 ELSE 1 END)
      ON CONFLICT(user_id,local_date,activity_type,scope,stage,model_version) DO UPDATE
      SET samples=user_learning_time_daily.samples+excluded.samples,total_ms=user_learning_time_daily.total_ms+excluded.total_ms,
        histogram=CASE WHEN valid THEN jsonb_set(user_learning_time_daily.histogram,ARRAY[bucket],to_jsonb(coalesce((user_learning_time_daily.histogram->>bucket)::integer,0)+1)) ELSE user_learning_time_daily.histogram END,
        anomaly_count=user_learning_time_daily.anomaly_count+excluded.anomaly_count,updated_at=now();
    IF phase='lesson_feedback' AND scope_name='lesson' AND old.canonical_word IS NOT NULL
      AND (s.ended_at IS NOT NULL OR s.state->>'phase'='lesson_complete' OR lower(btrim(coalesce(s.state->>'current_word',''))) IS DISTINCT FROM old.canonical_word) THEN
      SELECT count(*) FILTER(WHERE scope='pretest' AND active_ms BETWEEN 250 AND 300000)::integer,
        count(*) FILTER(WHERE scope='lesson' AND stage='answer' AND active_ms BETWEEN 250 AND 300000)::integer,
        count(*) FILTER(WHERE scope='lesson' AND stage='feedback' AND active_ms BETWEEN 250 AND 300000)::integer,
        coalesce(sum(active_ms) FILTER(WHERE scope IN ('pretest','lesson') AND active_ms BETWEEN 250 AND 300000),0)::bigint
        INTO pretest_n,lesson_answer_n,lesson_feedback_n,lifecycle_ms
        FROM public.user_learning_time_observations
        WHERE user_id=p_user_id AND session_id=s.id AND canonical_word=old.canonical_word AND finalized;
      IF pretest_n>0 AND lesson_answer_n>0 AND lesson_feedback_n>0 AND lifecycle_ms BETWEEN 750 AND 600000 THEN
        INSERT INTO public.user_learning_time_word_lifecycle(user_id,canonical_word,session_id,local_date,active_ms,pretest_samples,lesson_answer_samples,lesson_feedback_samples)
          VALUES(p_user_id,old.canonical_word,s.id,day,lifecycle_ms::integer,pretest_n,lesson_answer_n,lesson_feedback_n)
          ON CONFLICT(user_id,canonical_word) DO NOTHING;
        GET DIAGNOSTICS lifecycle_inserted=ROW_COUNT;
        IF lifecycle_inserted=1 THEN
          bucket := least(119,(lifecycle_ms/5000)::integer)::text;
          INSERT INTO public.user_learning_time_daily(user_id,local_date,activity_type,scope,stage,samples,total_ms,histogram,anomaly_count)
            VALUES(p_user_id,day,'__complete_new_word__','lesson','answer',1,lifecycle_ms,jsonb_build_object(bucket,1),0)
            ON CONFLICT(user_id,local_date,activity_type,scope,stage,model_version) DO UPDATE
            SET samples=user_learning_time_daily.samples+1,total_ms=user_learning_time_daily.total_ms+excluded.total_ms,
              histogram=jsonb_set(user_learning_time_daily.histogram,ARRAY[bucket],to_jsonb(coalesce((user_learning_time_daily.histogram->>bucket)::integer,0)+1)),updated_at=now();
        END IF;
      END IF;
    END IF;
    IF stage_name='feedback' AND scope_name='consolidation' AND s.state#>>'{payload,consolidation_status}'='feedback'
      AND (coalesce((s.state#>>'{payload,feedback,is_correct}')::boolean,false)
        OR coalesce((s.state#>>'{payload,feedback,reveal_answer}')::boolean,false)) THEN
      SELECT count(*)::integer INTO target_count FROM (
        SELECT DISTINCT lower(btrim(value)) AS word
        FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(s.state#>'{payload,consolidation_target_words}')='array'
          THEN s.state#>'{payload,consolidation_target_words}' ELSE '[]'::jsonb END)
        WHERE length(btrim(value)) BETWEEN 1 AND 100
      ) target_words;
      SELECT coalesce(sum(active_ms),0)::bigint INTO consolidation_total
        FROM public.user_learning_time_observations
        WHERE user_id=p_user_id AND session_id=s.id AND scope='consolidation' AND finalized AND active_ms BETWEEN 250 AND 300000;
      IF target_count>0 AND consolidation_total BETWEEN 250 AND 600000 THEN
        FOR word_key IN SELECT DISTINCT lower(btrim(value))
          FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(s.state#>'{payload,consolidation_target_words}')='array'
            THEN s.state#>'{payload,consolidation_target_words}' ELSE '[]'::jsonb END)
          WHERE length(btrim(value)) BETWEEN 1 AND 100
        LOOP
          SELECT * INTO life FROM public.user_learning_time_word_lifecycle
            WHERE user_id=p_user_id AND canonical_word=word_key FOR UPDATE;
          IF FOUND AND NOT life.consolidation_sampled THEN
            old_lifecycle_ms:=life.active_ms+life.consolidation_ms;
            new_lifecycle_ms:=least(600000,life.active_ms+life.consolidation_ms+(consolidation_total/target_count)::integer);
            old_bucket:=least(119,old_lifecycle_ms/5000)::text;
            new_bucket:=least(119,new_lifecycle_ms/5000)::text;
            UPDATE public.user_learning_time_word_lifecycle SET consolidation_ms=new_lifecycle_ms-life.active_ms,
              consolidation_sampled=true,updated_at=now()
              WHERE user_id=p_user_id AND canonical_word=word_key;
            IF old_bucket<>new_bucket THEN
              SELECT coalesce((histogram->>old_bucket)::integer,0),coalesce((histogram->>new_bucket)::integer,0)
                INTO old_bucket_count,new_bucket_count FROM public.user_learning_time_daily
                WHERE user_id=p_user_id AND local_date=life.local_date AND activity_type='__complete_new_word__'
                  AND scope='lesson' AND stage='answer' AND model_version='personal-time-v2-pilot' FOR UPDATE;
              IF FOUND THEN
                UPDATE public.user_learning_time_daily SET total_ms=greatest(0,total_ms+new_lifecycle_ms-old_lifecycle_ms),
                  histogram=jsonb_set(jsonb_set(histogram,ARRAY[old_bucket],to_jsonb(greatest(0,old_bucket_count-1))),
                    ARRAY[new_bucket],to_jsonb(new_bucket_count+1)),updated_at=now()
                  WHERE user_id=p_user_id AND local_date=life.local_date AND activity_type='__complete_new_word__'
                    AND scope='lesson' AND stage='answer' AND model_version='personal-time-v2-pilot';
              END IF;
            ELSE
              UPDATE public.user_learning_time_daily SET total_ms=greatest(0,total_ms+new_lifecycle_ms-old_lifecycle_ms),updated_at=now()
                WHERE user_id=p_user_id AND local_date=life.local_date AND activity_type='__complete_new_word__'
                  AND scope='lesson' AND stage='answer' AND model_version='personal-time-v2-pilot';
            END IF;
          END IF;
        END LOOP;
      END IF;
    END IF;
  END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION public.user_learning_time_profile_v2(p_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb; user_zone text; local_today date;
BEGIN
  IF p_user_id IS DISTINCT FROM public.wordloop_authenticated_user_id() THEN RAISE EXCEPTION 'UNAUTHORIZED'; END IF;
  SELECT coalesce(timezone,'Asia/Shanghai') INTO user_zone FROM public.users WHERE id=p_user_id;
  local_today := (now() AT TIME ZONE coalesce(user_zone,'Asia/Shanghai'))::date;
  -- At most 30 days of compact daily summaries; prefer recent 14 days, fall
  -- back to 30 only for sparse dimensions. Never scan attempts per answer.
  WITH selected AS (
    SELECT *,sum(samples) FILTER(WHERE local_date>=local_today-13) OVER(PARTITION BY activity_type,scope,stage) AS recent_n
    FROM public.user_learning_time_daily WHERE user_id=p_user_id AND local_date>=local_today-29 AND model_version='personal-time-v2-pilot'
  ), chosen AS (SELECT * FROM selected WHERE coalesce(recent_n,0)<30 OR local_date>=local_today-13),
  totals AS (SELECT activity_type,scope,stage,sum(samples) AS samples,sum(total_ms) AS total_ms,max(updated_at) AS updated_at FROM chosen GROUP BY activity_type,scope,stage),
  bins AS (SELECT activity_type,scope,stage,b.key,sum(b.value::integer) AS n FROM chosen CROSS JOIN LATERAL jsonb_each_text(histogram) b GROUP BY activity_type,scope,stage,b.key),
  all_totals AS (SELECT * FROM totals),
  all_bins AS (SELECT * FROM bins),
  hist AS (SELECT activity_type,scope,stage,jsonb_object_agg(key,n) AS histogram FROM all_bins GROUP BY activity_type,scope,stage)
  SELECT coalesce(jsonb_agg(to_jsonb(t)||jsonb_build_object('histogram',coalesce(h.histogram,'{}'::jsonb))),'[]'::jsonb) INTO result FROM all_totals t LEFT JOIN hist h USING(activity_type,scope,stage);
  RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.record_learning_time_v2(uuid,jsonb),public.user_learning_time_profile_v2(uuid) FROM PUBLIC,anonymous;
GRANT EXECUTE ON FUNCTION public.record_learning_time_v2(uuid,jsonb),public.user_learning_time_profile_v2(uuid) TO authenticated,wordloop_admin;

