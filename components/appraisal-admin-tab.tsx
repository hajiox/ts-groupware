"use client";

import { useEffect, useRef, useState } from "react";
import {
  APPRAISAL_HARASSMENT_CONTACTS,
  APPRAISAL_ITEMS,
  APPRAISAL_LABELS,
  APPRAISAL_TALK_ITEMS,
  emptyAppraisalRatings,
  emptyAppraisalTalkChecklist,
  type AppraisalRatings,
  type AppraisalRecord,
  type AppraisalTalkChecklist,
  type AppraisalTalkItemId,
} from "@/lib/appraisals";

type Person = { id: string; name: string; department: string };
type Payload = { employees: Person[]; assignableEmployees: Person[]; records: AppraisalRecord[]; reviewer: Person; reviewers: Person[]; executive: boolean; assignments: { reviewer_id: string; employee_id: string }[] };
const today = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());

export function AppraisalAdminTab() {
  const [month, setMonth] = useState(() => today().slice(0, 7));
  const [payload, setPayload] = useState<Payload | null>(null);
  const [employeeId, setEmployeeId] = useState("");
  const [ratings, setRatings] = useState<AppraisalRatings>(emptyAppraisalRatings);
  const [talkChecklist, setTalkChecklist] = useState<AppraisalTalkChecklist>(emptyAppraisalTalkChecklist);
  const [assessedOn, setAssessedOn] = useState(today);
  const [version, setVersion] = useState(0);
  const [status, setStatus] = useState("未着手");
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [assignmentReviewer, setAssignmentReviewer] = useState("");
  const [printOpen, setPrintOpen] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const sequence = useRef(0);
  const formRef = useRef<HTMLDivElement>(null);
  const selected = payload?.employees.find(e => e.id === employeeId);
  const count = APPRAISAL_ITEMS.filter(item => ratings[item.id]?.score !== null).length;
  const talkCount = APPRAISAL_TALK_ITEMS.filter(item => talkChecklist[item.id]).length;

  useEffect(() => {
    const controller = new AbortController();
    setPayload(null); setEmployeeId(""); setError(""); setMessage("");
    fetch(`/api/admin/appraisals?month=${month}`, { cache: "no-store", signal: controller.signal })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error || "取得できませんでした"); return data as Payload; })
      .then(setPayload)
      .catch(e => { if (e.name !== "AbortError") setError(e.message); });
    return () => controller.abort();
  }, [month]);

  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    const guard = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target.closest('a,button') : null;
      if (!target || sectionRef.current?.contains(target)) return;
      if (busy || !window.confirm("未保存の変更を破棄して画面を移動しますか？")) { event.preventDefault(); event.stopPropagation(); }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", guard, true);
    return () => { window.removeEventListener("beforeunload", warn); document.removeEventListener("click", guard, true); };
  }, [dirty, busy]);

  useEffect(() => {
    if (!printOpen) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPrintOpen(false);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [printOpen]);

  async function assign(targetId: string, enabled: boolean) {
    if (!assignmentReviewer || busy) return;
    setBusy(true); setError("");
    try {
      const response = await fetch('/api/admin/appraisals', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:enabled?'assign':'unassign',reviewerId:assignmentReviewer,employeeId:targetId}) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '担当を保存できませんでした');
      setPayload(p => p ? {...p,assignments:[...p.assignments.filter(a => !(a.reviewer_id === assignmentReviewer && a.employee_id === targetId)), ...(enabled ? [{reviewer_id:assignmentReviewer,employee_id:targetId}] : [])]} : p);
    } catch(e) { setError(e instanceof Error ? e.message : '担当を保存できませんでした'); }
    finally { setBusy(false); }
  }

  function open(employee: Person) {
    if (busy || (dirty && !window.confirm("未保存の変更を破棄して対象者を切り替えますか？"))) return;
    sequence.current++;
    const record = payload?.records.find(r => r.employee_id === employee.id && r.reviewer_id === payload.reviewer.id);
    setEmployeeId(employee.id); setRatings(record?.ratings || emptyAppraisalRatings());
    setTalkChecklist(record?.talk_checklist || emptyAppraisalTalkChecklist());
    setAssessedOn(record?.assessed_on || today()); setVersion(record?.version || 0);
    setStatus(record?.status === "completed" ? "完了" : record ? "下書き" : "未着手");
    setDirty(false); setMessage(""); setError(""); setPrintOpen(false);
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 0);
  }

  function change(id: string, changes: Partial<AppraisalRatings[string]>) {
    setRatings(previous => ({ ...previous, [id]: { ...previous[id], ...changes } }));
    setDirty(true); setMessage("");
  }

  function changeTalkItem(id: AppraisalTalkItemId, value: boolean) {
    setTalkChecklist(previous => ({ ...previous, [id]: value }));
    setDirty(true); setMessage("");
  }

  async function save(nextStatus: 'draft' | 'completed') {
    if (!selected || busy) return;
    setBusy(true); setError(""); setMessage("");
    const requestSequence = sequence.current;
    try {
      const response = await fetch("/api/admin/appraisals", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId, month, assessedOn, ratings, talkChecklist, version, status: nextStatus }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "保存できませんでした");
      if (requestSequence !== sequence.current) return;
      const record = data.record as AppraisalRecord;
      setPayload(previous => previous ? { ...previous, records: [...previous.records.filter(r => r.id !== record.id), record] } : previous);
      setRatings(record.ratings); setTalkChecklist(record.talk_checklist); setVersion(record.version); setDirty(false);
      setStatus(record.status === "completed" ? "完了" : "下書き");
      setMessage(record.status === "completed" ? "査定を完了しました。" : "下書きを保存しました。");
    } catch (e) { setError(e instanceof Error ? e.message : "保存できませんでした"); }
    finally { setBusy(false); }
  }

  return <section ref={sectionRef} className="appraisals" aria-label="社員査定">
    <header className="appraisal-header">
      <div><h2>査定表 <span className="appraisal-private">非公開</span></h2>
        <p>各項目を5段階で評価し、備考に具体的な内容を記入してください。</p>
        <p>プライオリティーは参考値です。評価点への加重は行いません。</p></div>
      <div className="appraisal-header-tools">
        <label>対象月<input type="month" value={month} min="2000-01" max="2099-12" disabled={busy} onChange={e => {
          if (!e.target.value || (dirty && !window.confirm("未保存の変更を破棄して対象月を切り替えますか？"))) return;
          setDirty(false); setMonth(e.target.value);
        }} /></label>
        <button type="button" disabled={busy || !payload} onClick={() => setPrintOpen(true)}>面談内容を印刷</button>
      </div>
    </header>
    {error && !selected && <p role="alert" className="appraisal-error">{error}</p>}
    {!payload && !error && <p>査定対象を読み込み中…</p>}
    {payload && <>
      {payload.executive && <details className="appraisal-overview"><summary>査定の担当設定（役員のみ）</summary>
        <p>管理者に担当する部下を設定してください。管理者は担当者の自分の査定だけを閲覧・編集できます。役員は全査定を閲覧できます。</p>
        <label>査定者<select value={assignmentReviewer} disabled={busy} onChange={e => setAssignmentReviewer(e.target.value)}><option value="">管理者を選択</option>{payload.reviewers.filter(r => r.id !== payload.reviewer.id).map(r => <option key={r.id} value={r.id}>{r.name}（{r.department}）</option>)}</select></label>
        {assignmentReviewer && <div className="appraisal-people">{payload.assignableEmployees.map(e => <label key={e.id}><input type="checkbox" disabled={busy} checked={payload.assignments.some(a => a.reviewer_id === assignmentReviewer && a.employee_id === e.id)} onChange={event => assign(e.id,event.target.checked)} /> {e.name}（{e.department}）</label>)}</div>}
      </details>}
      <p>査定者：<strong>{payload.reviewer.name}</strong> ／ 自分の完了：{payload.records.filter(r => r.reviewer_id === payload.reviewer.id && r.status === "completed" && payload.employees.some(e => e.id === r.employee_id)).length} / {payload.employees.length}名</p>
      <div className="appraisal-people">
        {payload.employees.map(employee => {
          const record = payload.records.find(r => r.employee_id === employee.id && r.reviewer_id === payload.reviewer.id);
          return <button type="button" key={employee.id} disabled={busy} aria-pressed={employeeId === employee.id} onClick={() => open(employee)}>
            <strong>{employee.name}</strong><small>{employee.department}</small><span>{record?.status === "completed" ? "完了" : record ? "下書き" : "未着手"}</span>
          </button>;
        })}
      </div>
      {payload.employees.length === 0 && <p>査定対象の部下が登録されていません。</p>}
      {selected && <div ref={formRef} className="appraisal-form">
        <div className="appraisal-form-heading"><h3>{selected.name}さんの査定</h3><span>{status}{dirty ? "・未保存" : ""} ／ 評価 {count}/10・面談確認 {talkCount}/5</span>
          <label>査定日<input type="date" value={assessedOn} disabled={busy} onChange={e => { setAssessedOn(e.target.value); setDirty(true); }} /></label></div>
        <fieldset disabled={busy}>
          <legend className="sr-only">査定項目</legend>
          {APPRAISAL_ITEMS.map(item => {
            const rating = ratings[item.id];
            return <article className="appraisal-item" key={item.id}>
              <div className="appraisal-item-heading"><h4 id={`appraisal-${item.id}`}>{item.label}</h4><span>プライオリティー {item.priority}</span></div>
              <div className="appraisal-score"><output htmlFor={`score-${item.id}`}>{rating.score === null ? "未評価" : `${rating.score} / 5　${APPRAISAL_LABELS[rating.score]}`}</output>
                {rating.score === null ? <button type="button" onClick={() => change(item.id, { score: 3 })}>「普通」で評価</button> : <button type="button" onClick={() => change(item.id, { score: null })}>未評価に戻す</button>}</div>
              <input id={`score-${item.id}`} type="range" min="1" max="5" step="1" value={rating.score ?? 3} aria-labelledby={`appraisal-${item.id}`} aria-valuetext={rating.score === null ? "未評価。スライダーを動かすか、普通で評価を押してください" : APPRAISAL_LABELS[rating.score]} onChange={e => change(item.id, { score: Number(e.target.value) })} />
              <div className="appraisal-scale" aria-hidden="true">{APPRAISAL_LABELS.slice(1).map((label, index) => <span key={label}>{index + 1}<br />{label}</span>)}</div>
              <label htmlFor={`comment-${item.id}`}>備考<textarea id={`comment-${item.id}`} maxLength={2000} rows={2} value={rating.comment} placeholder="具体的な行動、良い点や改善点など" onChange={e => change(item.id, { comment: e.target.value })} /></label>
            </article>;
          })}
        </fieldset>
        <section className="appraisal-talk" aria-labelledby="appraisal-talk-heading">
          <div className="appraisal-talk-heading">
            <div><h3 id="appraisal-talk-heading">面談で伝える内容</h3><p>査定対象者へ説明した項目を管理者がチェックしてください。チェック状態は査定と一緒に保存されます。</p></div>
            <div className="appraisal-talk-tools">
              <strong>{talkCount} / {APPRAISAL_TALK_ITEMS.length}項目 説明済み</strong>
              <button type="button" disabled={busy} onClick={() => setPrintOpen(true)}>印刷画面</button>
            </div>
          </div>
          <fieldset disabled={busy}>
            <legend className="sr-only">面談確認項目</legend>
            {APPRAISAL_TALK_ITEMS.map(item => <article className={`appraisal-talk-item${talkChecklist[item.id] ? " is-checked" : ""}`} key={item.id}>
              <div className="appraisal-talk-item-heading"><h4>{item.label}</h4><label><input type="checkbox" checked={talkChecklist[item.id]} onChange={event => changeTalkItem(item.id, event.target.checked)} /> 説明済み</label></div>
              {item.details.length > 0 && <ul>{item.details.map(detail => <li key={detail} className={detail.includes("ネガティブワード") ? "appraisal-important" : undefined}>{detail}</li>)}</ul>}
              {item.id === "harassment" && <div className="appraisal-harassment">
                <p><strong>ハラスメントとは、人に対する「嫌がらせ」や「いじめ」などの迷惑行為の全てを指します。</strong></p>
                <p>何をハラスメントと感じるかどうかは個人差がありますが、基本的には受けた者が不快である（つらい、意に反する）と感じたら、それは<strong>受けた者にとってのハラスメント</strong>とまずは考えましょう。</p>
                <p>2022年4月より労働施策総合推進法（別名パワハラ防止法）施行</p>
                <p>会社内又は上司・同僚より上記を少しでも感じた場合は必ず相談して下さい。<br />（電話・メッセンジャー・LINE等でも構いません）</p>
                <h5>相談窓口</h5>
                <ul className="appraisal-contacts">{APPRAISAL_HARASSMENT_CONTACTS.map(contact => <li key={contact.phone}><span>{contact.name}</span><a href={`tel:${contact.phone}`}>{contact.phone}</a></li>)}</ul>
              </div>}
            </article>)}
          </fieldset>
        </section>
        <div className="appraisal-actions">
          {error && <p role="alert" className="appraisal-feedback appraisal-error">{error}</p>}
          {message && <p role="status" className="appraisal-feedback appraisal-success">{message}</p>}
          <span>評価 {count}/10・面談確認 {talkCount}/5{dirty ? "・未保存の変更があります" : ""}</span><button type="button" disabled={busy} onClick={() => save('draft')}>{busy ? "保存中…" : "下書き保存"}</button><button type="button" className="appraisal-complete" disabled={busy || count !== 10} onClick={() => save('completed')}>査定を完了</button></div>
        <p className="appraisal-hint">全10項目を評価すると完了できます。保存済みの査定は再度開いて修正できます。本人には公開・通知されません。</p>
      </div>}
      {payload.executive && <details className="appraisal-overview"><summary>管理者の査定結果（役員のみ）</summary>
        {payload.records.filter(r => r.reviewer_id !== payload.reviewer.id).length === 0 && <p>この月の管理者による査定はまだありません。</p>}
        {payload.records.filter(r => r.reviewer_id !== payload.reviewer.id).map(record => <details key={record.id}>
          <summary>{payload.assignableEmployees.find(e => e.id === record.employee_id)?.name || "対象者"} ／ 査定者：{payload.reviewers.find(r => r.id === record.reviewer_id)?.name || "管理者"} ／ {record.status === 'completed' ? '完了' : '下書き'} ／ {record.assessed_on}</summary>
          {APPRAISAL_ITEMS.map(item => <p key={item.id}><strong>{item.label}：{APPRAISAL_LABELS[record.ratings[item.id].score ?? 0]}</strong><br /><span style={{ whiteSpace: "pre-wrap" }}>{record.ratings[item.id].comment || "備考なし"}</span></p>)}
          <p><strong>面談確認：{APPRAISAL_TALK_ITEMS.filter(item => record.talk_checklist?.[item.id]).length} / {APPRAISAL_TALK_ITEMS.length}項目</strong><br />{APPRAISAL_TALK_ITEMS.map(item => `${record.talk_checklist?.[item.id] ? "☑" : "☐"} ${item.label}`).join(" ／ ")}</p>
        </details>)}
      </details>}
      {printOpen && payload && <div className="appraisal-print-root" role="presentation" onMouseDown={() => setPrintOpen(false)}>
        <section className="appraisal-print-dialog" role="dialog" aria-modal="true" aria-labelledby="appraisal-print-title" onMouseDown={event => event.stopPropagation()}>
          <div className="appraisal-print-controls">
            <div><strong>印刷プレビュー</strong><small>査定点と備考は印刷されません。</small></div>
            <button type="button" onClick={() => setPrintOpen(false)}>閉じる</button>
            <button type="button" className="appraisal-print-button" onClick={() => window.print()}>印刷</button>
          </div>
          <article className="appraisal-print-sheet">
            <header className="appraisal-print-header">
              <p>面談確認書</p>
              <h2 id="appraisal-print-title">査定面談で伝える内容</h2>
              <div className="appraisal-print-meta">
                <span>対象者：<strong>{selected?.name || "　　　　　　　　　"}</strong></span>
                <span>所属：<strong>{selected?.department || "　　　　　　　　　"}</strong></span>
                <span>査定者：<strong>{payload.reviewer.name}</strong></span>
                <span>対象月：<strong>{Number(month.slice(0, 4))}年{Number(month.slice(5, 7))}月</strong></span>
                <span>査定日：<strong>{assessedOn.replaceAll("-", "/")}</strong></span>
              </div>
            </header>
            <p className="appraisal-print-intro">以下の内容を対象者へ説明し、理解を確認してください。</p>
            <div className="appraisal-print-items">
              {APPRAISAL_TALK_ITEMS.map((item, index) => <section className="appraisal-print-item" key={item.id}>
                <div className="appraisal-print-item-heading">
                  <span className="appraisal-print-number">{index + 1}</span>
                  <h3>{item.label}</h3>
                  <strong>{talkChecklist[item.id] ? "☑ 説明済み" : "□ 説明確認"}</strong>
                </div>
                {item.details.length > 0 && <ul>{item.details.map(detail => <li key={detail} className={detail.includes("ネガティブワード") ? "appraisal-print-important" : undefined}>{detail}</li>)}</ul>}
                {item.id === "harassment" && <div className="appraisal-print-harassment">
                  <p><strong>ハラスメントとは、人に対する「嫌がらせ」や「いじめ」などの迷惑行為の全てを指します。</strong></p>
                  <p>何をハラスメントと感じるかどうかは個人差がありますが、基本的には受けた者が不快である（つらい、意に反する）と感じたら、それは<strong>受けた者にとってのハラスメント</strong>とまずは考えましょう。</p>
                  <p>2022年4月より労働施策総合推進法（別名パワハラ防止法）施行</p>
                  <p>会社内又は上司・同僚より上記を少しでも感じた場合は必ず相談して下さい。<br />（電話・メッセンジャー・LINE等でも構いません）</p>
                  <h4>相談窓口</h4>
                  <ul className="appraisal-print-contacts">{APPRAISAL_HARASSMENT_CONTACTS.map(contact => <li key={contact.phone}><span>{contact.name}</span><span>{contact.phone}</span></li>)}</ul>
                </div>}
              </section>)}
            </div>
            <footer className="appraisal-print-signature">
              <p>以上の説明を受け、内容を確認しました。</p>
              <div><span>確認日：　　　　年　　　月　　　日</span><span>本人署名：　　　　　　　　　　　　　　　</span></div>
            </footer>
          </article>
        </section>
      </div>}
    </>}
    <style jsx>{`
      .appraisals { max-width: 1100px; margin: 0 auto; color: var(--text); }
      .appraisal-header,.appraisal-form-heading,.appraisal-item-heading,.appraisal-score,.appraisal-actions { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
      .appraisal-header-tools { display:flex; align-items:flex-end; gap:10px; flex-wrap:wrap; }
      h2 { font-size:22px; } h3 { font-size:19px; } h4 { margin:0; font-size:16px; }
      p { font-size:14px; line-height:1.7; } label { display:block; font-size:13px; }
      .appraisal-private { font-size:12px; border:1px solid var(--border); border-radius:5px; padding:3px 7px; margin-left:8px; }
      input[type=month],input[type=date],textarea,select { display:block; border:1px solid var(--border); border-radius:8px; padding:9px; color:inherit; background:var(--card, #1e293b); max-width:100%; }
      textarea { width:100%; margin-top:6px; resize:vertical; }
      button { border:1px solid var(--border); border-radius:8px; padding:9px 13px; background:var(--card, #1e293b); color:inherit; cursor:pointer; }
      button:disabled { opacity:.5; cursor:default; } button:focus-visible,input:focus-visible,textarea:focus-visible { outline:2px solid #60a5fa; outline-offset:3px; }
      .appraisal-people { display:grid; grid-template-columns:repeat(auto-fill,minmax(155px,1fr)); gap:10px; margin:20px 0; }
      .appraisal-people button { display:flex; flex-direction:column; gap:6px; text-align:left; }
      .appraisal-people button[aria-pressed=true] { border-color:#60a5fa; background:rgba(59,130,246,.14); }
      small,.appraisal-item-heading span,.appraisal-hint { color:var(--text-sub); font-size:12px; }
      .appraisal-form { scroll-margin-top:80px; } fieldset { margin:16px 0; padding:0; border:0; min-width:0; }
      .appraisal-item { padding:20px; margin-bottom:14px; border:1px solid var(--border); border-radius:12px; background:var(--card, #1e293b); }
      .appraisal-score { margin:18px 0 10px; } output { font-weight:700; color:#60a5fa; } .appraisal-score button { font-size:12px; }
      input[type=range] { width:100%; accent-color:#60a5fa; height:32px; cursor:pointer; }
      .appraisal-scale { display:flex; justify-content:space-between; font-size:12px; text-align:center; margin:0 0 20px; color:var(--text-sub); }
      .appraisal-scale span { width:20%; } .appraisal-actions { position:sticky; bottom:calc(76px + env(safe-area-inset-bottom)); padding:14px; border:1px solid var(--border); border-radius:10px; background:var(--card,#1e293b); box-shadow:0 3px 20px #0003; }
      .appraisal-feedback { flex-basis:100%; }
      .appraisal-talk { margin:28px 0 20px; }
      .appraisal-talk-heading,.appraisal-talk-item-heading { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; flex-wrap:wrap; }
      .appraisal-talk-heading p { margin-top:5px; color:var(--text-sub); }
      .appraisal-talk-tools { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      .appraisal-talk-tools > strong { color:#60a5fa; font-size:13px; }
      .appraisal-talk-item { padding:18px 20px; margin-bottom:12px; border:1px solid var(--border); border-radius:12px; background:var(--card,#1e293b); }
      .appraisal-talk-item.is-checked { border-color:#22c55e; background:rgba(34,197,94,.07); }
      .appraisal-talk-item-heading label { display:flex; align-items:center; gap:8px; font-weight:700; cursor:pointer; }
      .appraisal-talk-item input[type=checkbox] { width:20px; height:20px; accent-color:#22c55e; }
      .appraisal-talk-item ul { margin:14px 0 0; padding-left:22px; font-size:14px; line-height:1.8; }
      .appraisal-important { color:#f87171; font-weight:700; }
      .appraisal-harassment { margin-top:14px; padding-top:4px; border-top:1px solid var(--border); }
      .appraisal-harassment h5 { margin:16px 0 6px; font-size:14px; }
      .appraisal-contacts { list-style:none; padding:0!important; display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:6px 18px; }
      .appraisal-contacts li { display:flex; justify-content:space-between; gap:10px; }
      .appraisal-contacts a { color:#60a5fa; }
      .appraisal-actions span { flex:1; font-size:13px; } .appraisal-complete { background:#2563eb; color:white; }
      .appraisal-error { color:#f87171; } .appraisal-success { color:#4ade80; }
      .appraisal-overview { margin:24px 0; padding:16px; border:1px solid var(--border); border-radius:10px; }
      .appraisal-overview details { margin:12px 0; padding:12px; border-top:1px solid var(--border); } summary { cursor:pointer; }
      .appraisal-print-root { position:fixed; inset:0; z-index:1000; overflow:auto; padding:24px; background:rgba(2,6,23,.82); }
      .appraisal-print-dialog { width:min(900px,100%); margin:0 auto; }
      .appraisal-print-controls { position:sticky; top:0; z-index:2; display:flex; align-items:center; justify-content:flex-end; gap:10px; margin-bottom:12px; padding:12px; border:1px solid var(--border); border-radius:12px; background:var(--card,#1e293b); box-shadow:0 8px 30px #0006; }
      .appraisal-print-controls > div { display:flex; flex-direction:column; margin-right:auto; }
      .appraisal-print-controls small { margin-top:3px; }
      .appraisal-print-button { border-color:#2563eb; background:#2563eb; color:#fff; font-weight:700; }
      .appraisal-print-sheet { box-sizing:border-box; width:210mm; max-width:100%; min-height:297mm; margin:0 auto; padding:12mm; color:#111827; background:#fff; box-shadow:0 10px 35px #0008; font-family:"Yu Gothic","Meiryo",sans-serif; }
      .appraisal-print-header { padding-bottom:6mm; border-bottom:2px solid #111827; }
      .appraisal-print-header > p { margin:0 0 2mm; font-size:11px; letter-spacing:.18em; }
      .appraisal-print-header h2 { margin:0 0 5mm; color:#111827; font-size:24px; text-align:center; }
      .appraisal-print-meta { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:2mm 8mm; font-size:12px; }
      .appraisal-print-intro { margin:5mm 0 3mm; font-size:12px; }
      .appraisal-print-items { display:grid; gap:3mm; }
      .appraisal-print-item { break-inside:avoid; padding:3mm 4mm; border:1px solid #374151; }
      .appraisal-print-item-heading { display:grid; grid-template-columns:8mm 1fr auto; align-items:center; gap:3mm; }
      .appraisal-print-number { display:grid; place-items:center; width:7mm; height:7mm; border:1px solid #111827; border-radius:50%; font-weight:700; font-size:11px; }
      .appraisal-print-item h3 { margin:0; color:#111827; font-size:14px; }
      .appraisal-print-item-heading > strong { font-size:11px; white-space:nowrap; }
      .appraisal-print-item ul { margin:2mm 0 0; padding-left:7mm; font-size:11px; line-height:1.55; }
      .appraisal-print-important { color:#b91c1c; font-weight:700; }
      .appraisal-print-harassment { margin-top:2mm; padding-top:2mm; border-top:1px solid #9ca3af; }
      .appraisal-print-harassment p { margin:1mm 0; color:#111827; font-size:10.5px; line-height:1.45; }
      .appraisal-print-harassment h4 { margin:2mm 0 1mm; font-size:11px; }
      .appraisal-print-contacts { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:1mm 8mm; margin:0!important; padding:0!important; list-style:none; }
      .appraisal-print-contacts li { display:flex; justify-content:space-between; gap:3mm; }
      .appraisal-print-signature { break-inside:avoid; margin-top:6mm; padding-top:4mm; border-top:1px solid #111827; }
      .appraisal-print-signature p { margin:0 0 5mm; color:#111827; font-size:12px; }
      .appraisal-print-signature div { display:flex; justify-content:space-between; gap:8mm; font-size:12px; }
      @media(max-width:600px) { .appraisal-item,.appraisal-talk-item { padding:14px; } .appraisal-header { align-items:flex-start; } .appraisal-actions span { flex-basis:100%; } .appraisal-print-root { padding:8px; } .appraisal-print-controls { align-items:flex-end; } .appraisal-print-sheet { width:100%; min-height:auto; padding:18px; } .appraisal-print-meta { grid-template-columns:1fr; } .appraisal-print-signature div { flex-direction:column; } }
    `}</style>
    <style jsx global>{`
      @page { size:A4 portrait; margin:10mm; }
      @media print {
        body { background:#fff!important; }
        body * { visibility:hidden!important; }
        .appraisal-print-root,.appraisal-print-root * { visibility:visible!important; }
        .appraisal-print-root { position:absolute!important; inset:0!important; overflow:visible!important; padding:0!important; background:#fff!important; }
        .appraisal-print-dialog { width:100%!important; margin:0!important; }
        .appraisal-print-controls { display:none!important; }
        .appraisal-print-sheet { width:auto!important; max-width:none!important; min-height:auto!important; margin:0!important; padding:0!important; box-shadow:none!important; }
      }
    `}</style>
  </section>;
}
