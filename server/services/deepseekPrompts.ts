export const LESSON_GENERATION_PROMPT = `为考研英语一与 IELTS Academic 生成一张自然、简洁的英语单词 Lesson 卡。输入中的 plan 是唯一练习计划：必须逐字采用 plan.planned_activity_type、目标词义、skill_goal 和目标词，不得自行挑词、换题型、改变顺序或决定推进。lesson_profile 表示训练强度，不能据此覆盖计划。V1 由服务端规则规划；不要调用工具重新选择题型。

围绕词条给核心义、一个高价值搭配、最多两个常见派生、一条易混提醒、一条例句及中文译文。每个搭配和派生都要在同一字符串中同时给出英文和简体中文释义，例如“allocate resources（分配资源）”和“allocation n.（分配；拨款）”；不能只给英文词组或词形。词性覆盖输入给出的全部词性，不能只选一个。熟悉词只给核心义、一个搭配和音频需要的信息，note 与额外内容保持简短；未知词保留必要讲解。除词条、example_en 和 exercise.prompt 外使用简体中文。example_en 使用一般教育、科技、社会、工作、环境或公共服务语境，通常 15–25 词；不要默认写医学专业语境。练习语境必须不同于例句，不直接翻译、复述或微改例句。

严格按计划生成恰好一道短题：
- exact_cloze：短英语新语境，只有一个 ___；目标词不出现在空格外；accepted_answers 非空。
- word_recall：只给清晰的中文核心义提示，不出现目标词；accepted_answers 为目标词及必要的常见词形。
- translation_cn_to_en：给明确、自然的中文句子，训练一个指定词义或搭配；要求用户输出约 5–12 个英文词；不要把目标词或答案写在 prompt；accepted_answers 省略，按语义批改。
- collocation：给至少六词的英语新语境，只有一个明确搭配空格；目标词不出现在空格外，句法与意思线索足以排除随意猜介词；accepted_answers 非空。
- derivation：仅在 plan 指定且确有实用派生时提供清楚的词形/句法线索；答案必须是常用派生形式，不能把原词当答案。

所有普通练习单行、短、只含一个目标；不得造句或加第二题。activity_type 必须与 planned_activity_type 完全一致。固定答案仅保存在服务端，不能在 instruction、prompt、例句或解释中泄漏。不要因为生成困难而降级为填空。只返回一个 JSON 对象，不要 Markdown：
{
  "ipa": "...",
  "part_of_speech": "...",
  "meaning_zh": "...",
  "collocations": ["English collocation（中文释义）"],
  "derivations": ["English derivative + part of speech（中文释义）"],
  "example_en": "...",
  "example_zh": "...",
  "note": "...",
  "exercise": {
    "activity_type": "与计划完全一致",
    "instruction": "...",
    "prompt": "...",
    "accepted_answers": ["固定答案题必填；语义翻译省略"],
    "multiline": false
  }
}`;

export const SEMANTIC_GRADING_PROMPT = `严格按服务端原题、目标词义和评分要求批改，不改题、不换词、不决定推进。总体 is_correct 仅在目标词义、核心搭配、主要命题、否定与关键修饰关系正确时为 true；自然准确的不同表达均可通过。无关的小冠词、标点或轻微自然度建议不能判作目标词遗忘。task_fulfillment 表示主要命题是否完成。核心错误选择 meaning、collocation、grammar、spelling 或 pronunciation；正确时 error_layer=none。
每次只独立评估本次 answer。retry_count 只控制答错时是否显示答案，不表示本次仍然错误，不得照搬第一次的错误提示。先判定答案，再决定反馈；不能一边判错一边把用户原答案作为正确参考答案。
首次答错（retry_count=0）只给一个具体错误片段与短提示，禁止提供参考答案；第二次仍错必须给非空 reference_answer。message 与 short_hint 各用一句简短中文。不要输出分项评分、target_word_results、skill_results 或分析报告。以下只是结构示例，不能默认使用示例的判分；可选 reference_answer 仅在第二次答错时提供：
{
  "is_correct": true,
  "error_layer": "none",
  "task_fulfillment": true,
  "message": "答案正确。",
  "short_hint": "核心含义和用法表达准确。"
}`;

export const ENGLISH_DEFINITION_GRADING_PROMPT = `判断用户给出的简短英文释义是否准确表达目标词的核心义；接受自然的同义表达，不要求复述词典原句。feedback 必须使用简体中文，可引用必要的英文词句。只返回一个符合以下目标 JSON shape 的 JSON 对象，不要 Markdown：
{
  "is_correct": true,
  "feedback": "..."
}`;

export const WRAPUP_GENERATION_PROMPT = `生成一道考研英语一或 IELTS Academic 难度的长难句英译中任务。若输入包含 plan.skill_goal，句子主要结构必须自然体现这个训练点；不得擅自替换为其他技能目标。prompt 只能包含完整英文原句，不得包含编号、中文提示、译文或解析；必须为 25–40 个英文词（生成后先核对词数），只有一个主要结构训练点，如修饰范围、让步、指代、非谓语或名词性从句；优先自然使用一个适配目标词，第二个可选，不要硬塞两个词。提供完整英文原句和简洁指令，不返回中文译文、解析或答案。只返回 JSON：
{
  "activity_type": "translation_en_to_cn",
  "instruction": "请翻译成自然中文；主干分析可选。",
  "prompt": "...",
  "multiline": true
}`;

export const FULL_CN_TO_EN_CONSOLIDATION_PROMPT = `生成一道完整中译英综合任务。给出一个具体自然的中文句子，训练一个已学核心词或搭配；要求英文输出约 12–25 词。允许不同自然句式，不限制逐字翻译。不返回参考译文或结构解析。只返回 JSON：
{
  "activity_type": "translation_cn_to_en",
  "instruction": "请把这句话完整翻译成自然英文。",
  "prompt": "...",
  "multiline": true
}`;

export const SENTENCE_CONSOLIDATION_GENERATION_PROMPT = `生成一道情境造句综合任务。给出具体表达目标，例如“用 allocate 说明学校如何分配有限经费”；只要求用户写一个自然英文句子，通常 10–25 词，长度偏离一两词不能自动判错。目标词优先选最近学过、适用且尚未覆盖的词或明确错误词。语境自然，不强迫学术风格。prompt 可以展示目标词，必须标记为有提示应用。不要返回参考句。只返回 JSON：
{
  "activity_type": "sentence",
  "instruction": "按给出的表达目标写一个自然英文句子。",
  "prompt": "...",
  "multiline": true
}`;

export const WRAPUP_GRADING_PROMPT = `${SEMANTIC_GRADING_PROMPT}
本任务是英文长难句英译中；主干分析为可选提示。重点检查整体命题、关键修饰与逻辑关系，接受自然准确的不同译法。主干、从句与修饰范围错误用 grammar，原意、指代或逻辑误译用 meaning；不要输出 structure、logic、translation 或 naturalness 等其他分类。第二次仍错提供完整参考译文。参考答案字段示例：{"reference_answer":"完整中文译文"}。`;
