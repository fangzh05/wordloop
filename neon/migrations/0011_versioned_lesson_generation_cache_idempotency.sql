-- Keep identical cache payloads from different content/prompt versions as
-- distinct historical rows instead of treating a newer version as a duplicate.
DROP INDEX IF EXISTS public.lesson_generation_cache_idempotency_key;

CREATE UNIQUE INDEX lesson_generation_cache_idempotency_key
  ON public.lesson_generation_cache
  (user_id, private_set_id, word_id, cache_kind, content_version, prompt_version, cache_key, payload_hash);
