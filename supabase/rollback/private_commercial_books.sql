-- Soft rollback. Retain source rows, identities, preferences and all learner history.
-- Run only in the explicitly approved target environment.
begin;
update public.exam_books set is_available=false where id in
 ('ielts-wanglu-807-listening','ielts-zhenjing','toefl-xindongfang','cet6-xinghuo');
commit;
-- Keep the authorization-aware list RPC during application rollback: it hides
-- unavailable private catalog rows. Do not restore the old unfiltered catalog.
-- Re-select an authorized public target through the existing API when needed.
