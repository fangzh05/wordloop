# WordLoop 生产性能诊断与低风险优化报告

日期：2026-10-15（Asia/Shanghai）。分支：`codex/production-performance-audit`。本轮没有部署、上传 Worker 版本、修改生产数据库、创建索引、安装扩展或调整实例规格。原始工作区的未提交修改完整保留。

> 以下第 1–9 节是首次诊断时的历史快照。用户随后授权“修复后部署”，最新修复、测试与生产发布结果见第 10 节。

## 结论与验收状态

已证明存在的冗余是同一请求内重复预算预留和重复时区读取，已消除可复用的往返。当前证据还不能把用户感知卡顿归因于单一生产瓶颈，也不能宣布 800 ms / 3 秒 / 生产 P50 降低 30% 达标。

特别发现：前端提交不是一个 HTTP 请求。`StandaloneApp.dispatch()` 在主动作之前等待学习时间 checkpoint，之后再次等待 finalize，然后才更新页面；失败时 finalize 还可能再试一次。只测 `attempts.grading_ms` 或主动作 API 会系统性漏掉这部分等待。此次补齐测量，保留校准语义和发送顺序。

生产认证答题的完整基线、相同设备网络下的优化后复测、真实 AI 生成/错误/重试率，以及 Cloudflare 运行时 CPU/内存和 Neon 负载时间序列仍缺失。全量测试也有已复现的 main 基线失败，因此本分支尚不能作为已通过全部发布门槛的版本。

## 1. main 与生产版本：已通过产物核验

- `origin/main`：`5a972f27c6b68722ef03a185316fade83fa21ecf`。
- Worker：`wordloop-app`，目标 `wordloop.zehaoo.top`；配置还包含 `test.zehaoo.top`。
- 当前 100% 部署版本：`ed0393ff-8b6c-410b-9445-acf1cfcd0698`，部署时间 `2026-10-14T16:50:17.578Z`，说明为学习时间戳及巩固 payload 修复。
- 通过 Cloudflare 只读 content API 下载生产模块，再对 main 使用仓库构建脚本和 Wrangler 4.149.0 执行 dry-run。上传包逐字节相同：1,829,403 bytes，SHA-256 `bdc027d908b533e73e440f11da15595b7f7cb60890d9ac2122ec2b5a80310c12`。
- 生产 `/app.js` 与 main 构建结果也逐字节相同：1,129,764 bytes，SHA-256 `56b865558aeb01711ffc6f784513fe6d2525cb6cd60f2b6eb13851e42853136a`。
- 仓库 esbuild 的中间文件与 Wrangler 上传包不同；不能直接比较两种阶段的 hash。证据文件保留了中间产物和最终上传包两种结果。
- Neon 生产项目 `curly-salad-19419173`，main 分支 `br-bold-pond-az6tjrpc`，端点 `ep-silent-paper-aznrjrrz`，区域 `aws-ap-southeast-1`，min/max 均为 0.25 CU，suspend timeout 为 0。Worker 绑定指向这个 Data API。
- `bkt_mode=active`；时间校准 V2 与自适应预算 V2 的生产绑定均为 true。生产代码固定 `deepseek-flash` 和 `thinking: disabled`。
- 生产 settings API 返回 `observability=null`、`logpush=false`，不能认定历史结构化日志已经持久化可查询。本轮未改这些设置。

证据：[production-source-comparison.json](performance/production-source-comparison.json)、[production-observability.json](performance/production-observability.json)。产物核验采用 [Cloudflare 官方只读接口](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/get/)。

## 2. 完整调用链与定位

```text
点击学习动作
  → flushLearningTime(false) → record_learning_time 请求（独立认证、读写）
  → postAction（主 request_id）
      → Worker /api/web/action → authenticateWebUser
          → Supabase Auth getUser → Neon users profile 读取
      → 请求 schema / active session revision / 冻结计划校验
      → reserveLearningBudget → 校准成本 profile（缓存冷时两个读取 RPC）→ 预算 RPC
      → gradeLesson：确定性判分，或 DeepSeek JSON + schema 校验 / 最多一次重试
      → recordPlannedSubmission
          → 再次 reserveLearningBudget（现复用本请求成功结果）
          → record_planned_submission_v1：正式记录和状态提交
          → tryConsumeSkillEvidence：同步、可重放的 BKT 投影
      → successForSession
          → 时区 / 私人来源授权 / 必要展示字段
          → getProgress：snapshot RPC + 今日正式 Review count
          → pending consolidation / JSON 响应
  → flushLearningTime(true)（未成功时可能再 flush）
  → setView / 解除 busy
```

| 候选或已证明问题 | 代码位置 | 证据与当前处理 |
| --- | --- | --- |
| 前后两次时间采集串行等待 | `web/src/standalone/StandaloneApp.tsx:1075`、`web/src/standalone/useLearningTime.ts`、`web/src/learningTimeTracker.ts` | 代码证明存在等待，生产耗时未知。新增完整 interaction 计时及前后采集拆分；保留时长校准行为。 |
| 重复预算预留 | `server/webApi.ts:1269`、`server/services/studySessions.ts:517`、`server/services/learningBudget.ts:182` | 两个位置调用同一 user/task key。已读生产 RPC：用户 advisory lock；已存在任务直接 true，不重新扣预算。本请求复用成功结果；其他请求继续走 RPC。 |
| 重复时区读取 | `server/services/words.ts:87`、`server/webApi.ts:397`、`server/services/progress.ts:135` | 完成日期、learning_time 和进度查询重复读 users.timezone。缓存限于请求、数据库对象和用户；新请求重新读取。 |
| BKT 串行往返 | `server/services/learningModel.ts:9`、`server/services/studySessions.ts:572` | 读取 mode + pending 共 2 次；每条证据 read state + commit 共 2 次，冲突最多 3 轮。无冲突为 `2+2N`；pending 最多 16 条，最坏有界为 98 次。新增 bkt_ms；未改数学或移到后台。 |
| 同步进度 | `server/webApi.ts:377,397`、`server/services/progress.ts:171` | snapshot RPC 与 Review count 并行，Review count 前需时区。已复用时区；保留正式统计，避免猜测增量和多设备误差。已有 progressIfAvailable 捕获统计失败，不将已保存答题变成统计错误。私人授权仍必须校验。 |
| 下一词同步生成 | `server/webApi.ts:589,1310` | 从冻结队列校验目标词后等待生成和持久化；生成与 pronunciation 并行。没有安全缓存命中数据，未实施预生成。 |
| 学习状态 bootstrap | `server/services/studyBootstrap.ts`、`server/services/studySessions.ts` | 已有 active-session 提前返回、仅 hydration 已选词、revision 检查；保持现有路径，没有扩大成全书读取。 |
| 选题与预算成本 | `server/services/exercisePlanner.ts:375,426`、`server/services/learningTimeCalibration.ts:62` | 选题已有并行上下文读取；BKT 作为 planner 信号。校准 profile 原已有 60 秒跨请求缓存，冷缓存有两个并行 RPC；未更改成本估计、参数或缓存期限。 |
| AI JSON 修复重试 | `server/services/deepseek.ts:442` | 已有 compact feedback 和安全字段归一化；仅瞬时 HTTP、无效 JSON/schema 等进行一次重试。没有实际 invalid_schema 重试率，未继续压缩反馈。 |
| 身份与 Data API 网络 | `server/webAuth.ts`、`server/db.ts:82` | 真实普通用户包含 Auth getUser 和 profile 读取。新增 auth_ms 和 Data API 请求计数；owner SQL timing 不等于 authenticated Data API timing。 |

上述行号对应代码提交 `beaefde` 附近，后续编辑以函数名定位。

## 3. 已取得的生产数据及其限制

七天窗口聚合，仅查询 count、耗时和时间范围，没有读取答案正文。

| scope / 题型 | n | 平均 ms | P50 ms | P95 ms | P99 ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| lesson / word_recall | 151 | 0 | 0 | 0 | 0 |
| lesson / collocation | 46 | 0 | 0 | 0 | 0 |
| lesson / translation_cn_to_en | 24 | 1238 | 1207.5 | 1694.75 | 2059.43 |
| consolidation / sentence | 4 | 1712 | 1326 | 2959.2 | 3150.24 |
| consolidation / translation_cn_to_en | 3 | 1800 | 2015 | 2055.5 | 2059.1 |
| consolidation / translation_en_to_cn | 4 | 1129 | 1099.5 | 1306.15 | 1322.83 |

这些是 `attempts.grading_ms`，不是浏览器端到端，也不是整个 Worker。只含成功保存的尝试；没有失败、模型版本和 AI 重试分母。七天窗口跨多个发布版本及迁移前的历史数据，不能归因于当前模型版本。自当前 Worker 部署以后，仅有 **2 条 word_recall、平均 0 ms** 的记录，未找到当前发布下可用于 AI 尾延迟验收的样本。教学生成、英文释义批改的历史平均/P50/P95/P99/错误率/重试率缺失，巩固批改仅有上表极小样本。

零毫秒不代表 CPU 完全没有成本。[Cloudflare 官方计时说明](https://developers.cloudflare.com/workers/runtime-apis/performance/)指出生产 Worker 的计时器仅在 I/O 后推进；纯 CPU 阶段可能显示 0。此次使用 performance.now 的单调 API，但不会声称它能在生产 Worker 上测出真实亚毫秒 CPU。CPU 需结合平台指标和本地 profile。

证据：[production-readonly.json](performance/production-readonly.json)。

## 4. Neon 只读检查

目前仅有 plpgsql、pg_session_jwt、pgcrypto、uuid-ossp，没有 pg_stat_statements。未安装扩展或修改 shared_preload_libraries。

串行、owner 角色、同样 SQL 的三个 EXPLAIN ANALYZE 样本：

| 查询 | 执行时间 ms（三次） | 当前计划 |
| --- | --- | --- |
| get_progress_snapshot_v1 | 2.612 / 2.591 / 3.103 | Result 调用 STABLE SQL function；外层计划不展示全部内部索引细节 |
| pending evidence 等价只读查询 | 0.695 / 0.666 / 0.673 | Limit → Merge Anti Join → evidence_pending_idx 与 consumption 主键的 Index Only Scan |
| 最近一天正式 Review count | 0.073 / 0.074 / 0.073 | Aggregate，下层按用户/来源/时间限定的索引查询 |

首次单独 progress EXPLAIN 为 3.401 ms；并行八项诊断时为 35.527 ms，pending 为 11.435 ms，Review count 为 4.855 ms。这组并行诊断可能制造竞争，原始结果完整保留；没有选取最好的一次当作基线或拿不同负载对比优化。报告以上表串行样本用于描述当前 SQL 执行成本，仍不将它转换成完整请求时延。

七天 attempts 分组诊断采用 Seq Scan，执行 0.476 ms、2916 行中匹配 232 行。该查询跨用户统计，不代表 learner 热路径应加 created_at 索引。

计数快照：attempts 约 2916 行，seq_scan=7077、idx_scan=2222489；user_words 7048 行，seq_scan=4063、idx_scan=2278961；learning_settings 仅一行，顺序扫描合理。计数自统计重置累计，缺少统一窗口，不能解释为每秒请求频次。一次 pg_stat_activity 快照只有一个活动连接（包含诊断本身）、无锁等待，不能据此排除历史拥塞。没有可靠的 CPU/内存负载时间序列或 Worker edge→Neon 跨区域 RTT 样本。

| 候选方案 | 预计收益 | 风险与决定 |
| --- | --- | --- |
| 同请求预算 / 时区复用 | 每次 Lesson 提交常见少 1 个预算 RPC，时区少 R-1 次；收益随网络 RTT 增长 | 已实施，失败结果不缓存、独立请求仍访问原 RPC；不触及 schema。 |
| 新增 progress / evidence 索引 | 当前没有证明有足够收益 | pending 已命中索引；现有 SQL 串行样本为毫秒级。未提出无依据迁移。 |
| pg_stat_statements | 提供 calls、累计/平均执行时间和热点 SQL 排名 | 安装/预加载可能涉及权限、重启、统计内存和语句留存隐私；必须先确认版本/重启需求并取得授权。不是本轮变更。 |
| 调大 CU / 改区域 / 换 DB driver | 当前收益未知 | 有成本、身份和架构风险，缺少负载证据；未改。 |

完整计划：[sequential-plans.json](performance/sequential-plans.json)。SQL由工具 owner 执行，不是普通 authenticated 用户或 Data API 的证明。

## 5. 已实施优化及同条件复测

固定本机、串行 40 个样本、每个往返注入 20 ms 定时等待、预热成本 profile。Windows 调度使实际每次等待可能超过 20 ms。测试直接调用真实 reserveLearningBudget / getUserTimeZone 服务；模拟 transport，不调用真实 AI 或生产学习写入。

每样本模拟同请求的两次预算预留、完成日期/响应/进度三次时区读取。基线来自优化前的服务；优化后用相同脚本和参数复测。

| 指标 | 优化前 | 优化后 | 改善 |
| --- | ---: | ---: | ---: |
| 数据库往返 / 样本 | 5 | 2 | 少 3 次（60%） |
| 40 个样本总调用数 | 200 | 80 | 少 120 次 |
| 平均 ms | 155.30 | 62.28 | 59.9% |
| P50 ms | 154.91 | 62.01 | 60.0% |
| P95 ms | 161.63 | 63.09 | 61.0% |
| P99 ms | 169.59 | 76.98 | 54.6% |
| AI 调用 | 0 | 0 | 不变 |

这是辅助路径的受控实验，**不是整条 submitLesson、更不是生产端到端 P50 降低 60%**。实际请求的时区读取次数取决于路径；两次预算调用常见节省 1 个 RPC，时区节省不能无条件写成固定 2 次。

复测文件：[helper-baseline.json](performance/helper-baseline.json)、[helper-optimized.json](performance/helper-optimized.json)。运行：

```powershell
node --import tsx scripts/benchmark-request-reuse.ts result.json
```

## 6. 追踪设计、资源成本和统计方法

- Worker 每个 Web API 请求使用独立 AsyncLocalStorage，接受合法 UUID 请求 ID 或生成新 ID，通过 x-wordloop-request-id 回传。只在 action schema 校验后记录操作名称。
- 阶段：auth_ms、db_read_ms、budget_ms、ai_generation_ms、ai_grading_ms、db_write_ms、bkt_ms、progress_ms、response_ms、worker_total_ms。未执行阶段为 0；纯 CPU 的 0 也受平台时钟限制。
- auth_ms 包含 Supabase 身份认证及 learner profile 检查；db_read_ms/db_write_ms 是客户端 Data API 请求和实际 body 消费的时间，不是纯 SQL。读取 RPC 使用已知只读名称分类；未知 POST 保守进入 write 桶，不能据此认定该 RPC 修改了数据。
- budget、progress、BKT、auth 内部可能包含 DB 阶段；并行 DB 总和也可能大于墙钟时间。这些指标重叠，不能相加当作总耗时。
- response_ms 计 JSON 响应组装，不包括浏览器 paint；worker_total_ms 范围是 Web API handler，不能替代 Cloudflare 原生 invocation/CPU 指标。
- 每个 AI attempt 记录独立 call_id、task、attempt、duration、outcome、HTTP status、retry reason；主日志记录 model、调用数、attempt 数、重试数。原有 Flash / disabled 配置、语义反馈和 schema 保留。
- 默认按请求 10% 随机记录单行 JSON（可由 WORDLOOP_PERF_SAMPLE_RATE 调成 0–1）；不用数据库保存性能日志，不加 telemetry 网络请求。测量窗口可临时在隔离环境设为 1，避免尾延迟估计样本不足。
- 默认不发送 Server-Timing；开发环境可通过 WORDLOOP_SERVER_TIMING=true 启用。包含所有阶段及总耗时，适合 Network 面板；本轮未设置生产变量。
- client API event 包含请求 ID、等待时间和状态；另有完整 interaction event，将前置采集、主请求、后置采集与主动作 request_id 关联。interaction 到解除 busy / setView 调用为止，不含后续 DOM paint。
- 浏览器只发本地 CustomEvent `wordloop-request-performance`，不自动上传服务器或持久化。开发采集器可监听并保存 e.detail，禁止采集整个 action / body / URL 参数。
- 记录中没有答案、教学正文、word/source/user ID、JWT、密钥、数据库请求 URL。数据库 Response 保持原始流，只在消费 text/json 时计时，避免额外整份 buffering。
- 没有新增 KV/R2/DO/Queue、AI 请求、DB 日志写入。缓存随请求销毁。日志量约为 Web API 请求数×采样率；目前原生持久化未启用，后续如启用需另审核保留期、既有错误日志及费用。
- 本地 Wrangler startup profile：基线 Active 83.5 ms、改动版 78.5 ms（单次、不同采样），只作启动检查，不能声称 CPU 降低。生产 CPU/内存/日志费用变化 **未测量**。

日志聚合工具按操作及 AI task 输出平均/P50/P95/P99、错误率、重试率和数据库调用均值，按 call_id 合并修复重试，按主 request_id 连接 interaction。极小样本尾分位不用于验收。

```powershell
# 在获准的隔离测量环境使用。仅 tail 日志不部署。
npx wrangler tail wordloop-app --format json > worker.ndjson
node --import tsx scripts/summarize-learning-performance.ts combined.ndjson summary.json
```

应用日志采样之外还有 Cloudflare 侧采样和 tail 能力限制；汇总时需记录最终采样比例。浏览器日志与 Worker 日志合并为 NDJSON，完整 interaction 是首选 client_total_ms；bootstrap 等没有 interaction 时以 API event 关联。工具另外输出 client_interaction / client_api_only，单次 API client event 不能冒充点击总等待。

## 7. BKT、预生成、AI 和异步统计的评估

BKT：原始证据由正式提交 RPC 持久化，再消费 pending；现有 commit RPC 具幂等消费和 revision 检查，失败保留 pending，可通过 evidence 读取/重放脚本恢复。active planner 会读取投影信号，贸然后台化会产生 stale selection，甚至改变冻结计划。本轮只测量；若 bkt_ms 和调用数证明占比高，可评估同一事务内按证据顺序批处理、复用原数学参数并对每个事件保留消费记录。需要独立 schema/RPC 审查和竞态/重放测试，不能现在直接上线。

下一词预生成：只允许从现有冻结队列选 1 个确定计划。键至少包含 user、word、plan_id、exercise_id/type、生成版本、来源授权/版本；必须在读取缓存时再校验私人来源权限、plan 和当前 revision。不能预留学习预算、写 attempts、改变 cursor 或冻结新计划；正常点击仍完成预算预留及 CAS 持久化。缓存 miss、过期、错误、并发失败均回退现有流程。

当前没有缓存 binding、生成锁、命中率或多 edge 一致性证据。Cache API/普通 KV 不能被当作可靠全局互斥；私有教学内容要有受控存储访问，禁止公网可猜 URL。若引入 DO/可靠队列会增加资源和维护成本。一次生成可耗 30 秒，repair 可再 30 秒；[waitUntil 官方限制](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)为响应结束后共享最多 30 秒，且无可靠自动重放保障。因此本轮未强行实现预生成或使用 waitUntil。

资源估算（设计候选，未实际创建）：每个确定下一词增加正常 1 次 AI HTTP、repair 时最多 2 次，另需最多一次计划/授权读取及缓存 put；命中时一次 get，跨 edge 互斥还需锁服务操作。建议仅保留一个下一词、TTL 5 分钟、条目上限 64 KiB，存储上界约活动用户数×64 KiB；到期清理不得触及学习历史。这是待验证的限制方案，实际账户 CPU/子请求/存储配额及成本尚未获取。即使命中缓存，认证、预算、状态提交、统计及前后时间采集仍在，不能直接承诺点击 P95 <800 ms。

异步统计：目前已保存答题后的 progress 失败被局部吞掉，持久化不回滚。本轮继续返回权威统计；没有采用可能错算今日数量的乐观增量。未来如果 progress_ms 占比高，应先设计独立刷新版本、旧结果抑制、错误提示和刷新恢复协议，再解除关键路径等待。

AI：现有配置和开放语义判断均保留。没有实际 schema repair 频率，不能凭测试样本砍掉意义/搭配/语法等字段。确定性 recall、spelling、exact_cloze、固定答案 collocation、普通 Review 和中译英 Pretest 继续走现有确定性路由；已有英文释义评估是独立语义任务，未用关键词替代。

## 8. 测试与验收矩阵

| 场景 | 自动化证据 | 生产认证端到端性能 |
| --- | --- | --- |
| 普通复习提交 | webApi / reviewSubmission；含 FSRS 单次保存和丢失 cursor 响应恢复 | 未测 |
| 新词预检 | webApi / studyFlowIntegration / pretestAttempt | 未测 |
| 单词回忆与拼写 | webApi 确定性路由断言 | 未测；当前发布仅两条 grading_ms=0 |
| 精确填空 | webApi accepted_answers 判分及保留冻结题目 | 未测 |
| 中译英语义批改 | webApi / DeepSeek JSON 契约 | 仅跨发布七天 grading 样本 |
| 错误答案二次提交 | webApi / DeepSeek 防泄露和参考答案规则 | 未测 |
| 进入下一词 | webApi / standaloneActionClicks；含 request_id 到 interaction 关联 | 未测，未实施缓存 |
| 完成一轮 | studyFlowIntegration / webApi / studySessionRace | 未测 |
| 阶段巩固生成与批改 | webApi / DeepSeek / plannedSubmission | 只有极小历史 grading 样本 |
| 刷新恢复 | webApi / studySessions / Review cursor recovery | 未测 |

新增测试验证请求隔离、并发同 task 仅预留一次、跨用户/跨请求仍访问 RPC、预算失败不缓存、时区新请求刷新、DB body 未提前消费、AI 重试统计、trace ID 校验、失败 HTTP 和日志不含私密输入。PGlite 的 Neon 权限/时间校准测试通过，但 PostgreSQL 模拟不是云端 Data API / 普通用户 RLS / 真实网络复测。

- `npm run typecheck`：通过。
- `npm run build`：通过。
- `wrangler deploy --dry-run`：通过，没有部署。
- 最后一轮全量：123 个文件，118 通过、4 失败、1 跳过；984 个测试通过、5 失败、25 跳过。
- 146 项功能及追踪针对性测试通过。最后流式 body 调整后，又有 94 项受影响测试通过。
- `learningTimeCalibrationDatabase` 13 项、`neonSecurityMigration` 3 项、`reviewSubmission` 10 项、`studyFlowIntegration` 2 项等在全量运行中通过。
- 四个失败文件已在未修改 main SHA `5a972f2` 复现：analyticsToday 两个旧快照统计断言，progressRuntime 一个旧统计断言，performancePaths 两个源码字符串契约；familyDatabase 初始化遇到原有 allocator guard 不匹配，23 个测试被跳过。未通过修改学习统计或弱化测试来制造全绿。
- 本地真实 workerd smoke：health 200、auth/config 200、无凭据 bootstrap 401，拒绝请求带回正确 request ID 与 Server-Timing。不是认证学习流程验证。

证据：[workerd-smoke.json](performance/workerd-smoke.json)。原始日志在工作区忽略的 `performance-*.log` 中；本地 CPU profile 和下载的生产包保留于忽略的 `.qa/performance/`。

## 9. 提交与后续门槛

| SHA | 内容 |
| --- | --- |
| f7267c0f5c1d4fb04825264d625878d33a7e9eb6 | Worker 阶段追踪、关联 ID、隐私字段约束 |
| 29a56026b63c23fc9e1d3f864fdbcb7e476d73e5 | 请求内预算/时区复用及同条件 fixture 对照 |
| f38caf1201ebc7a6853ac4a2c4db1475af1af362 | 完整浏览器 interaction 计时及日志分位数汇总 |
| beaefdee0545c3cb5416fb459d994b09f3bb1b14 | 流式 DB 消费计时，避免额外 buffering |
| dc4bc1f | 区分 bootstrap/read 与完整 interaction；汇总分别保留 API-only 和 interaction 数据 |

以上均为本地提交，没有 push 或生产部署。FSRS/BKT 数学、复习日志、预算 RPC/计费、时间校准、学习记录、认证和私人词书控制保持原实现；没有 schema migration。

剩余工作是取得获准的隔离生产等价环境，先解决/明确 main 基线测试失败，再在同设备网络、同区域/规格、普通 authenticated 身份、相同类型/长度题目、相同冷热缓存条件下采集基线与改动。每类至少 100 样本用于初步 P95，P99 需要更大样本并报告置信与误差；失败请求和重试必须保留。逐项核查重复 submission、预算扣减、证据消费、恢复和跨设备版本，比较数据库次数与 AI 次数后再评估 P95 800 ms / 3 秒和 P50 降低 30%。

在这些证据到位前，不能认证生产等价性能测试完成，也不能断言实际瓶颈已最终定位。生产部署仍须用户确认；本报告不是上线许可。


## 10. 后续修复与生产发布（2026-10-15）

用户已明确授权修复后部署。本次修复的是过时测试契约及测试 SQL 加载，不改变正式学习统计、FSRS/BKT 数学或生产 schema。

- `analyticsToday` / `progressRuntime` 改为验证权威正式 Review 日志数量，而非旧会话 cursor 或 review_words_count；同时断言按 review_source、日期和用户过滤，且不重复加载完整会话题目。
- `performancePaths` 保留防全词库扫描的约束，更新为当前正式日志计数和两个小会话读取的边界。
- `familyDatabase` 的 SQL fixture 统一 LF，修复 Windows CRLF 与 migration dollar-quoted marker 不一致；原有迁移文件和生产数据库均未修改。23 个此前未能执行的测试全部通过。
- 全量结果：**1012 通过、0 失败、2 跳过**，122 个文件通过。剩余两个是 `supabase.integration.test.ts` 中需要隔离 Supabase service-role 环境的远程写库测试；本机没有该配置，未启用生产凭据替代隔离环境。
- 类型检查、Web/Worker 构建、dry-run 通过。

部署的代码提交：`a6260a39798e4d14fd2c17d3b76333b091aad101`。Worker：`wordloop-app`；版本：`fa90d49a-0b6a-4ca2-8424-670d984eb99b`；版本标签：`perf-a6260a3`。使用仓库正式 wrangler.jsonc 和 --keep-vars 发布，保留既有变量与密钥，Neon Data API、预算/时间校准 V2 绑定保持原值。没有执行数据库迁移、索引、扩展或实例变更。

发布后核验：

- 生产 Worker 上传包与本次 dry-run 产物逐字节一致，SHA-256 `cc5a13901e00429aa44e49acede17695ab8938942a1d1f5844bd6c3aae2ce990`。
- 生产 app.js 与本次构建逐字节一致，SHA-256 `a58d6e96d7909b404f1273a484832876d8d67ff0c406dbd4c349440226b21776`。
- `/health` 和 `/api/web/auth/config` 返回 200；无凭据 `/api/web/bootstrap` 和 `/api/web/budget` 返回 401，且带新的 request ID。Cloudflare 可附加自己的 Server-Timing；应用阶段 Server-Timing 仍保持默认关闭。
- 使用 Chrome 中现有登录状态，在独立新标签页打开今日页，正式复习、学习进度和预算加载成功；继续学习可恢复服务端已有会话，刷新后阶段与游标保持一致。没有输入或提交测试答案，也没有读取密码/JWT。此证据只覆盖这个现有账号，未证明所有普通用户角色。
- Workers 实时 tail 捕获新结构化日志。其中一个 `record_learning_time` 请求 200，worker_total_ms=528、auth_ms=323、db_calls=2。这证明追踪与真实认证/数据库路径工作；不是用户点击总耗时、不是 P95，也不能用单样本宣称性能目标达标。

证据：[release-verification.json](performance/release-verification.json)、[release-public-checks.json](performance/release-public-checks.json)、[release-safe-traces.json](performance/release-safe-traces.json)。原始发布和测试日志保留在工作区忽略的 `release-*.log`。

本次部署已完成。真实答题 P50/P95/P99、同网络前后对照、多设备及普通账号矩阵仍属于第 9 节列出的后续性能验收缺口。
