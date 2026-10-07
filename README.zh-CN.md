# WordLoop

[English](README.md) · [简体中文](README.zh-CN.md)

WordLoop 是一个以“持久化学习状态”为核心的个人英语学习系统。它不依赖聊天记录猜测学习进度，同一套学习状态可以通过两个入口使用：

- ChatGPT 内的 MCP App + 交互式 Widget；
- 独立响应式 Web App。

Supabase/Postgres 是词汇、学习会话、作答记录、FSRS 状态、技能证据、划词笔记、私测账号与统计数据的唯一持久化事实来源。WordLoop 自己负责排队、选题、状态转换和恢复；模型只在服务端已经确定目标、题型和流程之后参与内容生成与复杂语义批改。

> 当前 package 版本：0.1.0  
> 技术栈：Node.js 20+、TypeScript、React 19、Supabase/Postgres、MCP Apps、ts-fsrs、Cytoscape.js。  
> 本 README 对应当前最新功能线，包含 2026-10-07 的 Local Family Graph 与双语词典能力。

## 核心设计

WordLoop 把五类职责明确拆开。

- **FSRS 决定词汇什么时候复习。** ts-fsrs 仍然是词汇长期记忆的唯一调度器。普通 Lesson、综合练习、Capture 笔记复习和 BKT 都不能改写词汇卡的 due date。
- **WordLoop 决定下一步做什么。** 每日队列、冻结后的 Lesson 轮次、正式 Review 快照、学习会话游标和时间预算都由后端持有。
- **确定性 planner 决定出什么题。** 调用模型前，服务端已经冻结 activity、目标、技能 ID、提示程度、预计耗时和选题理由。
- **BKT 估计技能薄弱点，但不调度单词。** active 模式下，它只把基于真实作答的技能信号交给现有 Lesson planner；shadow 只记录建议；off 完全关闭。
- **DeepSeek 只在冻结契约内生成和批改。** 它不选词、不决定 FSRS 评分、不改变 Review 顺序，也不自行换题型。

浏览器永远拿不到 Supabase service-role key、DeepSeek key、Shanbay bridge secret 或其他服务端密钥。

## 当前学习流程

一次正常学习由后端 bootstrap 驱动，并持久化到 study_sessions。

1. **正式 Review**：只复习后端 due snapshot 中真正到期的卡；只有一次新的、无提示的独立 retrieval 才能推进词汇 FSRS。
2. **Pretest**：在不提前暴露答案的前提下判断当天新词熟悉度。
3. **发音交接**：预测试后可以在原卡片完成听音跟读与听音还原。
4. **Lesson**：冻结 5–7 词轮次，一次只处理一个词。模型不能重排、换词或偷偷替换已经保存的题。
5. **Application / consolidation**：长句翻译、中译英、造句等较长任务独立于普通 Lesson。
6. **Continue**：下一步永远由服务端返回的 durable state 决定，客户端不根据聊天上下文自行推断。

关闭 ChatGPT 或刷新网页不会重置学习。当前 phase、题面 payload、重试状态、冻结 plan 和 navigation cursor 都保存在数据库。

## 正式 Review 与 FSRS

词汇长期调度使用 ts-fsrs 的 FSRS v6。

当前配置：

- target retention：0.90；
- maximum interval：36500 天；
- 关闭 short-term FSRS learning steps。

新词习得和同日 relearning 由 WordLoop Lesson 负责，不再额外维护一套分钟级 scheduler。普通 attempt 永远不推进长期卡片；正式 Review 是唯一可以更新词汇 FSRS due state 的流程。

Capture 笔记复习是独立体系。用户显式启用后，note_review_states / note_review_events 使用同一套 FSRS 库保存“笔记级”复习状态，但绝不会覆盖 user_words 中的词汇卡。

## 题型规划与语义批改

Lesson planner 位于 server/services/exercisePlanner.ts。它综合目标词义、词性、错误层、最近题型历史、技能证据、题型适配性和冻结会话状态决定 activity。

常见任务包括：

- word recall / exact cloze；
- 中译英；
- collocation；
- derivation / word-family；
- sentence/application；
- consolidation。

固定答案题在服务端确定性判分。需要语义理解的开放题才发送给 DeepSeek，并通过严格 JSON schema + Zod 校验结果。当前模型为 deepseek-flash，thinking 关闭。

一次提交及其学习状态转换是幂等的。网络重试必须恢复原 plan / exercise，不能生成另一道题。

## BKT 与学习证据

BKT 位于真实作答证据之后、现有 planner 之前，它不是第二套学习系统。

- 独立首答在结果有效时形成 OBSERVE 证据；
- 有提示或讲解后的完成只形成 LEARN_ONLY；
- 冲突、未评估或无法解释的结果直接 IGNORE；
- 同一道 exercise 对同一 skill 最多更新一次；
- 当前 fixed-v1 参数：prior 0.2、learn 0.1、guess 0.2、slip 0.1；
- active 模式至少要求每个 skill 有 5 次独立观察。

核心证据存储包括 exercise_skill_evidence、bkt_updates 和 user_skill_state。历史 evidence 可以 replay，不改原始 attempt，也不碰 FSRS。

learning_settings.bkt_mode 支持：

- **active**：技能信号可影响尚未展示的未来 Lesson plan；
- **shadow**：只记录建议，不干预；
- **off**：关闭 BKT projection 和选题信号。

已经展示的题、正式 Review 顺序、Review rating 和 due date 都不能被 BKT 改写。

## 每日时间预算

默认每日学习预算为 45 分钟。每日新词上限只是 ceiling，不代表系统必须把所有词塞进当天。

系统在安排任务前估算成本；有 overdue Review 时优先处理 Review，并结合未来 7 天 FSRS 负荷进一步限制新词。已经冻结的 session 和已经保存的作答不会因为预算耗尽而丢失。

用户可以显式加练 15 分钟后继续。budget_complete 只表示“预计时间预算已用完”，不代表所有到期任务已经完成。

完整规则见 docs/EVIDENCE_BUDGET.md。

## Standalone Web App

根站点是与 MCP App 共用同一套后端状态的响应式学习客户端。

主要区域包括：

- **Today / Study**：Review、Pretest、Lesson、反馈和待做综合任务；
- **Capture**：划词记录单词、短语、搭配、句子、语法片段及上下文；
- **Note Review**：对显式启用的 Capture 笔记做 Again / Good 检索复习；
- **Insights**：记忆状态、到期分布、薄弱点和行为统计；
- **Vocabulary**：词库检索、单词详情、历史与 FSRS 状态；
- **Private beta 设置**：owner 创建内测账号。

Web 请求由服务端认证。内测账号使用 Supabase Auth 邮箱/密码登录，同时 public.users 作为应用 allowlist；没有公开注册入口。旧的 WORDLOOP_WEB_TOKEN 只保留 owner / integration 兼容用途，不应该发给内测用户。

## Capture / Notes

Capture 在加入正式词汇学习前与 user_words 保持分离。

它可以保存：

- selected text 与类型；
- 周围上下文和来源；
- 用户自己的理解 / 笔记；
- 重复出现记录；
- inbox / saved / linked / archived 状态。

同一内容反复遇到时会累计 occurrence，而不是无限制造重复 note。

显式“加入学习”时：

- 如果词已经存在，只建立关联，不重置 status 或 FSRS；
- 如果确实是新词，可以创建/连接词汇记录，但不会改写当前冻结 Lesson round。

Note Review 同样是 opt-in。归档、转换或清空“我的理解”会让它暂时退出复习候选，但不会删除已经存在的 Card 或复习事件。

## Local Family Graph

Standalone Lesson 的解释页现在带有当前单词的 **词族** 入口。

这个图刻意做成局部图，而不是全局知识网络：

- 每次只请求一跳；
- 服务端每次最多 24 个节点，浏览器累计最多 40 个；
- 只有打开 Family 面板时才懒加载 Cytoscape.js；
- 进一步关系必须由用户主动展开；
- 拼写相似、embedding 聚类或 LLM 推测都不能创建 lexical relation。

词汇知识层与用户学习状态严格分离。当前数据来源包括：

- Open English WordNet 2025：英语 sense 与经过验证的语义/形态证据；
- MorphyNet English derivational v1：经过 OEWN 校验的派生记录；
- ECDICT：lemma-level 中文释义和补充英文释义；
- 小型人工审核 fixture：用于确定性回归测试。

浏览词族本身不会创建词卡。用户可以保存 future candidate，也可以显式开始约 2 分钟的 Family micro-session。短课复用现有 activity、错误层和每日预算；只有完成预期引入流程后才最多激活一个 derivative，绝不会把整个词族塞进当天队列。

Family stage：

- **A**：base 还不稳定，只巩固原词；
- **B**：base 足够稳定时，引入一个高价值 derivative；
- **C**：已经学过同族成员后，只有 spacing 与稳定门槛都通过才引入下一个；
- **D**：已有多个稳定成员时做辨析，不再激活新词。

Network View、Global Graph、AI 自动造关系和第二套 Family mastery / scheduler 都明确不在当前版本范围内。

详细文档：

- docs/LOCAL_FAMILY_GRAPH.md
- docs/LEXICAL_CORPUS_IMPORT.md
- docs/BILINGUAL_FAMILY_DICTIONARY.md
- server/data/ATTRIBUTION.md

## 发音

配置 MERRIAM_WEBSTER_API_KEY 后，WordLoop 可以请求 Merriam-Webster Learner's Dictionary 音频。词典音频不可用时，支持的客户端回退到本地英文 speechSynthesis。

发音只属于教学/展示，不会独立推进词汇 FSRS。

## 扇贝导入

WordLoop 支持可选的一次性扇贝词书迁移。

当前 Standalone 导入路径使用隔离的 Cloudflare Browser Worker：

- 每个经过验证的 WordLoop 用户拥有独立 Durable Object / browser job；
- 用户在短时 Live View 中亲自登录扇贝；
- WordLoop 按 bounded chunk 持久化，再 acknowledgement 后推进远端 cursor；
- 重试复用 pending chunk，数据库写入保持幂等；
- 完成、取消或超时都会关闭浏览器；
- Cookie 和密码不会持久化到 WordLoop，也不会回传给前端。

已有学习状态与 FSRS 不会被导入覆盖。旧的服务端 Shanbay adapter 仅保留管理员兼容路径。

部署说明见 cloudflare/shanbay-import/README.md。

## ChatGPT MCP App

本地 Node 开发 MCP 地址：

~~~text
http://127.0.0.1:3000/mcp
~~~

Sites / Worker 部署地址：

~~~text
https://<your-site>/api/mcp
~~~

“开始学习 / 继续学习”的核心规则只有一条：先 bootstrap，再严格按照后端返回的 action 走。模型不能根据聊天记录自己重建队列。

MCP Widget 和 Standalone Web App 只是两个客户端，真正的学习状态始终在同一套后端和数据库里。

## 架构

~~~mermaid
flowchart LR
  C[ChatGPT MCP App] --> R[WordLoop runtime]
  W[Standalone Web App] --> R

  R --> A[Auth + study orchestration]
  A --> S[(Supabase Postgres)]
  A --> F[FSRS v6]
  A --> P[Deterministic planner]
  A --> B[BKT skill signals]

  P --> D[DeepSeek Flash]
  R --> M[Merriam-Webster audio]
  R --> H[Cloudflare Shanbay import bridge]
  R --> G[Local Family knowledge layer]

  G --> O[OEWN]
  G --> N[MorphyNet]
  G --> E[ECDICT]
~~~

server/worker.ts 是 Cloudflare Worker-compatible 入口；server/index.ts 保留本地 Node/Express 开发入口。

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
│   │   ├── bkt.ts
│   │   ├── bktPlanner.ts
│   │   ├── deepseek.ts
│   │   ├── exercisePlanner.ts
│   │   ├── familyDictionary.ts
│   │   ├── familyGraph.ts
│   │   ├── familyLesson.ts
│   │   ├── familyPolicy.ts
│   │   ├── fsrsScheduler.ts
│   │   ├── learningBudget.ts
│   │   ├── noteReviews.ts
│   │   └── studySessions.ts
│   ├── webApi.ts
│   ├── webAuth.ts
│   └── worker.ts
├── shared/
├── supabase/migrations/
├── tests/
└── web/src/
    ├── family/
    ├── lesson/
    ├── review/
    └── standalone/
~~~

## 环境变量

本地开发先复制 .env.example 到 .env，再配置服务端运行环境。

| 变量 | 是否需要 | 用途 |
| --- | --- | --- |
| SUPABASE_URL | 是 | Supabase 项目地址。 |
| SUPABASE_SERVICE_ROLE_KEY | 是 | 仅服务端使用的数据库凭据。 |
| SUPABASE_PUBLISHABLE_KEY | 私测 Web | 浏览器可见的 Supabase Auth key。 |
| DEV_USER_ID | owner / 兼容路径 | 旧路径使用的可信 owner UUID。 |
| DEEPSEEK_API_KEY | Lesson 生成 / 语义批改 | 仅服务端 DeepSeek key。 |
| WORDLOOP_WEB_TOKEN | 可选 owner 兼容 | 旧的 owner/integration Bearer token。 |
| MERRIAM_WEBSTER_API_KEY | 可选 | 词典发音音频。 |
| SHANBAY_IMPORT_WORKER_URL | 可选导入 | Browser import Worker 地址。 |
| SHANBAY_IMPORT_BRIDGE_SECRET | 可选导入 | WordLoop ↔ Worker 签名密钥。 |
| SHANBAY_AUTH_TOKEN | 仅旧导入 | 旧管理员迁移 adapter。 |
| SHANBAY_COOKIE | 旧路径备用 | 旧 adapter 的服务端 cookie。 |
| PORT | 否 | 本地端口，默认 3000。 |
| HOST | 否 | 默认 127.0.0.1。 |
| PUBLIC_BASE_URL | 部署 | 对外 origin。 |
| ALLOWED_HOSTS | 公网部署建议配置 | DNS-rebinding 防护。 |
| WORDLOOP_ROOT | 少数场景 | 显式项目根目录。 |
| ENABLE_WIDGET_PREVIEW | 仅开发 | 开启本地 Widget preview。 |
| WORDLOOP_PERF_LOG | 可选调试 | 输出 opt-in 模型耗时诊断。 |

任何服务端 secret 都不应该出现在 build/ 或浏览器 bundle 中。

## 数据库与迁移

新数据库运行当前 setup.sql。

已有数据库只按顺序执行缺失 migration。近期功能线主要增加：

- 冻结后的 balanced exercise plan 与 attribution；
- Canonical Capture / occurrence 存储与去重；
- Note Review state / event；
- learning evidence、BKT state 与 daily budget；
- active BKT planner 控制；
- cross-day Review handoff；
- Local Family Graph lexical / user 表；
- 双语 lexical dictionary entry。

词汇知识导入是 additive 的，不能改写 user_words、attempts、FSRS state 或已经冻结的 study_sessions。

## 安装与运行

要求：

- Node.js 20+；
- 已迁移的 Supabase 项目。

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

常用检查：

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

## 私测认证与安全

当前产品支持小规模邀请制多用户 beta。

- Supabase Auth 验证邮箱/密码 session；
- public.users 是应用 allowlist，只有 Auth 账号并不自动获得访问权；
- 没有公开 signup UI；
- owner 可在已认证的内测管理入口创建测试账号；
- Web API 与需要身份的 MCP tool call 都在服务端解析用户身份；
- service-role、DeepSeek 和 import bridge credential 永远留在服务端；
- 新增用户表和 lexical 表开启 RLS；需要特权的 RPC 只交给服务端运行时；
- ban / revoke Auth 用户即可撤销访问，不必同步删除其学习数据。

账号创建、恢复与撤销流程见 docs/PRIVATE_BETA.md。

## 数据来源与许可

WordLoop 会把词汇知识来源、版本和许可与数据一起保存。

应用代码与外部词汇数据并不共享同一许可。OEWN、Princeton WordNet、MorphyNet、ECDICT、Cytoscape.js 都有各自的 notice / attribution 要求。

重新分发 lexical data 或生成 bundle 前，请阅读：

- server/data/ATTRIBUTION.md
- server/data/licenses/

## 当前限制

- Family Graph 目前只做局部一跳图；Global / Network View 尚未实现。
- Family 的 utility / exam / interference 阈值是 deterministic v1 规则，不是经过长期校准的心理测量分数。
- BKT fixed-v1 参数还没有用大规模个人数据拟合；active 模式依赖 minimum-evidence guard。
- 用户学习状态仍以 lemma 为基本粒度，不支持每个 sense / POS 独立 mastery。
- ECDICT 覆盖很高但不是 100%，lemma-level 中文释义也不能等同于 synset translation。
- Shanbay Browser import 仍需要在真实 Cloudflare browser quota 与真实扇贝登录条件下继续验收。
- 旧事件缺乏足够证据时，一部分历史 analytics 会明确显示 unavailable，而不是补造数据。

## 教学策略

面向人的教学契约：

- docs/TEACHING_POLICY.md

运行时 prompt：

- server/teachingPrompt.ts

学习行为发生变化时，这两处应该保持同步。
