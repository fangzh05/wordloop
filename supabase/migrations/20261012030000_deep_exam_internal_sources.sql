-- Internal source metadata only. No payload, grants, membership writes or activation.
-- Requires 20261012020000. Original private data remains immutable.
do $guard$
begin
 if (select md5(pg_get_constraintdef(oid)) from pg_constraint where conrelid='public.exam_books'::regclass and conname='exam_books_id_check') is distinct from 'b4a8ddf1f58c647b60d2c66269ff0c30'
 or (select md5(pg_get_constraintdef(oid)) from pg_constraint where conrelid='public.word_source_definitions'::regclass and conname='word_source_definitions_book_id_check') is distinct from 'bb6945c7eb5f31cc3513d61b84554411'
 or (select md5(pg_get_constraintdef(oid)) from pg_constraint where conrelid='public.exam_definition_sources'::regclass and conname='exam_definition_sources_source_book_id_check') is distinct from '09687786af62a1a83dfd6ff44df71af2' then raise exception 'DEEP_SOURCE_CONSTRAINT_BASELINE_DRIFT';end if;
end $guard$;
alter table public.exam_books drop constraint exam_books_id_check;
alter table public.exam_books add constraint exam_books_id_check check(id in ('cet4','cet6','kaoyan','ielts','toefl','ielts-wanglu-807-listening','ielts-zhenjing','toefl-xindongfang','cet6-xinghuo','ielts-xindongfang','ielts-youdao','ielts-youdao-luan','ielts-niannian','ielts-leiji','ielts-jianqiao','toefl-youdao','toefl-gaopin','toefl-kyle-expanded'));
alter table public.word_source_definitions drop constraint word_source_definitions_book_id_check;
alter table public.word_source_definitions add constraint word_source_definitions_book_id_check check(book_id in ('ielts-wanglu-807-listening','ielts-zhenjing','toefl-xindongfang','cet6-xinghuo','ielts-xindongfang','ielts-youdao','ielts-youdao-luan','ielts-niannian','ielts-leiji','ielts-jianqiao','toefl-youdao','toefl-gaopin','toefl-kyle-expanded'));
alter table public.exam_definition_sources drop constraint exam_definition_sources_source_book_id_check;
alter table public.exam_definition_sources add constraint exam_definition_sources_source_book_id_check check(source_book_id in ('ielts-wanglu-807-listening','ielts-zhenjing','toefl-xindongfang','cet6-xinghuo','ielts-xindongfang','ielts-youdao','ielts-youdao-luan','ielts-niannian','ielts-leiji','ielts-jianqiao','toefl-youdao','toefl-gaopin','toefl-kyle-expanded'));
insert into public.exam_books(id,name_zh,name_en,sort_order,source,source_version,license) values
('ielts-xindongfang','新东方雅思（内部来源）','Internal ielts-xindongfang',9,'source_missing','pending','private_review_required'),
('ielts-youdao','有道雅思正序（内部来源）','Internal ielts-youdao',10,'source_missing','pending','private_review_required'),
('ielts-youdao-luan','有道雅思乱序（内部来源）','Internal ielts-youdao-luan',11,'source_missing','pending','private_review_required'),
('ielts-niannian','雅思词汇念念不忘（内部来源）','Internal ielts-niannian',12,'source_missing','pending','private_review_required'),
('ielts-leiji','IELTS词汇词以类记（内部来源）','Internal ielts-leiji',13,'source_missing','pending','private_review_required'),
('ielts-jianqiao','剑桥雅思词汇精典（内部来源）','Internal ielts-jianqiao',14,'source_missing','pending','private_review_required'),
('toefl-youdao','有道托福（内部来源）','Internal toefl-youdao',15,'source_missing','pending','private_review_required'),
('toefl-gaopin','托福高频词汇精讲（内部来源）','Internal toefl-gaopin',16,'source_missing','pending','private_review_required'),
('toefl-kyle-expanded','托福继承汇总（内部来源）','Internal toefl-kyle-expanded',17,'source_missing','pending','private_review_required') on conflict(id) do nothing;
insert into public.exam_definition_sources(exam_id,source_book_id,priority) values
('toefl','toefl-xindongfang',30),
('ielts','ielts-xindongfang',40),
('ielts','ielts-youdao',50),
('ielts','ielts-youdao-luan',60),
('ielts','ielts-niannian',70),
('ielts','ielts-leiji',80),
('ielts','ielts-jianqiao',90),
('toefl','toefl-youdao',100),
('toefl','toefl-gaopin',110),
('toefl','toefl-kyle-expanded',120) on conflict do nothing;
-- Extend the existing guarded admin intake, preserving all original validations.
do $$
declare body text; needle text := $old$if p_book not in ('ielts-wanglu-807-listening','ielts-zhenjing','cet6-xinghuo','toefl-xindongfang')$old$;
begin
 body:=pg_get_functiondef('commercial_import_admin.import_rows_v1(text,text,jsonb)'::regprocedure);
 if (length(body)-length(replace(body,needle,'')))/length(needle)<>1 then raise exception 'PRIVATE_INTAKE_BASELINE_DRIFT';end if;
 execute replace(body,needle,$new$if p_book not in ('ielts-wanglu-807-listening','ielts-zhenjing','toefl-xindongfang','cet6-xinghuo','ielts-xindongfang','ielts-youdao','ielts-youdao-luan','ielts-niannian','ielts-leiji','ielts-jianqiao','toefl-youdao','toefl-gaopin','toefl-kyle-expanded')$new$);
end $$;
