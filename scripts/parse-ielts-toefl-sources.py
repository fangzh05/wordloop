"""Lossless private staging; no database/network/model writes. Python 3 + openpyxl.
JSONL is parsed one physical line at a time; SQL-export tables join by actual IDs.
All text and original records remain outside Git. Identity changes are proposals.
"""
import hashlib,json,pathlib,re,sys,unicodedata,importlib.util
def digest(b):return hashlib.sha256(b).hexdigest()
def load(p):return json.loads(p.read_text('utf-8-sig'))
def run(root):
 root=pathlib.Path(root).resolve();checkout=pathlib.Path(__file__).resolve().parents[1]
 if root==checkout or checkout in root.parents:raise ValueError('Private directory required')
 books={};audit=[]
 def add(repo,path,id,exam,rows,name,version='unverified',derived=False):
  base=root/repo;p=base/'files'/path;pin=load(base/'lock.json')
  meta={'repo':repo,'commit':pin['commit'],'path':path,'sha256':digest(p.read_bytes())}
  captured=next(x for x in load(base/'manifest.json')['files'] if x['path']==path)
  if captured['sha256']!=meta['sha256']:raise ValueError('Pinned file checksum drift')
  records=[]
  for n,r in enumerate(rows,1):
   word=r['word'];locator=r.get('source_locator',f'line:{n}')
   r.update(source_row=n,source_locator=locator,normalized_word=word.strip().lower(),entry_key=digest(json.dumps([meta['sha256'],locator,word],ensure_ascii=False,separators=(',',':')).encode()),chapter=r.get('chapter'),category=r.get('category'),ipa_uk=r.get('ipa_uk'),ipa_us=r.get('ipa_us'))
   # Never silently change a stored identity. NFC/hyphen/HTML are review proposals.
   clean=unicodedata.normalize('NFC',word.strip()).replace('\u2010','-').replace('\u2011','-').replace('\u2212','-')
   r['normalization_proposal']=clean if clean!=word.strip() else None
   records.append(r)
  books[id]={'source':meta,'exam':exam,'name':name,'version':version,'derived':derived,'authorization':'publisher_permission_unverified','records':records}
  audit.append({'id':id,**meta,'name':name,'dataset_version':version,'publisher_edition':'unverified','author':'unverified','raw_records':len(records),'unique':len({r['normalized_word'] for r in records}),'missing_definitions':sum(not r['definition_raw'].strip() for r in records),'missing_pos':sum(not any(s['pos'] for s in r['senses']) for r in records),'missing_ipa':sum(not(r['ipa_uk'] or r['ipa_us']) for r in records),'missing_chapter':sum(not r['chapter'] for r in records),'license':pin['github_license'],'publisher_authorization':'unverified'})
 index=load(root/'KyleBing/dict/files/bookLists.txt')['data']['normalBooksInfo']
 ids={'IELTS_3':'ielts-xindongfang','IELTS_2':'ielts-youdao','IELTSluan_2':'ielts-youdao-luan','TOEFL_2':'toefl-youdao','TOEFL_3':'toefl-xindongfang'}
 for native,id in ids.items():
  rows=[];p=root/'KyleBing/dict/files/book-json-full'/f'{native}.json'
  item=next(x for x in index if x['id']==native)
  for n,line in enumerate(p.read_text('utf-8-sig').splitlines(),1):
   if not line.strip():raise ValueError(f'Blank JSONL row {p}:{n}')
   x=json.loads(line);c=x['content']['word']['content'];trans=c.get('trans',[])
   if x['bookId']!=native:raise ValueError('Book foreign key mismatch')
   rows.append({'word':x['headWord'],'source_locator':f'line:{n}/wordId:{x["content"]["word"]["wordId"]}', 'senses':[{'pos':t.get('pos',''),'definition_cn':t.get('tranCn',''),'definition_en':t.get('tranOther'),'raw':t} for t in trans], 'definition_raw':'\n'.join(t.get('tranCn','') for t in trans),'ipa_uk':c.get('ukphone'),'ipa_us':c.get('usphone'),'requires_human_review':x['headWord']!=x['content']['word']['wordHead'],'source_details':{'record':x,'book_index':{k:item[k] for k in ['id','title','version','bookOrigin']}}})
  add('KyleBing/dict',f'book-json-full/{native}.json',id,'ielts' if native.startswith('IELTS') else 'toefl',rows,item['title'],item['version'])
 base=root/'zhenghaoyang24/english-vocabulary/files';vocab=load(base/'tb_vocabulary.json');links=load(base/'tb_voc_book.json');bi=load(base/'tb_book.json')
 if len({x['wordid'] for x in vocab})!=len(vocab):raise ValueError('Duplicate vocabulary primary key')
 vs={x['wordid']:x for x in vocab};bs={x['bookid']:x for x in bi};pairs=[(x['bookid'],x['wordid']) for x in links]
 join={'vocabulary_rows':len(vocab),'mapping_rows':len(links),'missing_word_foreign_keys':sum(x['wordid'] not in vs for x in links),'missing_book_foreign_keys':sum(x['bookid'] not in bs for x in links),'duplicate_mappings':len(pairs)-len(set(pairs)),'orphan_vocabulary':len(set(vs)-{x['wordid'] for x in links}),'book_index':bi,'related_sha256':{p.name:digest(p.read_bytes()) for p in base.glob('tb_*.json')}}
 for bid,id,exam in [(4,'ielts-niannian','ielts'),(5,'toefl-gaopin','toefl')]:
  rows=[]
  for x in links:
   if x['bookid']!=bid or x['wordid'] not in vs:continue
   v=vs[x['wordid']];raw=v['paraphrase'] or '';senses=[]
   for line in raw.splitlines():
    m=re.match(r'^\s*((?:[a-z]+\.)+)\s*(.*)$',line)
    senses.append({'pos':m[1] if m else '', 'definition_cn':m[2] if m else line})
   rows.append({'word':v['spelling'],'senses':senses,'definition_raw':raw,'ipa_uk':v['UKphonetic'],'ipa_us':v['USphonetic'],'source_locator':f'vocbkid:{x["vocbkid"]}/wordid:{v["wordid"]}','source_details':{'mapping':x,'vocabulary':v,'book':bs[bid]}})
  add('zhenghaoyang24/english-vocabulary','tb_vocabulary.json',id,exam,rows,bs[bid]['bookname'])
 rows=[]
 fullpath=root/'KyleBing/english-vocabulary/files/full_line_jsonl/full/正序/托福.jsonl'
 fullhash=digest(fullpath.read_bytes())
 full=[json.loads(line) for line in fullpath.read_text('utf-8-sig').splitlines()];simple=load(root/'KyleBing/english-vocabulary/files/json/6-托福-顺序.json')
 if len(full)!=len(simple):raise ValueError('Derived export row mismatch')
 for x,f in zip(simple,full):
  if x['word']!=f['headWord']:raise ValueError('Derived export headword mismatch')
  c=f['content']['word']['content']
  rows.append({'word':x['word'],'senses':[{'pos':t.get('type',''),'definition_cn':t['translation']} for t in x['translations']],'definition_raw':'\n'.join(t['translation'] for t in x['translations']),'ipa_uk':c.get('ukphone'),'ipa_us':c.get('usphone'),'source_details':{'simple':x,'full':f,'full_path':str(fullpath.relative_to(root)),'full_sha256':fullhash}})
 add('KyleBing/english-vocabulary','json/6-托福-顺序.json','toefl-kyle-expanded','toefl',rows,'托福汇总（派生数据）',derived=True)
 # Reuse already pinned/downloaded workbook, retaining cells/row metadata in sidecar.
 spec=importlib.util.spec_from_file_location('commercial',checkout/'scripts/parse-commercial-sources.py');mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
 for filename,id in [('IELTS词汇词以类记.xlsx','ielts-leiji'),('剑桥雅思词汇精典.xlsx','ielts-jianqiao')]:
  p=root.parent/'English/7.雅思'/filename;rows,quality=mod.xlsx_records(p)
  meta={'repo':'lilinji/English','commit':'6996d60339f21501efb7796a959165e083b5a7f5','path':'7.雅思/'+filename,'sha256':digest(p.read_bytes())}
  for r in rows:
   r['source_details']={k:v for k,v in r.items() if k not in ('senses','definition_raw')}
   if r.get('continuation_rows'):r['requires_human_review']=True
  books[id]={'source':meta,'exam':'ielts','name':p.stem,'version':'unverified','derived':False,'authorization':'publisher_permission_unverified','records':rows}
  audit.append({'id':id,**meta,'name':p.stem,'publisher_edition':'unverified','author':'unverified','raw_records':len(rows),'unique':len({r['word'].strip().lower() for r in rows}),'missing_definitions':sum(not r['definition_raw'] for r in rows),'missing_pos':sum(not any(s['pos'] for s in r['senses']) for r in rows),'missing_ipa':sum(not(r['ipa_uk'] or r['ipa_us']) for r in rows),'missing_chapter':sum(not r['chapter'] for r in rows),'quality':quality})
 (root/'private-staging.json').write_text(json.dumps({'books':books,'join_audit':join},ensure_ascii=False,default=str),encoding='utf8')
 (root/'parse-audit.json').write_text(json.dumps({'sources':audit,'join':join},ensure_ascii=False,indent=2,default=str),encoding='utf8')
 print(json.dumps({'sources':[{k:x[k] for k in ['id','raw_records','unique','missing_definitions']} for x in audit],'join':join},ensure_ascii=False))
if __name__=='__main__':run(sys.argv[1])
