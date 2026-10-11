import json,pathlib,csv,re
p=pathlib.Path('.exam-books/expansion');out=[]
for id,file,kind in [('fanhongtao','fanhongtao-0.txt','lines'),('LynnShaw','LynnShaw-1.csv','csv'),('Mundi-Xu','Mundi-Xu-vocabulary.txt','pipe'),('hefengxian','hefengxian-1.txt','pipe')]:
 text=(p/file).read_text(encoding='utf-8-sig');words=[]
 if kind=='csv':words=[r['word'] for r in csv.DictReader(text.splitlines())]
 elif kind=='pipe':words=[x.split('|')[0] for x in text.splitlines() if '|' in x]
 else:words=[m.group(1) for x in text.splitlines() if (m:=re.match(r"^([A-Za-z][A-Za-z '-]*?)\*?\s{2,}[/\[]",x))]
 out.append({'source':id,'raw_parsed':len(words),'unique':len({x.strip().lower() for x in words}),'public_contribution':0,'parse_note':'review-only heuristic; no commercial glosses exported','restriction':'commercial or no verified redistribution permission'})
(p/'restricted-source-audit.json').write_text(json.dumps(out,indent=2),encoding='utf8');print(out)
