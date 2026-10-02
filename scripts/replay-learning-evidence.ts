import "dotenv/config";
import { getDatabase, getAuthenticatedUserId } from "../server/db.js";
import { consumeSkillEvidence } from "../server/services/learningModel.js";
import { assertDatabaseResult } from "../server/services/shared.js";

const db = getDatabase();
const userId = getAuthenticatedUserId();
const mode = await db.from("learning_settings").select("bkt_mode").eq("user_id", userId).maybeSingle();
assertDatabaseResult(mode.error);
if (mode.data?.bkt_mode === "off") throw new Error("BKT projection is disabled for this learner.");
let batches = 0;
for (; batches < 100; batches++) {
  const pending = await db.rpc("pending_skill_evidence_v1", { p_user_id: userId });
  assertDatabaseResult(pending.error);
  if (!pending.data?.length) break;
  await consumeSkillEvidence(db, userId);
}
const remaining = await db.rpc("pending_skill_evidence_v1", { p_user_id: userId });
assertDatabaseResult(remaining.error);
console.log(JSON.stringify({ batches, pending: Boolean(remaining.data?.length), fsrs_changed: false }));
if (remaining.data?.length) process.exitCode = 2;
