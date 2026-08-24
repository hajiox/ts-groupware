"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Ban,
  CalendarDays,
  Check,
  HeartHandshake,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  BEREAVEMENT_POLICY_ROWS,
  BEREAVEMENT_RELATIONSHIPS,
} from "@/lib/bereavement-leave";

type BereavementEmployee = {
  id: string;
  user_id: string | null;
  employee_code: string | null;
  display_name: string;
  real_name: string | null;
  department: string | null;
  work_style: string | null;
  payroll_status: string;
};

type BereavementRequest = {
  id: string;
  employee_id: string;
  user_id: string;
  relationship_code: string;
  relationship_label: string;
  relationship_degree: number;
  entitled_days: number;
  leave_start_date: string;
  leave_end_date: string;
  requested_days: number;
  request_status: "submitted" | "approved" | "rejected" | "cancelled";
  employee_memo: string | null;
  manager_memo: string | null;
  requested_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  cancelled_at: string | null;
  counting_method?: "calendar_days" | "confirmed_workdays";
  applied_dates?: {
    request_id: string;
    work_date: string;
    shift_label_snapshot: string | null;
    scheduled_minutes_snapshot: number | null;
  }[];
  employee?: BereavementEmployee | null;
};

type WorkdayPreview = {
  requestedStartDate: string;
  leaveStartDate: string;
  leaveEndDate: string;
  requestedDays: number;
  appliedDates: string[];
  skippedDates: string[];
};

type Payload = {
  canManage: boolean;
  eligibility: {
    eligible: boolean;
    reason: string | null;
    employee: BereavementEmployee | null;
  };
  ownRequests: BereavementRequest[];
  employees: BereavementEmployee[];
  requests: BereavementRequest[];
};

const STATUS_LABELS: Record<BereavementRequest["request_status"], string> = {
  submitted: "承認待ち",
  approved: "承認済み",
  rejected: "却下",
  cancelled: "取消済み",
};

function todayInJapan() {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function formatDateRange(startDate: string, endDate: string) {
  return startDate === endDate ? startDate : `${startDate}〜${endDate}`;
}

function workStyleLabel(value: string | null | undefined) {
  if (value === "regular_5d_8h") return "5日正社員";
  if (value === "regular_6d_6_5h") return "6日正社員";
  return "対象外";
}

export function BereavementLeaveTab() {
  const initialDate = todayInJapan();
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState("");
  const [message, setMessage] = useState("");
  const [relationshipCode, setRelationshipCode] = useState("");
  const [startDate, setStartDate] = useState(initialDate);
  const [requestedDays, setRequestedDays] = useState(1);
  const [preview, setPreview] = useState<WorkdayPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [employeeMemo, setEmployeeMemo] = useState("");
  const [reviewMemos, setReviewMemos] = useState<Record<string, string>>({});
  const [showProcessed, setShowProcessed] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/bereavement-leave", { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "忌引き休暇を読み込めませんでした");
      setPayload(data);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "忌引き休暇を読み込めませんでした");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedRelationship = useMemo(
    () => BEREAVEMENT_RELATIONSHIPS.find((item) => item.code === relationshipCode) || null,
    [relationshipCode],
  );
  const dateRangeIsValid = Boolean(
    selectedRelationship
    && preview
    && requestedDays >= 1
    && requestedDays <= selectedRelationship.entitledDays,
  );
  const pendingRequests = useMemo(
    () => (payload?.requests || []).filter((row) => row.request_status === "submitted"),
    [payload],
  );
  const processedRequests = useMemo(
    () => (payload?.requests || []).filter((row) => row.request_status !== "submitted"),
    [payload],
  );

  useEffect(() => {
    if (!selectedRelationship || !startDate || requestedDays < 1 || requestedDays > selectedRelationship.entitledDays) {
      setPreview(null);
      setPreviewError("");
      return;
    }

    const controller = new AbortController();
    setPreviewLoading(true);
    setPreviewError("");
    const timeout = window.setTimeout(() => {
      fetch("/api/bereavement-leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "preview",
          relationship_code: selectedRelationship.code,
          leave_start_date: startDate,
          requested_days: requestedDays,
        }),
        signal: controller.signal,
      })
        .then(async (response) => {
          const data = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(data.error || "対象勤務日を確認できませんでした");
          setPreview(data.selection || null);
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          setPreview(null);
          setPreviewError(error instanceof Error ? error.message : "対象勤務日を確認できませんでした");
        })
        .finally(() => setPreviewLoading(false));
    }, 200);

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [requestedDays, selectedRelationship, startDate]);

  async function post(body: Record<string, unknown>, successMessage: string, key: string) {
    setBusyKey(key);
    setMessage("");
    try {
      const response = await fetch("/api/bereavement-leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "忌引き休暇を更新できませんでした");
      setMessage(successMessage);
      await load();
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "忌引き休暇を更新できませんでした");
      return false;
    } finally {
      setBusyKey("");
    }
  }

  async function submitRequest() {
    if (!dateRangeIsValid || !selectedRelationship) return;
    const submitted = await post({
      action: "submit",
      relationship_code: selectedRelationship.code,
      leave_start_date: startDate,
      requested_days: requestedDays,
      employee_memo: employeeMemo,
    }, "忌引き休暇を申請しました", "submit");
    if (submitted) {
      setRelationshipCode("");
      setStartDate(initialDate);
      setRequestedDays(1);
      setPreview(null);
      setEmployeeMemo("");
    }
  }

  async function reviewRequest(row: BereavementRequest, approved: boolean) {
    if (!approved && !window.confirm(`${row.employee?.real_name || row.employee?.display_name || "スタッフ"}さんの申請を却下しますか？`)) return;
    await post({
      action: approved ? "approve" : "reject",
      request_id: row.id,
      manager_memo: reviewMemos[row.id] || "",
    }, approved ? "忌引き休暇を承認しました" : "忌引き休暇を却下しました", `review:${row.id}`);
  }

  async function cancelRequest(row: BereavementRequest, manager = false) {
    if (!window.confirm(`${formatDateRange(row.leave_start_date, row.leave_end_date)}の忌引き休暇申請を取り消しますか？`)) return;
    await post({
      action: "cancel",
      request_id: row.id,
      manager_memo: manager ? reviewMemos[row.id] || "" : "",
    }, "忌引き休暇申請を取り消しました", `cancel:${row.id}`);
  }

  function RequestSummary({ row, manager = false }: { row: BereavementRequest; manager?: boolean }) {
    const employeeName = row.employee?.real_name || row.employee?.display_name;
    return (
      <article className={`bereavement-request bereavement-request--${row.request_status}`}>
        <div className="bereavement-request__main">
          <div className="bereavement-request__heading">
            <strong>{manager && employeeName ? employeeName : `${row.relationship_label}（${row.relationship_degree}親等）`}</strong>
            <span className={`bereavement-status bereavement-status--${row.request_status}`}>
              {STATUS_LABELS[row.request_status]}
            </span>
          </div>
          {manager && (
            <small>
              {row.employee?.department || "所属未設定"} / {workStyleLabel(row.employee?.work_style)}
              {row.employee?.employee_code ? ` / 社員NO ${row.employee.employee_code}` : ""}
            </small>
          )}
          <p>
            <CalendarDays size={16} aria-hidden="true" />
            {formatDateRange(row.leave_start_date, row.leave_end_date)}
            <b>{row.requested_days}日</b>
          </p>
          {row.applied_dates && row.applied_dates.length > 0 && (
            <div className="bereavement-request__applied">
              <small>対象勤務日</small>
              <div>
                {row.applied_dates.map((day) => (
                  <span key={day.work_date}>{day.work_date.slice(5).replace("-", "/")}</span>
                ))}
              </div>
            </div>
          )}
          {manager && <p className="bereavement-request__relationship">{row.relationship_label} / {row.relationship_degree}親等</p>}
          {row.employee_memo && <p className="bereavement-request__memo">本人：{row.employee_memo}</p>}
          {row.manager_memo && <p className="bereavement-request__memo">管理者：{row.manager_memo}</p>}
        </div>
        {manager && row.request_status === "submitted" && (
          <div className="bereavement-request__review">
            <input
              type="text"
              value={reviewMemos[row.id] || ""}
              onChange={(event) => setReviewMemos((current) => ({ ...current, [row.id]: event.target.value }))}
              placeholder="管理者メモ（任意）"
              maxLength={500}
            />
            <button
              type="button"
              className="btn-primary"
              disabled={Boolean(busyKey)}
              onClick={() => void reviewRequest(row, true)}
            >
              <Check size={16} /> 承認
            </button>
            <button
              type="button"
              className="admin-btn-outline"
              disabled={Boolean(busyKey)}
              onClick={() => void reviewRequest(row, false)}
            >
              <X size={16} /> 却下
            </button>
          </div>
        )}
        {manager && row.request_status === "approved" && (
          <button
            type="button"
            className="admin-btn-danger"
            disabled={Boolean(busyKey)}
            onClick={() => void cancelRequest(row, true)}
          >
            <Ban size={15} /> 承認を取消
          </button>
        )}
        {!manager && row.request_status === "submitted" && (
          <button
            type="button"
            className="admin-btn-outline"
            disabled={Boolean(busyKey)}
            onClick={() => void cancelRequest(row)}
          >
            申請を取り消す
          </button>
        )}
      </article>
    );
  }

  return (
    <div className="bereavement-leave">
      <section className="admin-panel bereavement-leave__heading">
        <div>
          <span className="admin-payroll-kicker">Bereavement Leave</span>
          <h3 className="admin-section-title">忌引き休暇</h3>
          <p>正社員を対象に、確定シフトの勤務日だけを数えて申請・承認します。</p>
        </div>
        <button type="button" className="admin-icon-btn" onClick={() => void load()} disabled={loading} aria-label="更新">
          <RefreshCw size={18} />
        </button>
      </section>

      {message && <div className="admin-message">{message}</div>}

      <section className="admin-panel bereavement-policy">
        <div className="admin-panel__header">
          <div>
            <h4><HeartHandshake size={18} /> 忌引き休暇規定</h4>
            <p>開始日と日数を選びます。元々の休みは日数に含めず、有給残も消費しません。</p>
          </div>
          <span className="bereavement-policy__target">正社員のみ</span>
        </div>
        <div className="bereavement-policy__table" role="table" aria-label="忌引き休暇規定">
          <div role="row" className="bereavement-policy__row bereavement-policy__row--header">
            <span role="columnheader">親等</span>
            <span role="columnheader">主な親族</span>
            <span role="columnheader">日数</span>
          </div>
          {BEREAVEMENT_POLICY_ROWS.map((row) => (
            <div role="row" className="bereavement-policy__row" key={row.degree}>
              <span role="cell">{row.degree}</span>
              <span role="cell">{row.relationships}</span>
              <strong role="cell">{row.days}</strong>
            </div>
          ))}
        </div>
      </section>

      {loading && !payload ? (
        <section className="admin-panel"><p className="admin-empty">忌引き休暇を読み込み中...</p></section>
      ) : payload ? (
        <>
          {payload.eligibility.eligible ? (
            <section className="admin-panel bereavement-application">
              <div className="admin-panel__header">
                <div>
                  <h4>忌引き休暇を申請</h4>
                  <p>
                    {payload.eligibility.employee?.real_name || payload.eligibility.employee?.display_name}
                    {" / "}
                    {workStyleLabel(payload.eligibility.employee?.work_style)}
                  </p>
                </div>
                <ShieldCheck size={20} />
              </div>
              <div className="bereavement-form">
                <label>
                  <span>亡くなられた方との続柄</span>
                  <select
                    value={relationshipCode}
                    onChange={(event) => {
                      const code = event.target.value;
                      const relationship = BEREAVEMENT_RELATIONSHIPS.find((item) => item.code === code);
                      setRelationshipCode(code);
                      setRequestedDays(relationship?.entitledDays || 1);
                      setPreview(null);
                    }}
                  >
                    <option value="">選択してください</option>
                    {BEREAVEMENT_RELATIONSHIPS.map((item) => (
                      <option key={item.code} value={item.code}>
                        {item.label}（{item.degree}親等・最大{item.entitledDays}日）
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>取得開始日</span>
                  <input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} />
                </label>
                <label>
                  <span>取得する勤務日数</span>
                  <select
                    value={requestedDays}
                    onChange={(event) => setRequestedDays(Number(event.target.value))}
                    disabled={!selectedRelationship}
                  >
                    {Array.from({ length: selectedRelationship?.entitledDays || 1 }, (_, index) => index + 1).map((days) => (
                      <option value={days} key={days}>{days}日</option>
                    ))}
                  </select>
                </label>
                <label className="bereavement-form__memo">
                  <span>連絡事項（任意）</span>
                  <textarea
                    value={employeeMemo}
                    onChange={(event) => setEmployeeMemo(event.target.value)}
                    placeholder="管理者への連絡"
                    maxLength={500}
                  />
                </label>
              </div>
              <div className={`bereavement-form__summary${dateRangeIsValid ? " is-valid" : ""}`}>
                <span>忌引き対象の勤務日</span>
                <strong>
                  {previewLoading
                    ? "確認中..."
                    : preview
                      ? `${preview.requestedDays}日`
                      : "確定シフトを確認"}
                </strong>
                <small>
                  {preview
                    ? preview.appliedDates.map((date) => date.slice(5).replace("-", "/")).join("・")
                    : previewError || (selectedRelationship
                      ? `${selectedRelationship.label}は最大${selectedRelationship.entitledDays}日`
                      : "続柄を選択してください")}
                </small>
                {preview && preview.skippedDates.length > 0 && (
                  <em>元々の休み {preview.skippedDates.length}日を除外</em>
                )}
              </div>
              <button
                type="button"
                className="btn-primary bereavement-form__submit"
                disabled={!dateRangeIsValid || Boolean(busyKey)}
                onClick={() => void submitRequest()}
              >
                <HeartHandshake size={18} /> 申請する
              </button>
            </section>
          ) : (
            <section className="admin-panel bereavement-ineligible">
              <strong>申請対象外</strong>
              <p>{payload.eligibility.reason}</p>
            </section>
          )}

          <section className="admin-panel">
            <div className="admin-panel__header">
              <div>
                <h4>自分の申請履歴</h4>
                <p>承認待ちの申請は本人が取り消せます。承認後の変更は管理者へ連絡してください。</p>
              </div>
              <strong>{payload.ownRequests.length}件</strong>
            </div>
            <div className="bereavement-request-list">
              {payload.ownRequests.length
                ? payload.ownRequests.map((row) => <RequestSummary row={row} key={row.id} />)
                : <p className="admin-empty">忌引き休暇の申請履歴はありません</p>}
            </div>
          </section>

          {payload.canManage && (
            <section className="admin-panel bereavement-management">
              <div className="admin-panel__header">
                <div>
                  <h4>申請の承認・履歴</h4>
                  <p>正社員の申請だけが表示されます。承認済みの申請は管理者が取り消せます。</p>
                </div>
                <strong>{pendingRequests.length}件待ち</strong>
              </div>
              <div className="bereavement-request-list">
                {pendingRequests.length
                  ? pendingRequests.map((row) => <RequestSummary row={row} key={row.id} manager />)
                  : <p className="admin-empty">承認待ちの忌引き休暇はありません</p>}
              </div>
              {processedRequests.length > 0 && (
                <>
                  <button
                    type="button"
                    className="admin-btn-outline bereavement-management__history-toggle"
                    onClick={() => setShowProcessed((current) => !current)}
                  >
                    {showProcessed ? "処理済み履歴を閉じる" : `処理済み履歴を見る（${processedRequests.length}件）`}
                  </button>
                  {showProcessed && (
                    <div className="bereavement-request-list bereavement-request-list--processed">
                      {processedRequests.map((row) => <RequestSummary row={row} key={row.id} manager />)}
                    </div>
                  )}
                </>
              )}
            </section>
          )}
        </>
      ) : null}
    </div>
  );
}
