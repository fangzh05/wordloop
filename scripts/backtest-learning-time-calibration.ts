import { readFileSync } from "node:fs";
import { z } from "zod";
import { backtestLearningTimeCosts } from "../shared/learningTimeBacktest.js";

const observationSchema = z.object({
  learnerKey: z.string().min(1).max(128),
  date: z.string(),
  observedAt: z.string().datetime({ offset: true }),
  activityType: z.string().min(1).max(80),
  scope: z.string().min(1).max(40),
  stage: z.enum(["answer", "feedback", "explanation"]),
  activeMs: z.number().int().nullable(),
  dailyBudgetSeconds: z.number().nonnegative().nullable().optional(),
  completeDay: z.boolean().optional(),
}).strict();

const inputPath = process.argv[2];
if (!inputPath) {
  console.error("Usage: npm run backtest:learning-time -- <private-json-export>");
  process.exitCode = 2;
} else {
  try {
    const parsed = z.array(observationSchema).max(2_000_000).parse(JSON.parse(readFileSync(inputPath, "utf8")));
    // The report contains aggregate metrics only; pseudonymous keys and row values are never printed.
    const report = backtestLearningTimeCosts(parsed);
    console.log(JSON.stringify(report, null, 2));
    if (report.validRows === 0) process.exitCode = 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Invalid time-calibration export");
    process.exitCode = 2;
  }
}
