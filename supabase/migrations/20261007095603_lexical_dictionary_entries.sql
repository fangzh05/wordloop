-- Source dictionary entries are knowledge, never learning cards. Keep bilingual
-- lemma-level records separate from sense-specific OEWN definitions.
create table public.lexical_dictionary_entries (
  entry_id text primary key,
  lemma text not null check(lemma=lower(btrim(lemma)) and length(lemma) between 1 and 120),
  language text not null default 'en' check(language='en'),
  phonetic text,
  english_definition text not null check(length(english_definition)<=20000),
  chinese_translation text not null check(length(chinese_translation)<=20000),
  parts_of_speech jsonb not null check(jsonb_typeof(parts_of_speech)='array' and jsonb_array_length(parts_of_speech)<=32),
  source text not null check(length(btrim(source))>0),
  source_version text not null check(length(btrim(source_version))>0),
  license text not null check(length(btrim(license))>0),
  provenance jsonb not null check(jsonb_typeof(provenance)='object' and provenance<>'{}'),
  confidence double precision not null check(confidence between 0 and 1),
  imported_at timestamptz not null default now(),
  unique(language,lemma,source,source_version)
);
create index lexical_dictionary_lemma_idx on public.lexical_dictionary_entries(language,lemma,imported_at desc);
alter table public.lexical_dictionary_entries enable row level security;
revoke all on public.lexical_dictionary_entries from public,anon,authenticated;
grant select,insert,update,delete on public.lexical_dictionary_entries to service_role;
