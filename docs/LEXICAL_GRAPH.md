# 局部词汇知识图谱：Root / Network 交付与发布说明

本分支扩展现有 Family View，增加只读 Root View、Network View 与明确的未来候选动作。未发布生产，未在生产应用迁移或导入新数据。

## 审计与基线

- 独立 worktree：`C:/Users/16648/.codex/worktrees/lexical-root-network`；分支 `codex/lexical-root-network`。
- 开发基线：远端 `codex/local-family-graph` 的 `c1a7ef41fcef4126034a215a143233f6a7df0669`。2026-10-08 fetch 后仍是最新。
- Sites v146 的源码 `b9b21a133966ea4c9b46b2fbfca8b34215f8d289` 是该基线的祖先；保留在线 Family、双语词典和 Lesson 修复。没有基于较旧 main 重建。
- 当前主工作目录是 `feat/faster-exam-learning-flow`，其 `.family-graph/`、`.pos-hint-fix/` 保持原样。其他功能分支没有重置或覆盖。
- 生产只读 schema 审计：27,161 lexemes / 58,376 senses / 29,088 relations / 23,432 dictionary entries；已有 lexical 表全部开启 RLS。这些是本次实查数量，不是本分支新增量。
- 学习状态仍由 `user_words`、现有错误层、FSRS、BKT、Planner、预算和冻结 `study_sessions` 管理。

## 模型与 API

新增 migration：`supabase/migrations/20261008052820_lexical_root_network.sql`，由 Supabase CLI 创建。

| 增量实体 | 用途 |
| --- | --- |
| `lexical_etymons` | 历史形式、语言、释义、时期、来源、不确定性 |
| `lexical_etymological_links` | lexeme/etymon 间有外键约束的历史来源、现代派生与明确审核的共同祖源成员 |
| `lexical_sense_relations` | 指定 source/target sense 的语义边；复用现有 senses |
| `lexical_usage_patterns` | 独立 phrase/pattern；组合 FK 校验 sense 属于该 lexeme |
| `lexical_lexeme_morphemes` | 同步构词成分的关联与证据；morpheme 不是 etymon |
| `lexical_graph_edges_v1` | service-only、security-invoker 投影视图，兼容既有类型明确的 lexical_relations |
| `get_lexical_graph_v1` | 稳定只读 RPC；批量关联当前用户状态，无学习写入 |

新增 lemma、sense/synset、关系类型与双向 etymon 邻接索引。新增表开启 RLS，撤销 public/anon/authenticated 直接权限；仅服务角色可调用接受用户上下文的 RPC。不存在浏览器自选其他 user_id 的入口。

`GET /api/web/lexical/graph?lexeme=circle&view=root&depth=1`

`GET /api/web/lexical/graph?lexeme=persuade&view=network&depth=1&relation_types=SYNONYM,ANTONYM,CONTRAST,COLLOCATION`

`view=family` 兼容现有 Family 查询，但原 `/family/*` API、微课、候选策略、A/B/C/D 与 spacing 均保留。严格拒绝未知参数、重复参数、depth>1、非法类型与客户端身份。空 relation_types 表示关闭全部 Network 类型；省略时使用近义/反义/对比/搭配，易混与上下位按需开启。所有响应 no-store，不缓存用户状态。

一次最多 24 节点、96 条原始证据边；客户端累计最多 40 节点、160 边。重复来源仅在同一关系类型、方向和 sense pair 内合并。每词卡最多 8 senses / 4 forms；边的具体英文定义通过有界批量 SQL join 返回，避免多义词的关联 Sense 被词卡截断。没有浏览器全量语料、N+1 HTTP 查询、全局词网或新的运行时依赖。

Root 中历史路径默认也是一跳。共同祖源边是**审核成员关系的投影**，其 provenance 保留双方完整原始路径；它不表示两个现代英语词之间的直接派生。历史路径的箭头从较早形式指向后来形式。点击历史节点可按需展开其下一跳。

## 数据来源与核验

OEWN 固定 2025 XML SHA-256：`6f49adeec174ab3092169fb25cf4a925226b63975a5d29a691a5dff88f0673b2`。CLI 构建器强制校验 checksum。相同 synset 的具体 senses 映射 SYNONYM；显式 SenseRelation antonym 与 SynsetRelation hypernym/hyponym 保留原始 XML、sense IDs、来源和许可。

MorphyNet 与 ECDICT 继续使用已有固定版本；原 Family 派生数据没有重建。双语词卡继续按需复用 `/family/dictionary`。ECDICT 中文是 lemma-level 资料，不伪装成精确 synset 翻译。

Kaikki 审计依据：https://kaikki.org/dictionary/English/index.html 。当时网页是 2026-09-02 dump、2026-10-03 extraction，下载约 3.1 GB；模板提取和多层词源不直接等于可审核关系。本版采用**固定 Wiktionary 原始修订的有限人工审核**，不下载或盲目导入整个 Kaikki。许可参见 https://en.wiktionary.org/wiki/Wiktionary:Copyrights 。Wiktionary 改编数据遵循 CC BY-SA 4.0，保留作者归属、修订/history 链接、证据、变更说明与 share-alike notice；不是 MIT/CC0。

`verify-lexical-sources.ts` 已在线重取并校验全部 **11 个修订**和 Enago PDF 的固定 SHA-256。原始全文不进入前端包。Root 核心与 reviewed 语义记录在 `lexicalReviewed.json`；公开自动化抽样在 `lexicalCore.json`；两者都不包含私人词表/用户标识。

`circle` 路径区分：

- Latin circulus → Old French cercle → Middle English circle → circle。
- circulus → Late Latin circularis → Old French circulier → Middle English circuler → circular。
- circulus → Latin circulor → Late Latin circulō → circulātus → circulate。circulō 标注为后期旁系形式。
- circulor → circulātiō → Middle English circulacioun → circulation。
- circular → circularity、circle → encircle 是明确现代派生；`-ity` 与 `en-` 单独作为同步成分。

没有虚构 `circle → circular → circulate` 连续现代派生链。`circulation` 的现代 surface analysis 不覆盖其历史借词路径。circulus 之前更深的祖源、本族其他词以及时期未完成核验，均不补猜测。

`persuade / convince` 的特定近义来自 Wiktionary（persuade 修订 92177127、convince 92463707 的对应 sense）。这两个词并不处于同一 OEWN synset，不伪造 OEWN 证据。`dissuade` 的反义来自 OEWN；既有 reviewed CONTRAST 同时保留独立教学含义。`persuade someone to do something` 来自 OEWN `vtaa-to-inf` 的句法展开，是 pattern，不是 Lexeme。

`economic / economical` 的易混提示来自 Wiktionary economical 93026894 的用法说明。`adapt / adopt` 来自 Enago《Commonly Confused Words, Part I》PDF 第 6 页（印刷页 4），SHA-256 `398cdbd50a53083c74594c948093daf011616506346db7574a586c236096a8e4`。后者只保存事实性 pair 标注、短证据句与原创中文说明；PDF 及例句未再分发，也没有把 Enago 的版权说成开放数据许可。

## 实际数据范围与覆盖

| 数据集 | 范围与本次实际状态 |
| --- | --- |
| 完整公开词表范围构建 | 13 个公开查询词；4,313 canonical lexemes、22,941 OEWN Sense relations，加 3 条 reviewed Sense relations；包含一跳邻居周围的关系以支持明确展开 |
| 本地实际数据库 | 上述构建与原 Family fixture 合并后 4,323 lexemes、22,944 Sense relations；重复导入不改已有 Family keys/definitions/评分 |
| Root 核心 | 6 个目标现代词全部覆盖；11 etymons、22 links（14 历史路径边、2 现代派生、6 共同祖源成员）；2 morphemes、2 关联 |
| Network 用法 | 1 个 pattern；OEWN 上下位/反义/近义与 3 条额外核验的近义/易混关系 |
| 版本化公开抽样 fixture | 101 lexemes、532 senses、124 Sense relations；同样 11 etymons / 22 links / 1 pattern |
| 双语核心 fixture | 13/13 查询词均有固定 ECDICT 中文；普通生产词卡仍读取现有词典 |
| 生产新增量 | **0**：未应用新 migration、未导入新语料、未部署 |

公开 13 词表：circle / circular / circulate / circulation / circularity / encircle / persuade / convince / dissuade / economic / economical / adapt / adopt。Root 核心覆盖 6/6 circle 目标词；相对于整个 13 词公开范围为 6/13。这不是对 6,000 词或生产私人词表的覆盖率承诺。

Root 未核验：persuade、convince、dissuade、economic、economical、adapt、adopt 的历史来源，其他词，以及 circles/circulars 等其他 POS 的独立历史路径。空白会显示「暂无已核验的词源关系」。没有接入 DeepSeek/embedding 的词源或语义持久化生成器。未完成任意易混 pair 自动扩充；只展示已有证据。

## 复现、测试和 QA

```powershell
npm ci
node --import tsx scripts/verify-lexical-sources.ts
node --import tsx scripts/build-lexical-corpus.ts OEWN_2025_XML server/data/lexicalCoreVocabulary.json .qa/lexical-core.json
node --import tsx scripts/extract-lexical-fixture.ts .qa/lexical-core.json server/data/lexicalCoreVocabulary.json .qa/lexical-fixture.json
node --import tsx scripts/import-lexical-corpus.ts .qa/lexical-core.json .qa/lexical-core.sql
npm run typecheck
npm test
npm run build
```

管理员 SQL 输出是知识表事务，没有用户卡、FSRS、BKT 或 session 写入。ON CONFLICT DO NOTHING 保留既有 canonical lexemes、family keys 和已有 Sense 资料。扩展不同来源时保留独立 evidence IDs；固定版本的同一构建重跑保持稳定。

浏览器复现（先 build:web，合成用户、只监听 localhost，不读生产凭据）：

```powershell
node --import tsx scripts/qa/serveLexical.ts .qa/lexical-core.json
# 另一终端；使用固定 CLI 版本，避免用生产账号作为测试数据。
npx --yes --package @playwright/cli@0.1.22 playwright-cli -s=lexical-qa open http://127.0.0.1:4328
npx --yes --package @playwright/cli@0.1.22 playwright-cli -s=lexical-qa run-code --filename scripts/qa/lexicalGraph.browser.js
npx --yes --package @playwright/cli@0.1.22 playwright-cli -s=lexical-qa close
```

新增 28 项 Vitest 自动化包含真实 PostgreSQL/PGlite 迁移及查询、canonical 去重、Sense 多义、不同来源证据合并、反向边/环、缺失降级、多候选词源、方向、外键、RLS/函数授权、过滤/限额以及用户学习状态不变。原 Family SQL 微课/spacing/预算/FSRS 与全量 Lesson/Planner/BKT 回归继续执行。测试中的争议词源是明确 synthetic test，不属于交付数据。

本地 Chromium 390×844、820×1180 touch 与 1440×1000 自动化通过：首屏无图请求、切换三视图、真实 touch tap/pinch/drag/long press/double tap、明确展开/候选、过滤全关空态、历史/pattern 节点无候选或学习状态、浅/深主题、图实例释放、Escape/返回与焦点恢复、无横向溢出。2 学习卡、0 FSRS logs、冻结 Lesson state 未变化。不是 Safari/iPhone/iPad 实机、生产认证提交或生产延迟证据。

性能与最终全量测试结果见下方；生产 check:db 需要管理员环境且应在显式发布时运行。

## 发布步骤与回滚

1. 重新读取远端和 Sites 当前源码 SHA，确认生产此后更新都包含在待发布分支。保留现有 `.openai/hosting.json` project_id；不要从旧 main 替换站点源码。
2. 在独立验证库先应用本 migration 并导入 `.qa/lexical-core.sql`，运行相同 SQL/API/UI gates。生产变更必须在后续明确发布请求下执行。
3. 应用生产增量 migration；审核来源/许可 notice，运行 source verifier；在管理员事务中导入知识 SQL。前后比较 `user_words`、`user_skill_state` 和 `study_sessions`，不接触其内容。
4. 运行 `npm run check:db`；typecheck/test/build/Inspector 全部通过后，将**同一个精确 SHA**推送到 GitHub 和现有 Sites 绑定源码。
5. 用现有 Sites workflow 保存版本、部署并等到 succeeded，再检查 health、三个 graph API（含未认证 401）、Family 微课、来源、资源懒加载和真实移动端。Git push 或 build 不等于部署完成。
6. 应用回滚：恢复发布前的已验证 Sites 版本/源码。新 schema 是增量的，可以留存，旧 Family 查询不会读取它；候选仍使用原表。不要回滚学习卡或冻结队列。
7. 如需要 schema 清理，先完成应用回滚与备份，再单独撤除新 RPC/view、关联表和 etymon 表。保留所有 canonical lexemes/senses 与 `family_candidates`，避免删除被学习或其他功能引用的共享词条。没有理由恢复或覆盖 user_words。

## 文件清单

| 文件 | 作用 |
| --- | --- |
| `shared/lexicalContracts.ts` | 三视图、节点/边/Sense 与 strict 查询契约 |
| `server/services/lexicalGraph.ts` | 服务端用户身份、只读 RPC、多来源证据合并 |
| `server/webApi.ts` | 认证后的统一 GET 路由 |
| `supabase/migrations/20261008052820_lexical_root_network.sql` | 增量实体、外键、RLS、索引、查询 |
| `scripts/lib/networkCorpus.ts` | 确定性 OEWN 关系映射与范围选取 |
| `scripts/build-lexical-corpus.ts` | 固定 checksum 的离线构建 |
| `scripts/extract-lexical-fixture.ts` | 公开核心抽样，私人词表不提交 |
| `scripts/import-lexical-corpus.ts` | 知识表管理员 SQL 输出、保留现有事实 |
| `scripts/verify-lexical-sources.ts` | 原始固定修订及用法资料校验 |
| `scripts/lib/familyImportSql.ts` | 安全 lexical-only transport 的增量 allowlist |
| `scripts/check-db-schema.ts` | 新表/字段检查 |
| `scripts/build-sites-worker.ts` | 包含增量迁移的部署 artifact |
| `server/data/lexicalReviewed.json` | 有限审核词源与 Sense/用法来源 |
| `server/data/lexicalCore.json` | 公开 OEWN 抽样 fixture |
| `server/data/lexicalCoreDictionary.json` | 固定 ECDICT 核心双语 QA 数据 |
| `server/data/lexicalCoreVocabulary.json` | 13 词公开范围 |
| `server/data/ATTRIBUTION.md` | 来源及改编说明 |
| `server/data/licenses/Wiktionary-CC-BY-SA-4.0.md` | attribution / share-alike notice |
| `web/src/family/LexicalExplorer.tsx` | Root/Network、实体卡、过滤、按需展开、候选 |
| `web/src/family/FamilyPanel.tsx` | 三视图入口，保留原微课；复习时间 |
| `web/src/family/familyEngine.ts` | 复用懒加载 Cytoscape、多实体和边线型、释放 |
| `web/src/styles.css` | 沿用主题的低噪声触屏控件 |
| `tests/lexicalApi.test.ts` | 认证、身份、参数、过滤 |
| `tests/lexicalCorpus.test.ts` | 来源映射、稳定 ID、去重与 UI 累计限额 |
| `tests/lexicalDatabase.test.ts` | 真实 SQL、来源方向、RLS、学习不变 |
| `scripts/qa/serveLexical.ts`、`lexicalHarness.tsx`、`lexicalGraph.browser.js` | 可复现本地数据库与主要前端交互验收 |
| `README.md`、`README.zh-CN.md`、本文 | 功能、边界与部署/回滚 |
| `.gitignore` | 忽略本地浏览器日志 |

## 本次最终验证记录

- 全量 Vitest：819 passed / 2 skipped（凭据依赖集成测试）；新增 28 项全部通过。
- TypeScript、web/server/Sites 构建通过；新数据未被打包到生产 frontend JS。
- MCP Inspector tools/resources 检查通过。`check:db` 本次未完成：独立 worktree 缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY，未借此修改生产数据库。
- 当前生产构建 gzip：standalone 265,590 bytes、懒加载 family/graph chunk 144,093 bytes。
- 全部 11 个 Wiktionary 修订与 Enago 固定 PDF checksum 在线验证通过。
- Chromium 自动化结果：390×844、820×1180、1440×1000；每个 Root 初始 8 节点；errors=[]、warnings=[]、overflow=false；2 学习卡、0 FSRS logs，冻结 state 不变。
- 实际 touch tap、双指缩放、拖动、长按、双击通过；浅/深主题、明确展开、过滤全关空态、释放实例和关闭后焦点恢复通过。
- 数据/截图/日志保存在忽略的 `.qa/`，公开可复现 harness 与浏览器脚本已提交。

实际本地 PGlite（4,323 lexemes、22,944 Sense relations）各 25 次服务调用，含全部 Network 类型的更重查询：

| 查询 | 节点/边 | P50 ms | P95 ms | JSON bytes | 截断 |
| --- | --- | --- | --- | --- | --- |
| circle / Root | 8 / 8 | 7.30 | 10.62 | 92,248 | 否 |
| persuade / Network | 24 / 50 | 29.50 | 33.72 | 127,119 | 是 |
| economic / Network | 2 / 3 | 17.57 | 20.81 | 14,741 | 否 |
| adopt / Network | 24 / 46 | 29.14 | 32.07 | 133,962 | 否 |

这是本地 SQL/服务处理与原始 JSON 大小，不含生产网络，不能视为生产 benchmark。
