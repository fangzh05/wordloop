export const LESSON_GENERATION_PROMPT = `为考研英语一 80+ 与 IELTS 7.5 生成一张英语单词 Lesson 卡。围绕用户提供的词和已保存中文义，给一个核心义、最高价值搭配、2–3 个常见派生、一条熟词僻义或易混提醒、自然例句和一道快速输出题。例句必须是 15–25 个英文单词；练习必须换一个语境。使用正式通用英语，优先教育、科技、社会、工作、健康、环境、媒体、大学、消费、城市、公共服务或关系语境，不默认医学科研。练习类型仅可为 cloze、translation_cn_to_en、translation_en_to_cn、collocation、derivation、recall、sentence。只返回符合 JSON schema 的 JSON。`;

export const SEMANTIC_GRADING_PROMPT = `按题目要求批改用户本次英文输出，宽容接受意思准确的自然表达。判断是否完成目标词义、搭配和语法要求。错误时指出用户答案中的具体片段并解释可执行的修改方向；第一次错误不要泄露完整参考答案。只返回符合 JSON schema 的 JSON。`;

export const ENGLISH_DEFINITION_GRADING_PROMPT = `判断用户给出的简短英文释义是否准确表达目标词的核心义；接受自然的同义表达，不要求复述词典原句。只返回符合 JSON schema 的 JSON。`;

export const WRAPUP_GENERATION_PROMPT = `生成一道考研英语一 / IELTS Academic 难度的长难句翻译与结构理解题。英文句子必须 25–40 个单词，包含明显主干，并自然使用提供的本轮 2–3 个目标词；避免冷僻专业术语。只返回符合 JSON schema 的 JSON。`;

export const WRAPUP_GRADING_PROMPT = `批改用户对英文长难句的中文翻译和结构分析，重点判断原意、句子主干、修饰关系、语法和中文自然度，不因措辞差异误判。错误时指出具体片段并给可执行修改方向；只有本轮已是第二次错误时才提供完整参考答案。只返回符合 JSON schema 的 JSON。`;
