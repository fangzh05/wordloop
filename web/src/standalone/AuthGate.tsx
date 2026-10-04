import { useEffect, useState, type FormEvent } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import StandaloneApp from "./StandaloneApp.js";
import { getAuthClient } from "./authClient.js";
import { clearReadModelCache, clearToken, saveToken } from "./apiClient.js";
import { Button } from "../components/Button.js";

export function AuthGate() {
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [legacy, setLegacy] = useState(() => { try { const token = localStorage.getItem("wordloop_web_token"); return token && token.split(".").length !== 3 ? token : null; } catch { return null; } });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  useEffect(() => {
    try { const theme = localStorage.getItem("wordloop_appearance"); document.documentElement.dataset.theme = theme === "dark" || theme === "light" ? theme : "system"; } catch {}
    let active = true;
    let unsubscribe: (() => void) | undefined;
    const expired = () => { void getAuthClient().then(auth => auth.auth.signOut({ scope: "local" })); };
    const changed = () => { clearReadModelCache(); try { sessionStorage.removeItem("wordloop_draft"); } catch {} };
    void getAuthClient().then(async auth => {
      if (!active) return;
      setClient(auth);
      const subscription = auth.auth.onAuthStateChange((event, next) => {
        if (!active) return;
        if (next) { saveToken(next.access_token); setLegacy(null); if (event === "SIGNED_IN") changed(); } else if (event === "SIGNED_OUT") { setLegacy(null); clearToken(); changed(); }
        setSession(next);
      }).data.subscription;
      unsubscribe = () => subscription.unsubscribe();
      const restored = await auth.auth.getSession();
      if (restored.error) throw restored.error;
      if (active) { if (restored.data.session) saveToken(restored.data.session.access_token); else if (!legacy) clearToken(); setSession(restored.data.session); setLoading(false); }
    }).catch(() => { if (active) { setError("登录服务暂时不可用，请刷新后重试。"); setLoading(false); } });
    window.addEventListener("wordloop-session-expired", expired);
    return () => { active = false; unsubscribe?.(); window.removeEventListener("wordloop-session-expired", expired); };
  }, []);
  const path = window.location.pathname;
  if (loading) return <main className="standalone-shell auth-shell"><section className="widget-card standalone-card" role="status">正在连接 WordLoop…</section></main>;
  if (path === "/owner") return <StandaloneApp />;
  if (legacy && !session && path === "/") { saveToken(legacy); return <StandaloneApp />; }
  if (!session || path === "/reset-password" || path === "/update-password") return <AuthPage client={client} session={session} initialError={error} />;
  return <StandaloneApp key={session.user.id} />;
}

function AuthPage({ client, session, initialError }: { client: SupabaseClient | null; session: Session | null; initialError: string }) {
  const path = window.location.pathname;
  const reset = path === "/reset-password";
  const update = path === "/update-password";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  const [message, setMessage] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!client || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      if (reset) {
        const result = await client.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/update-password` });
        if (result.error) throw new Error("暂时无法发送邮件，请稍后重试。");
        setMessage("如果该邮箱有 WordLoop 账号，密码设置邮件已发送，请查收。");
      } else if (update) {
        if (!session) throw new Error("设置链接无效或已过期，请重新发送邮件。");
        if (password.length < 8) throw new Error("密码至少需要 8 个字符。");
        if (password !== confirm) throw new Error("两次输入的密码不一致。");
        const result = await client.auth.updateUser({ password });
        if (result.error) throw new Error("密码保存失败，请重新打开邮件链接后重试。");
        window.location.assign("/");
      } else {
        const result = await client.auth.signInWithPassword({ email: email.trim(), password });
        if (result.error) throw new Error("登录失败，请检查邮箱和密码。");
        if (result.data.session) saveToken(result.data.session.access_token);
        window.location.assign("/");
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "连接失败，请稍后重试。"); }
    finally { setBusy(false); }
  }
  return <main className="standalone-shell wordloop-shell auth-shell"><section className="widget-card standalone-card auth-card" aria-labelledby="auth-title">
    <div className="standalone-brand"><span className="standalone-mark">W</span>WordLoop</div>
    <header className="widget-header"><span className="eyebrow">内测</span><h1 id="auth-title">{reset ? "设置密码" : update ? "创建登录密码" : "登录"}</h1><p>{reset ? "输入邀请账号使用的邮箱，获取密码设置链接。" : update ? "设置密码后，即可继续学习。" : "使用受邀账号，继续你的每日学习。"}</p></header>
    <form className="auth-form" onSubmit={submit}>
      {!update && <label>邮箱<input className="answer-input standalone-input" type="email" autoComplete="username" autoCapitalize="none" value={email} onChange={e => setEmail(e.target.value)} required /></label>}
      {!reset && <label>{update ? "新密码" : "密码"}<input className="answer-input standalone-input" type="password" autoComplete={update ? "new-password" : "current-password"} minLength={update ? 8 : undefined} value={password} onChange={e => setPassword(e.target.value)} required /></label>}
      {update && <label>再次输入新密码<input className="answer-input standalone-input" type="password" autoComplete="new-password" minLength={8} value={confirm} onChange={e => setConfirm(e.target.value)} required /></label>}
      {error && <p className="standalone-status error" role="alert">{error}</p>}{message && <p className="standalone-status" role="status">{message}</p>}
      <Button type="submit" disabled={busy || !client || (update && !session)}>{busy ? "正在处理…" : reset ? "发送密码设置邮件" : update ? "保存密码" : "登录"}</Button>
    </form>
    <a className="auth-link" href={reset || update ? "/login" : "/reset-password"}>{reset || update ? "返回登录" : "首次设置密码 / 忘记密码"}</a>
    {!reset && !update && <p className="auth-helper">仅限受邀内测，账号由管理员创建。</p>}
  </section></main>;
}
