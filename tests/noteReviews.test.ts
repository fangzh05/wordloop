import { createEmptyCard } from "ts-fsrs";
import { describe, expect, it } from "vitest";
import {
  cardFromNoteReviewJson,
  cardToNoteReviewJson,
  scheduleNoteReviewCard,
} from "../server/services/noteReviews.js";
import {
  noteReviewEnabledRequestSchema,
  noteReviewRatingRequestSchema,
} from "../shared/noteReviewContracts.js";

const now = new Date("2026-10-02T00:00:00.000Z");

describe("independent Capture note review", () => {
  it("round-trips the direct ts-fsrs Card adapter without learning-table fields", () => {
    const card = createEmptyCard(now);
    const json = cardToNoteReviewJson(card);
    expect(cardFromNoteReviewJson(json)).toEqual(card);
    expect(json).toMatchObject({ due: now.toISOString(), reps: 0, lapses: 0 });
    expect(json).not.toHaveProperty("word_id");
    expect(json).not.toHaveProperty("user_word_id");
  });

  it("schedules Again and Good through the existing FSRS scheduler", () => {
    const card = createEmptyCard(now);
    const again = scheduleNoteReviewCard(card, "again", now, false);
    const good = scheduleNoteReviewCard(card, "good", now, false);
    expect(again.card.reps).toBe(1);
    expect(good.card.reps).toBe(1);
    expect(again.log.rating).not.toBe(good.log.rating);
    expect(again.card.last_review?.toISOString()).toBe(now.toISOString());
    expect(good.card.last_review?.toISOString()).toBe(now.toISOString());
  });

  it("keeps web contracts strict and server-owned", () => {
    expect(noteReviewEnabledRequestSchema.safeParse({ enabled: true }).success).toBe(true);
    expect(noteReviewEnabledRequestSchema.safeParse({ enabled: true, user_id: "attacker" }).success).toBe(false);
    expect(noteReviewRatingRequestSchema.safeParse({
      rating: "good",
      expected_revision: 0,
      expected_note_updated_at: now.toISOString(),
      idempotency_key: "00000000-0000-4000-8000-000000000003",
    }).success).toBe(true);
    expect(noteReviewRatingRequestSchema.safeParse({
      rating: "good",
      expected_revision: 0,
      expected_note_updated_at: now.toISOString(),
      idempotency_key: "00000000-0000-4000-8000-000000000003",
      note: "answer in request",
    }).success).toBe(false);
  });
});
