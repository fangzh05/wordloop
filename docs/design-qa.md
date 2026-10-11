# Exam books design QA

Product Design 0.1.56. Final result: **blocked for full product acceptance**.

Local incremental visual checks passed; authenticated production capture, real statistics, full learning interaction and iPhone/iPad Safari are unavailable/unverified. No production-ready claim is made.

Source: current TodayPage/VocabularyPage rendered before edits. Implementation: same local fixture after edits. Same desktop viewport and dark theme in `.qa/exam-books/today-comparison.png` and `vocabulary-comparison.png`; both sources and implementation viewed in combined inputs. Main CTA remains unchanged. Compact added rows follow existing tokens and do not replace page headings or toolbar. No new image/icon assets or UI framework.

Source state limitation: overview deliberately unavailable in both captures. Vocabulary before shows missing-auth error; after fixture auth returns an empty list. Compare heading/import/toolbar geometry and style only, not the differing list contents. No screenshot is an authenticated production capture.

Additional screenshots: 390×844 dark/light selector, scrolled-to-save mobile state, 820×1180 light selector, desktop selection. Browser exercised CET-6 selection and confirmed updated Today/Vocabulary labels; close returned focus to trigger. Disabled kaoyan row shows authorization/data reason. Native dialog and label controls retain keyboard semantics. Document scroll width did not exceed client width at checked responsive sizes.

The new selector has no independent preexisting visual target; it follows the existing settings sheet and user's compact-row specification. No visual mismatch correction loop was needed in the scoped comparisons. These checks cannot establish VoiceOver, Safari toolbar/safe-area behavior, live account persistence or complete accessibility compliance.

Remaining acceptance: authenticated before/after product capture; complete Today and Vocabulary real-data flow; iPhone/iPad Safari touch, safe-area, keyboard and VoiceOver checks; production multi-user privacy validation. Refer to builtin-exam-books-2026-10-11.md for full release limits.
