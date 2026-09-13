import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  DEV_USER_ID: z.string().uuid(),
});

let client: SupabaseClient | undefined;
let runtimeEnv: Record<string, unknown> | undefined;

function activeEnv(): Record<string, unknown> {
  if (runtimeEnv) return runtimeEnv;
  if (typeof process !== "undefined") return process.env;
  return {};
}

export function configureRuntimeEnv(env: Record<string, unknown>): void {
  const changed = runtimeEnv?.SUPABASE_URL !== env.SUPABASE_URL
    || runtimeEnv?.SUPABASE_SERVICE_ROLE_KEY !== env.SUPABASE_SERVICE_ROLE_KEY;
  runtimeEnv = env;
  if (changed) client = undefined;
}

export function getDatabase(): SupabaseClient {
  if (client) return client;
  const env = envSchema.safeParse(activeEnv());
  if (!env.success) {
    throw new Error("Wordloop server is missing valid Supabase configuration.");
  }
  client = createClient(env.data.SUPABASE_URL, env.data.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

export function getAuthenticatedUserId(): string {
  const parsed = z.string().uuid().safeParse(activeEnv().DEV_USER_ID);
  if (!parsed.success) throw new Error("DEV_USER_ID must be a valid UUID.");
  return parsed.data;
}

export function resetDatabaseForTests(): void {
  client = undefined;
  runtimeEnv = undefined;
}
