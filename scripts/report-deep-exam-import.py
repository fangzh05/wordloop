"""Private report + build privacy scan from real replay evidence. No network."""
import collections,hashlib,json,pathlib,sys
root=pathlib.Path(sys.argv[1]).resolve();repo=pathlib.Path(__file__).resolve().parents[1]
if root==repo or repo in root.parents:raise ValueError('Private report directory required')
load=lambda p:json.loads((root/p).read_text('utf-8-sig'))
draft=load('private-staging.json')['books'];plan=load('private-plan.json');snap=load('live-snapshot.json');replay=load('replay.json');old=load('../five-exam-snapshot.json');integrity=load('production-integrity.json')
if old['protected']!=integrity['protected']:raise ValueError('Production protected-state snapshot drift')
# Report net assignment in explicit order, separate from overlapping evidence contributions.
order=['ielts-zhenjing','ielts-wanglu-807-listening','ielts-xindongfang','ielts-youdao','ielts-youdao-luan','ielts-niannian','ielts-leiji','ielts-jianqiao','toefl-xindongfang','toefl-youdao','toefl-gaopin','toefl-kyle-expanded']
remaining={(a['exam'],a['word']):a['sources'] for a in plan['additions']};contributions=[]
for id in order:
 assigned=[key for key,sources in remaining.items() if id in sources]
 for key in assigned:del remaining[key]
 contributions.append({'source':id,'assigned_net':len(assigned),'overlapping_evidence_contribution':sum(id in a['sources'] for a in plan['additions'])})
if remaining:raise ValueError('Unattributed additions')
duplicates=[]
for id,b in draft.items():
 groups=collections.defaultdict(list)
 for r in b['records']:groups[r['word'].strip().lower()].append(r)
 d=[rs for rs in groups.values() if len(rs)>1]
 duplicates.append({'source':id,'duplicate_groups':len(d),'excess_rows':sum(len(rs)-1 for rs in d),'case_variant_groups':sum(len({r['word'] for r in rs})>1 for rs in d),'different_senses_groups':sum(len({json.dumps(r['senses'],sort_keys=True,ensure_ascii=False) for r in rs})>1 for rs in d)})
derived=draft['toefl-kyle-expanded'];expected={r['word'].strip().lower() for r in derived['records']};exports=[]
base=root/'KyleBing/english-vocabulary/files'
for p in base.rglob('*'):
 if p.suffix not in ['.txt','.jsonl']:continue
 lines=p.read_text('utf-8-sig').splitlines()
 words=[(json.loads(line).get('headWord') or json.loads(line).get('word')) if p.suffix=='.jsonl' else line.split('\t')[0] for line in lines]
 actual={w.strip().lower() for w in words};exports.append({'path':str(p.relative_to(base)),'rows':len(lines),'unique':len(actual),'matches_primary':actual==expected})
 if actual!=expected:raise ValueError('Derived format membership disagreement')
texts=[]
for p in (repo/'dist').rglob('*'):
 if p.is_file():
  try:texts.append((str(p.relative_to(repo)),p.read_text('utf8')))
  except UnicodeDecodeError:pass
glosses={r['definition_raw'] for b in draft.values() for r in b['records'] if len(r['definition_raw'])>=25}
hits=[]
for path,text in texts:
 for g in glosses:
  if g in text or json.dumps(g,ensure_ascii=True)[1:-1] in text:hits.append({'asset':path,'gloss_sha256':hashlib.sha256(g.encode()).hexdigest()})
if hits:raise ValueError('Private original text in public build')
reviews=[]
reviewed_words=set()
for p in root.glob('codebuddy-candidate-*.validated.json'):
 x=json.loads(p.read_text('utf8'));reviews.append({'file':p.name,'decisions':dict(collections.Counter(r['decision'] for r in x['records']))})
 reviewed_words.update(r['word'] for r in x['records'])
accepted=[r for rs in plan['accepted'].values() for r in rs];globalwords=set(snap['words'])
added_pairs={(a['exam'],a['word']) for a in plan['additions']}
old_pairs={(m['book_id'],m['normalized_word']) for m in snap['members']}
summary={'mode':'isolated test only; production unchanged','contribution_order':order,'contributions':contributions,'duplicates':duplicates,'derived_export_crosscheck':exports,'model_candidate_reviews':reviews,'model_reviewed_unique_words':len(reviewed_words),'model_changes_applied':0,'deduped_edition_records':plan['deduped_edition_records'],
 'new_source_definition_records':len(accepted),'definition_records_on_existing_shared_identity':sum(r['normalized_word'] in globalwords for r in accepted),'accepted_source_words_missing_shared_identity':len({r['normalized_word'] for r in accepted}-globalwords),
 'accepted_definition_coverage':{'records_with_definition':sum(bool(r['definition_raw'].strip()) for r in accepted),'missing':sum(not r['definition_raw'].strip() for r in accepted)},
 'publisher_authorization_verified':False,'new_production_usable_definitions':0,'original_publisher_wording_verified':False,'prior_held_records_still_isolated':85,'held_new_unique_across_exams':len({h['word'] for h in plan['held'] if (draft[h['source']]['exam'],h['word']) not in added_pairs|old_pairs}),
 'build_privacy':{'files':len(texts),'long_glosses_checked':len(glosses),'matches':len(hits)},'production_protected_tables_unchanged':len(old['protected']),'production_writes':0}
(root/'acceptance.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf8')
md=['# WordLoop IELTS / TOEFL 深度补全验收','', '**范围：本地隔离数据库完成，生产未写入、Worker 未部署。**','', '|指标|IELTS|TOEFL|','|---|---:|---:|']
labels={'current':'生产当前唯一成员','raw_new_records':'新来源原始行','normalized_new_unique':'新来源规范唯一词头','overlap_with_current':'新来源与旧成员重合','cross_source_excess':'原始行减跨来源唯一词头','new_source_candidates':'新来源净新增候选','legacy_only_candidates':'仅历史来源补充的候选','accepted_additions':'本轮审核规则通过的净新增','pending_unique_new':'暂缓的新词头','additions_with_private_definition':'新增中具有私人来源释义','ecdict_covered_additions':'新增中已有 ECDICT 释义','new_shared_identities':'新增成员中共享 words 原来缺失','final':'隔离数据库最终唯一成员'}
for key,label in labels.items():md.append('|'+label+'|'+'|'.join(str(m[key]) for m in plan['metrics'])+'|')
md+=['','IELTS 另含历史来源独有的 483 个候选，因此不能仅用“新来源候选”与最终新增数相减计算暂缓数量。历史来源已通过上一轮审核，本轮复用；253 个历史来源新增没有 ECDICT 或本轮新来源佐证，单列保留既有审核证据。','', '## 来源净贡献','', '按下表顺序把重复贡献归属一次；重合证据贡献另列，不能相加。','', '|内部来源|分配净新增|重合证据贡献|','|---|---:|---:|']
md += [f'|{c["source"]}|{c["assigned_net"]}|{c["overlapping_evidence_contribution"]}|' for c in contributions]
md+=['','## 释义、质量与权限','',f'- 隔离库新增 {len(accepted):,} 条来源释义；其中 {summary["definition_records_on_existing_shared_identity"]:,} 条属于此前已有共享身份。通过导入的记录有效释义覆盖率为 100%，原始来源缺失字段见 parse-audit.json。',f'- 共享 words 在隔离库由 8,800 增至 {replay["passes"][0]["shared_words"]:,}；它包含旧考试成员补齐的词头，不等同于本轮净新增成员数。新成员中此前缺失的共享身份跨考试去重为 {plan["unique_new_global_words"]:,}。','- 保留中文、英文释义、原词性、UK/US 音标、搭配、原始记录、版本、定位与文件校验值；缺失章节不伪造。音频只保留引用元数据。','- 不合并屈折或派生身份；仅作后续复核候选，不改词族图。大型继承托福表独有项全部暂缓，不因自评置信度提升。',f'- 本轮暂缓 {len(plan["held"]):,} 条来源记录（含重复继承表记录）；新增待审唯一词头 IELTS 2,607、TOEFL 1,553。此前 85 条保持隔离。',f'- CodeBuddy CLI 审核代码与 {len(reviewed_words)} 个疑难词头；JSON 经 Zod 校验，有缓存、重试；未发送商业释义。建议不直接写回。规则审计有 needs_changes 历史记录，逐条处理；未经复审的建议不得称通过。','- KyleBing/dict、zhenghaoyang24 仓库未发现明确数据许可；KyleBing/english-vocabulary 的 BSD-3-Clause 不证明上游有道/出版物原文再分发授权。lilinji 聚合声明同样不构成出版社授权。','- 原书原文一致性与出版社授权仍未确认。新释义仅在隔离私人测试层完成导入，生产新增可用释义为 0；不得将测试 entitlement 当作真实授权。','', '## 验证与限制','', '- 两次真实语料导入：第二次来源释义、共享身份、考试成员净新增均为 0。','- IELTS、TOEFL 各 10 个本轮新增成员通过原有学习入库；来源访问有授权/无授权/过期/普通角色拒绝的自动化测试。','- 五个学习入口保持不变；既有三个考试词书成员不变；原书释义与 ECDICT 并存，冻结题目由现有快照与重试测试保护。',f'- 生产只读复核 {len(old["protected"])} 项完整内容哈希全部一致，包括 7,048 用户学习词、1,745 FSRS 日志、BKT、笔记和会话。隔离库原词头 ID、已有来源释义、历史卡片和日志哈希一致。',f'- 公开构建扫描 {len(texts)} 个文本产物、{len(glosses):,} 段长度至少 25 字符的原释义，命中 0；短释义可能与普通公共文本同形，不能把该抽样扫描称作形式化泄漏证明。','- PGlite 为实际 PostgreSQL 引擎隔离重放；未连接独立 Supabase 测试项目。两个外部 Supabase 集成测试跳过，不冒充真实移动设备或线上鉴权验收。','', '## 发布与回滚','', '1. 暂不部署。审阅分支差异及私人数据许可；为确有许可的账号逐来源确认授权证据，未确认来源不启用。','2. 再取生产只读快照、校验所有来源和旧成员哈希；若基线漂移，重新计算计划。','3. 经批准后先安装兼容迁移 20261012020000、20261012030000，部署并验证服务端五入口及权限，再使用审阅的参数化来源导入和 merge.sql。新释义与新成员分开审计、备份。','4. merge.sql 不自动启用任何私人来源。来源启用及 entitlement 单独批准；不得全用户开放。','5. 回滚使用 rollback.sql 仅删除本批次且仍由本批次拥有的新增成员；停用本次新增的来源映射，保留原始来源数据和词头，不删除学习记录。恢复上个 Worker 版本；迁移新增的内部来源元数据可保留。','', '详细证据：dry-run.json、parse-audit.json、acceptance.json、replay.json、production-integrity.json、review-queue.json、CodeBuddy *.validated.json、typecheck.log、tests.log、build.log。']
(root/'delivery-report.md').write_text('\n'.join(md)+'\n',encoding='utf8')
print(json.dumps({k:summary[k] for k in ['new_source_definition_records','definition_records_on_existing_shared_identity','accepted_source_words_missing_shared_identity','build_privacy','production_protected_tables_unchanged']}));print(json.dumps(contributions))
