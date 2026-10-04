import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | undefined;
let pending: Promise<SupabaseClient> | undefined;
export async function getAuthClient(): Promise<SupabaseClient> {
  if (client) return client;
  if (pending) return pending;
  pending = initialize().catch(error => { pending = undefined; throw error; });
  return pending;
}

async function initialize(): Promise<SupabaseClient> {
  const response = await fetch("/api/web/auth/config", { cache: "no-store" });
  if (!response.ok) throw new Error("登录服务暂时不可用，请稍后重试。");
  const { url, key } = await response.json() as { url: string; key: string };
  client = createClient(url, key, { auth: { storageKey: "wordloop_auth", persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  return client;
}

export async function currentAccessToken(): Promise<string | null> {
  if (!client) return null;
  const { data, error } = await client.auth.getSession();
  if (error) throw new Error("无法刷新登录状态，请重新登录。");
  return data.session?.access_token ?? null;
}
