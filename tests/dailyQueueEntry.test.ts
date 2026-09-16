import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DbClient } from "../server/services/words.js";

const wordService = vi.hoisted(() => ({
  getUserTimeZone: vi.fn(),
  prepareDailyNewWords: vi.fn(),
}));

vi.mock("../server/services/words.js", () => wordService);

import { ensureDailyQueueForDate, ensureTodayQueue } from "../server/services/dailyQueue.js";

const db = {} as DbClient;
const userId = "00000000-0000-0000-0000-000000000001";

describe("daily queue entry guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wordService.getUserTimeZone.mockResolvedValue("Asia/Shanghai");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards a known date to the idempotent prepare RPC", async () => {
    wordService.prepareDailyNewWords.mockResolvedValue({
      date: "2026-09-16", prepared: 50, added: 0, limit: 50,
    });

    await expect(ensureDailyQueueForDate("2026-09-16", db, userId)).resolves.toEqual({
      date: "2026-09-16", prepared: 50, added: 0,
    });
    expect(wordService.getUserTimeZone).not.toHaveBeenCalled();
    expect(wordService.prepareDailyNewWords).toHaveBeenCalledOnce();
    expect(wordService.prepareDailyNewWords).toHaveBeenCalledWith(db, userId, "2026-09-16");
  });

  it("resolves the local date once before preparing today's queue", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T00:30:00.000Z"));
    wordService.getUserTimeZone.mockResolvedValue("America/Los_Angeles");
    wordService.prepareDailyNewWords.mockResolvedValue({
      date: "2026-09-15", prepared: 50, added: 50, limit: 50,
    });

    await expect(ensureTodayQueue(db, userId)).resolves.toEqual({
      date: "2026-09-15", prepared: 50, added: 50,
    });
    expect(wordService.getUserTimeZone).toHaveBeenCalledOnce();
    expect(wordService.prepareDailyNewWords).toHaveBeenCalledWith(db, userId, "2026-09-15");
  });

  it.each([
    { label: "complete queue", prepared: 50, added: 0 },
    { label: "raised limit", prepared: 50, added: 30 },
    { label: "lowered limit preserves existing words", prepared: 50, added: 0 },
  ])("preserves prepare results for a $label", async ({ prepared, added }) => {
    wordService.prepareDailyNewWords.mockResolvedValue({
      date: "2026-09-16", prepared, added, limit: 50,
    });

    await expect(ensureDailyQueueForDate("2026-09-16", db, userId)).resolves.toMatchObject({
      date: "2026-09-16", prepared, added,
    });
  });
});
