import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { dedupeShanbayWords, mapShanbayWord } from "../server/integrations/shanbay/mapper.js";

const sql = readFileSync(new URL("../supabase/migrations/202609130002_fsrs_shanbay.sql", import.meta.url), "utf8");

describe("idempotent Shanbay import", () => {
  it("keeps one vocabulary/card for duplicates from multiple books", () => {
    const words = [
      mapShanbayWord({ vocabulary: { word: "plausible" } }, "learning", 0),
      mapShanbayWord({ vocabulary: { word: "Plausible" } }, "simple_learned", 10),
    ];
    expect(dedupeShanbayWords(words)).toHaveLength(1);
  });
  it("only inserts missing user_words and upserts source relationships", () => {
    const body = sql.slice(sql.indexOf("import_vocabulary_batch_v1"), sql.indexOf("prepare_daily_new_words_v1"));
    expect(body).toContain("on conflict(user_id,word_id) do nothing");
    expect(body).toContain("on conflict(user_id,word_id,source_type,source_book_id) do update");
    expect(body).not.toMatch(/fsrs_(stability|difficulty|state|reps|lapses)\s*=/);
  });
});
