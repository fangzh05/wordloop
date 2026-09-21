import { describe, expect, it } from "vitest";
import { buildMerriamWebsterAudioUrl } from "../server/tools/getPronunciationAudio.js";

describe("Merriam-Webster pronunciation audio URL", () => {
  it("uses the documented standard directory rule", () => {
    expect(buildMerriamWebsterAudioUrl("vibrate01")).toBe(
      "https://media.merriam-webster.com/audio/prons/en/us/mp3/v/vibrate01.mp3",
    );
  });

  it("handles documented special directories", () => {
    expect(buildMerriamWebsterAudioUrl("bixfoo")).toContain("/bix/bixfoo.mp3");
    expect(buildMerriamWebsterAudioUrl("ggbar")).toContain("/gg/ggbar.mp3");
    expect(buildMerriamWebsterAudioUrl("3d000001")).toContain("/number/3d000001.mp3");
  });
});
