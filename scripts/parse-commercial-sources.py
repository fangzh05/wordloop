"""Lossless private staging. No database writes, evaluation, or model calls.
Requires openpyxl==3.1.5. All outputs must stay outside the Git checkout.
"""
import csv, hashlib, json, pathlib, re, sys
import openpyxl

def static_json(text):
    # The inspected sources contain JSON literals assigned to const. Never eval JS.
    starts = [m.start() for m in re.finditer(r'[\[{]', text)]
    for start in starts:
        try: return json.JSONDecoder().raw_decode(text[start:])[0]
        except json.JSONDecodeError: pass
    raise ValueError('Not a JSON static literal; requires AST adapter')

def senses(text):
    # Keep every original line, including continuations, without rewriting it.
    result = []
    for line in text.splitlines():
        m = re.match(r'^\s*((?:[A-Za-z]+\.)+(?:/[A-Za-z]+\.)*)\s*(.*)$', line)
        if m: result.append({'pos': m[1], 'definition_cn': m[2], 'raw': line})
        elif line.strip() and result: result[-1]['definition_cn'] += '\n'+line
        elif line.strip(): result.append({'pos': '', 'definition_cn': line, 'raw': line})
    return result

def xlsx_records(path):
    wb = openpyxl.load_workbook(path, data_only=False)
    records, issues, raw = [], [], []
    merges = {}
    for sheet in wb:
        for area in sheet.merged_cells.ranges:
            for row in sheet.iter_rows(min_row=area.min_row,max_row=area.max_row,min_col=area.min_col,max_col=area.max_col):
                for cell in row: merges[(sheet.title,cell.coordinate)] = sheet.cell(area.min_row,area.min_col).coordinate
        last = None; chapter = None
        for row in sheet.iter_rows():
            cells = [{'coordinate': c.coordinate, 'value': c.value, 'type': c.data_type,
                      'merged_from': merges.get((sheet.title,c.coordinate))} for c in row]
            raw.append({'sheet':sheet.title,'row':row[0].row,'cells':cells})
            values = [str(c.value) if c.value is not None else '' for c in row]
            if not any(values) or values[0] in ('单词','word','Word'): continue
            word = values[0]
            if not word and any(values[1:]):
                # Inherit only an explicit merged headword; ambiguous blanks stay review-only.
                origin = merges.get((sheet.title,row[0].coordinate))
                if origin: word = str(sheet[origin].value)
                elif last:
                    last['continuation_rows'].append(row[0].row)
                    last['definition_raw'] += '\n'+values[-1]
                    last['senses'] = senses(last['definition_raw'])
                    issues.append({'sheet':sheet.title,'row':row[0].row,'reason':'ambiguous_blank_continuation'})
                    continue
            if word and not any(values[1:]) and not re.fullmatch(r"[A-Za-z][A-Za-z '\-]*",word):
                chapter = word; continue
            if not word: issues.append({'row':row[0].row,'reason':'missing_headword'}); continue
            record = {'word':word,'source_row':row[0].row,'sheet':sheet.title,'chapter':chapter,'category':None,
                      'ipa_uk':values[1] or None,'ipa_us':values[2] or None,'definition_raw':values[3],
                      'senses':senses(values[3]),'continuation_rows':[],'raw_cells':cells}
            if row[0].data_type != 's': issues.append({'row':row[0].row,'reason':'non_text_headword'})
            records.append(record); last = record
    return records, {'merged_cells': [str(a) for s in wb for a in s.merged_cells.ranges], 'issues':issues,'raw_rows':raw}

def parse(path):
    if path.suffix == '.xlsx': return xlsx_records(path)
    if path.suffix == '.csv': return list(csv.DictReader(path.open(encoding='utf-8-sig',newline=''))), {}
    if path.suffix in ('.json','.js','.ts'):
        return static_json(path.read_text(encoding='utf-8-sig')), {}
    return [{'source_row':i,'raw':line} for i,line in enumerate(path.read_text(encoding='utf-8-sig').splitlines(),1)], {}

if __name__ == '__main__':
    root = pathlib.Path(sys.argv[1]).resolve()
    repo = pathlib.Path(__file__).resolve().parents[1]
    if root == repo or repo in root.parents: raise ValueError('Private output cannot be inside checkout')
    manifest = json.loads((root/'source-manifest.json').read_text(encoding='utf8'))
    all_sets, audits, books = {}, [], {}
    out = root/'parsed';out.mkdir(exist_ok=True)
    chosen = {'王陆807雅思词汇听力第2版.xlsx':'ielts-wanglu-807-listening', '星火6级词汇必背.xlsx':'cet6-xinghuo'}
    for source in manifest:
        for meta in source['files']:
            path = pathlib.Path(meta['local'])
            if hashlib.sha256(path.read_bytes()).hexdigest() != meta['sha256']: raise ValueError('Checksum mismatch')
            if path.suffix != '.xlsx' and path.name not in ('vocabulary.js','listening179.json','reading538words.js'): continue
            data, quality = parse(path)
            if path.name == 'vocabulary.js':
                records=[]
                for chapter,section in data.items():
                    for group_index,group in enumerate(section['words'],1):
                        for item in group:
                            for variant_index,word in enumerate(item['word']):
                                records.append({'word':word,'source_row':item['id'],'source_locator':f'{chapter}/group/{group_index}/id/{item["id"]}/variant/{variant_index}',
                                    'chapter':chapter,'category':section['label'],'logical_group':group_index,'senses':[{'pos':item['pos'],'definition_cn':item['meaning']}],
                                    'definition_raw':item['meaning'],'raw_record':item,'audio_metadata':{'file':section['audio'],'repo':meta['repo'],'commit':meta['commit']},'ipa_uk':None,'ipa_us':None})
                books['ielts-zhenjing']={'source':meta,'records':records,'meaning_provenance':'repository transcription; publisher fidelity unverified'}
                quality['source_items']=sum(len(g) for s in data.values() for g in s['words'])
                quality['chapters']=len(data)
            elif path.name in ('listening179.json','reading538words.js'):
                # These are substitution resources, never automatically book memberships or etymology.
                records = [];pairs=[]
                for section in (data if path.name=='reading538words.js' else [{'words':data}]):
                    for item in section['words']:
                        records.append({'source_record':item,'relation_type':'synonym_substitution','status':'review_required'})
                        head=item['word'] if isinstance(item,dict) else item[1]
                        targets=item.get('replace',[]) if isinstance(item,dict) else item[4]
                        for target in targets:
                            pairs.append({'source':head,'target':target,'relation_type':'synonym_substitution','source_record':item['index'] if isinstance(item,dict) else item[0],'status':'review_required'})
                quality['resource_items']=len(records)
                quality['relation_pairs']=len(pairs)
                (out/(path.stem+'-pairs.json')).write_text(json.dumps({'source':meta,'pairs':pairs},ensure_ascii=False),encoding='utf8')
            else: records=data
            key=hashlib.sha256((meta['repo']+meta['path']).encode()).hexdigest()[:16]
            (out/(key+'.json')).write_text(json.dumps({'source':meta,'records':records,'quality':quality},ensure_ascii=False,default=str),encoding='utf8')
            words={r['word'].strip().lower() for r in records if 'word' in r}
            all_sets[key]=words
            audits.append({**meta,'parsed_file':key+'.json','raw_entries':quality.get('source_items',len(records)), 'parsed_records':len(records),
                'unique_words':len(words),'missing_definitions':sum(not r.get('definition_raw') for r in records) if words else None,
                'missing_ipa':sum(not r.get('ipa_uk') and not r.get('ipa_us') for r in records) if words else None,
                'missing_chapter':sum(not r.get('chapter') for r in records) if words else None,
                'author': '王陆' if '王陆' in path.name else 'unverified', 'version': '第2版' if '第2版' in path.name else 'unverified',
                'book_name':path.stem, 'original_gloss_verified':False,'quality_issue_count':len(quality.get('issues',[]))})
            if path.name in chosen: books[chosen[path.name]]={'source':meta,'records':records,'meaning_provenance':'unverified workbook gloss; cannot claim original book wording'}
    for audit in audits:
        key=pathlib.Path(audit['parsed_file']).stem
        audit['overlaps']={other:len(all_sets[key]&words) for other,words in all_sets.items() if other!=key and words and all_sets[key]}
    (root/'parse-audit.json').write_text(json.dumps(audits,ensure_ascii=False,indent=2),encoding='utf8')
    (root/'private-draft.json').write_text(json.dumps({'mode':'quarantined','books':books,'missing':['toefl-xindongfang'],'authorization':'not_verified'},ensure_ascii=False),encoding='utf8')
    print(json.dumps({k:{'rows':len(v['records']),'unique':len({r['word'].strip().lower() for r in v['records']})} for k,v in books.items()}))
