# WordLoop

[English](README.md) · [简体中文](README.zh-CN.md)

WordLoop 是一个围绕**持久化学习状态、主动回忆和明确教学策略**构建的个人英语学习系统。它不依赖聊天记录猜测“你学到哪了”，而是把学习进度、复习调度、题型计划、错误证据、划词笔记和词族知识统一放在可恢复的后端状态里。

同一套学习状态目前有两个入口：

- ChatGPT 内的 MCP App + 交互式 Widget；
- 独立响应式 Web App。

它的目标不是做一个“会聊天的背单词机器人”，而是把长期记忆、主动输出、用法训练、阅读积累、薄弱技能诊断和词族扩展拆成可控的模块。Supabase/Postgres 是事实来源；FSRS 负责长期词汇调度；BKT 估计技能薄弱点；确定性 planner 决定题型；DeepSeek 只在计划已经冻结之后生成内容或做必要的语义批改。

> 当前 package：`0.1.0`  
> 技术栈：Node.js 20+、TypeScript、React 19、Supabase/Postgres、MCP Apps、ts-fsrs、Cytoscape.js  
> 当前功能最完整的产品线：`codex/local-family-graph`

## 产品模型

WordLoop 把学习问题拆成多层，每一层只负责自己的事情：

| 层 | 职责 |
| --- | --- |
| 词汇状态 | 每个 normalized word 只有一份 canonical 用户学习记录 |
| 长期记忆 | FSRS 决定词汇什么时候该复习 |
| 学习编排 | WordLoop 后端决定下一步 durable state |
| 题型规划 | deterministic planner 冻结题型、目标和技能意图 |
| 技能诊断 | BKT 根据有效作答证据估计薄弱技能 |
| 内容生成 / 语义批改 | DeepSeek 只在冻结后的题目契约里工作 |
| 阅读积累 | Capture 保存词、短语、句子及上下文，不强制进入词汇队列 |
| 词族学习 | verified local lexical graph 控制派生词扩展 |
| 数据洞察 | 只读指标展示记忆、错误、活动和到期负荷 |
| 身份认证 | Supabase Auth + allowlist 支持小范围私测 |

整个系统最重要的原则是：**任何模块都不能偷偷变成第二套词汇 scheduler。**

FSRS 负责长期 due date。BKT 不改 due date。Capture 不改 due date。Family Graph 不改 due date。普通 Lesson 练习也不改 due date。

## 完整学习闭环

一次正常学习由后端驱动，并且可以恢复：

~~~text
到期 Review
   ↓
Pretest
   ↓
发音 / 听音还原
   ↓
冻结后的 Lesson
   ↓
Application / consolidation
   ↓
可选 Family micro-session
   ↓
从持久化状态继续
~~~

当前 phase、正在学的词、冻结 plan、题面 payload、retry state 和 navigation cursor 都保存在 `study_sessions`。关闭 ChatGPT、刷新网页或下次重新打开，不需要依赖聊天记录重新猜进度。

### 1. 正式 Review

正式 Review 只处理后端当前 due snapshot 里的词。

- 长期调度使用 FSRS v6。
- target retention：`0.90`。
- maximum interval：`36500` 天。
- `enable_short_term: false`。
- 只有新的、无提示、独立 retrieval 才能推进词汇卡。
- 普通 Lesson、看答案后的纠正、Capture 笔记复习、浏览词族都不会推进词汇 FSRS。

### 2. Pretest 与发音

新词在正式教学前先做预测试。

当前流程支持：

- 中文核心义 → 英文单词；
- 英文单词 + 词性 → 简单英文定义；
- 听音跟读；
- Lesson 前的听音还原。

配置 `MERRIAM_WEBSTER_API_KEY` 后优先使用 Merriam-Webster Learner's Dictionary 音频；不可用时，支持的客户端回退到英文 `speechSynthesis`。

### 3. 冻结式 Lesson 规划

Lesson 题型由服务端确定性 planner 决定。

模型生成前，WordLoop 已经冻结：

- target word / sense；
- activity type；
- skill IDs；
- hint level；
- expected duration；
- planning reason；
- plan / exercise ID。

常见题型包括：

- word recall；
- exact cloze；
- 中译英；
- collocation；
- derivation / word-family；
- sentence / application；
- consolidation。

重试时必须恢复同一道已保存 exercise，不能悄悄换题。

### 4. 确定性判分 + DeepSeek

固定答案题由服务端直接确定性判分。

只有真正需要语义理解的开放题才交给 DeepSeek。模型输出必须通过严格 JSON schema 和 Zod 校验，才能进入正式学习状态。

DeepSeek 不负责决定：

- 下一个单词；
- Review 队列；
- 题型；
- FSRS rating；
- due date。

### 5. BKT 技能模型

BKT 位于“有效作答证据”和“未来 Lesson plan”之间。

当前 fixed-v1 参数：

- prior：`0.2`；
- learn：`0.1`；
- guess：`0.2`；
- slip：`0.1`。

Evidence 规则：

- 独立首答在证据有效时可成为 `OBSERVE`；
- 有提示完成属于 `LEARN_ONLY`；
- 冲突或无法解释的结果是 `IGNORE`；
- 一道 exercise 对同一 skill 最多更新一次；
- active 模式至少需要该 skill 有 5 次独立观察。

模式：

- `active`：技能信号可以影响未来尚未展示的 Lesson plan；
- `shadow`：只记录建议，不实际干预；
- `off`：关闭 BKT projection 和选题信号。

BKT 不能改变已经展示的题、正式 Review 顺序、Review rating 或 FSRS due date。

### 6. 每日时间预算

默认每日学习预算为 45 分钟。

每日新词上限只是 ceiling。WordLoop 在安排新任务前估算成本，优先处理 overdue Review，并结合短期 FSRS workload forecast 控制后续新词量。

用户可以显式加练 15 分钟。budget stop 只表示预计学习时间已用完，不代表所有 due task 已完成。

完整规则见 `docs/EVIDENCE_BUDGET.md`。

## 词族学习系统

词族现在是 WordLoop 的一级核心能力。

目标不是给当前词堆一排 derivative，而是围绕当前词构建一个**小而可信的局部词族图**，再决定用户现在应该：

- 只浏览；
- 只巩固 base；
- 保存一个相关词以后再学；
- 现在引入一个 derivative；
- 对已经学过的同族词做辨析。

### 局部词族图

Family Graph 刻意限制规模：

- 默认一跳；
- 单次服务端最多 24 个节点；
- 浏览器累计最多 40 个；
- 更深关系必须用户主动展开；
- Cytoscape.js 只有打开 Family 面板时才懒加载。

拼写相似、embedding 聚类或 LLM 猜测不能直接生成 lexical relation。

### 数据来源

词族知识有明确来源：

- **Open English WordNet 2025**：英文 sense 和 verified lexical evidence；
- **MorphyNet English derivational v1**：经过校验的派生关系；
- **ECDICT**：lemma-level 中文释义和补充英文释义；
- 小型人工审核 fixture：用于确定性回归测试。

导入数据保留 source、revision、license 和 provenance。

### A / B / C / D 四阶段

- **A：巩固 base。** 原词不稳定或错误明显时，不激活新 derivative。
- **B：引入一个 derivative。** base 稳定后，才可能引入一个高价值且形态透明的新词。
- **C：间隔扩展。** 想继续学下一个同族词，必须满足 spacing 与稳定性门槛。
- **D：同族辨析。** 已经有多个稳定成员时，优先做语境辨析，不继续加词。

Family micro-session 是短时、可恢复、幂等的小课，可以包含形态说明、词性识别、definition recall、搭配、语境提取和主动回忆。

浏览图或保存 candidate 都不会创建词卡。只有完成预定 introduction 后，最多激活一个 derivative，并继续走现有 vocabulary / FSRS 路径。

Family 没有第二套 mastery 模型，也没有第二套 scheduler。

详细文档：

- `docs/LOCAL_FAMILY_GRAPH.md`
- `docs/LEXICAL_CORPUS_IMPORT.md`
- `docs/BILINGUAL_FAMILY_DICTIONARY.md`
- `server/data/ATTRIBUTION.md`

### 词根同源与语义网络

同一个局部弹层现在提供 **词族 | 词根同源 | 语义网络**。词族保留原微课和 A/B/C/D 间隔；词根同源区分经过核验的历史借词路径、共同祖源和现代派生；语义网络展示具体 Sense 的近义、反义、对比、易混、独立搭配与上下位关系。新增两种视图仅浏览现有学习状态，只有明确操作才保存未来候选。

Root 核心覆盖 circle 等六个目标词，未核验词源保持空态。OEWN 2025、固定 Wiktionary 修订与用法资料保留证据和各自许可。图谱仍默认一跳、每次最多 24 节点、浏览器最多 40 节点、Cytoscape 懒加载。本开发分支不会自动部署。详见[图谱交付、覆盖范围、迁移及回滚](docs/LEXICAL_GRAPH.md)。

## Capture 与 Note Review

Capture 用来记录阅读中遇到的内容，但不会强制进入学习队列。

一条 Capture 可以保存：

- selected text；
- word / phrase / collocation / sentence / grammar 类型；
- 周围上下文；
- 来源；
- 用户自己的理解 / 笔记；
- 多次 occurrence；
- inbox / saved / linked / archived 状态。

重复遇到同一内容时会累计 occurrence，而不是无限制造重复 note。

加入学习必须显式触发：

- 已存在的词只建立关联，不重置状态或 FSRS；
- 真正的新词可以创建/连接 vocabulary，但不会改写当前冻结的 Lesson round。

Note Review 也是 opt-in，并且与词汇 Review 分离。它有自己的 `note_review_states` / `note_review_events`，不会覆盖 `user_words`。

见 `docs/NOTE_REVIEW_MVP.md`。

## Insights 与词库

Standalone 里有只读 analytics 和完整词库视图。

当前指标包括：

- 长期首次回忆成功率；
- 当前 memory set；
- FSRS Stability / Difficulty / Retrievability；
- overdue / due / future due 分布；
- active error layers；
- 按题型统计的历史 error matrix；
- 正式 Review 活动；
- first introduction；
- Capture activity；
- focus-word ranking。

旧数据不足以支持某项指标时会显示 unavailable，不补造历史。

指标定义见 `docs/WORDLOOP_INSIGHTS_METRICS.md`。

## 产品入口

### Standalone Web App

根站点是完整响应式学习客户端。

主要区域：

- Today / Study；
- Capture；
- Note Review；
- Insights；
- Vocabulary；
- 私测账号设置。

### ChatGPT MCP App

本地 MCP：

~~~text
http://127.0.0.1:3000/mcp
~~~

Sites / Worker：

~~~text
https://<your-site>/api/mcp
~~~

用户说“开始学习 / 继续学习”时，第一步必须 bootstrap，再按后端 action 继续。模型不能根据聊天历史自己重建队列。

两个客户端共享同一套 canonical learner state。

## 扇贝导入

WordLoop 支持可选的一次性扇贝词汇迁移。

当前 Standalone 路径使用隔离的 Cloudflare Browser Worker：

- 每个已验证 WordLoop 用户有独立 active Durable Object / browser job；
- 用户通过短时 Live View 登录；
- bounded chunk 持久化；
- acknowledgement 后再推进远端 cursor；
- retry 幂等；
- 完成、取消或超时关闭 browser。

Cookie 和密码不会保存到 WordLoop，也不会返回给 Web App。

已有学习状态和 FSRS 不会被覆盖。

见 `cloudflare/shanbay-import/README.md`。

## 私测认证

当前产品支持小范围邀请制多用户 beta。

- Supabase Auth 验证邮箱/密码 session；
- `public.users` 是 WordLoop allowlist；
- 没有公开 signup UI；
- owner 可以创建内测账号；
- 旧的 `WORDLOOP_WEB_TOKEN` 只保留 owner / integration 兼容用途；
- Web API 和需要身份的 MCP call 都在服务端解析用户身份。

见 `docs/PRIVATE_BETA.md`。

## 架构

~~~mermaid
flowchart LR
  U[User] --> C[ChatGPT MCP App]
  U --> W[Standalone Web App]

  C --> R[WordLoop Runtime]
  W --> R

  R --> A[Auth + Study Orchestration]
  A --> S[(Supabase/Postgres)]

  A --> F[FSRS v6]
  A --> P[Deterministic Exercise Planner]
  A --> B[BKT Skill State]

  P --> D[DeepSeek Flash]

  R --> G[Local Family Layer]
  G --> O[OEWN]
  G --> M[MorphyNet]
  G --> E[ECDICT]

  R --> MW[Merriam-Webster Audio]
  R --> SH[Cloudflare Shanbay Import Bridge]
~~~

学习状态、词汇知识、模型生成和 UI rendering 被明确分层，不互相替代。

## 核心持久化数据

| 模块 | Canonical storage |
| --- | --- |
| Vocabulary / FSRS | `user_words`, `fsrs_review_logs` |
| Attempts / error evidence | `attempts` 与错误进度表 |
| Durable study flow | `study_sessions.state` |
| Exercise plans | 持久化 plan / exercise records |
| Skill evidence / BKT | `exercise_skill_evidence`, `bkt_updates`, `user_skill_state` |
| Capture | `captured_notes`, `captured_note_occurrences` |
| Note Review | `note_review_states`, `note_review_events` |
| Family knowledge | lexical lexeme / sense / form / relation tables |
| Family user state | candidates / exposures / micro-sessions |
| Private beta | Supabase Auth + `public.users` allowlist |

## 项目结构

~~~text
wordloop/
├── build/                         # standalone / GPT Sites shell
├── cloudflare/shanbay-import/     # 隔离浏览器导入 bridge
├── docs/
│   ├── TEACHING_POLICY.md
│   ├── EVIDENCE_BUDGET.md
│   ├── NOTE_REVIEW_MVP.md
│   ├── PRIVATE_BETA.md
│   ├── LOCAL_FAMILY_GRAPH.md
│   ├── LEXICAL_CORPUS_IMPORT.md
│   ├── BILINGUAL_FAMILY_DICTIONARY.md
│   └── WORDLOOP_INSIGHTS_METRICS.md
├── scripts/
│   ├── bkt-calibration/
│   ├── build-family-corpus.ts
│   ├── build-ecdict-corpus.ts
│   ├── build-oewn-dictionary.ts
│   └── replay-learning-evidence.ts
├── server/
│   ├── services/
│   ├── tools/
│   ├── mcpCore.ts
│   ├── webApi.ts
│   ├── webAuth.ts
│   └── worker.ts
├── shared/
├── supabase/migrations/
├── tests/
└── web/src/
    ├── dashboard/
    ├── family/
    ├── lesson/
    ├── pretest/
    ├── review/
    └── standalone/
~~~

## 环境变量

本地开发先复制 `.env.example` 到 `.env`。

| 变量 | 是否需要 | 用途 |
| --- | --- | --- |
| `SUPABASE_URL` | 是 | Supabase 项目地址 |
| `SUPABASE_SERVICE_ROLE_KEY` | 是 | 仅服务端数据库凭据 |
| `SUPABASE_PUBLISHABLE_KEY` | 私测 Web | 浏览器可用的 Supabase Auth key |
| `DEV_USER_ID` | owner / 旧路径 | 可信 owner UUID |
| `DEEPSEEK_API_KEY` | Lesson 生成 / 语义批改 | 服务端模型 key |
| `WORDLOOP_WEB_TOKEN` | 可选 owner 兼容 | 旧 owner/integration Bearer token |
| `MERRIAM_WEBSTER_API_KEY` | 可选 | 词典发音音频 |
| `SHANBAY_IMPORT_WORKER_URL` | 可选导入 | Browser import Worker 地址 |
| `SHANBAY_IMPORT_BRIDGE_SECRET` | 可选导入 | Server-to-Worker 签名密钥 |
| `SHANBAY_AUTH_TOKEN` | 旧导入 | 旧管理员 adapter |
| `SHANBAY_COOKIE` | 旧路径备用 | 旧 adapter cookie |
| `PORT` | 否 | 本地端口，默认 3000 |
| `HOST` | 否 | 默认 127.0.0.1 |
| `PUBLIC_BASE_URL` | 部署 | 对外产品 origin |
| `ALLOWED_HOSTS` | 公网部署建议 | DNS-rebinding 防护 |
| `WORDLOOP_ROOT` | 少数场景 | 显式项目根目录 |
| `ENABLE_WIDGET_PREVIEW` | 仅开发 | 本地 Widget preview |
| `WORDLOOP_PERF_LOG` | 可选调试 | 仅在包含 latency instrumentation 的代码线上提供性能诊断 |

任何 secret 都必须留在服务端，不能进入 browser bundle。

## 数据库与迁移

全新数据库运行当前 `setup.sql`。

已有数据库只按顺序执行缺失 migration。当前产品线的重要迁移包括：

- `202609290001_capture_notes.sql`
- `20260929120641_captured_notes.sql`
- `20260929172617_captured_notes_canonical_adapter.sql`
- `20260929172621_analytics_read_models.sql`
- `20260929184221_progress_scheduled_stability_mean.sql`
- `20260930043404_balanced_exercise_plans.sql`
- `20260930043648_exercise_plan_fk_indexes.sql`
- `20260930141500_consolidation_target_attribution.sql`
- `202610020001_note_review_states.sql`
- `20261002024106_evidence_budget.sql`
- `20261004045839_bkt_active_planner.sql`
- `20261004164746_cross_day_review_handoff.sql`
- `20261007025825_captured_note_deduplication.sql`
- `20261007053500_local_family_graph.sql`
- `20261007095603_lexical_dictionary_entries.sql`
- `20261008052820_lexical_root_network.sql`

这些显式文件名同时属于仓库 migration / README 测试契约。

Lexical knowledge import 是 additive 的，不能改写 learner vocabulary、attempt、FSRS state 或 frozen study session。

## 安装与运行

要求：

- Node.js 20+；
- 已完成 migration 的 Supabase 项目。

~~~bash
npm install
cp .env.example .env
npm run dev
~~~

生产构建：

~~~bash
npm run build
npm start
~~~

验证：

~~~bash
npm run typecheck
npm test
npm run build
npm run check:db
npm run predeploy:check
~~~

重放 pending learning evidence，不改原始 attempt 或 FSRS：

~~~bash
npm run evidence:replay
~~~

MCP Inspector：

~~~bash
npx @modelcontextprotocol/inspector --web http://127.0.0.1:3000/mcp
~~~

## 当前开发状态

当前功能最完整的产品线是 `codex/local-family-graph`。

它包含当前的 BKT、时间预算、Capture / Note Review、私测认证、Local Family Graph、词汇语料与双语词典。

PR #2 的 latency optimization 已在 2026-10-07 合入兄弟分支 `codex/exercise-balanced-learning-flow`。那条代码线包含更紧凑的 semantic grading、较低的模型输出上限、减少 frozen-plan 写入以及额外 timing diagnostics。**在两条代码线真正合流之前，本 README 不把这些实现描述成当前分支已经具备。**

这个区分是刻意的：README 应该描述实际存在的代码，而不是描述一个目前没有任何单一 branch 真正包含的“概念全集”。

## 当前限制

- 未做全局词网；Root 词源覆盖仅限已经核验的路径。
- 不允许 LLM 自动生成 lexical relation。
- 还没有 per-sense / per-POS learner mastery。
- BKT fixed-v1 参数还没有用大规模个人数据拟合。
- ECDICT 中文释义是 lemma-level，不等同于 synset translation。
- 旧事件证据不足时，部分历史 analytics 仍然 unavailable。
- Shanbay Browser import 仍受真实扇贝登录条件和 Cloudflare browser quota 影响。
- 当前两条 active feature line 仍需要代码级合流，才能得到同时包含 Family/BKT/private-beta 与 PR #2 latency optimization 的唯一最终 branch。

## 文档索引

- `docs/TEACHING_POLICY.md`：教学行为与 ChatGPT teaching contract
- `docs/EVIDENCE_BUDGET.md`：evidence、BKT 边界与每日预算
- `docs/NOTE_REVIEW_MVP.md`：Capture Note Review
- `docs/PRIVATE_BETA.md`：认证与邀请账号
- `docs/LOCAL_FAMILY_GRAPH.md`：词族图实现
- `docs/LEXICAL_CORPUS_IMPORT.md`：OEWN / MorphyNet corpus import
- `docs/BILINGUAL_FAMILY_DICTIONARY.md`：ECDICT / OEWN 双语词典
- `docs/WORDLOOP_INSIGHTS_METRICS.md`：analytics 指标定义与证据边界
- `server/data/ATTRIBUTION.md`：词汇数据来源与许可

人类可读的教学规则和 `server/teachingPrompt.ts` 应该在学习行为变化时保持同步。
