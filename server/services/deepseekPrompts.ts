export const LESSON_GENERATION_PROMPT = `为考研英语一 80+ 与 IELTS 7.5 生成一张英语单词 Lesson 卡。输入包含 server-owned lesson_profile 和 error_focus；严格执行它们，不要自行判定或更改 profile。围绕用户提供的词和已保存中文义，给一个核心义、最高价值搭配、2–3 个常见派生、一条熟词僻义或易混提醒、自然例句和恰好一道主要练习。除英语词条、example_en 和 exercise.prompt 外，讲解、说明和指导尽量使用简体中文。part_of_speech 尽量使用“adj.（形容词）”这样的中英标注；collocations 和 derivations 尽量保留英文并附简洁中文释义；为英文例句提供准确自然的中文译文 example_zh。例句建议 15–25 个英文单词。例句负责理解，exercise 负责提取；练习必须换一个自然语境，不可照抄或仅把例句改成填空。

练习必须短、单一、可快速完成。activity_type 只可使用 exact_cloze、translation_cn_to_en，或在 targeted_relearn 且 error_focus=collocation 时使用 collocation。不得生成 sentence 或 semantic_expression。quick_recall 只能使用 exact_cloze：题目约 8–18 个简单英文词，目标是在 10–20 秒内根据清楚的语义/搭配线索主动回忆并拼出目标词；不要靠复杂语法、额外生词或重复例句制造难度。prompt 必须有且只有一个 ___，目标词不能在空格外出现，accepted_answers 必须非空，multiline 必须为 false。reinforce 优先使用 exact_cloze；只有短填空不合适时才用简短 CN→EN，仍只出一道题。targeted_relearn 只训练指定 error_focus：spelling 要求精确目标词形；meaning 用能区分目标词义的新语境；collocation 练目标搭配或极短的搭配翻译；grammar 可用很短的 CN→EN 检查词性、介词或句法位置；pronunciation 依靠本卡的 IPA/音频并配一道简单 exact_cloze，不要要求造句。error_focus 为空时优先 exact_cloze。

所有 exact_cloze 的 prompt 必须包含 ___，目标词不得出现在空格之外，accepted_answers 必须非空。普通 profile 不得生成开放写作、自由造句、复述例句或第二道题。开放题只允许 targeted_relearn 的 collocation/grammar 弱点使用非常短的输出，且优先短翻译或搭配题。

只返回一个符合以下目标 JSON shape 的 JSON 对象，不要 Markdown：
{
  "ipa": "...",
  "part_of_speech": "...",
  "meaning_zh": "...",
  "collocations": ["..."],
  "derivations": ["..."],
  "example_en": "...",
  "example_zh": "...",
  "note": "...",
  "exercise": {
    "activity_type": "exact_cloze",
    "instruction": "...",
    "prompt": "... ___ ...",
    "accepted_answers": ["..."],
    "multiline": false
  }
}`;

export const SEMANTIC_GRADING_PROMPT = `按题目要求批改用户本次英文输出，宽容接受意思准确的自然表达。判断是否完成目标词义、搭配和语法要求。message 和 explanation 必须使用简体中文；可引用用户答案中的英文错误片段。错误时指出具体片段并解释可执行的修改方向；第一次错误不要泄露完整参考答案。只返回一个符合以下目标 JSON shape 的 JSON 对象，不要 Markdown：
{
  "is_correct": false,
  "error_layer": "meaning",
  "message": "...",
  "explanation": "...",
  "reference_answer": "..."
}`;

export const ENGLISH_DEFINITION_GRADING_PROMPT = `判断用户给出的简短英文释义是否准确表达目标词的核心义；接受自然的同义表达，不要求复述词典原句。feedback 必须使用简体中文，可引用必要的英文词句。只返回一个符合以下目标 JSON shape 的 JSON 对象，不要 Markdown：
{
  "is_correct": true,
  "feedback": "..."
}`;

export const WRAPUP_GENERATION_PROMPT = `生成一道考研英语一 / IELTS Academic 难度的长难句翻译与结构理解题。英文句子必须 25–40 个单词，包含明显主干，并自然使用提供的本轮 2–3 个目标词；避免冷僻专业术语。instruction 必须使用简体中文。只返回一个符合以下目标 JSON shape 的 JSON 对象，不要 Markdown：
{
  "activity_type": "sentence",
  "instruction": "...",
  "prompt": "...",
  "multiline": true
}`;

export const WRAPUP_GRADING_PROMPT = `批改用户对英文长难句的中文翻译和结构分析，重点判断原意、句子主干、修饰关系、语法和中文自然度，不因措辞差异误判。message、explanation 和参考译文都必须使用简体中文；错误时指出具体片段并给可执行修改方向；只有本轮已是第二次错误时才提供完整参考答案。只返回一个符合以下目标 JSON shape 的 JSON 对象，不要 Markdown：
{
  "is_correct": false,
  "error_layer": "grammar",
  "message": "...",
  "explanation": "...",
  "reference_answer": "..."
}`;
