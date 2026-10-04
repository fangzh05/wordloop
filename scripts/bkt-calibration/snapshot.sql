-- Read-only export template. Bind $1 to authenticated learner UUID.
-- Never commit UUIDs, answers, word strings, or raw event payloads.
-- Run once and retain its captured_at/hash. Do not refresh an opened holdout.
with candidates as (
 select e.*, row_number() over(partition by e.user_id,e.exercise_id,e.skill_id order by e.id) as rn
 from public.exercise_skill_evidence e
 where e.user_id=$1::uuid and e.evidence_version='evidence-v1'
 and e.outcome in ('correct','incorrect') and e.quality in ('OBSERVE','LEARN_ONLY')
 and not exists (
  select 1 from public.exercise_skill_evidence peer
  where peer.user_id=e.user_id and peer.submission_id=e.submission_id
    and peer.skill_id=e.skill_id and peer.outcome<>e.outcome
 )
), audit as (
 select e.id,e.skill_id,e.scope,e.quality,e.outcome,e.first_unprompted,e.hint_used,
 e.answer_revealed,e.modified_correct,e.created_at,a.activity_type,a.error_layer,a.is_correct,
 (lower(btrim(a.user_answer))=w.normalized_word) as exact_match,
 case
  when a.activity_type='review' and e.skill_id='target_word_spelling'
    then (e.outcome='correct')=(lower(btrim(a.user_answer))=w.normalized_word)
  when a.activity_type='review' and e.skill_id='target_sense_retrieval'
       and a.error_layer in ('none','meaning')
    then (e.outcome='correct')=(lower(btrim(a.user_answer))=w.normalized_word)
  else null
 end as deterministic_audit
 from candidates e
 left join public.attempts a on a.user_id=e.user_id and a.submission_id=e.submission_id
 left join public.words w on w.id=e.word_id
 where e.rn=1
)
select jsonb_build_object(
 'captured_at', now(),
 'human_gold_count', (select count(*) from public.evidence_gold_labels where user_id=$1::uuid),
 'rows', coalesce((select jsonb_agg(to_jsonb(audit) order by id) from audit),'[]'::jsonb)
) as snapshot;
