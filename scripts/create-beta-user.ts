import "dotenv/config";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

// Credentials and passwords arrive through environment/stdin, never arguments or logs.
const input = z.object({ email: z.string().email(), password: z.string().min(8), owner: z.boolean().default(false), words: z.array(z.string().trim().min(1).max(100)).max(5000).default([]) }).strict();
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const account = input.parse(JSON.parse(raw));
const url = z.string().url().parse(process.env.SUPABASE_URL);
const key = z.string().min(20).parse(process.env.SUPABASE_SERVICE_ROLE_KEY);
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
const id = account.owner ? z.string().uuid().parse(process.env.DEV_USER_ID) : undefined;
const created = await db.auth.admin.createUser({ email: account.email, password: account.password, email_confirm: true, ...(id ? { id } : {}) });
if (created.error || !created.data.user) throw new Error("Account creation failed; no existing account was changed.");
const userId = created.data.user.id;
const profile = await db.from("users").upsert({ id: userId }, { onConflict: "id", ignoreDuplicates: true });
if (profile.error) {
  await db.auth.admin.deleteUser(userId);
  throw new Error("Account setup failed; access was not enabled.");
}
if (account.words.length) {
  const imported = await db.rpc("import_words_v1", { p_user_id: userId, p_words: account.words, p_date: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date()), p_source: "private_beta" });
  if (imported.error) throw new Error("Account created, but vocabulary import failed. Retry import separately.");
}
console.log("Beta account created. Existing progress was preserved.");
