-- Private Anki-backed Lesson cache. This table is deliberately outside the
-- public content catalogs and is scoped to one authenticated user's private
-- kaoyan union. Cache rows never enter study_sessions.state.payload except
-- when the existing Lesson handler creates that user's current session.
CREATE TABLE public.lesson_generation_cache (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  private_set_id text NOT NULL,
  word_id uuid NOT NULL REFERENCES public.words(id) ON DELETE CASCADE,
  cache_kind text NOT NULL CHECK (cache_kind IN ('materials', 'lesson')),
  cache_key char(64) NOT NULL CHECK (cache_key ~ '^[0-9a-f]{64}$'),
  payload_hash char(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  sense_fingerprint char(64) NOT NULL CHECK (sense_fingerprint ~ '^[0-9a-f]{64}$'),
  plan_fingerprint char(64),
  target_sense text NOT NULL CHECK (length(btrim(target_sense)) BETWEEN 1 AND 240),
  lesson_profile text CHECK (lesson_profile IS NULL OR lesson_profile IN ('quick_recall', 'reinforce', 'targeted_relearn')),
  planned_activity_type text,
  error_focus text,
  plan_context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(plan_context) = 'object'),
  content_version text NOT NULL,
  prompt_version text NOT NULL,
  source_version text NOT NULL,
  source_kind text NOT NULL CHECK (source_kind IN ('anki', 'codebuddy_deepseek', 'mixed', 'runtime_deepseek')),
  generation_method text NOT NULL CHECK (generation_method IN ('apkg_import', 'codebuddy_cli', 'existing_runtime_fallback')),
  material_payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(material_payload) = 'object'),
  lesson_payload jsonb CHECK (lesson_payload IS NULL OR jsonb_typeof(lesson_payload) = 'object'),
  missing_fields text[] NOT NULL DEFAULT ARRAY[]::text[],
  quality_status text NOT NULL CHECK (quality_status IN ('valid', 'partial', 'needs_review', 'failed')),
  is_valid boolean NOT NULL DEFAULT false,
  model_name text,
  model_effort text CHECK (model_effort IS NULL OR model_effort = 'low'),
  codebuddy_request_id text,
  input_tokens integer CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens integer CHECK (output_tokens IS NULL OR output_tokens >= 0),
  token_usage_status text NOT NULL DEFAULT 'unavailable' CHECK (token_usage_status IN ('available', 'unavailable')),
  retry_count integer NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  error_code text,
  error_summary text CHECK (error_summary IS NULL OR length(error_summary) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((cache_kind = 'materials' AND plan_fingerprint IS NULL AND lesson_profile IS NULL AND planned_activity_type IS NULL)
      OR (cache_kind = 'lesson' AND plan_fingerprint IS NOT NULL AND lesson_profile IS NOT NULL AND planned_activity_type IS NOT NULL)),
  CHECK (is_valid = (quality_status = 'valid' AND lesson_payload IS NOT NULL))
);

CREATE OR REPLACE FUNCTION public.can_access_personal_kaoyan_union_v1(p_word_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO pg_catalog, public
AS $function$
  SELECT p_word_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.word_sources source
        WHERE source.user_id = public.wordloop_authenticated_user_id()
          AND source.source_book_id = 'ougkp'
     )
     AND EXISTS (
       SELECT 1 FROM public.word_sources source
        WHERE source.user_id = public.wordloop_authenticated_user_id()
          AND source.source_book_id = 'athgc'
     )
     AND EXISTS (
       SELECT 1 FROM public.word_sources source
        WHERE source.user_id = public.wordloop_authenticated_user_id()
          AND source.word_id = p_word_id
          AND source.source_book_id IN ('ougkp', 'athgc')
     )
$function$;
REVOKE ALL ON FUNCTION public.can_access_personal_kaoyan_union_v1(uuid) FROM PUBLIC, anonymous;
GRANT EXECUTE ON FUNCTION public.can_access_personal_kaoyan_union_v1(uuid) TO authenticated, wordloop_admin;

-- The input key identifies the reusable request; payload_hash preserves a
-- changed result as another row instead of overwriting the previous revision.
CREATE UNIQUE INDEX lesson_generation_cache_idempotency_key
  ON public.lesson_generation_cache
  (user_id, private_set_id, word_id, cache_kind, cache_key, payload_hash);
CREATE INDEX lesson_generation_cache_lookup
  ON public.lesson_generation_cache
  (user_id, private_set_id, word_id, cache_kind, cache_key, created_at DESC)
  WHERE is_valid;
CREATE INDEX lesson_generation_cache_material_lookup
  ON public.lesson_generation_cache
  (user_id, private_set_id, word_id, target_sense, source_version, created_at DESC)
  WHERE cache_kind = 'materials' AND quality_status IN ('valid', 'partial');

ALTER TABLE public.lesson_generation_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.lesson_generation_cache FORCE ROW LEVEL SECURITY;
CREATE POLICY lesson_generation_cache_personal_union_scope
  ON public.lesson_generation_cache
  FOR ALL TO authenticated, wordloop_admin
  USING (
    user_id = (SELECT public.wordloop_authenticated_user_id())
    AND private_set_id = 'kaoyan-personal-union-v1'
    AND public.can_access_personal_kaoyan_union_v1(word_id)
  )
  WITH CHECK (
    user_id = (SELECT public.wordloop_authenticated_user_id())
    AND private_set_id = 'kaoyan-personal-union-v1'
    AND public.can_access_personal_kaoyan_union_v1(word_id)
  );
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lesson_generation_cache TO authenticated, wordloop_admin;
CREATE TRIGGER lesson_generation_cache_assert_user
  BEFORE INSERT OR UPDATE OR DELETE ON public.lesson_generation_cache
  FOR EACH ROW EXECUTE FUNCTION wordloop_private.assert_current_user_row();

COMMENT ON TABLE public.lesson_generation_cache IS
  'User-private Anki/DeepSeek Lesson cache; private_set_id plus user_id are required for every read and write.';
