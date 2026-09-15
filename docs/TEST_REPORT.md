# Wordloop V1 Test Report

Run date: 2026-09-15 (Asia/Shanghai)

## Required checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `npm test` | Passed; 79 tests passed, 2 Supabase integration tests skipped because credentials were not available |
| Plugin manifest validator | Passed |
| MCP Inspector strict `tools/list` | Passed; 25 tools, no strict schema failure |
| MCP App metadata probe | Passed; seven render tools resolved their UI resources |

The resolved UI resources use `text/html;profile=mcp-app`, `prefersBorder: true`, and modern nested `_meta.ui.resourceUri`; the compatibility key is added by the official helper.

## Covered behavior

- Duplicate/repeated imports are normalized case-insensitively while preserving first-seen order.
- Empty imports fail clearly.
- Malformed word entries fail validation.
- Newline, space, comma, English semicolon, Chinese comma, and Chinese semicolon paste delimiters are parsed.
- An incorrect exercise increments `wrong_count`, resets the global streak, and activates its layer without changing any FSRS field or review timestamp.
- One correct repair leaves an error active; the second consecutive correct repair clears that layer.
- Mastery requires at least three correct attempts, two consecutive correct attempts, and no active error flag.
- FSRS v6 covers all four New-card ratings, deterministic due advancement, lapse handling, and DB ↔ Card conversion.
- Due mastered cards remain eligible, future cards stay out of the queue, and no random filler is added.
- Review payloads are server-owned, carry `review_kind`, preserve persisted meaning/part of speech, and force the deterministic `cn_to_en` direction.
- The daily learning queue returns the first unfinished word after the current position and reports `round_complete` at the end without selecting a replacement.
- Lesson exercise, submission, and next-word handoffs use direct widget messages and `get_next_learning_word`; they do not depend on model-context persistence.
- Resumable study sessions persist the exact pretest, lesson, or dictation Widget payload before rendering; fixed phase transitions and retry state are backend-owned, while review remains a live FSRS/error queue without a session snapshot.
- Lesson explain payloads include the complete exercise, feedback carries the original exercise, and reload/resume/retry tests preserve the exact card without a GPT turn.
- `get_active_study_session`, `advance_study_session`, and `finish_study_session` expose only the durable cursor and fixed transitions; arbitrary session JSON is rejected.
- Shanbay fixture tests cover current-book parsing, all three states, structured IPA/senses, safe 401/invalid-payload errors, and multi-state/multi-book deduplication.
- Progress calculations separate mastered, learning, and error-book counts.
- GET `/` returns health status.
- POST `/mcp` initializes over local Streamable HTTP and lists all data/render tools; the deployed GPT Site uses `/api/mcp` because `/mcp` is reserved by the Sites gateway.
- The GPT Sites Worker serves `/health` and exposes all 25 tools over stateless Web Standard Streamable HTTP.
- The optional Supabase integration tests verify session persistence across independent context reads and clean up their temporary user when credentials and the migration are present; they are skipped locally without Supabase credentials.

## Visual QA

The accepted design reference is `docs/design/wordloop-concept.png` at 1536 × 1024. The implementation now uses an Apple-inspired material system: platform typography, translucent functional layers, immediate press feedback, restrained blue controls and green progress, desktop and mobile layouts, plus dark, reduced-motion, reduced-transparency, and increased-contrast modes.

The supervised Sites preview was opened in the cloud browser. The Shanbay import view loaded the current-book card, materialbook ID field, full-import/preview/refresh actions, and the complete unlearned/learning/learned/unique counts after Preview. The Dashboard rendered Due now, Tomorrow, and Next 7 days. A full-page screenshot timed out, so the verification used the rendered accessibility DOM and interactive controls.

```bash
ENABLE_WIDGET_PREVIEW=true npm run dev
```

- `http://127.0.0.1:3000/preview/import`
- `http://127.0.0.1:3000/preview/pretest`
- `http://127.0.0.1:3000/preview/dashboard`
- `http://127.0.0.1:3000/preview/pronunciation`
- `http://127.0.0.1:3000/preview/dictation`
- `http://127.0.0.1:3000/preview/review`
- `http://127.0.0.1:3000/preview/lesson`
- Append `?theme=dark` for dark mode.


- Lesson Widget：explain、exercise、feedback 三种模式共用同一张卡片，正式练习提交留在 Widget 内。
