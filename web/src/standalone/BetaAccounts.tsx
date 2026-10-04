import { useEffect, useState, type FormEvent } from "react";
import { accountInfo, createBetaAccount } from "./apiClient.js";
import { Button } from "../components/Button.js";

export function BetaAccounts() {
  const [owner, setOwner] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [words, setWords] = useState("");
  const [ownAccount, setOwnAccount] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => { let active = true; void accountInfo().then(info => { if (active) setOwner(info.is_owner); }).catch(() => {}); return () => { active = false; }; }, []);
  if (!owner) return null;
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setMessage("");
    try {
      const result = await createBetaAccount({ email: email.trim(), password, owner: ownAccount, words: words.split(/[\s,，;；]+/).filter(Boolean) });
      setPassword(""); setEmail(""); setWords("");
      setMessage(result.vocabulary_imported ? "账号已创建。请私下把登录邮箱和密码交给使用者。" : "账号已创建，但词汇导入失败，请在划词页面添加词汇。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "账号创建失败，请重试。"); }
    finally { setBusy(false); }
  }
  return <div className="settings-section"><h3>内测</h3><p>每个账号拥有独立的词库和学习记录。</p><form className="auth-form" onSubmit={submit}>
    <label>账号邮箱<input type="email" autoComplete="off" required value={email} onChange={e => setEmail(e.target.value)} /></label>
    <label>初始密码<input type="password" autoComplete="new-password" minLength={8} required value={password} onChange={e => setPassword(e.target.value)} /></label>
    <label>初始词汇（可选，用空格或逗号分隔）<textarea value={words} onChange={e => setWords(e.target.value)} rows={3} /></label>
    <label><span><input type="checkbox" checked={ownAccount} onChange={e => setOwnAccount(e.target.checked)} />这是我的账号，保留现有学习记录</span></label>
    <Button type="submit" disabled={busy}>{busy ? "正在创建…" : "创建内测账号"}</Button>
    {message && <p role="status" className="standalone-status">{message}</p>}
  </form></div>;
}
