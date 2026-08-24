"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Archive, CheckCircle2, Clock3, Copy, ExternalLink, FileCheck2, FilePlus2, Plus, Printer, RotateCcw, Send, ShieldAlert, TestTube2, Trash2 } from "lucide-react";
import { USER_DEPARTMENTS, type UserDepartment } from "@/lib/departments";

type CheckItem = { id: string; text: string };
type Template = {
  id: string;
  title: string;
  body: string;
  check_items: CheckItem[];
  agreement_label: string;
  company_name: string;
  is_active: boolean;
  updated_at?: string;
};
type User = {
  id: string;
  display_name: string;
  department: UserDepartment;
};
type PledgeAssignmentStatus = {
  id: string;
  user_id: string | null;
  recipient_name: string;
  recipient_department: string | null;
  status: "pending" | "processing" | "submitted";
  pledged_at: string | null;
  signed_attachment: Record<string, unknown> | null;
  created_at: string;
  elapsed_days: number;
  reminder_level: "pending" | "warning" | "final" | "submitted";
};
type Delivery = {
  id: string;
  title_snapshot: string;
  target_label: string | null;
  is_test: boolean;
  sent_at: string;
  total: number;
  submitted: number;
  assignments: PledgeAssignmentStatus[];
};
type Payload = { templates: Template[]; users: User[]; deliveries: Delivery[] };

function newItemId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `item-${Date.now()}`;
}

function editorFingerprint(title: string, body: string, items: CheckItem[], agreementLabel: string, companyName: string) {
  return JSON.stringify({ title, body, items, agreementLabel, companyName });
}

export function PledgeAdminTab() {
  const [payload, setPayload] = useState<Payload>({ templates: [], users: [], deliveries: [] });
  const [templateId, setTemplateId] = useState("");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [items, setItems] = useState<CheckItem[]>([]);
  const [agreementLabel, setAgreementLabel] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [targetMode, setTargetMode] = useState<"all" | UserDepartment | "individual">("all");
  const [selectedUserIds, setSelectedUserIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [savedFingerprint, setSavedFingerprint] = useState("");
  const [statusFilter, setStatusFilter] = useState<"pending" | "all" | "submitted">("pending");

  async function load(preferredTemplateId?: string, excludedTemplateId?: string) {
    setLoading(true);
    const response = await fetch("/api/admin/pledges", { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      setMessage(data?.error || "誓約機能を読み込めませんでした");
      setLoading(false);
      return;
    }
    setPayload(data);
    const availableTemplates = data.templates.filter((template: Template) => template.id !== excludedTemplateId);
    const selected = availableTemplates.find((template: Template) => template.id === preferredTemplateId)
      || availableTemplates.find((template: Template) => template.id === templateId)
      || availableTemplates.find((template: Template) => template.is_active)
      || availableTemplates[0];
    if (selected) applyTemplate(selected);
    else resetTemplateEditor();
    setLoading(false);
  }

  function applyTemplate(template: Template) {
    setTemplateId(template.id);
    setTitle(template.title);
    setBody(template.body);
    setItems(Array.isArray(template.check_items) ? template.check_items : []);
    setAgreementLabel(template.agreement_label);
    setCompanyName(template.company_name);
    setSavedFingerprint(editorFingerprint(
      template.title,
      template.body,
      Array.isArray(template.check_items) ? template.check_items : [],
      template.agreement_label,
      template.company_name,
    ));
  }

  function resetTemplateEditor() {
    const nextItems = [{ id: newItemId(), text: "" }];
    const nextCompanyName = "株式会社テクニカルスタッフ";
    const nextAgreementLabel = "上記内容を確認し、誓約する";
    setTemplateId("");
    setTitle("");
    setBody("");
    setItems(nextItems);
    setAgreementLabel(nextAgreementLabel);
    setCompanyName(nextCompanyName);
    setSavedFingerprint(editorFingerprint("", "", nextItems, nextAgreementLabel, nextCompanyName));
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedUsers = useMemo(() => payload.users.filter((user) => selectedUserIds.has(user.id)), [payload.users, selectedUserIds]);
  const currentFingerprint = useMemo(
    () => editorFingerprint(title, body, items, agreementLabel, companyName),
    [title, body, items, agreementLabel, companyName],
  );
  const hasUnsavedChanges = Boolean(savedFingerprint) && currentFingerprint !== savedFingerprint;
  const currentTemplate = payload.templates.find((template) => template.id === templateId) || null;
  const targetCount = targetMode === "all"
    ? payload.users.length
    : targetMode === "individual"
      ? selectedUsers.length
      : payload.users.filter((user) => user.department === targetMode).length;
  const liveAssignments = useMemo(
    () => payload.deliveries.filter((delivery) => !delivery.is_test).flatMap((delivery) => delivery.assignments || []),
    [payload.deliveries],
  );
  const statusSummary = useMemo(() => ({
    pending: liveAssignments.filter((assignment) => assignment.status !== "submitted").length,
    warning: liveAssignments.filter((assignment) => assignment.reminder_level === "warning").length,
    final: liveAssignments.filter((assignment) => assignment.reminder_level === "final").length,
    submitted: liveAssignments.filter((assignment) => assignment.status === "submitted").length,
  }), [liveAssignments]);
  const filteredDeliveries = useMemo(() => payload.deliveries
    .map((delivery) => ({
      ...delivery,
      visibleAssignments: (delivery.assignments || []).filter((assignment) => {
        if (statusFilter === "pending") return assignment.status !== "submitted";
        if (statusFilter === "submitted") return assignment.status === "submitted";
        return true;
      }),
    }))
    .filter((delivery) => delivery.visibleAssignments.length > 0), [payload.deliveries, statusFilter]);

  async function saveTemplate(showMessage = true) {
    const cleanItems = items.map((item) => ({ ...item, text: item.text.trim() })).filter((item) => item.text);
    if (!title.trim() || !body.trim() || cleanItems.length === 0 || !agreementLabel.trim() || !companyName.trim()) {
      throw new Error("タイトル、本文、チェック項目、同意ボタン、会社名を入力してください");
    }
    const response = await fetch("/api/admin/pledges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "save_template",
        template_id: templateId || undefined,
        title: title.trim(),
        body: body.trim(),
        check_items: cleanItems,
        agreement_label: agreementLabel.trim(),
        company_name: companyName.trim(),
        is_active: currentTemplate?.is_active ?? true,
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(data?.error || "誓約内容を保存できませんでした");
    setTemplateId(data.template_id);
    setItems(cleanItems);
    setSavedFingerprint(editorFingerprint(title.trim(), body.trim(), cleanItems, agreementLabel.trim(), companyName.trim()));
    if (showMessage) setMessage("誓約内容を保存しました");
    return data.template_id as string;
  }

  function confirmDiscardChanges() {
    return !hasUnsavedChanges || window.confirm("保存していない変更があります。破棄して切り替えますか？");
  }

  function handleTemplateChange(nextTemplateId: string) {
    if (!confirmDiscardChanges()) return;
    const selected = payload.templates.find((template) => template.id === nextTemplateId);
    if (selected) {
      applyTemplate(selected);
      setMessage("");
    }
  }

  function handleNewTemplate() {
    if (!confirmDiscardChanges()) return;
    resetTemplateEditor();
    setMessage("新しい誓約書を作成します。内容を入力して保存してください");
  }

  function handleDuplicateTemplate() {
    if (!title.trim()) return;
    const copiedTitle = `${title.trim()}（複製）`;
    setTemplateId("");
    setTitle(copiedTitle);
    setItems(items.map((item) => ({ ...item, id: newItemId() })));
    setSavedFingerprint("__new-copy__");
    setMessage("複製を新しい誓約書として編集中です。保存すると別の誓約書になります");
  }

  async function setTemplateActive(isActive: boolean) {
    if (!templateId) return;
    const verb = isActive ? "再開" : "保管";
    if (!window.confirm(`この誓約書を${verb}しますか？過去の配信・提出履歴は残ります。`)) return;
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/pledges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_template_active", template_id: templateId, is_active: isActive }),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `誓約書を${verb}できませんでした`);
      const changedTemplateId = templateId;
      await load(isActive ? changedTemplateId : undefined, isActive ? undefined : changedTemplateId);
      setMessage(`誓約書を${verb}しました`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `誓約書を${verb}できませんでした`);
    } finally {
      setSaving(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    setMessage("");
    try {
      const id = await saveTemplate();
      await load(id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "誓約内容を保存できませんでした");
    } finally {
      setSaving(false);
    }
  }

  async function handlePaperPrint() {
    const printWindow = window.open("about:blank", "_blank");
    if (!printWindow) {
      setMessage("印刷画面を開けませんでした。ポップアップを許可してください");
      return;
    }
    printWindow.document.write("紙の誓約書を準備しています...");
    setSaving(true);
    setMessage("");
    try {
      const savedTemplateId = await saveTemplate(false);
      printWindow.location.href = `/admin/pledges/print?template_id=${encodeURIComponent(savedTemplateId)}`;
    } catch (error) {
      printWindow.close();
      setMessage(error instanceof Error ? error.message : "印刷画面を開けませんでした");
    } finally {
      setSaving(false);
    }
  }

  async function sendPledge(isTest: boolean) {
    if (!isTest && targetCount === 0) {
      setMessage("送信対象者を選択してください");
      return;
    }
    const targetText = isTest ? "佐藤正彦だけにテスト配信" : `${targetCount}名に配信`;
    if (!window.confirm(`${targetText}します。よろしいですか？`)) return;
    setSaving(true);
    setMessage("");
    try {
      const savedTemplateId = await saveTemplate(false);
      const requestBody: Record<string, unknown> = {
        action: isTest ? "send_test" : "send",
        template_id: savedTemplateId,
      };
      if (!isTest) {
        if (targetMode === "all") requestBody.target_type = "all";
        else if (targetMode === "individual") {
          requestBody.target_type = "individual";
          requestBody.user_ids = [...selectedUserIds];
        } else {
          requestBody.target_type = "department";
          requestBody.department = targetMode;
        }
      }
      const response = await fetch("/api/admin/pledges", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || "誓約書を配信できませんでした");
      setMessage(isTest ? "佐藤正彦だけにテスト配信しました" : `${data.recipients}名へ誓約書を配信しました`);
      await load(savedTemplateId);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "誓約書を配信できませんでした");
    } finally {
      setSaving(false);
    }
  }

  function toggleUser(userId: string) {
    setSelectedUserIds((current) => {
      const next = new Set(current);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  return (
    <div className="pledge-admin">
      <section className="pledge-admin__heading">
        <div>
          <span>Agreement Management</span>
          <h2>誓約管理</h2>
          <p>本文と確認項目を編集し、対象者へ配信します。</p>
        </div>
        <FileCheck2 size={30} aria-hidden="true" />
      </section>

      {message && <div className="admin-message">{message}</div>}

      <section className="pledge-template-manager">
        <div className="pledge-template-manager__heading">
          <div>
            <span>誓約書一覧</span>
            <strong>{payload.templates.filter((template) => template.is_active).length}件 使用中</strong>
          </div>
          <button type="button" className="btn-primary" onClick={handleNewTemplate} disabled={saving || loading}>
            <FilePlus2 size={17} aria-hidden="true" />新しい誓約書
          </button>
        </div>
        <div className="pledge-template-manager__controls">
          <label className="pledge-template-select">
            <span>編集する誓約書</span>
            <select value={templateId} onChange={(event) => handleTemplateChange(event.target.value)} disabled={saving || loading}>
              {!templateId && <option value="">新しい誓約書（未保存）</option>}
              {payload.templates.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.title}{template.is_active ? "" : "（保管済み）"}
                </option>
              ))}
            </select>
          </label>
          <div className="pledge-template-manager__actions">
            <button type="button" className="admin-btn-outline" onClick={handleDuplicateTemplate} disabled={saving || loading || !title.trim()}>
              <Copy size={16} aria-hidden="true" />複製
            </button>
            {currentTemplate && (
              <button
                type="button"
                className="admin-btn-outline"
                onClick={() => void setTemplateActive(!currentTemplate.is_active)}
                disabled={saving || loading}
              >
                {currentTemplate.is_active ? <Archive size={16} aria-hidden="true" /> : <RotateCcw size={16} aria-hidden="true" />}
                {currentTemplate.is_active ? "保管" : "使用を再開"}
              </button>
            )}
          </div>
        </div>
        <p>誓約書ごとに本文・確認項目・配信履歴を分けて管理します。保管しても過去の提出記録は削除されません。</p>
      </section>

      <section className="pledge-editor">
        <div className="pledge-editor__title">
          <div>
            <h3>{templateId ? "誓約内容を編集" : "新しい誓約書を作成"}</h3>
            {hasUnsavedChanges && <p className="pledge-editor__unsaved">未保存の変更があります</p>}
          </div>
          <div className="pledge-editor__actions">
            <button type="button" className="admin-btn-outline" onClick={() => void handlePaperPrint()} disabled={saving || loading || currentTemplate?.is_active === false}>
              <Printer size={16} aria-hidden="true" />紙で印刷
            </button>
            <button type="button" className="btn-primary" onClick={handleSave} disabled={saving || loading}>保存</button>
          </div>
        </div>
        <label className="pledge-field">
          <span>タイトル</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={180} />
        </label>
        <label className="pledge-field">
          <span>本文</span>
          <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={12} />
        </label>
        <div className="pledge-check-editor">
          <div className="pledge-check-editor__header">
            <span>チェック項目</span>
            <button type="button" className="admin-btn-outline" onClick={() => setItems((current) => [...current, { id: newItemId(), text: "" }])}>
              <Plus size={15} aria-hidden="true" />追加
            </button>
          </div>
          {items.map((item, index) => (
            <div key={item.id} className="pledge-check-editor__row">
              <span>{index + 1}</span>
              <textarea
                value={item.text}
                rows={2}
                onChange={(event) => setItems((current) => current.map((row) => row.id === item.id ? { ...row, text: event.target.value } : row))}
              />
              <button type="button" className="admin-icon-danger" title="削除" onClick={() => setItems((current) => current.filter((row) => row.id !== item.id))}>
                <Trash2 size={16} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
        <div className="pledge-editor__footer-fields">
          <label className="pledge-field">
            <span>同意ボタン</span>
            <input value={agreementLabel} onChange={(event) => setAgreementLabel(event.target.value)} maxLength={180} />
          </label>
          <label className="pledge-field">
            <span>会社名</span>
            <input value={companyName} onChange={(event) => setCompanyName(event.target.value)} maxLength={180} />
          </label>
        </div>
      </section>

      <section className="pledge-delivery">
        <div className="pledge-editor__title">
          <div><h3>送信先</h3><p>選択中 {targetCount}名</p></div>
          <button type="button" className="admin-btn-outline pledge-test-btn" onClick={() => void sendPledge(true)} disabled={saving || loading || currentTemplate?.is_active === false}>
            <TestTube2 size={16} aria-hidden="true" />テスト送信
          </button>
        </div>
        <div className="pledge-target-tabs">
          <button type="button" className={targetMode === "all" ? "active" : ""} onClick={() => setTargetMode("all")}>全員</button>
          {USER_DEPARTMENTS.map((department) => (
            <button key={department} type="button" className={targetMode === department ? "active" : ""} onClick={() => setTargetMode(department)}>{department}</button>
          ))}
          <button type="button" className={targetMode === "individual" ? "active" : ""} onClick={() => setTargetMode("individual")}>個別</button>
        </div>
        {targetMode === "individual" && (
          <div className="pledge-user-grid">
            {payload.users.map((user) => (
              <button key={user.id} type="button" className={selectedUserIds.has(user.id) ? "selected" : ""} onClick={() => toggleUser(user.id)}>
                <strong>{user.display_name}</strong><span>{user.department}</span>
              </button>
            ))}
          </div>
        )}
        <button type="button" className="pledge-send-btn" onClick={() => void sendPledge(false)} disabled={saving || loading || targetCount === 0 || currentTemplate?.is_active === false}>
          <Send size={18} aria-hidden="true" />{targetCount}名へ誓約書を送信
        </button>
      </section>

      <section className="pledge-status">
        <div className="pledge-status__heading">
          <div>
            <h3>提出状況</h3>
            <p>送信から7日で警告、14日で最終警告になります。テスト送信は集計に含みません。</p>
          </div>
          <button type="button" className="admin-btn-outline" onClick={() => void load(templateId)} disabled={loading || saving}>更新</button>
        </div>

        <div className="pledge-status__summary">
          <div><Clock3 size={18} aria-hidden="true" /><strong>{statusSummary.pending}</strong><span>未提出</span></div>
          <div><AlertTriangle size={18} aria-hidden="true" /><strong>{statusSummary.warning}</strong><span>7日警告</span></div>
          <div><ShieldAlert size={18} aria-hidden="true" /><strong>{statusSummary.final}</strong><span>14日最終警告</span></div>
          <div><CheckCircle2 size={18} aria-hidden="true" /><strong>{statusSummary.submitted}</strong><span>提出済み</span></div>
        </div>

        <div className="pledge-status__filters" role="tablist" aria-label="提出状況の絞り込み">
          <button type="button" className={statusFilter === "pending" ? "active" : ""} onClick={() => setStatusFilter("pending")}>未提出</button>
          <button type="button" className={statusFilter === "all" ? "active" : ""} onClick={() => setStatusFilter("all")}>全件</button>
          <button type="button" className={statusFilter === "submitted" ? "active" : ""} onClick={() => setStatusFilter("submitted")}>提出済み</button>
        </div>

        {filteredDeliveries.length === 0 && <p className="admin-empty">該当する提出状況はありません</p>}
        <div className="pledge-status__deliveries">
          {filteredDeliveries.map((delivery, index) => (
            <details key={delivery.id} className="pledge-status__delivery" open={index === 0}>
              <summary>
                <div>
                  <strong>{delivery.title_snapshot}</strong>
                  <span>{delivery.is_test ? "テスト / " : ""}{delivery.target_label || "-"}</span>
                </div>
                <div>
                  <strong>{delivery.submitted}/{delivery.total}</strong>
                  <span>{new Date(delivery.sent_at).toLocaleString("ja-JP")} 送信</span>
                </div>
              </summary>
              <div className="pledge-status__people">
                {delivery.visibleAssignments.map((assignment) => (
                  <div key={assignment.id} className={`pledge-status__person pledge-status__person--${assignment.reminder_level}`}>
                    <div>
                      <strong>{assignment.recipient_name}</strong>
                      <span>{assignment.recipient_department || "所属なし"}</span>
                    </div>
                    <span className={`pledge-status__badge pledge-status__badge--${assignment.reminder_level}`}>
                      {assignment.reminder_level === "submitted"
                        ? assignment.signed_attachment?.source === "doc-scanner-paper-pledge" ? "紙提出" : "提出済み"
                        : assignment.reminder_level === "final" ? "最終警告"
                          : assignment.reminder_level === "warning" ? "警告" : "未提出"}
                    </span>
                    <div className="pledge-status__submitted-at">
                      <time>
                        {assignment.status === "submitted" && assignment.pledged_at
                          ? `${new Date(assignment.pledged_at).toLocaleString("ja-JP")} 提出`
                          : `送信から${assignment.elapsed_days}日`}
                      </time>
                      {assignment.signed_attachment?.source === "doc-scanner-paper-pledge" && (
                        <a href={`/api/admin/pledges/paper?assignment_id=${encodeURIComponent(assignment.id)}`} target="_blank" rel="noreferrer">
                          原本 <ExternalLink size={13} aria-hidden="true" />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </details>
          ))}
        </div>
      </section>
    </div>
  );
}
