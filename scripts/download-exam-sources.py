import json, urllib.request, pathlib, hashlib, datetime, sys, shutil
import urllib.parse
out=pathlib.Path('.exam-books/expansion');out.mkdir(parents=True,exist_ok=True)
for name in ['sources.json','nawl-source.json']:
 bundled=pathlib.Path('docs/data/exam-books/expansion-20261011')/name
 if not (out/name).exists() and bundled.exists() and '--refresh' not in sys.argv: shutil.copyfile(bundled,out/name)
meta=out/'nawl-source.json'
if meta.exists():
 m=json.loads(meta.read_text(encoding='utf8'));target=out/'nawl.txt'
 if not target.exists():target.write_bytes(urllib.request.urlopen(m['url'],timeout=60).read())
 if hashlib.sha256(target.read_bytes()).hexdigest()!=m['sha256']:raise RuntimeError('NAWL checksum mismatch')
repos=['KyleBing/english-vocabulary','wangjiuyi543-ui/cet6-vocabulary','fanhongtao/IELTS','LynnShaw/vocabulary_for_ielts','Mundi-Xu/ielts','hefengxian/ielts-vocabulary','gungorkaya-eng/toefl-essential-vocabulary-dataset']
manifest=[]
lock=out/'sources.json'
if lock.exists() and '--refresh' not in sys.argv:
 for source in json.loads(lock.read_text(encoding='utf8')):
  for f in source.get('files',[]):
   target=out/f['local']
   if not target.exists():
    url='https://raw.githubusercontent.com/'+source['repo']+'/'+source['commit']+'/'+urllib.parse.quote(f['path'])
    target.write_bytes(urllib.request.urlopen(url,timeout=60).read())
   if hashlib.sha256(target.read_bytes()).hexdigest()!=f['sha256']: raise RuntimeError('Source checksum mismatch')
 print('Locked source files verified; use --refresh for a new source intake')
 sys.exit(0)
def get(url):
 return urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'WordLoop-source-audit'}),timeout=60).read()
for repo in repos:
 try:
  meta=json.loads(get('https://api.github.com/repos/'+repo));commit=json.loads(get('https://api.github.com/repos/'+repo+'/commits/'+meta['default_branch']))['sha'];tree=json.loads(get('https://api.github.com/repos/'+repo+'/git/trees/'+commit+'?recursive=1'))['tree']
  paths=[x['path'] for x in tree if x['type']=='blob']; (out/(repo.split('/')[0]+'-tree.json')).write_text(json.dumps(paths,ensure_ascii=False),encoding='utf8')
  if repo.startswith('KyleBing'): selected=['4 六级-乱序.txt','6 托福-乱序.txt','json/4-CET6-顺序.json','json/6-托福-顺序.json']
  else:selected=[p for p in paths if p.lower().endswith(('.txt','.csv','.json','.jsonl','.md')) and not any(x in p for x in ['node_modules','.github','package','lock'])][:30]
  selected+= [p for p in paths if p.lower().split('/')[-1] in ['license','license.md','license.txt','readme.md']]
  files=[]
  for i,p in enumerate(dict.fromkeys(selected)):
   data=get('https://raw.githubusercontent.com/'+repo+'/'+commit+'/'+urllib.parse.quote(p)); local=repo.split('/')[0]+'-'+str(i)+pathlib.Path(p).suffix; (out/local).write_bytes(data);files.append({'path':p,'local':local,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)})
  manifest.append({'repo':repo,'url':'https://github.com/'+repo,'commit':commit,'downloaded_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'license':meta.get('license'),'files':files})
  print(repo,commit,len(files))
 except Exception as e:manifest.append({'repo':repo,'error':str(e)});print(repo,str(e))
 (out/'sources.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8')
