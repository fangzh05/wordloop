import type { EvidenceQuality } from "../../shared/learningEvidence.js";

export const BKT_VERSION = "fixed-v1";
export const BKT_PARAMS = Object.freeze({ prior: 0.2, learn: 0.1, guess: 0.2, slip: 0.1 });
export interface BktParams { prior: number; learn: number; guess: number; slip: number; }
export function predictCorrect(mastery: number, params: BktParams = BKT_PARAMS): number {
  return mastery * (1 - params.slip) + (1 - mastery) * params.guess;
}
/** Binary observation, then one learning opportunity; no forgetting or FSRS writes. */
export function updateBkt(mastery: number, quality: EvidenceQuality, correct: boolean | null,
  params: BktParams = BKT_PARAMS): number {
  if (![mastery, ...Object.values(params)].every(x => Number.isFinite(x) && x >= 0 && x <= 1)) throw new Error("BKT_INVALID_PROBABILITY");
  if (quality === "IGNORE") return mastery;
  let posterior = mastery;
  if (quality === "OBSERVE") {
    if (correct === null) throw new Error("BKT_BINARY_OBSERVATION_REQUIRED");
    const mastered = mastery * (correct ? 1 - params.slip : params.slip);
    const unmastered = (1 - mastery) * (correct ? params.guess : 1 - params.guess);
    if (mastered + unmastered === 0) throw new Error("BKT_IMPOSSIBLE_OBSERVATION");
    posterior = mastered / (mastered + unmastered);
  }
  return posterior + (1 - posterior) * params.learn;
}

export function predictionMetrics(rows: readonly { prediction: number; correct: boolean }[]) {
  if (!rows.length) return { count: 0, brier: null, log_loss: null, calibration: [] };
  const bins = Array.from({ length: 5 }, (_, i) => ({ lower: i / 5, count: 0, predicted: 0, observed: 0 }));
  let brier = 0, loss = 0;
  for (const row of rows) {
    const p = Math.max(1e-9, Math.min(1 - 1e-9, row.prediction));
    const y = Number(row.correct);
    brier += (p - y) ** 2;
    loss -= y * Math.log(p) + (1 - y) * Math.log(1 - p);
    const bin = bins[Math.min(4, Math.floor(p * 5))]!;
    bin.count++; bin.predicted += p; bin.observed += y;
  }
  return { count: rows.length, brier: brier / rows.length, log_loss: loss / rows.length,
    calibration: bins.map(b => ({ ...b, predicted: b.count ? b.predicted / b.count : null, observed: b.count ? b.observed / b.count : null })) };
}
