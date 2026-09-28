alter table public.attempts
  drop constraint if exists attempts_activity_type_check;

alter table public.attempts
  add constraint attempts_activity_type_check check (activity_type in (
    'pretest_cn_to_en', 'pretest_en_definition', 'translation_cn_to_en',
    'translation_en_to_cn', 'cloze', 'exact_cloze', 'derivation', 'listening',
    'collocation', 'sentence', 'review', 'recall'
  ));
