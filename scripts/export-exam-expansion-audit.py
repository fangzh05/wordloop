import json,pathlib,collections,hashlib
p=pathlib.Path('.exam-books/expansion');out=pathlib.Path('docs/data/exam-books/expansion-20261011');out.mkdir(parents=True,exist_ok=True)
for file in ['sources.json','nawl-source.json','report.json','source-overlap.json','accepted-contributions.json','restricted-source-audit.json','model-review.json','release-gates.json','replay-result.json']:(out/file).write_bytes((p/file).read_bytes())
for a,b in [('KyleBing-4','KyleBing-LICENSE.txt'),('wangjiuyi543-ui-17','frequency-LICENSE.txt'),('gungorkaya-eng-4','gungorkaya-LICENSE.txt')]:(out/b).write_bytes((p/a).read_bytes())
payload=json.loads((p/'draft-corpus.json').read_text());(out/'additions.json').write_text(json.dumps(payload['relationships'],ensure_ascii=False,indent=2),encoding='utf8')
reviews=json.loads((p/'model-review.json').read_text());pending=json.loads((p/'human-review.json').read_text());summary={'pending_memberships':len(pending),'pending_unique_words':len({x['word'] for x in pending}),'issues':dict(collections.Counter(i for x in pending for i in x['issues'])),'model_requires_review':sum(x['requires_review'] for x in reviews),'model_identity_change_suggestions':sum(x['decision'] in ['inflection_of','spelling_variant','exact_duplicate'] for x in reviews),'missing_gloss_unique':len({x['word'] for x in pending if 'missing_chinese_gloss' in x['issues']}),'new_dictionary_rows':len(payload['dictionary_entries'])}
(out/'quality-summary.json').write_text(json.dumps(summary,indent=2))
v=json.loads((p/'backup/verification.json').read_text());(out/'backup-verification.json').write_text(json.dumps({k:x for k,x in v.items() if k!='files'},indent=2))
for f in out.iterdir():
 if f.is_file() and f.name!='manifest.json':f.write_bytes(f.read_bytes().replace(b'\r\n',b'\n'))
(out/'manifest.json').write_text(json.dumps({'status':'dry-run only; no production writes','files':{f.name:hashlib.sha256(f.read_bytes()).hexdigest() for f in out.iterdir() if f.name!='manifest.json'}},indent=2))
print(summary)
