import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

type SchemaCheck = {
  table: string;
  column: string;
  migration: string;
};

const checks: SchemaCheck[] = [
  { table: "users", column: "daily_new_word_limit", migration: "202609130002" },
  { table: "user_words", column: "fsrs_state", migration: "202609130002" },
  { table: "study_sessions", column: "state", migration: "202609150004" },
  { table: "study_sessions", column: "updated_at", migration: "202609150004" },
  { table: "word_sources", column: "user_id", migration: "202609130002" },
  { table: "fsrs_review_logs", column: "user_id", migration: "202609130002" },
];

function isSchemaMismatch(message: string): boolean {
  return /could not find .*column|schema cache|column .* does not exist|relation .* does not exist|does not exist/i.test(message);
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    console.error("WordLoop database schema check requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
    process.exitCode = 1;
    return;
  }

  const db = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const results = await Promise.all(checks.map(async (check) => {
    const { error } = await db.from(check.table).select(check.column).limit(0);
    return { check, error };
  }));
  const failures = results.filter((result) => result.error);
  if (failures.length === 0) {
    console.log("WordLoop database schema OK");
    return;
  }

  for (const failure of failures) {
    const message = failure.error?.message ?? "unknown database error";
    if (isSchemaMismatch(message)) {
      console.error(`Missing ${failure.check.table}.${failure.check.column}; deploy migration ${failure.check.migration}.`);
    } else {
      console.error(`Could not verify ${failure.check.table}.${failure.check.column}: ${message}`);
    }
  }
  process.exitCode = 1;
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "WordLoop database schema check failed.");
  process.exitCode = 1;
});
