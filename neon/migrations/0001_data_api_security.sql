-- Apply only after the business schema/data have been restored to Neon and the
-- external-auth Data API has created its `auth.user_id()` helper. The Data API
-- must expose only `public` and must be provisioned with default grants off.
-- This migration deliberately drops restored Supabase policies and installs a
-- fresh Neon policy set instead of treating those policies as portable security.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anonymous') THEN
    CREATE ROLE anonymous NOLOGIN NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'wordloop_admin') THEN
    CREATE ROLE wordloop_admin NOLOGIN NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS;
  END IF;
END $$;

-- Neon Data API starts each request as authenticator and uses the verified
-- JWT role claim with SET ROLE. The Worker emits wordloop_admin only for the
-- configured owner account, so the API needs permission to select that role.
-- authenticator is NOINHERIT; this does not give it admin privileges by
-- default, and wordloop_admin remains subject to RLS with NOBYPASSRLS.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    EXECUTE 'GRANT wordloop_admin TO authenticator';
  END IF;
END $$;

REVOKE ALL ON SCHEMA public FROM PUBLIC, anonymous, authenticated, wordloop_admin;
GRANT USAGE ON SCHEMA public TO authenticated, wordloop_admin;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, anonymous, authenticated, wordloop_admin;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anonymous, authenticated, wordloop_admin;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anonymous, authenticated, wordloop_admin;

-- The Data API roles cannot use Neon-managed schema auth directly. Expose only
-- the verified JWT subject through a tightly scoped, fixed-search-path wrapper.
CREATE OR REPLACE FUNCTION public.wordloop_authenticated_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT auth.user_id()::uuid
$$;
REVOKE ALL ON FUNCTION public.wordloop_authenticated_user_id() FROM PUBLIC, anonymous, authenticated, wordloop_admin;
GRANT EXECUTE ON FUNCTION public.wordloop_authenticated_user_id() TO authenticated, wordloop_admin;

-- No restored Supabase policy survives this reset. Each table below receives a
-- new explicit policy that uses the user ID from the Worker-signed Neon JWT.
DO $$
DECLARE policy_row record;
BEGIN
  FOR policy_row IN
    SELECT n.nspname, c.relname, pol.polname
    FROM pg_policy pol
    JOIN pg_class c ON c.oid = pol.polrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
  LOOP
    EXECUTE format('DROP POLICY %I ON %I.%I', policy_row.polname, policy_row.nspname, policy_row.relname);
  END LOOP;
END $$;

-- Only user-scoped routines need to run with the caller's database role. This
-- makes Postgres RLS apply inside legacy routines that were SECURITY DEFINER
-- under Supabase's service-role model. rls_auto_enable remains an owner-only
-- maintenance routine and is not exposed through the Data API.
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.prosecdef
      AND p.proname NOT IN ('rls_auto_enable', 'wordloop_authenticated_user_id')
  LOOP
    EXECUTE format('ALTER FUNCTION %I.%I(%s) SECURITY INVOKER', f.nspname, f.proname, f.args);
  END LOOP;
END $$;

CREATE SCHEMA IF NOT EXISTS wordloop_private;
REVOKE ALL ON SCHEMA wordloop_private FROM PUBLIC, anonymous, authenticated, wordloop_admin;

CREATE OR REPLACE FUNCTION wordloop_private.assert_current_user_row()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  row_user_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_user_id := OLD.user_id;
  ELSE
    row_user_id := NEW.user_id;
  END IF;
  IF row_user_id IS DISTINCT FROM public.wordloop_authenticated_user_id() THEN
    RAISE EXCEPTION 'WordLoop row is outside the authenticated user scope' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.user_id IS DISTINCT FROM public.wordloop_authenticated_user_id() THEN
    RAISE EXCEPTION 'WordLoop row is outside the authenticated user scope' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION wordloop_private.assert_current_user_parent()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  parent_id uuid;
  parent_user_id uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    parent_id := (to_jsonb(OLD) ->> TG_ARGV[1])::uuid;
  ELSE
    parent_id := (to_jsonb(NEW) ->> TG_ARGV[1])::uuid;
  END IF;
  EXECUTE format('SELECT user_id FROM public.%I WHERE id = $1', TG_ARGV[0])
    INTO parent_user_id USING parent_id;
  IF parent_user_id IS DISTINCT FROM public.wordloop_authenticated_user_id() THEN
    RAISE EXCEPTION 'WordLoop child row is outside the authenticated user scope' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    EXECUTE format('SELECT user_id FROM public.%I WHERE id = $1', TG_ARGV[0])
      INTO parent_user_id USING (to_jsonb(OLD) ->> TG_ARGV[1])::uuid;
    IF parent_user_id IS DISTINCT FROM public.wordloop_authenticated_user_id() THEN
      RAISE EXCEPTION 'WordLoop child row is outside the authenticated user scope' USING ERRCODE = '42501';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION wordloop_private.assert_current_user_row() FROM PUBLIC, anonymous, authenticated, wordloop_admin;
REVOKE ALL ON FUNCTION wordloop_private.assert_current_user_parent() FROM PUBLIC, anonymous, authenticated, wordloop_admin;

-- User-owned rows are scoped by their user_id column. The trigger is a second
-- check for writes made by a legacy SECURITY DEFINER routine.
DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'user_id' AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'users'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('CREATE POLICY wordloop_user_scope ON public.%I FOR ALL TO authenticated, wordloop_admin USING (user_id = (SELECT public.wordloop_authenticated_user_id())) WITH CHECK (user_id = (SELECT public.wordloop_authenticated_user_id()))', t.relname);
    EXECUTE format('DROP TRIGGER IF EXISTS wordloop_user_scope_guard ON public.%I', t.relname);
    EXECUTE format('CREATE TRIGGER wordloop_user_scope_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION wordloop_private.assert_current_user_row()', t.relname);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated, wordloop_admin', t.relname);
  END LOOP;
END $$;
REVOKE INSERT, UPDATE, DELETE ON public.exam_book_entitlements FROM authenticated, wordloop_admin;

-- User profile data is private. The owner-only WordLoop account endpoint can
-- create a profile for the Auth user it just created; learners cannot create
-- profiles or modify another user's row.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;
CREATE POLICY wordloop_users_select_self ON public.users
  FOR SELECT TO authenticated, wordloop_admin USING (id = (SELECT public.wordloop_authenticated_user_id()));
CREATE POLICY wordloop_users_insert_admin ON public.users
  FOR INSERT TO wordloop_admin WITH CHECK (true);
CREATE POLICY wordloop_users_update_self ON public.users
  FOR UPDATE TO authenticated, wordloop_admin
  USING (id = (SELECT public.wordloop_authenticated_user_id())) WITH CHECK (id = (SELECT public.wordloop_authenticated_user_id()));
GRANT SELECT, UPDATE ON public.users TO authenticated, wordloop_admin;
GRANT INSERT ON public.users TO wordloop_admin;

-- Rows without user_id inherit their owner's scope through a parent FK.
DO $$
DECLARE child_table text; parent_table text; child_key text;
BEGIN
  FOR child_table, parent_table, child_key IN
    SELECT * FROM (VALUES
      ('capture_note_occurrences', 'capture_notes', 'note_id'),
      ('daily_import_words', 'daily_imports', 'import_id'),
      ('difficult_sentence_words', 'difficult_sentences', 'sentence_id'),
      ('user_word_error_progress', 'user_words', 'user_word_id')
    ) AS relationships(child_table, parent_table, child_key)
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', child_table);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', child_table);
    EXECUTE format(
      'CREATE POLICY wordloop_parent_scope ON public.%I FOR ALL TO authenticated, wordloop_admin USING (EXISTS (SELECT 1 FROM public.%I parent WHERE parent.id = %I.%I)) WITH CHECK (EXISTS (SELECT 1 FROM public.%I parent WHERE parent.id = %I.%I))',
      child_table, parent_table, child_table, child_key, parent_table, child_table, child_key
    );
    EXECUTE format('DROP TRIGGER IF EXISTS wordloop_parent_scope_guard ON public.%I', child_table);
    EXECUTE format('CREATE TRIGGER wordloop_parent_scope_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION wordloop_private.assert_current_user_parent(%L, %L)', child_table, parent_table, child_key);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO authenticated, wordloop_admin', child_table);
  END LOOP;
END $$;

-- WordLoop's account records, dictionary and lexical graph are global or
-- separately scoped. Learners can read the shared dictionary/graph. The
-- vocabulary import RPC may add canonical words, while lexical datasets remain
-- read-only to application tokens.
ALTER TABLE public.words ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.words FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE ON public.words TO authenticated, wordloop_admin;
CREATE POLICY wordloop_words_read ON public.words
  FOR SELECT TO authenticated, wordloop_admin USING (true);
CREATE POLICY wordloop_words_insert ON public.words
  FOR INSERT TO authenticated, wordloop_admin WITH CHECK (true);
CREATE POLICY wordloop_words_update ON public.words
  FOR UPDATE TO authenticated, wordloop_admin USING (true) WITH CHECK (true);

DO $$
DECLARE t record;
BEGIN
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND (c.relname LIKE 'lexical\_%' ESCAPE '\')
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t.relname);
    EXECUTE format('CREATE POLICY wordloop_lexical_read ON public.%I FOR SELECT TO authenticated, wordloop_admin USING (true)', t.relname);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated, wordloop_admin', t.relname);
  END LOOP;
END $$;

ALTER TABLE public.exam_books ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_books FORCE ROW LEVEL SECURITY;
CREATE POLICY wordloop_exam_books_visible ON public.exam_books
  FOR SELECT TO authenticated, wordloop_admin
  USING (
    (is_public AND is_available)
    OR EXISTS (
      SELECT 1 FROM public.exam_book_entitlements entitlement
      WHERE entitlement.book_id = exam_books.id
        AND entitlement.user_id = (SELECT public.wordloop_authenticated_user_id())
        AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
    )
  );
GRANT SELECT ON public.exam_books TO authenticated, wordloop_admin;

ALTER TABLE public.exam_book_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_book_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY wordloop_entitlement_self_read ON public.exam_book_entitlements
  FOR SELECT TO authenticated, wordloop_admin USING (user_id = (SELECT public.wordloop_authenticated_user_id()));
GRANT SELECT ON public.exam_book_entitlements TO authenticated, wordloop_admin;

ALTER TABLE public.exam_book_words ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_book_words FORCE ROW LEVEL SECURITY;
CREATE POLICY wordloop_exam_book_words_visible ON public.exam_book_words
  FOR SELECT TO authenticated, wordloop_admin
  USING (EXISTS (SELECT 1 FROM public.exam_books book WHERE book.id = exam_book_words.book_id));
GRANT SELECT ON public.exam_book_words TO authenticated, wordloop_admin;

ALTER TABLE public.exam_definition_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exam_definition_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY wordloop_exam_definition_sources_visible ON public.exam_definition_sources
  FOR SELECT TO authenticated, wordloop_admin
  USING (EXISTS (SELECT 1 FROM public.exam_books book WHERE book.id = exam_definition_sources.exam_id));
GRANT SELECT ON public.exam_definition_sources TO authenticated, wordloop_admin;

-- Private licensed definitions require an active per-user entitlement. The
-- service RPC uses the same row policy, and no authenticated write grants exist.
ALTER TABLE public.source_definition_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_definition_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY wordloop_source_batches_entitled_read ON public.source_definition_batches
  FOR SELECT TO authenticated, wordloop_admin
  USING (EXISTS (
    SELECT 1 FROM public.exam_book_entitlements entitlement
    WHERE entitlement.book_id = source_definition_batches.book_id
      AND entitlement.user_id = (SELECT public.wordloop_authenticated_user_id())
      AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
      AND entitlement.third_party_processing_allowed
  ));
GRANT SELECT ON public.source_definition_batches TO authenticated, wordloop_admin;

ALTER TABLE public.word_source_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.word_source_definitions FORCE ROW LEVEL SECURITY;
CREATE POLICY wordloop_source_definitions_entitled_read ON public.word_source_definitions
  FOR SELECT TO authenticated, wordloop_admin
  USING (EXISTS (
    SELECT 1 FROM public.exam_book_entitlements entitlement
    WHERE entitlement.book_id = word_source_definitions.book_id
      AND entitlement.user_id = (SELECT public.wordloop_authenticated_user_id())
      AND (entitlement.expires_at IS NULL OR entitlement.expires_at > now())
      AND entitlement.third_party_processing_allowed
  ));
GRANT SELECT ON public.word_source_definitions TO authenticated, wordloop_admin;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO authenticated, wordloop_admin;

-- Trigger functions are not RPCs. Keep the maintenance toggle private; expose
-- the rest only to authenticated Worker-minted roles.
DO $$
DECLARE f record;
BEGIN
  FOR f IN
    SELECT n.nspname, p.proname, pg_get_function_identity_arguments(p.oid) AS args
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f' AND p.proname <> 'rls_auto_enable'
      AND p.prorettype <> 'trigger'::regtype
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I(%s) TO authenticated, wordloop_admin', f.nspname, f.proname, f.args);
  END LOOP;
END $$;

-- New objects created after this migration stay private by default. Owner-managed
-- catalog imports use the Neon owner connection and do not pass through Data API.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anonymous, authenticated, wordloop_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anonymous, authenticated, wordloop_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anonymous, authenticated, wordloop_admin;
