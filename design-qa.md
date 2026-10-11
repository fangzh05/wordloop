# Study UI design QA

Source: user photos 1–4, especially photo 3's open vocabulary layout; later explicit requests require a borderless translation screen and only Continue on review feedback.
Evidence: docs/study-ui-qa/comparison.png, consolidation-mobile.png, consolidation-desktop.png, review-mobile.png, audio-mobile.png.
Viewport: mobile 390x844 CSS pixels, desktop 1440x1000. User source 590x1280 includes iOS chrome; comparison scales source proportionally and omits fabricated device chrome. Implementation captures full-page content at browser density.

Findings resolved:
- Removed legacy enclosing card and oversized title from translation entry; retained the product's typography and navy palette.
- Removed prompt, answer and action-region borders per user correction. Input focus remains visible for keyboard accessibility.
- Review feedback uses the same component as Lesson feedback, with only Continue and no retry. Incorrect verdict says the review result was recorded.
- Audio control measured 43.99x43.99 CSS px, border radius 50%; translation submit measured radius 8px.

Fidelity: checked font hierarchy, line wrapping, layout rhythm, original color tokens, supplied icon reuse, and copy. No raster assets needed. Full view comparison is saved; focused border/radius measurements confirm the specific controls. Design intentionally changes photo 2's card framing and preserves photo 3's open reading style.

Interactions checked in in-app browser: empty translation disables submission; typing enables it; submitting fixture opens feedback. Review feedback exposes only Back and Continue. Console error checks returned none. Server tests confirm completed rounds resolve a new pretest and return budget_paused only when server bootstrap says budget_complete.

Limits: browser uses source components with fixtures; no authenticated live account writes or physical iPhone Safari acceptance performed. Review feedback is a client presentation of the server's submitted result; refresh resumes the server cursor.

Validation: typecheck and Cloudflare Worker build passed. Full suite: 861 passed, 2 skipped; added review presentation checks: 2 passed. Updated server continuation tests passed.

final result: passed
