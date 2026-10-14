"""Download pinned real data files to a private directory, never Worker assets."""
import hashlib,json,pathlib,sys,time,urllib.request,urllib.parse,concurrent.futures
root=pathlib.Path(sys.argv[1]).resolve()
checkout=pathlib.Path(__file__).resolve().parents[1]
if root==checkout or checkout in root.parents:raise ValueError('Private output must be outside checkout')
root.mkdir(parents=True,exist_ok=True)
def get(url):
 for attempt in range(4):
  try:return urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'WordLoop-source-audit'}),timeout=180).read()
  except Exception:
   if attempt==3:raise
   time.sleep(2**attempt)
def intake(repo):
 target=root/repo;target.mkdir(parents=True,exist_ok=True)
 lock=target/'lock.json'
 if lock.exists():pin=json.loads(lock.read_text(encoding='utf8'))
 else:
  meta=json.loads(get('https://api.github.com/repos/'+repo));sha=json.loads(get('https://api.github.com/repos/'+repo+'/commits/'+meta['default_branch']))['sha']
  pin={'repo':repo,'commit':sha,'default_branch_at_capture':meta['default_branch'],'github_license':meta.get('license')};lock.write_text(json.dumps(pin,indent=2),encoding='utf8')
 treefile=target/'tree.json'
 if not treefile.exists():treefile.write_bytes(get(f"https://api.github.com/repos/{repo}/git/trees/{pin['commit']}?recursive=1"))
 tree=json.loads(treefile.read_text(encoding='utf8'))
 if tree.get('truncated'):raise ValueError('Truncated repository tree')
 paths=[x['path'] for x in tree['tree'] if x['type']=='blob']
 docs=[p for p in paths if pathlib.PurePosixPath(p).name.lower() in ['readme.md','license','license.md','license.txt','booklists.txt'] and p.count('/')<=1]
 if repo=='KyleBing/dict':selected=[p for p in paths if p.startswith('book-json-full/') and pathlib.PurePosixPath(p).stem in ['TOEFL_3','TOEFL_2','IELTS_3','IELTS_2','IELTSluan_2']]
 elif repo=='zhenghaoyang24/english-vocabulary':selected=[p for p in paths if pathlib.PurePosixPath(p).name in ['tb_book.json','tb_voc_book.json','tb_vocabulary.json']]
 else:selected=[p for p in paths if any(t in p.lower() for t in ['toefl','托福']) and pathlib.PurePosixPath(p).suffix.lower() in ['.txt','.json','.jsonl','.csv']]
 def download(p):
  out=target/'files'/p;out.parent.mkdir(parents=True,exist_ok=True)
  if not out.exists():
   data=get(f"https://raw.githubusercontent.com/{repo}/{pin['commit']}/"+urllib.parse.quote(p));tmp=out.with_suffix(out.suffix+'.tmp');tmp.write_bytes(data);tmp.replace(out)
  data=out.read_bytes()
  return {'path':p,'local':str(out),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'format':out.suffix,'license_scope':'private_review_required','publisher_authorization':'unverified'}
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:files=list(pool.map(download,sorted(set(selected+docs))))
 manifest={**pin,'tree_complete':True,'selected_data_files':selected,'files':files}
 (target/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf8')
 return manifest
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:manifests=list(pool.map(intake,['KyleBing/dict','zhenghaoyang24/english-vocabulary','KyleBing/english-vocabulary']))
(root/'source-manifest.json').write_text(json.dumps(manifests,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps([{'repo':m['repo'],'commit':m['commit'],'data_files':m['selected_data_files'],'bytes':sum(f['bytes'] for f in m['files'])} for m in manifests],ensure_ascii=False))
