import { getAuthenticatedUserId, getDatabase, getWordloopWebToken } from "./db.js";

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
  const db = getDatabase();
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user || data.user.is_anonymous) throw new WebAuthError(401, "UNAUTHORIZED", "登录已过期，请重新登录。");
  const profile = await db.from("users").select("id").eq("id", data.user.id).maybeSingle();
  if (profile.error) throw new WebAuthError(503, "AUTH_UNAVAILABLE", "暂时无法验证账号，请稍后重试。");
  if (!profile.data) throw new WebAuthError(403, "INVITE_REQUIRED", "此账号尚未获得 WordLoop 内测邀请。");
  return data.user.id;
}
