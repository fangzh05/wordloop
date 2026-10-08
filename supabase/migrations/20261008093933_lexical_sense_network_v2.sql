-- Administrator-reviewed sense translations/priorities only; never lemma glosses.
create table lexical_sense_annotations (
 sense_id text primary key references lexical_senses,
 definition_zh text check(length(definition_zh) between 1 and 1000), editorial_priority integer not null default 0 check(editorial_priority between -100 and 100),
 reviewer text not null check(reviewer<>''), source text not null check(source<>''), source_version text not null check(source_version<>''),
 license text not null check(license<>''), provenance jsonb not null check(jsonb_typeof(provenance)='object' and provenance<>'{}'),
 confidence double precision not null check(confidence between 0.85 and 1)
);
alter table lexical_sense_annotations enable row level security;
revoke all on lexical_sense_annotations from public,anon,authenticated;
grant select,insert,update,delete on lexical_sense_annotations to service_role;

-- Additive read-only V2. V1 and original knowledge remain intact.
create table lexical_spelling_variants (
 variant_id text primary key,
 first_sense_id text not null references lexical_senses,
 second_sense_id text not null references lexical_senses,
 first_label text not null, second_label text not null,
 source text not null check(source<>''), source_version text not null check(source_version<>''),
 license text not null check(license<>''), provenance jsonb not null check(jsonb_typeof(provenance)='object' and provenance<>'{}'),
 confidence double precision not null check(confidence between 0.85 and 1),
 check(first_sense_id < second_sense_id), unique(first_sense_id),unique(second_sense_id)
);
create function validate_lexical_spelling_variant_v2() returns trigger language plpgsql security invoker set search_path=public,pg_temp as $$
begin
 if not exists(select 1 from lexical_senses a join lexical_senses b on a.synset_id=b.synset_id
 join lexical_lexemes x on x.lexeme_id=a.lexeme_id join lexical_lexemes y on y.lexeme_id=b.lexeme_id
 where a.sense_id=new.first_sense_id and b.sense_id=new.second_sense_id and a.lexeme_id<>b.lexeme_id and x.part_of_speech=y.part_of_speech)
 or exists(select 1 from lexical_spelling_variants where variant_id<>new.variant_id
 and (first_sense_id in(new.first_sense_id,new.second_sense_id) or second_sense_id in(new.first_sense_id,new.second_sense_id)))
 then raise exception 'LEXICAL_VARIANT_INVALID'; end if;
 return new;
end $$;
create trigger lexical_variant_check before insert or update on lexical_spelling_variants for each row execute function validate_lexical_spelling_variant_v2();
alter table lexical_spelling_variants enable row level security;
revoke all on lexical_spelling_variants from public,anon,authenticated;
grant select,insert,update,delete on lexical_spelling_variants to service_role;
revoke all on function validate_lexical_spelling_variant_v2() from public,anon,authenticated;
grant execute on function validate_lexical_spelling_variant_v2() to service_role;

create function get_lexical_graph_v2(p_user_id uuid,p_entity text,p_types text[] default array['SYNONYM','ANTONYM','CONTRAST','COLLOCATION'],
 p_pos text default null,p_sense_id text default null,p_scope text default 'sense',p_offset integer default 0,p_limit integer default 8,p_include_folded boolean default false,p_evidence_offset integer default 0)
returns jsonb language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare v_center text; v_sense text; v_ids text[]; v_edges jsonb; v_nodes jsonb; v_options jsonb;
 v_groups jsonb; v_total integer; v_unscoped integer; v_edge_total integer; v_folded integer;
begin
 if p_evidence_offset is null or p_evidence_offset<0 or p_evidence_offset>10000 or p_include_folded is null or p_user_id is null or p_limit is null or p_limit<1 or p_limit>8 or p_offset is null or p_offset<0 or p_offset>10000
 or p_scope is null or p_scope not in ('sense','unscoped') or (p_pos is not null and p_pos not in('n','v','a','r'))
 or (p_scope='unscoped' and p_sense_id is not null) then raise exception 'LEXICAL_REQUEST_INVALID'; end if;
 if p_types is null or not(p_types<@array['SYNONYM','ANTONYM','CONTRAST','CONFUSABLE','COLLOCATION','HYPERNYM','HYPONYM']) then raise exception 'LEXICAL_REQUEST_INVALID'; end if;
 select coalesce(jsonb_agg(to_jsonb(l)||jsonb_build_object('senses',(select coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object('verified_definition_zh',a.definition_zh,'teaching_priority',coalesce(a.editorial_priority,0),'annotation',to_jsonb(a)) order by coalesce(a.editorial_priority,0) desc,s.sense_id),'[]') from lexical_senses s left join lexical_sense_annotations a using(sense_id) where s.lexeme_id=l.lexeme_id)) order by l.part_of_speech,l.lexeme_id),'[]')
 into v_options from lexical_lexemes l where l.lemma=lower(btrim(p_entity)) or l.lexeme_id=p_entity
 or l.lemma=(select lemma from lexical_lexemes where lexeme_id=p_entity);
 select lexeme_id into v_center from lexical_lexemes l where (l.lexeme_id=p_entity or l.lemma=lower(btrim(p_entity))) and (p_pos is null or l.part_of_speech=p_pos)
 and (p_sense_id is null or exists(select 1 from lexical_senses where sense_id=p_sense_id and lexeme_id=l.lexeme_id))
 order by (l.lexeme_id=p_entity) desc,l.part_of_speech,l.lexeme_id limit 1;
 if v_center is null then
  if jsonb_array_length(v_options)>0 and (p_pos is not null or p_sense_id is not null) then raise exception 'LEXICAL_REQUEST_INVALID'; end if;
  return null;
 end if;
 if p_sense_id is not null then
  if not exists(select 1 from lexical_senses where sense_id=p_sense_id and lexeme_id=v_center) then raise exception 'LEXICAL_SENSE_INVALID'; end if;
  v_sense:=p_sense_id;
 elsif p_scope='sense' then select s.sense_id into v_sense from lexical_senses s left join lexical_sense_annotations a using(sense_id) where s.lexeme_id=v_center order by coalesce(a.editorial_priority,0) desc,s.sense_id limit 1;
 end if;
 select count(*) into v_unscoped from lexical_graph_edges_v1 e where e.view='network' and e.confidence>=0.85
 and ((e.source_id=v_center and e.source_sense_id is null) or (e.target_id=v_center and e.target_sense_id is null));
 -- Filter FIRST. Never collect all polysemous adjacency and then recover senses client-side.
 with candidates as (
 select e.*,case when e.source_id=v_center then e.target_id else e.source_id end other_id,
 case when e.source_id=v_center then e.target_sense_id else e.source_sense_id end other_sense
 from lexical_graph_edges_v1 e where e.view='network' and e.confidence>=0.85 and e.relation_type=any(p_types)
 and e.source<>'' and e.source_version<>'' and e.license<>'' and jsonb_typeof(e.provenance)='object' and e.provenance<>'{}'
 and ((e.source_id=v_center and ((p_scope='sense' and e.source_sense_id=v_sense) or (p_scope='unscoped' and e.source_sense_id is null)))
 or (e.target_id=v_center and ((p_scope='sense' and e.target_sense_id=v_sense) or (p_scope='unscoped' and e.target_sense_id is null))))
 ), keyed as (
 select c.*,l.lemma,
 case when variant_id is null then other_id||':'||coalesce(other_sense,'unscoped') else 'variant:'||variant_id end group_id,
 case when l.lemma in('do','have','be','act') and c.relation_type='SYNONYM' then 1 else 0 end broad,
 case when c.relation_id like 'reviewed:%' then 1 else 0 end reviewed,
 case when uw.meaning_error or uw.collocation_error then 1 else 0 end needs_practice
 from candidates c left join lexical_lexemes l on l.lexeme_id=c.other_id
 left join lexical_spelling_variants v on c.other_sense in(v.first_sense_id,v.second_sense_id)
 left join words w on w.normalized_word=l.lemma left join user_words uw on uw.word_id=w.id and uw.user_id=p_user_id
 ), ranked as (
 select group_id,min(broad) broad,max(reviewed) reviewed,max(needs_practice) needs_practice,max(confidence) confidence,
 min(coalesce(lemma,other_id)) label from keyed group by group_id
 ), numbered as (
 select *,row_number() over(order by broad,reviewed desc,confidence desc,needs_practice desc,label,group_id) ordinal from ranked where p_include_folded or broad=0
 ), page as (select * from numbered where ordinal>p_offset and ordinal<=p_offset+p_limit)
 select (select count(*) from numbered), (select count(*) from ranked where broad=1),
 coalesce((select jsonb_agg(jsonb_build_object('group_id',p.group_id,
 'node_ids',(select jsonb_agg(id order by id) from (select distinct other_id id from keyed where group_id=p.group_id) n),
 'edge_ids',(select jsonb_agg(relation_id order by relation_id) from keyed where group_id=p.group_id),
 'variants',(select coalesce(jsonb_agg(jsonb_build_object('lexeme_id',s.lexeme_id,'label',case when s.sense_id=v.first_sense_id then v.first_label else v.second_label end,'source',v.source,'provenance',v.provenance)),'[]')
 from lexical_spelling_variants v join lexical_senses s on s.sense_id in(v.first_sense_id,v.second_sense_id) where 'variant:'||v.variant_id=p.group_id)) order by p.ordinal) from page p),'[]'),
 coalesce((select jsonb_agg(to_jsonb(k)-array['other_id','other_sense','group_id','lemma','broad','reviewed','needs_practice','view'] order by p.ordinal,k.relation_id) from keyed k join page p using(group_id)),'[]')
 into v_total,v_folded,v_groups,v_edges;
 -- Safety cap is separate from the eight pedagogical groups; retain truncation evidence.
 v_edge_total:=jsonb_array_length(v_edges);
 select coalesce(jsonb_agg(e),'[]') into v_edges from (select e from jsonb_array_elements(v_edges) with ordinality x(e,ord) order by ord offset p_evidence_offset limit 96) bounded;
 select array_prepend(v_center,coalesce(array_agg(id order by id),'{}')) into v_ids from (
 select distinct id from jsonb_array_elements(v_groups) g cross join lateral jsonb_array_elements_text(g->'node_ids') id where id<>v_center) n;
 -- Up to 8 groups x 2 explicitly verified spellings + center; no recursion.
 select coalesce(jsonb_agg(e||jsonb_build_object('source_definition',s.definition,'target_definition',t.definition,
 'source_examples',s.provenance->'example_sentences','target_examples',t.provenance->'example_sentences')),'[]') into v_edges
 from jsonb_array_elements(v_edges) e left join lexical_senses s on s.sense_id=e->>'source_sense_id' left join lexical_senses t on t.sense_id=e->>'target_sense_id';
 select coalesce(jsonb_agg(node order by node->>'node_id'),'[]') into v_nodes from (
 select to_jsonb(l)||jsonb_build_object('node_id',l.lexeme_id,'node_type','lexeme',
 'senses',(select coalesce(jsonb_agg(to_jsonb(s)),'[]') from (select * from lexical_senses where lexeme_id=l.lexeme_id order by sense_id) s),
 'forms',(select coalesce(jsonb_agg(to_jsonb(f)),'[]') from (select * from lexical_forms where lexeme_id=l.lexeme_id order by form_id limit 4) f),
 'user_state',case when uw.id is null then null else jsonb_build_object('status',uw.status,'stability',uw.fsrs_stability,'reps',uw.fsrs_reps,'consecutive_correct',uw.consecutive_correct,'next_review_at',uw.next_review_at,'error_layers',to_jsonb(array_remove(array[case when uw.meaning_error then 'meaning' end,case when uw.spelling_error then 'spelling' end,case when uw.pronunciation_error then 'pronunciation' end,case when uw.collocation_error then 'collocation' end,case when uw.grammar_error then 'grammar' end],null)),
 'layers',(select jsonb_object_agg(layer,jsonb_build_object('needs_practice',case layer when 'meaning' then uw.meaning_error when 'spelling' then uw.spelling_error when 'pronunciation' then uw.pronunciation_error when 'collocation' then uw.collocation_error else uw.grammar_error end,'correct_streak',p.consecutive_correct)) from unnest(array['meaning','spelling','pronunciation','collocation','grammar']) layer left join user_word_error_progress p on p.user_word_id=uw.id and p.error_layer=layer)) end,
 'priority',0.65,'reason','已核验的局部关系') node
 from lexical_lexemes l left join words w on w.normalized_word=l.lemma left join user_words uw on uw.word_id=w.id and uw.user_id=p_user_id where l.lexeme_id=any(v_ids)
 union all
 select to_jsonb(p)||jsonb_build_object('node_id',pattern_id,'node_type','pattern','lemma',pattern,'language','en','gloss',explanation) from lexical_usage_patterns p where pattern_id=any(v_ids)

 ) n;
 select coalesce(jsonb_agg(case when n->>'node_type'='lexeme' then n||jsonb_build_object('learner_state',n->'user_state') else n end),'[]') into v_nodes from jsonb_array_elements(v_nodes) n;

 return jsonb_build_object('view','network','center',(select n from jsonb_array_elements(v_nodes) n where n->>'node_id'=v_center),
 'nodes',v_nodes,'edges',v_edges,'depth',1,'truncated',v_total>p_offset+p_limit or v_edge_total>p_evidence_offset+96,
 'network',jsonb_build_object('selected_sense_id',v_sense,'scope',p_scope,'lexeme_options',v_options,'groups',v_groups,
 'total_groups',v_total,'next_evidence_offset',case when v_edge_total>p_evidence_offset+96 then p_evidence_offset+96 else null end,'next_offset',case when v_total>p_offset+p_limit then p_offset+p_limit else null end,'unscoped_count',v_unscoped,
 'folded_count',v_folded,'ordering','宽泛近义词折叠；审核来源、置信度、已有词义/搭配错误、词形及 ID 稳定排序。义项按审核优先级及 ID 排序；没有核验词频或考试证据时为中性值。'));
end $$;
revoke all on function get_lexical_graph_v2(uuid,text,text[],text,text,text,integer,integer,boolean,integer) from public,anon,authenticated;
grant execute on function get_lexical_graph_v2(uuid,text,text[],text,text,text,integer,integer,boolean,integer) to service_role;
