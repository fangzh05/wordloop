# 考试词书扩充与生产数据发布：2026-10-11

用户明确指示“部署”后，以下保守子集已增量导入生产。新增成员 1,543 条、共享 ECDICT 词典 100 条；第二次执行零重复新增。待审集合未发布。运行时代码未改变，Worker 保持原版本。完整结果见 [production-release.json](production-release.json)。

发布前新建完整目标表快照，生产临时表恢复和本地 PGlite 恢复均逐行匹配。48 张非目标 public 业务表导入前后完整行哈希一致；原词典、旧成员、CET-4 和考研目录未改变。目录 RPC 已返回新计数，线上主域名/测试域名首页、health、auth config 均 200，MCP 初始化通过（33 tools、16 resources）。

以下为原 dry-run 数据与方法记录，拟总数已全部核验为实际生产总数。实体 Safari、登录后的浏览器完整学习操作尚未验收。

|词书|生产基线|拟新增成员|拟总数|暂缓候选关系|
|---|---:|---:|---:|---:|
|CET-6|5,406|606|6,012|3,072|
|IELTS|5,038|470|5,508|8|
|TOEFL|6,973|467|7,440|5,071|

共拟新增 1,543 个成员关系、100 条共享 ECDICT 词典记录。新增成员中文释义覆盖率 100%；复用现有词典，不覆盖现有条目，不生成 AI 释义。旧词书所有成员保留。考研 7,048 和 CET-4 3,846 不变。

## 生产与分支核对

目标项目 `jgzzrlnmakllhurjiazh`。现有 `(book_id, normalized_word)` 主键、`(user_id, word_id)` 唯一约束保持。词典唯一约束为 `(language, lemma, source, source_version)`；导入还检查任意既有语言/词头记录，避免覆盖现有释义。

工作分支 `codex/exam-books-expansion`，基于 `codex/builtin-exam-books` 的 `9b96d0d`。原工作区 `feat/faster-exam-learning-flow` 存在无关修改，未改动。当前 Worker `wordloop-app` 最新部署版本 `f7dd3e3f-762b-4ee3-b222-2390ed46d69c`，部署标注 `40cd372`，2026-10-11 10:00:07 UTC。GitHub main 是 `ea218fa`，没有假定它等同生产源。新增代码是离线工具，未修改前端、学习调度或 Worker 运行代码。

## 来源与许可

完整锁定版本、文件 SHA-256、下载时间、仓库许可证见 [sources.json](sources.json) 和 [nawl-source.json](nawl-source.json)。原始文件只在被 Git 忽略的 `.exam-books/expansion` 保存；本目录不含商业词书释义、例句、原顺序或完整编排。

- ECDICT：沿用已锁定 MIT 数据版本 `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`，许可见上级目录。
- KyleBing：BSD-3-Clause，独立提取正序/乱序 headword。六级两份各 5,651 行、3,991 唯一词，共有 3,990 词，各有一个独有词。托福各 13,477 行、10,367 唯一词，集合相同。没有从这些文件导入释义或例句。
- CET6 frequency：MIT，5,821 个 lemma；频率、年份数保留本地。仅作为佐证；缺少独立考试来源的词不导入。它不是官方大纲。
- NAWL 1.2：Browne, Culligan & Phillips，957 词，官方 [下载及许可说明](https://www.newgeneralservicelist.com/new-academic-word-list)。NAWL 衍生 headword 子集依据 [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) 署名并相同方式共享；没有对 WordLoop 应用代码重新许可。标准化、筛选、与既有词书求差属于本次修改。
- gungorkaya：MIT，但自述 AI-enriched。仅选择同时受到 KyleBing 或 NAWL 佐证且有可靠 ECDICT 中文释义的词，不导入 AI 同义词、例句或释义。
- fanhongtao：明确抄录新东方商业词书；LynnShaw、Mundi-Xu：未确认数据再分发许可；hefengxian：仓库 MIT，但词表自述来自《雅思词汇真经》。四者仅本地审查，公开贡献均为 0。启发式解析分别得到 2,073、3,592、3,632、1,661 唯一词，见 [审查统计](restricted-source-audit.json)，这些数字不是完整性承诺。

AWL 已审查大学官方研究入口，但当前入口返回 410，未取得明确覆盖本次公开再分发的许可，不从第三方镜像补入。官方 [CET 大纲入口](https://cet.neea.edu.cn/xhtml1/folder/16113/1588-1.htm) 及 [2016 大纲 PDF](https://www.neea.edu.cn/res/Home/1704/55b02330ac17274664f06d9d3db8249d.pdf) 已定位；未确认全文再分发权限，暂不抽取公开附表。后续可在权利确认后增量补充。

IELTS 新增部分主要扩大学术阅读/写作覆盖，适用于 Academic 辅助学习，未宣称是 General Training 核心必考集合。TOEFL 使用学术词表与考试来源交叉证据，未将 10,367 词通用大表整体纳入。两者都不是官方完整词库。

## 实际来源贡献与质量

贡献可重叠，不能相加：六级 KyleBing 正序 606、乱序 605、真题频率佐证 250；雅思 NAWL 470；托福 KyleBing 326、NAWL 368、gungorkaya 125。分来源原始数、唯一数、旧词重合、实际差集见 [report.json](report.json)，交叉重复及正乱序差异见 [source-overlap.json](source-overlap.json)。

新增后交集：CET6∩IELTS 3,497；CET6∩TOEFL 3,741；IELTS∩TOEFL 3,523；三者交集 2,656。每个词仍使用原规范词头与唯一用户学习身份。

词形判断结合 ECDICT exchange 原始字段，额外识别不规则形式（例如 shrank → shrink），仍仅记录候选关系，不合并身份。实际 WorkBuddy ACP 调用 12 批，316 个疑难词头，默认读取安装桥接器配置 `auto`；底层模型名称/版本未得到服务验证，不能声称某个具体模型。严格 Zod 校验字段、枚举、输入词头全集和输出唯一性。每批保存提示版本、输入哈希、原始输出、成功缓存与服务信息。重复执行 12 个缓存命中、0 新调用。

模型结果：keep 117、distinct_lemma 54、inflection_of 103、uncertain 22、multiword_expression 4、spelling_variant 3、invalid 13；122 项要求进一步审核。106 个词形/异体建议均未触发身份合并、删除或关系写入。模型自评置信度不用于批准合并。

暂缓共 8,151 个词书候选关系、7,431 个唯一词：8,113 个关系缺少充分考试证据，693 个唯一词缺可靠中文释义，281 个关系触发人工词形/格式审核。模型 invalid 的 13 个词头也未导入。类别重叠。所有暂缓词留在本地 `human-review.json`、`missing-dictionary.json`，不显示为可学新词。API 成本未知：ACP 不提供 token/账单数据；未知不代表免费。

## 增量导入、安全与回滚

`prepare-exam-expansion.ts` 仅生成审阅 SQL，始终不连接生产库。导入 SQL 使用事务、advisory lock、现有唯一约束和 `on conflict do nothing`；验证基线、词书范围、词典中文覆盖及最终计数，失败回滚。唯一新增结构位于非公开 `exam_expansion_audit`：批次、来源证据、实际插入成员与快照；撤销匿名/认证用户权限。多来源不会覆盖原成员的单一来源字段，既有成员的新增来源证据也保存在批次记录。

SQL 只插入缺失共享词典/成员，并更新三个目标目录的来源、版本、许可、checksum。不更新词实体、学习状态、FSRS、BKT、会话、私人释义、笔记或词族。回滚仅删除本批实际插入成员并恢复目标目录元数据；保留词典新增和所有学习记录。

真实生产快照保存在本地 `.exam-books/expansion/backup`：26,447 条完整词典、28,311 条完整成员、5 条完整目录、列定义、分块 SHA-256。已恢复到隔离 PostgreSQL；固定 UTC 和 C 排序后，全部表的完整行哈希与再次读取的生产库一致，见 [备份验证](backup-verification.json)。这是本次词典/词书范围备份，**不是完整用户库或完整 Supabase 项目备份**。

在真实快照恢复库执行两次增量导入，成员均为 29,854，词典均为 26,547；第二次无新增，原有完整词典记录保持原样。撤销后成员恢复 28,311，词典保留 26,547。隔离模拟学习记录也保持不变。生产保护表前后完整行哈希一致，见 [protected-state-audit.json](protected-state-audit.json)。

数据 payload 450,155 字节，约 0.43 MiB。真实快照隔离回放总表/索引空间从 43,008,000 增至 94,240,768 字节，增量约 48.9 MiB，**主要包括私有审计快照**；索引布局为近似生产结构，不能当作生产存储实测。生产已核验净新增 1,543 条成员、100 条词典。私有审计结构（含新快照、事务快照、来源和传输分块）实测 97,140,736 字节；数据库当前总大小 403,655,827 字节。这不是同口径导入前后数据库总量差。

## 验证及剩余关口

- TypeScript 类型检查和构建通过。
- Vitest 限制并行度后 886 通过、2 跳过；首次全并行运行出现数据库/MCP测试超时，重跑通过。新增与词书聚焦测试 14 通过。
- `npm run check:db` 已执行，但因当前环境没有 `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` 退出。通过已认证 Supabase MCP 独立核实该脚本对应的 48 个列/RPC 存在性检查，全部存在；另在只读事务中执行同一组 12 个 RPC 探针，全部可调用，三个 schema 探针返回 true；这不替代服务端密钥经 REST API 的检查。
- 已完成本次真实范围备份恢复、真实数据两次导入回放、回滚、现有释义保护、原用户库前后核对。现有词书数据库测试覆盖切换时不丢失进度、懒惰纳入学习与共享身份。
- 未完成：真实浏览器新增词 Pretest→Lesson→评分→Review、手机性能基准、iPhone/iPad Safari 硬件验收、完整 `check:db` 凭据模式检查。没有声称生产导入后的 UI/学习验收已经完成。

生产写入关口已完成：用户明确指示“部署”，重新核对 Worker 与完整目标表哈希，重新导出快照并验证恢复后执行事务；核验目录 RPC 计数、48 张保护表、旧词典和成员、重复执行及线上服务。浏览器真实学习操作仍在未完成验收范围。

## 重复运行

从仓库根目录执行，服务端凭据/WorkBuddy runtime 路径仅使用环境变量：

```powershell
python scripts/download-exam-sources.py
# 首次需通过认证数据库工具导出 live-snapshot.json；不提交账户数据。
$env:ECDICT_PATH='本地锁定 ECDICT CSV 路径'
$env:WORKBUDDY_PYTHON='已安装 WorkBuddy ACP bridge 的 python.exe'
node --import tsx scripts/expand-exam-books.ts .exam-books/expansion --review
node --import tsx scripts/prepare-exam-expansion.ts .exam-books/expansion
node --import tsx scripts/replay-exam-expansion.ts .exam-books/expansion
node --import tsx scripts/verify-exam-backup.ts .exam-books/expansion/backup --replay
```

下载器默认复用本目录的锁定清单并验证 SHA-256；`--refresh` 是新一轮来源采集，不能自动沿用旧审核结论。WorkBuddy 故障或非法 JSON 只留下原始响应/已成功缓存并退出，没有数据库写入路径。原始材料、缓存、真实快照及审阅 SQL 不进入 Git。

本次发布新快照位于本地 `.exam-books/expansion/deployment/fresh-backup`，数据库保留私有 `expansion_d7df5e05d9b42663_predeploy` 快照。托福分页查询使用现有主键 Index Only Scan，51 行实测执行约 1.44ms；此为单次数据库查询，不能替代手机性能基准。Supabase advisor 仍报告既有 public/Auth 配置提示，未扩展修改范围，见 [提示及修复链接](production-advisors.json)。
