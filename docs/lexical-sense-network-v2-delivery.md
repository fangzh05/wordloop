# WordLoop 词汇语义网络 V2 交付记录

日期：2026-10-08。独立分支：`codex/lexical-sense-network-v2`。本次只开发、测试、提交；没有修改生产数据库，没有 Sites 部署。

## 基线与根因

生产 Sites v147 绑定 `89801d1382769c3760dd976d09d503dfc5e88a5a`，对应远端 `codex/lexical-root-network`。从该提交创建独立 worktree，没有用旧 main 覆盖生产。提交前重新 fetch，词汇分支仍为该 SHA。另一个较新的未合并分支 `codex/browser-run-shanbay` 的手机键盘修复 `e06101683518b940c05581ee1e75e6e31c85529b` 已合并到本分支，合并提交为 `0b986d8`。原工作区和原 lexical worktree 的未提交文件均保留。

旧问题贯穿检索与展示：V1 RPC 收集中心 lexeme 的全部义项邻接边，以 canonical ID 排序后先截断到 24 个节点，中心义项又只返回部分；前端随后把不同 source_sense_id 的边合并到同一个中心词的固定半径径向图。因而 bear 的生育、忍受、表现、怀有情绪等义项，以及 bearing 的仪态、方向、纹章义项混杂。节点截断既没有教学排序，也无法保证选中的义项有完整候选；手机端固定圆形布局进一步造成标签重叠。

V2 从服务端先确定 lexeme/POS/sense，再筛选、排序、分页；前端以当前义项组织关系卡片和小型图谱。不是仅减少随机节点。

## 义项、排序与折叠规则

1. Canonical lexeme ID 区分词性，sense ID 区分含义，每条边保留实际来源和目标义项。合并多来源边时将端点 ID 与 sense ID 成对比较，防止交叉义项错误合并；原始 relation ID、方向、解释与 provenance 均保留。
2. 已验证上下文 sense ID 可直接选择对应词性与义项。当前 Lesson 调用方没有可靠 sense ID，故不从题目、中文或 embedding 猜测；提供可选的精确上下文接口。没有上下文时按词性/canonical ID、审核优先级和 sense ID 确定性排序，界面明确显示当前词性并允许切换。这个排序不代表使用频率。
3. ECDICT lemma/POS 中文只显示在词条概览。单独的 `lexical_sense_annotations` 接受带审核人和完整来源的 sense 中文或编辑优先级；本次没有写入任何正式中文译义。没有审核译义时显示英文 definition 与“暂无已核验中文义项”。
4. 先筛选关系类型及当前精确义项、有效来源和置信度，再按宽泛关系、审核关系、来源置信度、当前用户既有 meaning/collocation 错误、lemma 和 group ID 稳定排序。不使用固定 utility_score 冒充词频，也不按关系数量评估重要性。无证据的考试/词频信息不参与排序。
5. 默认每页最多 8 个逻辑邻接项，手机预览最多 4 个，桌面最多 8 个。低度数义项不凑数。`do/have/be/act` 的宽泛 SYNONYM 默认折叠，可明确展开；不同义项通过选择器检索。未绑定 sense 的历史审核关系单独展示并明确说明不能据此推断当前义项的可替换性。
6. 拼写变体只在显式审核词对、相同 POS、相同 synset、OEWN 正字法变体证据同时满足时合并展示。harbor/harbour 标注美式/英式；两者 canonical ID、sense ID 和所有边仍然存在，不删除词典记录。不同 sense 不合并。
7. 每页最多 8 组、最多 17 个原始词条节点（含中心及成对变体），仍在既有 24 节点安全上限内；每次最多 96 条证据边，额外证据独立分页。普通关系分页与证据分页分别返回 next offset；查询永远是一跳，不累积全部展开结果成巨图。

## UI 与学习边界

保留 Family、Root、Network。Network 使用现有 Cytoscape 的分层两列、小型矩形节点，长词换行；手机完整内容以关系分组卡片阅读。节点、边和卡片都可查看具体英文定义、两个实际义项、源链接、完整 provenance、近义替换限制；“未学习”说明与语义关系类型分开。没有生成不存在于来源中的例句或辨析：有词典例句时展示，并注明例句可能使用同义成员；没有精确辨析时明确展示现有解释与替换限制。

保留拖动、缩放、双击切换中心、长按候选。切换中心只在能唯一核验目标 sense 时携带它。界面取消 sticky 顶栏遮挡，触摸控件至少 44px，弹层内部滚动。网络浏览请求可取消，旧结果不会覆盖新选择；只读操作不发 POST。

候选动作仍使用既有显式服务端流程。FSRS、BKT、Planner、学习预算、DeepSeek 错误层、冻结 Lesson 的核心服务文件与生产基线比较没有差异。未增加第二套记忆状态或调度器。

## 修改文件清单

| 范围 | 文件与作用 |
| --- | --- |
| 协议 | `shared/lexicalContracts.ts`：严格 V2 参数、分组与分页契约；`shared/familyContracts.ts`：可选审核义项字段 |
| 服务端 | `server/services/lexicalGraph.ts`：兼容 V1/V2、错误映射、成对义项证据合并；`server/webApi.ts`：鉴权后转发严格参数 |
| 数据库 | `supabase/migrations/20261008093933_lexical_sense_network_v2.sql`：新增知识表、校验 trigger、RLS/授权及只读 V2 RPC；V1 不变 |
| 语料 | `scripts/lib/networkCorpus.ts`、`server/data/lexicalReviewed.json`：审核拼写对与 OEWN 证据；`scripts/lib/familyImportSql.ts`、`scripts/import-lexical-corpus.ts`：仅知识导入、显式 PK、防止 JSON 键顺序改变主键选择 |
| 来源夹具 | `scripts/extract-sense-fixture.ts`、`tests/data/oewn-bear-bearing-2025.xml` 与 manifest：固定公开来源、可复现提取；`.gitattributes` 固定 XML 原始字节，避免 Windows 换行转换破坏 SHA |
| 前端 | `web/src/family/SenseNetworkExplorer.tsx`：义项选择、分组卡片、分页；`LexicalEvidence.tsx`：独立证据展示；`LexicalExplorer.tsx`：Network/Root 路由；`FamilyPanel.tsx`：精确上下文接口；`familyEngine.ts`：布局与边点击；`web/src/styles.css`：响应式与弹层 |
| 自动化 | `tests/lexicalSenseDatabase.test.ts`、`tests/lexicalSenseApi.test.ts`、`tests/lexicalCorpus.test.ts` |
| 浏览器 | `scripts/qa/serveLexical.ts`、`lexicalHarness.tsx`、`lexicalGraph.browser.js`、`lexicalSenseGraph.browser.js`、`lexicalSenseGestures.browser.js` |
| 合并保留 | Shanbay 手机键盘分支的 worker/input、session UI、样式及其 2 个测试；未部署其 Cloudflare worker |

## 真实验证与局限

最终完整命令：`npm run typecheck`、`npm test`、`npm run build`。结果：typecheck/build 成功；100 个测试文件通过、1 个跳过；856 个测试通过、2 个跳过。跳过的是既有 Supabase 在线集成测试，没有将其视为生产验证。没有未解决失败。

新增 18 个数据库测试使用 PGlite 的真实 PostgreSQL 执行生产 schema 和新增 migration，导入完整公开测试子集，而非只 mock 图谱结果。覆盖 bear/bearing 词性与义项、排序先于截断、分页可达、变体和不同 sense、额外证据、空过滤、非法参数、服务角色权限及用户隔离、只读状态、审核中文能力；另有 17 个 V2 API 测试及 crossed-sense 证据合并回归。persuade/convince/dissuade、economic/economical、adapt/adopt 的已有审核关系及搭配保留。初次浏览器回归曾把 Wiktionary 近义义项和 OEWN 搭配义项当成同一页；修正为选择实际来源义项后通过。

数据固定为 [OEWN 2025 官方 XML](https://en-word.net/static/english-wordnet-2025.xml.gz)，许可见 manifest。完整 XML SHA256：`6f49adeec174ab3092169fb25cf4a925226b63975a5d29a691a5dff88f0673b2`。子集 SHA256：`5a886acb81b982e458aa5ef8cdce67f2f0a45e9ce0148d519205441b3f787823`。独立重新提取得到相同 SHA；子集保留根词全部条目、根 synset 全部成员与直接上下位关系，不依赖私人词库。

Chrome 真实浏览器 QA：390×844、820×1180、1440×1000。V147 原组件/RPC与同一公开词典数据对照，bear 旧图 24 节点，节点及标签边界盒分别有 49/29/23 对相交；V2 行为义项 6 张关系卡，三个尺寸的图谱节点及标签相交、裁切、横向溢出均为 0，控件均满足触摸尺寸。节点/边证据、纹章 charge、宽泛关系展开、分页、变体、切换视图、深色模式、词族微课、精确上下文和候选动作检查通过。CDP 触控测试的缩放、拖动、双击与长按三个尺寸均通过。不能据此宣称 iPhone Safari 实机验收完成；没有实机验证。

浏览前后比较完整 `user_words`、`study_sessions`、`fsrs_review_logs`、`user_skill_state`、`user_word_error_progress`、`exercise_skill_evidence`、`learning_budget_events` JSON，保持相同；请求记录没有只读 POST。使用合成用户和非空已有 FSRS 字段、冻结队列、BKT、错误层及预算，复习日志和 skill evidence 在夹具中为空；已有 FSRS/Lesson 全套回归也通过。未读取或变更真实用户学习表，未运行生产认证账户/生产数据库验收。

外部截图及结果 JSON：`C:/Users/16648/Documents/WordLoop-deliveries/2026-10-08-sense-v2/`。包括 before-bear、after-selectors、after-bear、after-variants、after-bearing-heraldry 的三个尺寸，以及 Root/深色截图。浏览器脚本接受 Playwright page 与外部输出目录，输出不进入产品构建。运行 `node --import tsx scripts/qa/serveLexical.ts` 可启动本地 V2 QA（默认 4329）；对照脚本另需在 4328 启动基线 QA。

## 兼容性、性能与后续发布/回滚

V1 RPC 和原调用签名保留。新前端显式请求 version=2；V2 migration 缺失时返回可识别的服务不可用错误，不偷偷回退到混杂旧图。新增表仅为共享审核知识，没有用户记忆字段。服务端从已验证身份传入 user ID，客户端不能传 user_id；函数使用 security invoker、固定 search_path、服务角色执行授权，匿名和 authenticated 无直接执行权限，新增表启用 RLS。有关函数权限的规范参考 [Supabase 官方函数文档](https://supabase.com/docs/guides/database/functions)。

本地 PGlite 26 次查询（首轮预热，25 次统计）的示例：bear V1 全义项 p50 41.08ms / p95 224.67ms、107775 bytes；V2 行为义项 p50 16.83ms / p95 44.30ms、74941 bytes。bearing V1 p50 18.01ms / p95 50.47ms、27648 bytes；V2 仪态义项 p50 12.40ms / p95 51.00ms、20628 bytes。这是不同查询语义的本地样本，不是同等工作量的生产性能承诺；V2返回全部选择器义项使 payload 仍非极小。standalone bundle 约增加 14KB，现有 Cytoscape family bundle 增加不足 1KB，没有新增图形引擎。

本次未执行以下步骤：正式发布前需审核并应用新增 migration、用现有语料导入流程生成并审查知识 SQL（包括变体证据，仅补充词典知识），然后在准确提交上重新通过发布门禁、核对 Sites 绑定与认证只读验收，再部署。旧知识库不会自动获得变体行；没有这些行时只是不合并变体，不猜测。审核中文表初始为空。

回滚可恢复 v147 对应代码/既有 V1 消费者；新增知识表与 V2 RPC 可保留，不需要删除用户数据或回滚学习 schema。若仅回滚本次修复而保留 Shanbay 手机键盘功能，使用本分支修复前的合并提交 `0b986d8`。最终完整提交 SHA 由 `git rev-parse HEAD` 获取，并在交付回复给出。
