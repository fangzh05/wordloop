"""Prepare transport chunks of the exact reviewed SQL; never connects to production."""
import pathlib, re, hashlib, json
d = pathlib.Path('.exam-books/expansion')
s = (d/'review-import.sql').read_text(encoding='utf-8')
# Schema is installed separately through a tracked migration. Transactions are
# provided by the single outer DO statement on the database connection.
s = re.sub(r'^begin;\n|^commit;\n', '', s, flags=re.M)
s = re.sub(r'^(?:create schema if not exists|revoke all on|create table if not exists exam_expansion_audit)[^\n]*\n', '', s, flags=re.M)
batch=json.loads((d/'release-gates.json').read_text())['batch']
out=d/'deployment';out.mkdir(exist_ok=True)
parts=[s[i:i+48000] for i in range(0,len(s),48000)]
for i,p in enumerate(parts):
    h=hashlib.sha256(p.encode()).hexdigest()
    q="insert into exam_expansion_audit.transport(batch,part,payload,hash) values ('%s',%d,'%s','%s') on conflict(batch,part) do nothing;"%(batch,i,p.replace("'","''"),h)
    (out/f'part-{i}.sql').write_text(q,encoding='utf-8',newline='')
h=hashlib.sha256(s.encode()).hexdigest()
final="""do $deploy$ declare statement text; begin
select string_agg(payload,'' order by part) into statement from exam_expansion_audit.transport where batch='%s';
if (select count(*) from exam_expansion_audit.transport where batch='%s')<>%d or
exists(select 1 from exam_expansion_audit.transport where batch='%s' and encode(sha256(convert_to(payload,'UTF8')),'hex')<>hash) or
encode(sha256(convert_to(statement,'UTF8')),'hex')<>'%s' then raise exception 'Transport hash mismatch'; end if;
execute statement;
end $deploy$;
"""%(batch,batch,len(parts),batch,h)
(out/'apply.sql').write_text(final,encoding='utf-8',newline='')
gate="if not exists(select 1 from exam_expansion_audit.checkpoints where batch='%s' and phase='restore_verified' and data->>'exact_json_match'='true') then raise exception 'Restore gate missing';end if;\n"%batch
(out/'apply-production.sql').write_text(final.replace('execute statement;',gate+'execute statement;'),encoding='utf-8',newline='')
(out/'plan.json').write_text(json.dumps(dict(batch=batch,parts=len(parts),sha256=h,reviewed_sql_sha256=hashlib.sha256((d/'review-import.sql').read_bytes()).hexdigest()),indent=2))
print((out/'plan.json').read_text())
