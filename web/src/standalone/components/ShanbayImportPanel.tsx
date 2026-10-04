import { useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button.js";
import { clearReadModelCache, shanbayImport, type ShanbayImportJob } from "../apiClient.js";

export function ShanbayImportPanel({ onImported }: { onImported: () => void }): React.JSX.Element {
  const [job, setJob] = useState<ShanbayImportJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  const running = useRef(false);
  const stopRequested = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const update = (value: ShanbayImportJob) => { if (alive.current) setJob(value); };
  const message = (error: unknown) => error instanceof Error ? error.message : "操作失败，请重试。";
  useEffect(() => {
    if (!job || job.state !== "waiting_login") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      try { const next = await shanbayImport("status", job.jobId); if (!cancelled) update(next); }
      catch (error) { if (!cancelled) setError(message(error)); }
      if (!cancelled) timer = setTimeout(() => void check(), 5000);
    };
    timer = setTimeout(() => void check(), 5000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [job?.jobId, job?.state]);
  const connect = async () => {
    if (running.current) return;
    // Open synchronously so mobile browsers do not block the login window.
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    running.current = true; setBusy(true); setError("");
    try {
      const next = await shanbayImport("start"); update(next);
      if (popup && next.liveUrl) popup.location.replace(next.liveUrl);
    } catch (error) { popup?.close(); if (alive.current) setError(message(error)); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  };
  const importBook = async () => {
    if (!job || running.current) return;
    running.current = true; stopRequested.current = false; setBusy(true); setError("");
    try {
      let next = job;
      while (alive.current && !stopRequested.current && ["ready", "importing"].includes(next.state)) {
        next = await shanbayImport("chunk", job.jobId); update(next);
      }
      if (stopRequested.current && next.state !== "completed") { next = await shanbayImport("cancel", job.jobId); update(next); }
      if (next.processed > 0 || next.state === "completed") { clearReadModelCache(); onImported(); }
    } catch (error) { if (alive.current) setError(message(error)); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  };
  const cancel = async () => {
    if (!job) return;
    if (running.current) { stopRequested.current = true; return; }
    running.current = true; setBusy(true);
    try { update(await shanbayImport("cancel", job.jobId)); setError(""); }
    catch (error) { setError(message(error)); }
    finally { running.current = false; setBusy(false); }
  };
  const active = job && ["waiting_login", "ready", "importing"].includes(job.state);
  return <div className="shanbay-import-panel">
    <div><strong>从扇贝导入</strong><p>在扇贝页面完成登录，返回这里导入当前词书。仅导入到你的账号，本次结束后退出远程会话。</p></div>
    <div className="shanbay-import-actions">
      {(!active || job.state === "waiting_login") && <button type="button" className="secondary-button" disabled={busy} onClick={() => void connect()}>{busy ? "正在连接…" : active ? "打开扇贝登录" : "连接扇贝"}</button>}
      {job?.liveUrl && job.state === "waiting_login" && <a className="secondary-button" href={job.liveUrl} target="_blank" rel="noopener noreferrer">进入登录页面</a>}
      {job && ["ready", "importing"].includes(job.state) && <Button type="button" disabled={busy} onClick={() => void importBook()}>{busy ? "正在导入…" : job.state === "importing" ? "继续导入" : `导入「${job.book?.name ?? "当前词书"}」`}</Button>}
      {active && <button type="button" className="secondary-button" disabled={busy && job.state === "waiting_login"} onClick={() => void cancel()}>{busy ? "停止导入" : "取消"}</button>}
    </div>
    {job && <p role="status">{job.state === "waiting_login" ? "等待扇贝登录。完成后返回本页，词书会自动显示。" : job.state === "ready" ? `已连接：${job.book?.name ?? "当前词书"}` : job.state === "importing" ? `已处理 ${job.processed} 个词条。` : job.state === "completed" ? `导入完成，已处理 ${job.processed} 个词条。` : job.state === "expired" ? "连接已过期，请重新连接。" : job.state === "failed" ? "连接失败，请重试。" : "已取消。"}</p>}
    {error && <p className="standalone-status error" role="alert">{error}</p>}
  </div>;
}
