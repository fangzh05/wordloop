# Wordloop V1 Test Report

Run date: 2026-09-13 (Asia/Shanghai)

## Required checks

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run build` | Passed |
| `npm test` | 18 passed, 1 Supabase integration test skipped because credentials were not available |
| Plugin manifest validator | Passed |
| MCP Inspector strict `tools/list` | Passed; 12 tools, no strict schema failure |
| MCP App metadata probe | Passed; 4 render tools resolved their UI resources |

The resolved UI resources use `text/html;profile=mcp-app`, `prefersBorder: true`, and modern nested `_meta.ui.resourceUri`; the compatibility key is added by the official helper.

## Covered behavior

- Duplicate/repeated imports are normalized case-insensitively while preserving first-seen order.
- Empty imports fail clearly.
- Malformed word entries fail validation.
- Newline, space, comma, English semicolon, Chinese comma, and Chinese semicolon paste delimiters are parsed.
- An incorrect attempt increments `wrong_count`, resets the global streak, activates its layer, and schedules +1 day.
- One correct repair leaves an error active; the second consecutive correct repair clears that layer.
- Mastery requires at least three correct attempts, two consecutive correct attempts, and no active error flag.
- Progress calculations separate mastered, learning, and error-book counts.
- GET `/` returns health status.
- POST `/mcp` initializes over Streamable HTTP and lists all data/render tools.
- The GPT Sites Worker serves `/health` and exposes all 12 tools over stateless Web Standard Streamable HTTP.
- The optional Supabase integration test verifies persistence across independent context reads and cleans up its temporary user when credentials and the migration are present.

## Visual QA

The accepted design reference is `docs/design/wordloop-concept.png` at 1536 × 1024. The implementation now uses an Apple-inspired material system: platform typography, translucent functional layers, immediate press feedback, restrained blue controls and green progress, desktop and mobile layouts, plus dark, reduced-motion, reduced-transparency, and increased-contrast modes.

An implementation screenshot could not be captured in this execution environment: the managed cloud browser blocks workspace localhost, and the permitted local Playwright fallback could not download Chromium because its CDN timed out. This is an explicit verification gap, not reported as a pass. Use the preview routes below on a machine with a browser:

```bash
ENABLE_WIDGET_PREVIEW=true npm run dev
```

- `http://127.0.0.1:3000/preview/import`
- `http://127.0.0.1:3000/preview/dashboard`
- `http://127.0.0.1:3000/preview/pronunciation`
- `http://127.0.0.1:3000/preview/dictation`
- Append `?theme=dark` for dark mode.
