"""Pinned source intake. Run outside the repository; never download audio."""
import concurrent.futures, hashlib, json, pathlib, sys, urllib.request, urllib.parse

ROOT = pathlib.Path(sys.argv[1]).resolve()
CHECKOUT = pathlib.Path(__file__).resolve().parents[1]
if ROOT == CHECKOUT or CHECKOUT in ROOT.parents: raise ValueError('Private output cannot be inside checkout')
ROOT.mkdir(parents=True, exist_ok=True)
LOCKS = {'hefengxian/my-ielts': '5cef573933663c4673c6e0093f1df04e68018b1a',
         'lilinji/English': '6996d60339f21501efb7796a959165e083b5a7f5'}

def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'WordLoop-private-audit'}), timeout=90).read()

def intake(repo, sha):
    tree_path = ROOT / (repo.split('/')[1] + '-tree.json')
    if not tree_path.exists():
        tree_path.write_bytes(get(f'https://api.github.com/repos/{repo}/git/trees/{sha}?recursive=1'))
    tree = json.loads(tree_path.read_text(encoding='utf-8-sig'))
    if tree.get('truncated'): raise ValueError('Incomplete Git tree')
    paths = [x['path'] for x in tree['tree'] if x['type'] == 'blob']
    if repo.startswith('hefengxian'):
        selected = [p for p in paths if p.startswith(('src/pages/vocabulary/', 'src/pages/reading/', 'src/pages/listening/')) and p.endswith(('.js', '.json', '.txt', '.md', '.py'))]
    else:
        selected = [p for p in paths if p.startswith(('7.雅思/', '7.托福/', '4.六级/')) and p.endswith('.xlsx') and (any(x in p for x in ['王陆807雅思词汇听力', '雅思词汇真经', '星火', 'TOEFL词汇', 'TOEFLiBT', '核心词汇', '六级新大纲']) and p.count('/') == 1)]
    selected += [p for p in paths if p.lower() in ('readme.md', 'license', 'license.md', 'license.txt')]
    def fetch(p):
        target = ROOT / 'sources' / repo / p
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists(): target.write_bytes(get(f'https://raw.githubusercontent.com/{repo}/{sha}/'+urllib.parse.quote(p)))
        data = target.read_bytes()
        return {'repo': repo, 'commit': sha, 'path': p, 'local': str(target), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'format': target.suffix, 'license_scope': 'private_review_required', 'authorization': 'unverified; repository availability is not publisher authorization'}
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool: files = list(pool.map(fetch, selected))
    return {'repo': repo, 'commit': sha, 'license_files': [p for p in paths if pathlib.PurePosixPath(p).name.lower() in ('license','license.md','license.txt')], 'tree_complete': True, 'files': files}

manifest = [intake(repo, sha) for repo, sha in LOCKS.items()]
(ROOT/'source-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf8')
print(json.dumps({'repositories': len(manifest), 'files': sum(len(x['files']) for x in manifest)}))
