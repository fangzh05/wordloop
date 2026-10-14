import { getAuthenticatedUserId, getDatabase, getSupabaseAuthClient, getWordloopWebToken, isLegacyOwner, isStagingDiagnosticsEnabled, shouldExposeStagingDiagnostics, withUserIdentity } from "./db.js";

export class WebAuthError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export async function authenticateWebUser(request: Request): Promise<string> {
  const token = /^Bearer ([^\s]+)$/i.exec(request.headers.get("authorization")?.trim() ?? "")?.[1];
  if (!token) throw new WebAuthError(401, "UNAUTHORIZED", "请先登录。");
  const legacy = getWordloopWebToken();
  // Retain the owner's existing integration credential, never share it with testers.
  if (legacy && token === legacy) return getAuthenticatedUserId();
  if (token.split(".").length !== 3) throw new WebAuthError(401, "UNAUTHORIZED", "请先登录。");
  const { data, error } = await getSupabaseAuthClient().auth.getUser(token);
  if (error || !data.user || data.user.is_anonymous) throw new WebAuthError(401, "UNAUTHORIZED", "登录已过期，请重新登录。");
  const origin = new URL(request.url).origin;
  const profile = await withUserIdentity(data.user.id, () => getDatabase().from("users").select("id").eq("id", data.user!.id).maybeSingle(), origin);
  if (profile.error) {
    const profileMessage = String(profile.error.message ?? "unknown error").slice(0, 240);
    console.error("WordLoop auth profile lookup failed", { code: profile.error.code ?? null, message: profileMessage });
    const rawCode = profile.error.code;
    const databaseCode = typeof rawCode === "string" && /^[A-Z0-9_]{1,32}$/.test(rawCode) ? rawCode : undefined;
    const safeCause = /permission denied for schema auth/i.test(profileMessage)
      ? "auth_schema_usage"
      : /permission denied for table users/i.test(profileMessage)
        ? "users_table_grant"
        : /permission denied for function/i.test(profileMessage)
          ? "function_execute"
          : "database_permission";
    const diagnostic = shouldExposeStagingDiagnostics(data.user.id)
      ? " [staging诊断: " + (databaseCode ?? "unknown") + "/" + safeCause + "]"
      : "";
    throw new WebAuthError(503, "AUTH_UNAVAILABLE", "暂时无法验证账号，请稍后重试。" + diagnostic);
  }
  if (!profile.data) {
    if (isLegacyOwner(data.user.id)) {
      const bound = await withUserIdentity(data.user.id, () => getDatabase().from("users").upsert(
        { id: data.user!.id }, { onConflict: "id", ignoreDuplicates: true },
      ), origin);
      if (bound.error) {
        const rawCode = bound.error.code;
        const databaseCode = typeof rawCode === "string" && /^[A-Z0-9_]{1,32}$/.test(rawCode) ? rawCode : undefined;
        console.error("WordLoop owner profile binding failed", { ...(databaseCode ? { database_code: databaseCode } : {}) });
        throw new WebAuthError(503, "AUTH_UNAVAILABLE", "暂时无法验证账号，请稍后重试。");
      }
      return data.user.id;
    }
    if (isStagingDiagnosticsEnabled()) {
      const scopedSubject = await withUserIdentity(data.user.id, () => getDatabase().rpc("wordloop_authenticated_user_id"), origin);
      console.warn("WordLoop staging auth profile missing", {
        configured_owner: isLegacyOwner(data.user.id),
        neon_subject_matches: !scopedSubject.error && scopedSubject.data === data.user.id,
        neon_subject_error: scopedSubject.error?.code ?? null,
      });
    }
    throw new WebAuthError(403, "INVITE_REQUIRED", "此账号尚未获得 WordLoop 内测邀请。");
  }
  return data.user.id;
}
