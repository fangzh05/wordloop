# Local Family Graph v1 交付记录

## 实现位置与审计结论

实现位于隔离 checkout `.family-graph`，分支 `codex/local-family-graph`。从 `f29dc9c` 开始审计，发布前已对齐 Sites v143 的基线 `7c5e9b5a188696d306085f19e757d1daaca89ea0`，保留其统一题面与词性提示处理。原工作目录的 `docs/TEACHING_POLICY.md` 等未提交工作未改动。Sites 绑定源码通过官方 workflow 校验；GitHub main 为另一条较旧源码线，本次发布以当前 Sites 基线为准。

开发前审计了仓库和只读生产 schema/RPC：`words` 是共享词汇表；`user_words` 是唯一词汇学习/FSRS 状态；`user_word_error_progress` 保存五个错误层的连续正确证据；`attempts` 保存练习；`study_sessions.state` 保存冻结队列及当前流程。FSRS 继续使用现有 `fsrsScheduler.ts`，保留 `enable_short_term: false` 等全部参数。没有第二套 vocabulary state、review scheduler 或 Family mastery。

入口加入 standalone Lesson 的解释页面。当前学习词 →「词族」→ 局部 modal → mini card / 明确展开 / 重新居中 / 未来候选 →「学习这个词族 · 约 2 分钟」。关闭返回原来的学习页面，不推进 Lesson 游标。Fast Loop、普通 Review 队列和 MCP 工具契约保持原有行为。

## 修改文件

| 文件 | 用途 |
| --- | --- |
| `package.json` / `package-lock.json` | 固定 Cytoscape 3.33.1 依赖 |
| `shared/familyContracts.ts` | 词条/关系/用户状态/微课 API 契约与请求限额 |
| `server/services/familyPolicy.ts` | 规范化、一跳筛选、确定性选择、分阶段及干扰保护 |
| `server/services/familyLesson.ts` | 原创、经审核的固定短课内容与现有 activity 类型路由 |
| `server/services/familyGraph.ts` | 用户状态 join、候选、持久化短课、现有 FSRS 初始化 |
| `server/webApi.ts` | 复用验证身份的 Family Web API |
| `server/worker.ts` | 按需 `/family.js` 静态资源 |
| `supabase/migrations/20261007053500_local_family_graph.sql` | 知识表、用户候选/暴露/短课事务、RLS、索引、RPC |
| `scripts/extract-family-fixture.mjs` | 从官方 OEWN XML 生成有限审核集 |
| `scripts/import-family-seed.ts` | 显式管理员知识数据导入，无学习卡写入 |
| `scripts/check-db-schema.ts` | 新表与 Family schema/RPC 安装检查 |
| `scripts/build-widgets.ts` | 独立引擎包、内容哈希版本、MIT notice |
| `scripts/build-sites-worker.ts` | 引擎及 SQL migration 打包 |
| `server/data/familySeed.json` | 21 lexeme / 17 relation 的审核集 |
| `server/data/ATTRIBUTION.md` | 来源、改编说明、许可和编辑评分说明 |
| `server/data/licenses/OEWN-LICENSE.md` | 官方 OEWN CC BY 4.0 notice |
| `server/data/licenses/WNDB_License.txt` | 官方 Princeton WordNet notice |
| `server/data/licenses/Cytoscape-MIT.txt` | Cytoscape MIT notice |
| `web/src/family/FamilyPanel.tsx` | 图、词卡、候选、短课、恢复和无 hover 操作 |
| `web/src/family/familyEngine.ts` | Cytoscape 图与触屏/低缩放/位置缓存 |
| `web/src/standalone/StandaloneApp.tsx` | 正在学习词的入口 |
| `web/src/standalone/apiClient.ts` | 复用已有带身份的 request helper |
| `web/src/styles.css` | 局部弹层与手机布局 |
| `tests/familyGraph.test.ts` | 规范化、过滤、节点/环、评分、分阶段等策略测试 |
| `tests/familyDatabase.test.ts` | 真实 PostgreSQL 事务、用户隔离、幂等、FSRS/冻结队列回归 |
| `tests/familyApi.test.ts` | 实际 Web router 的认证/限额/请求边界 |
| `docs/LOCAL_FAMILY_GRAPH.md` | 本交付与验收说明 |

浏览器 QA 的合成用户、临时服务、日志和截图保存在被忽略的 `.qa/`，不包含生产凭据。

## Schema 与 API

语言知识：`lexical_lexemes`、`lexical_senses`、`lexical_forms`、`lexical_morphemes`、`lexical_relations`。Lexeme 按语言、lemma、POS 唯一，Sense 保留 synset，Form 保留读音/形式类型，Relation 保留 direction、来源、版本、许可、provenance、confidence 和教学元数据。`family_key` 是审核集的形态族分组，用于跨可见分支的间隔检查，不能由拼写相似性生成。

用户数据：`family_candidates` 只保存未来候选；`family_exposures` 只保存族内引入/辨析历史；`family_micro_sessions` 只保存连接既有 `study_session_id` 的短课进度、回答与幂等键。这三张表没有 FSRS 卡、due 或掌握概率字段。图的用户层直接 join `user_words` / `user_word_error_progress`。既有词汇模型按 lemma 学习，因此不同 POS 图节点读取同一已有 lemma 状态；没有另建每 Sense/POS 卡片。

所有新表开启 RLS，撤销 anon/authenticated 的直接访问，仅经现有服务端验证身份访问。新 RPC 使用 security invoker 和固定 search_path，客户端无直接执行权限。邻接索引包含 `(source_id, relation_type, confidence)` 和 `(target_id, relation_type, confidence)`；用户历史按用户/词族/时间索引。

另外兼容修复了现有 `ensure_user_word_v1` 的 PostgreSQL 输出变量 `word_id` 与列名歧义：使用具名 unique constraint 和带别名的列。词汇初始化、touch existing、返回值及 FSRS 语义不变。真实 PostgreSQL 测试直接复用了该函数。

接口均为既有 `/api/web` 风格，身份来自认证后的服务端上下文，拒绝客户端 `user_id` 和未知字段，响应 `no-store`：

- `GET /family/graph?lexeme=...&depth=1`：当前词及一跳 DERIVATION。
- `GET /family/expand?lexeme=...&depth=1`：用户主动指定节点的下一跳。
- `GET /family/candidate?lexeme=...`：一个可解释候选、是否允许、阶段、当前用户状态。
- `POST /family/candidates`：保存一个未来候选，不创建词卡。
- `POST /family/start`：幂等构建/恢复一次短课。
- `GET /family/session`：恢复当前学习 session 的未完成短课。
- `POST /family/answer`：服务端判分、推进一步，最终最多激活一个 derivative。

每次图查询最多 24 个节点、每个节点最多 8 个 sense 和 4 个 form；前端累计最多 40 个节点。知识查询无需用户已学习才能成立。全族间隔保护只额外返回一个 developing guard 和有限暴露记录，不把远处节点加载到图中。

## 数据与 normalization

新增唯一运行时依赖：**Cytoscape.js 3.33.1，MIT**，版本固定。测试复用项目已有 PGlite/Vitest，没有引入 Sigma、ML 或全局图引擎。

知识骨架为 [OEWN 2025 官方 XML](https://en-word.net/static/english-wordnet-2025.xml.gz)。[官方许可](https://github.com/globalwordnet/english-wordnet/blob/main/LICENSE.md) 要求归属 OEWN 团队与 Princeton WordNet，完整 notices 已保存。四个额外 relation 来源为固定修订 Wiktionary，CC BY-SA 4.0，永久链接与改编说明见 `server/data/ATTRIBUTION.md`。尚未导入 Kaikki。原创中文练习与词汇事实分别存放，LLM 没有 lexical relation 写入入口。

规则：Unicode NFC、首尾空格去除、内部空白合并、小写；英语单词/带连字符形式按 `en:lemma:POS` 生成 canonical ID。多词 usage 不作为 lexeme 导入；不同 POS 保留独立知识节点；不同来源写到相同 canonical 节点，关系 evidence 合并保留来源。拒绝 self-loop、缺失来源/版本/许可/provenance、非有限 confidence。相似字符串、embedding 或前缀不能生成关系。

OEWN derivation/pertainym 不作盲目全量映射。只有审核 allowlist 中、保留原始 sense evidence 的具体形态 pair 才可进入 DERIVATION；普通 pertainym 不自动归类。synonym/contrast 等保留自己的 relation type，Family 默认只读 confidence ≥ 0.85 的 DERIVATION。重复来源/反向 evidence 去重为同一条可视 edge，同时保留 additional_sources；一跳查询无需递归，环不会无限展开。

审核集案例：persuade 初始只有 persuasion / persuasive，主动展开 persuasive 才出现 persuasively；convince 不在 Family，dissuade 是 CONTRAST；reconcile 有 reconciliation / reconcilable；economic 图区分 economy / economics / economical，后两者具有较高 interference penalty；act 初始只有 action / active / actor，后续分支必须主动展开。`economics` 被视为独立学科词条，不能当成普通复数 inflection 来激活。`act → active` 明确标记表层形态分析与历史借词说明。

## 候选策略与学习流程

确定性选择只使用已核验的一跳派生关系。引入优先向 reviewed base→derivative 的方向选择，不把可浏览的 parent 默认推荐成新 derivative。相同图、用户状态、暴露记录、给定时间得到相同结果；并列按 canonical ID 排序。

评分为 `utility × (0.5 + 0.5 × exam relevance) × transparency × frequency value × user need × (1 − 0.8 × interference risk)`。未提供可靠词频的节点用中性值 0.5，frequency_band 为 null，不能把编辑估计伪装成真实频率。utility ≥ 0.6、transparency ≥ 0.6 才允许首次引入。评分和门槛是可测试 v1 规则，UI 只解释人类可读理由，不显示内部乘积分数。

- A：base 的 reps < 2、stability < 3 天、连续正确 < 2、意义/拼写有待练习或 status=new 时，只练原词；未学习 base 只能浏览/保存候选。
- B：base 稳定时，本次只选择一个高价值未学习 derivative。
- C：同族已有暴露后，至少间隔 3 天，并且已学习的同族成员均达到上述稳定门槛，才引入下一个。SQL 用户锁重新检查，跨窗口、跨中心也不能绕过。
- D：当前一跳里已有至少两个其他稳定成员时，做 3 个已学习形式的语境提取，不激活新词。近期仍有族内练习时继续留出间隔。

reconcile 示例：base + 后缀/词干变化说明 → reconciliation 词性辨认 → 新语境填空 → reconcile A **with** B → reconcile yourself **to** sth → 未提示的中文到英文主动回忆。提交后才显示反馈；后续题目答案不提前放进 DOM。中途退出可恢复，网络重试不会重复练习事件、预算或 FSRS log。

短课使用现有 `derivation` / `collocation` / `word_recall` activity 及五个错误层。已有词的练习通过 `record_attempt_v2` 记为 consolidation，不改 frozen Lesson cursor。整课使用现有 daily budget 预留 120 秒。尚未激活 derivative 的回答只存短课 transcript；最终完成才通过 `ensure_user_word_v1` 初始化一个词，并把实际末题回忆经现有 `scheduleReview` + `record_pretest_result_v2` 初始化其 FSRS。答对 Good、答错 Again，遵循原调度策略。激活竞争中如果词卡已存在，则保存既有卡的 schedule。其他有限一跳 derivative 进入 future candidate pool，绝不建立卡或全族今日新词。

## 移动端、性能与验证

Cytoscape 按打开弹层才加载；主页面不请求 graph/candidate。引擎为单独带内容哈希的 bundle；对照冻结的上述 baseline、相同依赖和 esbuild 参数，standalone gzip 从 258,822 到 261,838 bytes，增加 **3,016 bytes**。按需引擎 gzip **143,715 bytes**。这是包大小/请求证据，不是生产网络下的全站延迟 benchmark。

UI 对齐现有 `.wordloop-shell`：使用已有系统字体、灰白材质、20px 卡片圆角、10px 控件圆角、浅色 #3168c6 / 深色 #85adfa 品牌色及共用 Button。Cytoscape 也读取相同 CSS tokens，跟随浅色/深色/系统主题更新。桌面两列（关系图 + 词卡/短课），手机单列；错误层收进可展开的学习状态，操作说明与数据许可默认折叠。退出或 Escape 后焦点回到词族入口，短课沿用现有输入与进度样式，并读取已有 visual viewport 高度变量。

布局是最多 40 节点的有限径向布局，没有迭代物理模拟，不需要 Worker。中心最大；其他节点大小由 utility/用户需要决定，degree 不参与。低 zoom 隐藏低优先级 label 和较低置信度 edge；本地仅缓存中心对应的手动位置，最多 160 个 point。ResizeObserver/图实例在退出时释放。

本地 Chromium 的 390×844 touch / 820×1180 touch 验收包含真实 touch tap、双击、长按、拖动、位置保存和 pinch（UI 对齐后 zoom 0.82→1.67），无 pageerror、无横向溢出；另外检查 1440×1000 桌面布局、浅色/深色/系统主题、Escape 焦点恢复，以及完整 reconcile 提交、关闭/恢复、主动回忆不泄露、只有一个新卡及一个 FSRS log。浏览器使用实际 FamilyPanel/engine、现有学习页布局 CSS 和真实 PGlite SQL、合成身份，不代表生产认证或 Safari 实机证据。

验证结果：typecheck 通过；web/server/Sites 三段构建通过；MCP Inspector 与全部 Lesson resource alias 通过；全量 **767 passed / 2 skipped**。新增 Family **34 项**（策略 15、真实 PostgreSQL 14、API 5）覆盖规范化、DERIVATION/置信度、一跳/展开、去重/环、用户 join/隔离、评分稳定性、A/B/C/D、远分支干扰、预算/重试、激活竞争、Good/Again、冻结队列和「不激活整个词族」。另外用真实 StandaloneApp Lesson 组件检查 1440×1000、390×844、820×1180：入口在「常见派生」同一标题行、44px 点击区域、初始无图谱请求、打开只有 3 个 reconcile 一跳节点、关闭恢复焦点、无横向溢出或 pageerror。

## 安装与尚未完成的验证

Lesson 的「常见派生」标题旁提供「词族」入口，点击后按需加载局部图谱。发布时按项目已有迁移流程应用 `20261007053500_local_family_graph.sql`，再以服务器管理员环境运行：

```powershell
node --import tsx scripts/import-family-seed.ts
npm run check:db
```

环境变量应通过既有安全服务端配置提供，不放入前端、命令输出或仓库。Importer 只 upsert lexical tables，可重复运行。2026-10-07 已通过 Supabase connector 应用生产 migration 与 seed，`family_graph_schema_v1()` 返回 true，21 lexeme / 16 DERIVATION / 1 CONTRAST；微课与候选初始均为 0。重复导入在同一 repeatable-read 事务内比较全部 `user_words` 与 `study_sessions`，确认没有改变任何学习状态或会话。`check:db` 在隔离 checkout 缺少 service role 配置，因此该命令未执行；2 个既有 Supabase 集成测试跳过。真实账号点击/提交、真实 iPhone/iPad Safari 和生产性能需要分别记录发布验收证据，不能用本地测试代替。

## Network View 与已知限制

Schema 已预留 INFLECTION / SYNONYM / ANTONYM / CONTRAST / COLLOCATION / CONFUSABLE / HYPERNYM / HYPONYM。Network View、词根词缀独立视图、Kaikki enrichment、pronunciation 练习、个性化 goal scorer、大规模导入和所有普通队列的 proximity 排序尚未开发。当前只在 Family introduction 入口实施 spacing；不会为了新功能重排 immutable Review queue。

覆盖为有限审核集，其他词会明确提示尚无核验数据；没有自动 LLM 补关系。当前 utility/exam 评分为固定编辑规则，3 天及稳定门槛尚未经长期真实用户校准。用户学习状态沿用 lemma 粒度，暂不支持每 sense/POS 的独立掌握统计；错误层无证据时明确显示「尚无分层证据」，不伪造 mastery dots。未来候选池只保存待引入意向，不自动往今日学习塞词。

Global Graph、Contextual Bandit、复杂 AI 自动词网及第二套 scheduler 不在本版范围。
