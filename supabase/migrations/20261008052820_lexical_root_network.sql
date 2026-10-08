-- Additive knowledge schema; no learning/scheduler writes. All edges carry evidence.
create index if not exists lexical_lexemes_lemma_idx on lexical_lexemes(lemma,part_of_speech,lexeme_id);
create table lexical_etymons (
 etymon_id text primary key check(etymon_id like 'ety:%'), historical_form text not null,
 language text not null, gloss text not null, period text, explanation text not null default '', uncertain boolean not null default false,
 source text not null check(source<>''), source_version text not null check(source_version<>''), license text not null check(license<>''),
 provenance jsonb not null check(jsonb_typeof(provenance)='object' and provenance<>'{}'), confidence double precision not null check(confidence between 0 and 1)
);
create table lexical_etymological_links (
 link_id text primary key, source_lexeme_id text references lexical_lexemes, source_etymon_id text references lexical_etymons,
 target_lexeme_id text references lexical_lexemes, target_etymon_id text references lexical_etymons,
 relation_type text not null check(relation_type in ('ETYMOLOGICAL_ORIGIN','SHARED_ETYMON','MORPHOLOGICAL_DERIVATION')),
 direction text not null check(direction in ('forward','undirected')), explanation text not null,
 source text not null check(source<>''), source_version text not null check(source_version<>''), license text not null check(license<>''),
 provenance jsonb not null check(jsonb_typeof(provenance)='object' and provenance<>'{}'), confidence double precision not null check(confidence between 0 and 1),
 check(num_nonnulls(source_lexeme_id,source_etymon_id)=1 and num_nonnulls(target_lexeme_id,target_etymon_id)=1),
 check(coalesce(source_lexeme_id,source_etymon_id)<>coalesce(target_lexeme_id,target_etymon_id)),
 check(relation_type<>'MORPHOLOGICAL_DERIVATION' or (source_lexeme_id is not null and target_lexeme_id is not null)),
 check(relation_type<>'SHARED_ETYMON' or (source_etymon_id is not null and target_lexeme_id is not null))
);
create index lexical_etylinks_source_lexeme_idx on lexical_etymological_links(source_lexeme_id,relation_type,confidence);
create index lexical_etylinks_target_lexeme_idx on lexical_etymological_links(target_lexeme_id,relation_type,confidence);
create index lexical_etylinks_source_etymon_idx on lexical_etymological_links(source_etymon_id,relation_type,confidence);
create index lexical_etylinks_target_etymon_idx on lexical_etymological_links(target_etymon_id,relation_type,confidence);
create table lexical_sense_relations (
 relation_id text primary key, source_sense_id text not null references lexical_senses, target_sense_id text not null references lexical_senses,
 relation_type text not null check(relation_type in ('SYNONYM','ANTONYM','CONTRAST','CONFUSABLE','HYPERNYM','HYPONYM')),
 direction text not null check(direction in ('forward','undirected')), explanation text not null,
 source text not null check(source<>''), source_version text not null check(source_version<>''), license text not null check(license<>''),
 provenance jsonb not null check(jsonb_typeof(provenance)='object' and provenance<>'{}'), confidence double precision not null check(confidence between 0 and 1),
 check(source_sense_id<>target_sense_id)
);
create index lexical_sense_relations_source_idx on lexical_sense_relations(source_sense_id,relation_type,confidence);
create index lexical_sense_relations_target_idx on lexical_sense_relations(target_sense_id,relation_type,confidence);
create index if not exists lexical_senses_synset_idx on lexical_senses(synset_id,lexeme_id);
-- Composite FK prevents a pattern being silently attached to another word's sense.
alter table lexical_senses add constraint lexical_senses_id_lexeme_key unique(sense_id,lexeme_id);
create table lexical_usage_patterns (
 pattern_id text primary key check(pattern_id like 'pattern:%'), lexeme_id text not null references lexical_lexemes,
 sense_id text, pattern text not null check(length(pattern) between 1 and 200), explanation text not null, example text,
 source text not null check(source<>''), source_version text not null check(source_version<>''), license text not null check(license<>''),
 provenance jsonb not null check(jsonb_typeof(provenance)='object' and provenance<>'{}'), confidence double precision not null check(confidence between 0 and 1),
 foreign key(sense_id,lexeme_id) references lexical_senses(sense_id,lexeme_id)
);
create index lexical_usage_patterns_lexeme_idx on lexical_usage_patterns(lexeme_id,sense_id);
create table lexical_lexeme_morphemes (
 association_id text primary key, lexeme_id text not null references lexical_lexemes, morpheme_id text not null references lexical_morphemes,
 explanation text not null, source text not null check(source<>''), source_version text not null check(source_version<>''), license text not null check(license<>''),
 provenance jsonb not null check(jsonb_typeof(provenance)='object' and provenance<>'{}'), confidence double precision not null check(confidence between 0 and 1)
);
create index lexical_lexeme_morphemes_lexeme_idx on lexical_lexeme_morphemes(lexeme_id);
create index lexical_lexeme_morphemes_morpheme_idx on lexical_lexeme_morphemes(morpheme_id);
do $$ declare t text; begin
 foreach t in array array['lexical_etymons','lexical_etymological_links','lexical_sense_relations','lexical_usage_patterns','lexical_lexeme_morphemes'] loop
 execute format('alter table public.%I enable row level security',t);
 execute format('revoke all on public.%I from public,anon,authenticated',t);
 execute format('grant select,insert,update,delete on public.%I to service_role',t);
 end loop;
end $$;
-- Project existing records rather than duplicating the dictionary. This service-only
-- view carries sense IDs and never promotes a synset translation to a Chinese sense.
create view lexical_graph_edges_v1 with (security_invoker=true) as
 select link_id relation_id,coalesce(source_lexeme_id,source_etymon_id) source_id,coalesce(target_lexeme_id,target_etymon_id) target_id,
 relation_type,direction,explanation,source,source_version,license,provenance,confidence,null::text source_sense_id,null::text target_sense_id,'root'::text view
 from lexical_etymological_links
 union all
 select r.relation_id,s.lexeme_id,t.lexeme_id,r.relation_type,r.direction,r.explanation,r.source,r.source_version,r.license,r.provenance,r.confidence,r.source_sense_id,r.target_sense_id,'network'
 from lexical_sense_relations r join lexical_senses s on s.sense_id=r.source_sense_id join lexical_senses t on t.sense_id=r.target_sense_id where s.lexeme_id<>t.lexeme_id
 union all
 select relation_id,source_id,target_id,relation_type,direction,coalesce(morphology,''),source,source_version,license,provenance,confidence,null,null,'network'
 from lexical_relations where relation_type in ('ANTONYM','CONTRAST','CONFUSABLE','HYPERNYM','HYPONYM')
 union all
 select pattern_id||':edge',lexeme_id,pattern_id,'COLLOCATION','forward',explanation,source,source_version,license,provenance,confidence,sense_id,null,'network' from lexical_usage_patterns
 union all
 select a.association_id,a.lexeme_id,m.morpheme_id,upper(m.type),'forward',a.explanation,a.source,a.source_version,a.license,a.provenance,a.confidence,null,null,'root'
 from lexical_lexeme_morphemes a join lexical_morphemes m using(morpheme_id);
revoke all on lexical_graph_edges_v1 from public,anon,authenticated;
grant select on lexical_graph_edges_v1 to service_role;
create function get_lexical_graph_v1(p_user_id uuid,p_entity text,p_view text,p_types text[] default array['SYNONYM','ANTONYM','CONTRAST','COLLOCATION'],p_limit integer default 24)
returns jsonb language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare v_center text; v_ids text[]; v_edges jsonb; v_nodes jsonb; v_total integer; v_edge_total integer;
begin
 if p_limit<1 or p_limit>24 or p_view not in ('root','network') or p_user_id is null then raise exception 'LEXICAL_REQUEST_INVALID'; end if;
 if p_types is null or not(p_types<@array['SYNONYM','ANTONYM','CONTRAST','CONFUSABLE','COLLOCATION','HYPERNYM','HYPONYM']) then raise exception 'LEXICAL_FILTER_INVALID'; end if;
 select lexeme_id into v_center from lexical_lexemes where lexeme_id=p_entity or lemma=lower(btrim(p_entity))
 order by (lexeme_id=p_entity) desc,case when p_view='root' and part_of_speech='n' then 0 when part_of_speech='v' then 1 when part_of_speech='n' then 2 else 3 end,lexeme_id limit 1;
 if v_center is null and p_view='root' then select etymon_id into v_center from lexical_etymons where etymon_id=p_entity; end if;
 if v_center is null then return null; end if;
 -- Explicit shared-etymon memberships are evidence-backed historical closures,
 -- not inferred strings. A projected shared edge retains BOTH membership paths.
 with adjacent as (
 select * from lexical_graph_edges_v1 e where e.view=p_view and e.confidence>=0.85 and (e.source_id=v_center or e.target_id=v_center)
 and (p_view='root' or e.relation_type=any(p_types))
 union all
 select 'shared:'||a.link_id||':'||b.link_id,v_center,b.target_lexeme_id,'SHARED_ETYMON','undirected','共同祖源；不表示两个现代词之间直接派生。',a.source,a.source_version,a.license,
 jsonb_build_object('etymon_id',a.source_etymon_id,'url',a.provenance->>'url','paths',jsonb_build_array(to_jsonb(a),to_jsonb(b))),least(a.confidence,b.confidence),null,null,'root'
 from lexical_etymological_links a join lexical_etymological_links b on b.source_etymon_id=a.source_etymon_id
 where p_view='root' and a.relation_type='SHARED_ETYMON' and b.relation_type='SHARED_ETYMON'
 and a.target_lexeme_id=v_center and b.target_lexeme_id<>v_center and a.confidence>=0.85 and b.confidence>=0.85
 ) select coalesce(jsonb_agg(to_jsonb(a) order by relation_id),'[]') into v_edges from adjacent a;
 select count(distinct id) into v_total from (select e->>'source_id' id from jsonb_array_elements(v_edges) e union select e->>'target_id' from jsonb_array_elements(v_edges) e) n where id<>v_center;
 select array_prepend(v_center,coalesce(array_agg(id),'{}')) into v_ids from (
 select distinct id from (select e->>'source_id' id from jsonb_array_elements(v_edges) e union select e->>'target_id' from jsonb_array_elements(v_edges) e) n
 where id<>v_center order by id limit p_limit-1) n;
 select count(*) into v_edge_total from jsonb_array_elements(v_edges) e where e->>'source_id'=any(v_ids) and e->>'target_id'=any(v_ids);
 select coalesce(jsonb_agg(e),'[]') into v_edges from (
 select e from jsonb_array_elements(v_edges) e where e->>'source_id'=any(v_ids) and e->>'target_id'=any(v_ids) order by e->>'relation_id' limit 96) bounded;
 -- Bounded batch join keeps relation-specific senses available even when the
 -- lexeme has more than the eight senses displayed in its dictionary card.
 select coalesce(jsonb_agg(e||jsonb_build_object('source_definition',s.definition,'target_definition',t.definition)),'[]') into v_edges
 from jsonb_array_elements(v_edges) e left join lexical_senses s on s.sense_id=e->>'source_sense_id'
 left join lexical_senses t on t.sense_id=e->>'target_sense_id';
 select coalesce(jsonb_agg(node order by node->>'node_id'),'[]') into v_nodes from (
 select to_jsonb(l)||jsonb_build_object('node_id',l.lexeme_id,'node_type','lexeme',
 'senses',(select coalesce(jsonb_agg(to_jsonb(s)),'[]') from (select * from lexical_senses where lexeme_id=l.lexeme_id order by sense_id limit 8) s),
 'forms',(select coalesce(jsonb_agg(to_jsonb(f)),'[]') from (select * from lexical_forms where lexeme_id=l.lexeme_id order by form_id limit 4) f),
 'user_state',case when uw.id is null then null else jsonb_build_object('status',uw.status,'stability',uw.fsrs_stability,'reps',uw.fsrs_reps,'consecutive_correct',uw.consecutive_correct,'next_review_at',uw.next_review_at,'error_layers',to_jsonb(array_remove(array[case when uw.meaning_error then 'meaning' end,case when uw.spelling_error then 'spelling' end,case when uw.pronunciation_error then 'pronunciation' end,case when uw.collocation_error then 'collocation' end,case when uw.grammar_error then 'grammar' end],null)),
 'layers',(select jsonb_object_agg(layer,jsonb_build_object('needs_practice',case layer when 'meaning' then uw.meaning_error when 'spelling' then uw.spelling_error when 'pronunciation' then uw.pronunciation_error when 'collocation' then uw.collocation_error else uw.grammar_error end,'correct_streak',p.consecutive_correct)) from unnest(array['meaning','spelling','pronunciation','collocation','grammar']) layer left join user_word_error_progress p on p.user_word_id=uw.id and p.error_layer=layer)) end,
 'priority',0.65,'reason','已核验的局部关系') node
 from lexical_lexemes l left join words w on w.normalized_word=l.lemma left join user_words uw on uw.word_id=w.id and uw.user_id=p_user_id where l.lexeme_id=any(v_ids)
 union all
 select to_jsonb(e)||jsonb_build_object('node_id',etymon_id,'node_type','etymon','lemma',historical_form) from lexical_etymons e where etymon_id=any(v_ids)
 union all
 select to_jsonb(p)||jsonb_build_object('node_id',pattern_id,'node_type','pattern','lemma',pattern,'language','en','gloss',explanation) from lexical_usage_patterns p where pattern_id=any(v_ids)
 union all
 select to_jsonb(m)||to_jsonb(a)||jsonb_build_object('node_id',m.morpheme_id,'node_type','morpheme','lemma',m.surface,'language','en','gloss',m.meaning) from lexical_morphemes m join lateral (select * from lexical_lexeme_morphemes where morpheme_id=m.morpheme_id order by association_id limit 1) a on true where m.morpheme_id=any(v_ids)
 ) n;
 select coalesce(jsonb_agg(case when n->>'node_type'='lexeme' then n||jsonb_build_object('learner_state',n->'user_state') else n end),'[]') into v_nodes from jsonb_array_elements(v_nodes) n;
 return jsonb_build_object('view',p_view,'center',(select n from jsonb_array_elements(v_nodes) n where n->>'node_id'=v_center),'nodes',v_nodes,'edges',v_edges,'depth',1,'truncated',v_total>p_limit-1 or v_edge_total>96);
end $$;
revoke all on function get_lexical_graph_v1(uuid,text,text,text[],integer) from public,anon,authenticated;
grant execute on function get_lexical_graph_v1(uuid,text,text,text[],integer) to service_role;
