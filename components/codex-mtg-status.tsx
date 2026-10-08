"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getDeviceHeaders } from "@/lib/device-id";

type Machine = {
  id: string;
  pcName: string;
  canExecuteCode: boolean;
  lastSeenAt: string | null;
  revokedAt: string | null;
  expiresAt?: string | null;
  peerListenerSeenAt?: string | null;
};

type StatusResponse = {
  status: {
    ownerPcName: string;
    online: boolean;
    lastSeenAt: string | null;
    pendingCount: number;
    runningCount: number;
    needsOperatorCount: number;
  };
  machines: Machine[];
  jobs: { id: string; status: string; createdAt: string; summary: string | null; postId: string }[];
};

function seenAt(value: string | null) {
  if (!value) return "接続履歴なし";
  return new Date(value).toLocaleString("ja-JP", {
    month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function jobStatus(value: string) {
  const labels: Record<string, string> = {
    pending: "未処理", queued: "未処理", running: "対応中", claimed: "対応中", completed: "完了", failed: "エラー",
    needs_operator: "確認待ち", canceled: "取消", cancelled: "取消",
  };
  return labels[value] || value;
}

export function CodexMtgStatus({ canManageMachines }: { canManageMachines: boolean }) {
  const [data, setData] = useState<StatusResponse | null>(null);
  const [error, setError] = useState("");
  const [pcName, setPcName] = useState("");
  const [busy, setBusy] = useState(false);
  const [issuedToken, setIssuedToken] = useState<{ token: string; pcName: string } | null>(null);
  const mounted = useRef(false);
  const activeRequest = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (activeRequest.current) return;
    const controller = new AbortController();
    activeRequest.current = controller;
    try {
      const response = await fetch("/api/admin/codex-mtg", {
        cache: "no-store", headers: getDeviceHeaders(), signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok || !result.ok || !result.status) {
        throw new Error(result.error?.message || (typeof result.error === "string" ? result.error : "担当PCの状態を確認できません"));
      }
      if (mounted.current) {
        setData(result);
        setError("");
      }
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current) {
        setError(cause instanceof Error ? cause.message : "担当PCの状態を確認できません");
      }
    } finally {
      if (activeRequest.current === controller) activeRequest.current = null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const refreshVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const timer = window.setInterval(refreshVisible, 15_000);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      mounted.current = false;
      activeRequest.current?.abort();
      activeRequest.current = null;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, [refresh]);

  async function manageMachine(body: { action: "register"; pcName: string } | { action: "revoke"; machineId: string }) {
    setBusy(true);
    setError("");
    if (body.action === "register") setIssuedToken(null);
    try {
      const response = await fetch("/api/admin/codex-mtg", {
        method: "POST",
        headers: { ...getDeviceHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error?.message || (typeof result.error === "string" ? result.error : "PCの登録情報を更新できません"));
      if (body.action === "register" && typeof result.token === "string") {
        setIssuedToken({ token: result.token, pcName: result.machine?.pcName || body.pcName });
        setPcName("");
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "PCの登録情報を更新できません");
    } finally {
      setBusy(false);
    }
  }

  const status = data?.status;
  const owner = status?.ownerPcName || "TSA";
  return (
    <aside aria-label="CodexMTGの担当PCと連携状況" style={{ padding: "8px 16px", fontSize: 12, lineHeight: 1.6, borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
      <div>担当PC: <strong>{owner}</strong> / 他PCは連携・報告専用 / 管理職の投稿は担当Codexへ通知</div>
      <div role="status">
        {error ? "状態を確認できません" : status ? (
          <><span style={{ color: status.online ? "#22c55e" : "var(--text-sub)" }}>{status.online ? "● オンライン" : "○ 停止中・未接続"}</span>
            {" / "}未処理 {status.pendingCount}件 / 対応中 {status.runningCount}件
            {status.needsOperatorCount > 0 && <> / 確認待ち {status.needsOperatorCount}件</>}
          </>
        ) : "接続状況を確認中…"}
        <button type="button" onClick={() => void refresh()} style={{ marginLeft: 10, textDecoration: "underline" }}>更新</button>
      </div>
      {status && !status.online && !error && <div style={{ color: "var(--text-sub)" }}>投稿は保存されます。担当PCの接続後に確認します。最終接続: {seenAt(status.lastSeenAt)}</div>}
      {error && <p role="alert" style={{ color: "#f87171", margin: "4px 0" }}>{error}</p>}
      <details style={{ marginTop: 4, maxHeight: 220, overflowY: "auto" }}>
        <summary style={{ cursor: "pointer" }}>連携状況{canManageMachines ? "・PC登録" : ""}</summary>
        {(data?.machines || []).map(machine => (
          <div key={machine.id} style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", paddingTop: 4 }}>
            <strong>{machine.pcName}</strong>
            <span>{machine.canExecuteCode ? "担当PC" : "連携・報告専用"} / {machine.revokedAt ? "失効済み" : `最終接続: ${seenAt(machine.lastSeenAt)}`}</span>
            {!machine.canExecuteCode && !machine.revokedAt && <span>自動受信: {machine.peerListenerSeenAt
              ? `最終確認 ${seenAt(machine.peerListenerSeenAt)}` : "未接続（MCP接続だけでは自動受信しません）"}</span>}
            {!machine.revokedAt && machine.expiresAt && <span>キー期限: {new Date(machine.expiresAt).toLocaleDateString("ja-JP")}</span>}
            {canManageMachines && !machine.revokedAt && <button type="button" disabled={busy} onClick={() => void manageMachine({ action: "revoke", machineId: machine.id })} style={{ color: "#f87171", textDecoration: "underline" }}>失効</button>}
          </div>
        ))}
        {canManageMachines && (
          <form onSubmit={event => { event.preventDefault(); if (pcName.trim()) void manageMachine({ action: "register", pcName: pcName.trim() }); }} style={{ display: "flex", flexWrap: "wrap", gap: 8, paddingTop: 8 }}>
            <label>PC名 <input value={pcName} onChange={event => setPcName(event.target.value)} maxLength={64} required placeholder="PC名" style={{ width: 150, padding: "3px 6px", border: "1px solid var(--border)", borderRadius: 4 }} /></label>
            <button type="submit" disabled={busy || !pcName.trim()} className="btn-primary" style={{ padding: "3px 10px", fontSize: 12 }}>PCを登録</button>
          </form>
        )}
        {canManageMachines && issuedToken && <div style={{ paddingTop: 6 }}>
          <p style={{ margin: "4px 0" }}>{issuedToken.pcName} の接続トークン。この画面で一度だけ表示します。登録するPCへ設定してください。</p>
          <textarea readOnly aria-label="新しいPCの接続トークン" value={issuedToken.token} rows={2} onFocus={event => event.target.select()} style={{ width: "100%", overflowWrap: "anywhere" }} />
          <button type="button" onClick={() => setIssuedToken(null)} style={{ textDecoration: "underline" }}>トークン表示を閉じる</button>
        </div>}
        {(data?.jobs || []).length > 0 && <ul style={{ paddingLeft: 18, margin: "8px 0 0", maxHeight: 120, overflowY: "auto" }}>
          {data?.jobs.slice(0, 5).map(job => <li key={job.id}>{jobStatus(job.status)} / {seenAt(job.createdAt)}{job.summary ? ` / ${job.summary}` : ""}</li>)}
        </ul>}
      </details>
    </aside>
  );
}
