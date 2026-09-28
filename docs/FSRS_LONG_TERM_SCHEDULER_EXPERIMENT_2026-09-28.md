# WordLoop FSRS LongTermScheduler 实验与迁移报告

日期：2026-09-28
仓库分支：`feat/standalone-webapp`，实验基线 `5d1a41cc92f7c8089ae0d5df973f25e0565e9bac`
依赖：锁文件固定 `ts-fsrs 5.4.2`（实现 FSRS-6）

## 迁移实现与修改前生产基线

生产代码现已统一使用 `enable_short_term: false`。WordLoop Lesson/relearn Lesson 承担短期 acquisition 与当天巩固；FSRS 只做长期排程。`request_retention=0.90`、`maximum_interval=36500`、默认 weights 和原有 fuzz 行为不变。`learning_steps` / `relearning_steps` 已从生产配置移除；当前锁定的 `ts-fsrs` 接受 `Partial<FSRSParameters>`，并在 short-term 关闭时不应用这些 step。

修改生产参数前，对当前 WordLoop Supabase 的 `user_words` 执行了只读聚合查询。`due_next_24h` 只计入未来 24 小时，不含 `due_now`：

| State | count | due_now | due_next_24h | fsrs_learning_steps > 0 |
|---|---:|---:|---:|---:|
| New | 6438 | 0 | 0 | 0 |
| Learning | 2 | 2 | 0 | 1 |
| Review | 153 | 4 | 66 | 0 |
| Relearning | 0 | 0 | 0 | 0 |

本次切换时有 **2 张历史 Learning/Relearning 卡**可能在下一次真实评分时经历 scheduler 状态转换；两张都是 Learning，当前均已到期，其中 1 张的 `fsrs_learning_steps` 非零。没有 Relearning 卡。查询没有修改数据库。

生产 `scheduleReview()` 默认 fuzz 下，固定时间 Fresh card 本轮实测 Again/Hard/Good/Easy 分别为 **1/2/3/9 天**，均进入 Review 且 `learning_steps=0`。Easy 的 fuzz 结果会随调度 seed 变化；回归只约束合理天级区间，不断言精确时间戳。

Review Again 的生产回归同时确认 FSRS due 是天级、`flow.relearn_words` 仍收录错词，而且 `buildLessonWords()` 仍将其放进 Lesson。Pretest known/uncertain/unknown 仍映射 Good/Hard/Again；known 不进 Lesson，uncertain/unknown 进 Lesson，三种新卡 due 都是天级。同日 due requery 仍按 `next_review_at` 正常执行，没有增加 date-level suppression 或 queue filter。

无 database migration、历史数据编辑、FSRS log replay 或手工 card reset。部署后最初一段时间仍可能看到上述旧 Learning/Relearning 卡的分钟级 due 自然再出现一次；下一次评分会由 LongTermScheduler 转成天级 due，这属于旧状态清尾，不表示新 scheduler 仍生成分钟级 due。

## 结论

WordLoop 现在使用一个全局 `enable_short_term: false` policy：由 Pretest 后的 Lesson/relearn Lesson 承担短期学习和重学，FSRS 保留评分历史并负责长期排程。Pretest 与正式 Review 共用同一个生产 scheduler，没有双 scheduler 路径。

直接切换在本实验覆盖的 New、Learning、Relearning、Review 卡上均不报错；所有 Learning/Relearning 输入在下一次评分后转为 Review，due 变为天级，稳定度/难度保持有限且落在 FSRS 有效范围。唯一需要产品上明确的语义变化是：**已有 Learning 卡在 LongTermScheduler 下评分 Again 会增加一次 `lapses`，BasicScheduler 对同一状态的 Again 不增加。** 因此这属于调度器可运行、状态可转换，但 lapse 计数语义并非完全无变化的迁移。

用户提供的“50 次新词 Pretest、87 次 Lesson attempts、112 次同日 formal reviews”是部署前观察基线；本次查询了当前 `user_words` state 分布，但没有重新计算该历史事件统计，也没有改写任何生产数据。

## 实验边界和参数

原实验先用两种测试 scheduler 对比了策略。迁移回归现在改为通过生产 `createFsrsScheduler()` / `scheduleReview()` 验证统一策略；BasicScheduler 只在一个测试中作为已知旧 lapse 语义的对照，不是生产路径：

- Basic：`enable_short_term: true`
- LongTerm：`enable_short_term: false`
- 对比实验共同参数：`request_retention: 0.90`、`maximum_interval: 36500`，默认 weights 不变。
- Production regression 使用 `enable_fuzz: true`，固定时间并以区间断言 due，避免锁定 fuzz 时间戳。
- `fsrs()` 接受 `Partial<FSRSParameters>`；生产配置不再传 `learning_steps` / `relearning_steps`。

依赖锁定证据在 `package-lock.json` 的 `node_modules/ts-fsrs` 项。生产参数和 fuzz 默认值分别位于 `server/services/fsrsScheduler.ts` 的 scheduler 工厂及 `scheduleReview()`。

## 1. 当前重复的来源

`server/services/words.ts` 将 Pretest 结果映射成 FSRS rating：known → Good、uncertain → Hard、unknown → Again，然后立即调用 `scheduleReview()` 并通过 `record_pretest_result_v2` 保存卡片与一条 `review_source='pretest'` 日志。与此同时，Pretest 后还有 WordLoop Lesson。BasicScheduler 因此会给新卡安排 1 分钟、6 分钟或 10 分钟后的 due；Easy 进入 Review 长期状态。

Lesson attempts 本身不推进 FSRS；`record_attempt_v2` 只记录练习结果。Review 失败则另行写入 FSRS Again/Relearning，并把词追加到 `relearn_words` 供 WordLoop Lesson 重学。于是短时重试同时有两条路径：FSRS learning/relearning steps 和 WordLoop Lesson/relearn。题述 112 次同日 formal reviews 正是与 50 次新词 Pretest 重叠的调度信号，87 次 Lesson attempts 则反映另一条练习路径。

## 2–3. Basic 与 LongTerm，以及 Fresh card 的实测结果

`ts-fsrs 5.4.2` 按 `enable_short_term` 在 scheduler 创建时选 `BasicScheduler` 或 `LongTermScheduler`。Basic 应用 learning/relearning step 策略；LongTerm 不应用这些 steps，New、Learning、Relearning 的评分都走 review 状态的长期计算，并输出 Review 状态与日级间隔。LongTerm 下 Review 的 Again 仍是 Review，不进入 10 分钟 Relearning。

Fresh card 在固定测试时间、生产 fuzz 设置下的结果：

| Rating | Basic state；stability / difficulty | Basic due；days / step | LongTerm state；stability / difficulty | LongTerm due；days / step |
|---|---|---|---|---|
| Again | Learning；0.212 / 6.4133 | +1 分钟；0 / 0 | Review；0.212 / 6.4133 | +1 天；1 / 0 |
| Hard | Learning；1.2931 / 5.11217071 | +6 分钟；0 / 0 | Review；1.2931 / 5.11217071 | +2 天；2 / 0 |
| Good | Learning；2.3065 / 2.11810397 | +10 分钟；0 / 1 | Review；2.3065 / 2.11810397 | +3 天；3 / 0 |
| Easy | Review；8.2956 / 1 | +10 天；10 / 0 | Review；8.2956 / 1 | +10 天；10 / 0 |

因此 LongTerm 的首个长期间隔是 Again 1 天、Hard 2 天、Good 3 天、Easy 10 天。ts-fsrs 对小于 2.5 天的间隔不 fuzz；Easy 的未 fuzz 间隔是 8 天，当前生产开启 fuzz 后本次固定 fixture 得到 10 天。LongTerm 没有分钟级 due。

## 4. Existing Learning card 切换

用当前 BasicScheduler 先构造生产形态的 Learning 卡：step 0 来自 Fresh Again（due +1 分钟、stability 0.212、difficulty 6.4133、reps 1）；step 1 来自 Fresh Good（due +10 分钟、stability 2.3065、difficulty 2.11810397、reps 1）。在原 due 时刻改用 LongTerm 评分，所有结果均无异常：状态转为 Review、step 清零、reps 变 2，due 是原 due 加下表的天数。

| 原 Learning step | Rating | 新 stability / difficulty | 间隔 | lapses |
|---:|---|---|---:|---:|
| 0 | Again | 0.06862175 / 8.80630447 | 1 天 | 0 → 1 |
| 0 | Hard | 0.212 / 7.60420977 | 2 天 | 不变 |
| 0 | Good | 0.212 / 6.40211507 | 3 天 | 不变 |
| 0 | Easy | 0.212 / 5.20002037 | 4 天 | 不变 |
| 1 | Again | 0.52337685 / 7.39450274 | 1 天 | 0 → 1 |
| 1 | Hard | 2.3065 / 4.75285849 | 2 天 | 不变 |
| 1 | Good | 2.3065 / 2.11121424 | 3 天 | 不变 |
| 1 | Easy | 2.3065 / 1 | 4 天 | 不变 |

日志的输入 `state` 仍记为 Learning；新 card `state` 是 Review。数字均有限、difficulty 在 1–10。Again 的 stability 下调且 difficulty 上调是 FSRS failure 计算的结果；与 Basic 不同的是 `lapses` 会加 1。这也是直接切换前需明确的计数语义。

## 5. Existing Relearning card 切换

用 10 天历史 Review 卡经 Basic Again 构造 Relearning fixture：stability 1.05557597、difficulty 8.47323965、due +10 分钟、reps 9、lapses 3。LongTerm 在该 due 时刻执行四种 rating 均无异常，所有新卡均为 Review、step 0、reps 10，due 分别为 1/2/3/4 天。

| Rating | 新 stability / difficulty | 间隔 | lapses |
|---|---|---:|---:|
| Again | 0.27136134 / 9.48339263 | 1 天 | 3 → 4 |
| Hard | 1.05557597 / 8.9716937 | 2 天 | 不变 |
| Good | 1.05557597 / 8.45999478 | 3 天 | 不变 |
| Easy | 1.05557597 / 7.94829586 | 4 天 | 不变 |

Relearning 的 Again 再增加一次 lapse，因为它是一次新的失败评分；LongTerm 不再安排额外的 10 分钟 Relearning。

## 6. Existing Review card 切换

用历史 Review fixture（上次复习 10 天前、stability 5.2、difficulty 5.4、reps 8、lapses 2）验证四种 rating。状态保持 Review、step 0、正常更新 stability/difficulty，due 均为天级：

| Rating | 新 stability / difficulty | 间隔 | 新 lapses |
|---|---|---:|---:|
| Again | 1.05557597 / 8.47323965 | 1 天 | 3 |
| Hard | 16.23118713 / 6.93153401 | 15 天 | 2 |
| Good | 23.54251268 / 5.38982837 | 23 天 | 2 |
| Easy | 39.553692 / 3.84812273 | 39 天 | 2 |

同一张 Review 卡再连续 Good、Good、Again，间隔为 23、67、2 天；持续保持 Review，最终 due 为 `2026-12-29T12:00:00Z`。`get_retrievability()` 对迁移后的 Learning 结果仍返回有限数值。Review 长期调度、rating history、stability、difficulty、retrievability 与 request retention 均继续工作。

## 7. Weights 与参数语义

- scheduler strategy 会改变：当前 flag 选择 Basic 或 LongTerm；同时决定是否应用 steps。
- 本仓库没有传入自定义 weights。两个 scheduler 得到相同的 21 个默认 weights；`w[19]` 均为 0.0658。request retention、maximum interval、learning/relearning steps 数组也一致。
- ts-fsrs 的 `migrateParameters()` / `clipParameters()` 对显式自定义 weights 会依 flag 改变 `w[19]` 下界：开启短期时为 0.01，关闭时为 0。用 `w[19]=0` 验证会分别得到 0.01 与 0；当前默认 `w[19]=0.0658` 不触发此差异，且本项目未配置自定义 weight migration。
- 公式语义也受 flag 影响：短期开启时 `t=0` 使用 short-term stability 分支；关闭时走一般 recall/forget 分支，failure stability 的下界计算也不再使用 `w17/w18` 项。故“weights 数值相同”不代表所有评分公式相同。
- `request_retention=0.90` 没有变化；long-term interval 与 retrievability 仍使用 FSRS 算法和同一套默认 weights。

## 8–10. 架构与历史卡切换建议

**最终实现全局关闭 short-term，Pretest 与 Review 不使用不同 flag。** 这与目标流一致：

- New：Pretest 继续记录 FSRS rating/log；Lesson 负责当天的教学和主动练习；FSRS 新 due 是 1–10 天，不会在 Lesson 中再发起 1/6/10 分钟 formal review。
- Review failure：FSRS Again 负责更新 FSRS history/stability/difficulty/lapses，并安排至少 1 天后的长期 due；`relearn_words` 仍让 WordLoop Lesson 当天承接重学。Lesson attempts 不覆盖 FSRS 字段。
- FSRS 仍保留 rating history、stability、difficulty、retrievability、`request_retention` 和 long-term interval scheduling。WordLoop 只独占短期练习路径。

历史 card 无需重算 history、重置 stability/difficulty 或新增 SQL migration。全局切换只改变之后调用的 scheduler；旧 card 与 `fsrs_review_logs` 在下一次评分前保持不变。现查到的 2 张 Learning 卡 `next_review_at` 暂时保留原 due；每张卡下一次评分后才转成 Review 并得到新的天级 due。Review 卡直接继续长期调度。因此切换后可能还会消费一次既存的短 due，但不会继续生成新的分钟 step。

旧 Learning 卡在 LongTermScheduler 下评分 Again 可能增加一次 `lapses`，而 BasicScheduler 下同一状态的 Again 不增加。本次回归直接验证并接受这项一次性 transition semantic；不对 FSRS 输出做手工补丁，也不保留双 scheduler。

Lesson profile / 自适应任务没有纳入本次改动；本次只确认 Review failure 仍走 `relearn_words` → `buildLessonWords()`。

## 11. 验证与发布边界

- `npm test`：54 个测试文件通过、1 个文件跳过；467 passed、2 skipped。Supabase integration 的 2 个既有用例仍为 skipped。
- `npm run typecheck`：通过。
- `npm run build`：通过，覆盖 widgets、server、Sites worker。
- Supabase state 基线为只读聚合查询；回归使用本地 fixture，不向生产数据库写入。
- 本次没有部署。部署后的 cohort 统计应只针对部署后新产生的 Pretest 卡，不应把现有历史卡的清尾当作新 scheduler 仍产生分钟 due。
