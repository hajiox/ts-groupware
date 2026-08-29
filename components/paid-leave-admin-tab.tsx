"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarDays, Check, Eye, RefreshCw, RotateCcw, Users } from "lucide-react";

type EmployeeOption = {
  id: string;
  user_id: string;
  employee_code: string | null;
  name: string;
  hire_date: string | null;
  department: string | null;
  work_style: string | null;
  pendingCount: number;
  availableDays: number;
  nextGrantDate: string | null;
  projectedGrantDays: number;
};

type LeaveRequest = {
  id: string;
  leave_date: string;
  leave_unit: string;
  requested_days: number | string;
  request_source: string;
  request_status: string;
  paid_wage_amount: number | string | null;
  employee_memo: string | null;
  manager_memo: string | null;
};

type Resolution = {
  id: string;
  work_date: string;
  resolution_type: string;
  resolution_status: string;
  employee_memo: string | null;
  manager_memo: string | null;
  raw_payload: {
    attendance_issue?: {
      issue_kind?: string;
      scheduled_start_time?: string | null;
      scheduled_end_time?: string | null;
      actual_start_time?: string | null;
      actual_end_time?: string | null;
      late_minutes?: number | string | null;
      early_leave_minutes?: number | string | null;
    };
  } | null;
};

type AttendanceIssue = {
  assignmentId: string;
  periodId: string;
  workDate: string;
  shiftLabel: string | null;
  startTime: string | null;
  endTime: string | null;
  scheduledMinutes: number | null;
  actualStartTime: string | null;
  actualEndTime: string | null;
  lateMinutes: number;
  earlyLeaveMinutes: number;
  issueKind: string;
  managerNote: string | null;
  possibleReplacementDates: string[];
};

type DeviationTotals = {
  lateCount: number;
  earlyLeaveCount: number;
  missingPunchCount: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
};

type Dashboard = {
  today: string;
  employee: {
    id: string;
    userId: string;
    employeeCode: string | null;
    name: string;
    hireDate: string | null;
    department: string | null;
    workStyle: string | null;
  };
  profile: {
    next_grant_date: string | null;
    projected_grant_days: number | string | null;
  } | null;
  balance: {
    availableDays: number;
    allocatedDays: number;
    expiredUnusedDays: number;
  };
  grants: {
    id: string;
    grant_date: string;
    granted_days: number | string;
    grant_source: string;
    grant_status: string;
    notes: string | null;
  }[];
  requests: LeaveRequest[];
  resolutions: Resolution[];
  unresolved: AttendanceIssue[];
  attendanceReconciliation: {
    missingScheduledDays: number;
    unscheduledWorkedDates: string[];
    unexplainedDayDeficit: number;
  };
  attendanceDeviations: {
    month: DeviationTotals;
    year: DeviationTotals;
    sinceSystemStart: DeviationTotals;
  };
  absences: {
    month: number;
    year: number;
    tenure: number;
  };
  attendance: {
    rate: number | null;
    numeratorDays: number;
    denominatorDays: number;
    referenceStart: string;
    referenceEnd: string;
    isMeasuring: boolean;
    measurementReadyDate: string;
  };
  average: {
    averageMinutesPerDay: number | null;
    averageWagePerDay: number | null;
    hourlyRate: number | null;
    source: string;
    workedDays: number;
    referenceStart: string;
    referenceEnd: string;
    isNetWorkTime: boolean;
    includedInMonthlySalary: boolean;
  };
};

type AdminPayload = {
  employees: EmployeeOption[];
  dashboard: Dashboard | null;
  canViewAs: boolean;
  canApprovePaidLeave: boolean;
  approvableRequestIds: string[];
  canRegisterSelectedEmployee: boolean;
  canConfirmSelectedResolution: boolean;
};

const RESOLUTION_LABELS: Record<string, string> = {
  punch_missing: "打刻忘れ",
  punch_correction: "打刻修正",
  paid_leave_full: "有給（全休）",
  paid_leave_half: "有給（半休）",
  bereavement_leave: "忌引き休",
  absence: "欠勤",
  work_schedule_changed: "勤務時間変更の承認",
  employer_shutdown: "会社都合休業",
};

const REQUEST_STATUS_LABELS: Record<string, string> = {
  draft: "下書き",
  submitted: "承認待ち",
  approved: "承認済み",
  rejected: "却下",
  cancelled: "取消",
  consumed: "取得済み",
  voided: "無効",
};

const REQUEST_SOURCE_LABELS: Record<string, string> = {
  shift_preference: "シフト希望",
  employee: "本人申請",
  admin: "管理調整",
  missing_punch_resolution: "打刻確認",
  import: "移行データ",
};

function formatMinutes(value: number | null) {
  if (value === null) return "未集計";
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${hours}時間${minutes ? `${minutes}分` : ""}`;
}

function formatMoney(value: number | null) {
  return value === null ? "未設定" : `${Math.round(value).toLocaleString("ja-JP")}円`;
}

function formatPeriod(start: string, end: string) {
  return `${start.slice(5).replace("-", "/")}〜${end.slice(5).replace("-", "/")}`;
}

function formatDays(value: number) {
  return Number(value || 0).toLocaleString("ja-JP", { maximumFractionDigits: 1 });
}

function formatDate(value: string | null) {
  return value ? value.replaceAll("-", "/") : "未設定";
}

export function PaidLeaveAdminTab() {
  const [payload, setPayload] = useState<AdminPayload | null>(null);
  const [selectedUserId, setSelectedUserId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [grantDays, setGrantDays] = useState("");
  const [grantDate, setGrantDate] = useState("");
  const [grantMemo, setGrantMemo] = useState("");
  const [leaveDate, setLeaveDate] = useState("");
  const [leaveUnit, setLeaveUnit] = useState<"full_day" | "half_day">("full_day");
  const [leaveMemo, setLeaveMemo] = useState("");
  const [resolutionMemos, setResolutionMemos] = useState<Record<string, string>>({});

  const load = useCallback(async (nextUserId = selectedUserId) => {
    setLoading(true);
    const params = new URLSearchParams();
    if (nextUserId) params.set("user_id", nextUserId);
    try {
      const response = await fetch(`/api/admin/paid-leave?${params.toString()}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "有給管理を読み込めませんでした");
      setPayload(data);
      const resolvedUserId = nextUserId || data.dashboard?.employee?.userId || data.employees?.[0]?.user_id || "";
      setSelectedUserId(resolvedUserId);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "有給管理を読み込めませんでした");
    } finally {
      setLoading(false);
    }
  }, [selectedUserId]);

  useEffect(() => {
    void load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function post(
    body: Record<string, unknown>,
    successMessage: string | ((data: Record<string, unknown>) => string),
  ) {
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/paid-leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "更新できませんでした");
      setMessage(typeof successMessage === "function" ? successMessage(data) : successMessage);
      await load(selectedUserId);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "更新できませんでした");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function registerEmployeeLeave() {
    if (!dashboard || !leaveDate) return;
    const success = await post({
      action: "register_employee_leave",
      employee_id: dashboard.employee.id,
      leave_date: leaveDate,
      leave_unit: leaveUnit,
      memo: leaveMemo,
    }, (data) => data.approvalPending
      ? "有給申請を登録しました。所属長の承認待ちです。"
      : "有給を承認し、残日数と確定シフトへ反映しました。");
    if (success) {
      setLeaveDate("");
      setLeaveUnit("full_day");
      setLeaveMemo("");
    }
  }

  async function resolveUnansweredIssue(issue: AttendanceIssue, resolutionType: "absence" | "work_schedule_changed") {
    if (!dashboard) return;
    const managerMemo = resolutionMemos[issue.assignmentId]?.trim() || "";
    if (resolutionType === "work_schedule_changed" && !managerMemo) {
      setMessage("勤務日変更の内容を入力してください。");
      return;
    }
    if (
      resolutionType === "absence"
      && !window.confirm(`${issue.workDate}を欠勤として確定します。給与・出勤率へ反映してよいですか？`)
    ) return;
    await post({
      action: "resolve_unanswered_issue",
      employee_id: dashboard.employee.id,
      assignment_id: issue.assignmentId,
      work_date: issue.workDate,
      resolution_type: resolutionType,
      manager_memo: managerMemo,
    }, resolutionType === "absence" ? "欠勤として確定しました" : "勤務日変更として確定しました");
  }

  function preparePaidLeave(issue: AttendanceIssue) {
    setLeaveDate(issue.workDate);
    setLeaveUnit(issue.issueKind === "missing_all" ? "full_day" : "half_day");
    setLeaveMemo(resolutionMemos[issue.assignmentId]?.trim() || issue.managerNote || "勤怠差異から管理者設定");
    requestAnimationFrame(() => document.getElementById("leave-admin-register")?.scrollIntoView({ behavior: "smooth", block: "center" }));
  }

  const dashboard = payload?.dashboard || null;
  const selectedEmployee = useMemo(
    () => payload?.employees.find((employee) => employee.user_id === selectedUserId) || null,
    [payload?.employees, selectedUserId],
  );
  const employeesByDepartment = useMemo(() => {
    const employees = payload?.employees || [];
    const departments = ["フロア", "製造", "道の駅"];
    const groups = departments.map((department) => ({
      department,
      employees: employees.filter((employee) => employee.department === department),
    }));
    const unassigned = employees.filter((employee) => !departments.includes(employee.department || ""));
    if (unassigned.length) groups.push({ department: "所属未設定", employees: unassigned });
    return groups;
  }, [payload?.employees]);
  const pendingResolutions = dashboard?.resolutions.filter((row) => ["employee_answered", "reopened"].includes(row.resolution_status)) || [];
  const upcomingGrant = dashboard
    ? [...dashboard.grants]
      .filter((grant) => grant.grant_status === "granted" && grant.grant_date > dashboard.today)
      .sort((left, right) => left.grant_date.localeCompare(right.grant_date))[0] || null
    : null;

  return (
    <div className="leave-admin">
      <section className="admin-panel leave-admin__heading">
        <div>
          <span className="admin-payroll-kicker">Paid Leave</span>
          <h3 className="admin-section-title">有給・欠勤管理</h3>
          <p>法定付与、残日数、未打刻回答、欠勤履歴をスタッフ別に確認します。</p>
        </div>
        <button type="button" className="admin-icon-btn" onClick={() => void load()} disabled={loading} aria-label="更新">
          <RefreshCw size={18} />
        </button>
      </section>

      {message && <div className="admin-message">{message}</div>}

      <section className="admin-panel leave-admin__balances">
        <div className="admin-panel__header">
          <div>
            <h4><Users size={17} /> 全員の有給残日数</h4>
            <p>スタッフを押すと、下の個人詳細を開きます。</p>
          </div>
          <strong>{payload?.employees.length || 0}名</strong>
        </div>
        {loading && !payload ? (
          <p className="admin-empty">残日数を読み込み中...</p>
        ) : (
          <div className="leave-balance-groups">
            {employeesByDepartment.map((group) => (
              <div className="leave-balance-group" key={group.department}>
                <div className="leave-balance-group__heading">
                  <strong>{group.department}</strong>
                  <span>{group.employees.length}名</span>
                </div>
                {group.employees.length === 0 ? (
                  <p className="admin-empty">対象者なし</p>
                ) : group.employees.map((employee) => (
                  <button
                    type="button"
                    className={`leave-balance-row${employee.user_id === selectedUserId ? " leave-balance-row--selected" : ""}`}
                    key={employee.id}
                    onClick={() => {
                      setSelectedUserId(employee.user_id);
                      void load(employee.user_id);
                    }}
                    disabled={loading}
                  >
                    <span className="leave-balance-row__identity">
                      <strong>{employee.name}</strong>
                      <small>
                        {employee.employee_code ? `社員NO ${employee.employee_code}` : "社員NO未設定"}
                        {employee.pendingCount ? ` / 未確認${employee.pendingCount}` : ""}
                      </small>
                      <small>入社日 {formatDate(employee.hire_date)}</small>
                    </span>
                    <span className="leave-balance-row__figures">
                      <em>{formatDays(employee.availableDays)}日</em>
                      <small className="leave-balance-row__next">
                        <span>次回 {formatDate(employee.nextGrantDate)}</span>
                        {employee.nextGrantDate && <span>+{formatDays(employee.projectedGrantDays)}日</span>}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="admin-panel leave-admin__selector">
        <label>
          <span>スタッフ</span>
          <select
            className="admin-select"
            value={selectedUserId}
            onChange={(event) => {
              const next = event.target.value;
              setSelectedUserId(next);
              void load(next);
            }}
          >
            {(payload?.employees || []).map((employee) => (
              <option key={employee.id} value={employee.user_id}>
                {employee.name} / {employee.department || "所属未設定"}{employee.pendingCount ? ` / 未確認${employee.pendingCount}` : ""}
              </option>
            ))}
          </select>
        </label>
        {payload?.canViewAs && selectedUserId && (
          <a className="admin-btn-outline leave-admin__view-as" href={`/leave?user_id=${encodeURIComponent(selectedUserId)}`}>
            <Eye size={16} /> 本人画面で確認
          </a>
        )}
      </section>

      {loading ? (
        <section className="admin-panel"><p className="admin-empty">読み込み中...</p></section>
      ) : dashboard ? (
        <>
          <section className="leave-summary-grid">
            <article><span>有給残</span><strong>{formatDays(dashboard.balance.availableDays)}日</strong></article>
            <article>
              <span>{upcomingGrant ? "直近の付与予定" : "次回法定付与"}</span>
              <strong>{upcomingGrant?.grant_date || dashboard.profile?.next_grant_date || "未設定"}</strong>
              <small>
                {upcomingGrant
                  ? `${Number(upcomingGrant.granted_days)}日予定`
                  : `${dashboard.profile?.projected_grant_days || 0}日見込`}
              </small>
            </article>
            <article>
              <span>{dashboard.attendance.isMeasuring ? "出勤率" : "直近3か月の参考出勤率"}</span>
              <strong>
                {dashboard.attendance.isMeasuring
                  ? "計測中"
                  : dashboard.attendance.rate === null
                    ? "集計前"
                    : `${(dashboard.attendance.rate * 100).toFixed(1)}%`}
              </strong>
              <small>
                {dashboard.attendance.isMeasuring
                  ? `${formatPeriod(dashboard.attendance.referenceStart, dashboard.attendance.referenceEnd)}を集計中`
                  : `${formatPeriod(dashboard.attendance.referenceStart, dashboard.attendance.referenceEnd)} / ${dashboard.attendance.numeratorDays}/${dashboard.attendance.denominatorDays}日`}
              </small>
            </article>
            <article><span>欠勤</span><strong>今月 {dashboard.absences.month}回</strong><small>年{dashboard.absences.year} / 入社後{dashboard.absences.tenure}</small></article>
            <article>
              <span>遅刻・早退</span>
              <strong>今月 {dashboard.attendanceDeviations.month.lateCount + dashboard.attendanceDeviations.month.earlyLeaveCount}回</strong>
              <small>
                遅刻 {dashboard.attendanceDeviations.month.lateCount}回・{dashboard.attendanceDeviations.month.lateMinutes}分
                {" / "}
                早退 {dashboard.attendanceDeviations.month.earlyLeaveCount}回・{dashboard.attendanceDeviations.month.earlyLeaveMinutes}分
                {" / "}
                年 {dashboard.attendanceDeviations.year.lateCount + dashboard.attendanceDeviations.year.earlyLeaveCount}回
              </small>
            </article>
          </section>
          <p className="leave-attendance-note">
            {dashboard.attendance.isMeasuring
              ? `${dashboard.attendance.measurementReadyDate.replaceAll("-", "/")}から直近3か月の参考出勤率を表示します。`
              : "この3か月値は日常確認用です。法定付与の80%判定は、各付与日前の6か月または1年間で別に計算します。"}
          </p>

          <section className="admin-panel leave-admin__average">
            <div>
              <span>直近3か月の実勤務（休憩控除後）</span>
              <strong>{formatMinutes(dashboard.average.averageMinutesPerDay)}</strong>
              <small>
                集計{dashboard.average.workedDays}日
                {" / "}
                {formatPeriod(dashboard.average.referenceStart, dashboard.average.referenceEnd)}
              </small>
            </div>
            <div>
              <span>{dashboard.average.includedInMonthlySalary ? "有給日の賃金扱い" : "1日参考賃金"}</span>
              <strong>
                {dashboard.average.includedInMonthlySalary
                  ? "月給に含む"
                  : formatMoney(dashboard.average.averageWagePerDay)}
              </strong>
              {!dashboard.average.includedInMonthlySalary && (
                <small>時給 {formatMoney(dashboard.average.hourlyRate)}</small>
              )}
            </div>
            <p>
              {dashboard.average.includedInMonthlySalary
                ? "勤務時間は打刻を15分単位で丸め、5時間超30分・6時間超45分・8時間超60分の休憩を差し引いた実績です。正社員の有給賃金は月給に含まれます。"
                : "勤務時間は打刻を15分単位で丸め、5時間超30分・6時間超45分・8時間超60分の休憩を差し引いた実績です。有給賃金は確定シフトの所定時間×時給で計算します。"}
            </p>
          </section>

          {payload?.canRegisterSelectedEmployee && (
            <section className="admin-panel leave-admin__actions" id="leave-admin-register">
              <div className="admin-panel__header">
                <div>
                  <h4>所属スタッフの有給を登録</h4>
                  <p>希望提出期限後やシフト確定後も登録できます。休みの日は全休の承認後に有給へ変更します。</p>
                </div>
              </div>
              <div className="leave-action-row">
                <input type="date" className="form-input" value={leaveDate} onChange={(event) => setLeaveDate(event.target.value)} />
                <select className="form-input" value={leaveUnit} onChange={(event) => setLeaveUnit(event.target.value as "full_day" | "half_day")}>
                  <option value="full_day">有給（全休）</option>
                  <option value="half_day">有給（半休）</option>
                </select>
                <input className="form-input" value={leaveMemo} onChange={(event) => setLeaveMemo(event.target.value)} placeholder="本人からの申請内容・備考" />
                <button type="button" className="btn-primary" disabled={busy || !leaveDate} onClick={() => void registerEmployeeLeave()}>
                  有給を設定
                </button>
              </div>
            </section>
          )}

          <section className="admin-panel leave-admin__issues">
            <div className="admin-panel__header">
              <div>
                <h4><AlertTriangle size={17} /> 未処理の勤怠差異</h4>
                <p>確定シフトと打刻を照合した要確認日です。シフト外出勤が同月にある場合は、勤務日変更の可能性も表示します。</p>
              </div>
              <strong>{dashboard.unresolved.length}件</strong>
            </div>
            {dashboard.attendanceReconciliation.missingScheduledDays > 0 && (
              <div className="leave-reconciliation-summary">
                <span>打刻なし {dashboard.attendanceReconciliation.missingScheduledDays}日</span>
                <span>シフト外出勤 {dashboard.attendanceReconciliation.unscheduledWorkedDates.length}日</span>
                <strong>日数不足 {dashboard.attendanceReconciliation.unexplainedDayDeficit}日</strong>
              </div>
            )}
            <div className="leave-review-list">
              {dashboard.unresolved.length === 0 ? <p className="admin-empty">未処理の勤怠差異はありません</p> : dashboard.unresolved.map((issue) => (
                <article key={`${issue.assignmentId}:${issue.workDate}`}>
                  <div>
                    <strong>{issue.workDate} / {issue.issueKind === "missing_all" ? "出勤・退勤の打刻なし" : issue.issueKind === "missing_clock_in" ? "出勤打刻なし" : issue.issueKind === "missing_clock_out" ? "退勤打刻なし" : issue.lateMinutes && issue.earlyLeaveMinutes ? `遅刻${issue.lateMinutes}分・早退${issue.earlyLeaveMinutes}分` : issue.lateMinutes ? `遅刻${issue.lateMinutes}分` : `早退${issue.earlyLeaveMinutes}分`}</strong>
                    <small className="leave-review-list__deviation">
                      予定 {issue.startTime?.slice(0, 5) || "--:--"}-{issue.endTime?.slice(0, 5) || "--:--"}
                      {issue.actualStartTime || issue.actualEndTime ? ` / 実績 ${issue.actualStartTime || "--:--"}-${issue.actualEndTime || "--:--"}` : " / 実績なし"}
                    </small>
                    {issue.managerNote && <span>勤怠備考: {issue.managerNote}</span>}
                    {issue.possibleReplacementDates.length > 0 && (
                      <span className="leave-review-list__replacement">同月のシフト外出勤: {issue.possibleReplacementDates.join("、")}</span>
                    )}
                    {payload?.canRegisterSelectedEmployee && (
                      <input
                        className="form-input leave-review-list__memo"
                        value={resolutionMemos[issue.assignmentId] || ""}
                        onChange={(event) => setResolutionMemos((current) => ({ ...current, [issue.assignmentId]: event.target.value }))}
                        placeholder="勤務日変更の振替日・確認内容"
                      />
                    )}
                  </div>
                  {payload?.canRegisterSelectedEmployee && (
                    <div className="leave-review-list__actions leave-review-list__actions--issue">
                      <button type="button" className="admin-btn-outline admin-btn-danger" disabled={busy} onClick={() => void resolveUnansweredIssue(issue, "absence")}>欠勤で確定</button>
                      <button type="button" className="admin-btn-outline" disabled={busy || !resolutionMemos[issue.assignmentId]?.trim()} onClick={() => void resolveUnansweredIssue(issue, "work_schedule_changed")}>勤務日変更</button>
                      <button type="button" className="admin-btn-outline" disabled={busy} onClick={() => preparePaidLeave(issue)}>有給を設定</button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>

          <section className="admin-panel leave-admin__actions">
            <div className="admin-panel__header">
              <div>
                <h4>開始残高・追加付与</h4>
                <p>過去の使用分を確認後、0.5日単位で残高を調整します。</p>
              </div>
            </div>
            <div className="leave-action-row">
              <input type="date" className="form-input" value={grantDate} onChange={(event) => setGrantDate(event.target.value)} />
              <input type="number" min="0.5" step="0.5" className="form-input" value={grantDays} onChange={(event) => setGrantDays(event.target.value)} placeholder="日数" />
              <input className="form-input" value={grantMemo} onChange={(event) => setGrantMemo(event.target.value)} placeholder="調整理由" />
              <button
                type="button"
                className="admin-btn-outline"
                disabled={busy || !grantDays}
                onClick={() => post({
                  action: "add_grant",
                  employee_id: dashboard.employee.id,
                  grant_date: grantDate,
                  days: grantDays,
                  notes: grantMemo,
                }, "有給残高を追加しました")}
              >
                残高を増やす
              </button>
              <button
                type="button"
                className="admin-btn-outline"
                disabled={busy || !grantDays}
                onClick={() => post({
                  action: "deduct_opening_usage",
                  employee_id: dashboard.employee.id,
                  effective_date: grantDate,
                  days: grantDays,
                  notes: grantMemo,
                }, "使用済み日数を残高へ反映しました")}
              >
                使用済みとして減らす
              </button>
            </div>
          </section>

          <section className="admin-panel">
            <div className="admin-panel__header">
              <div>
                <h4>本人回答の確認</h4>
                <p>未打刻日の回答は管理者が確定するまで欠勤・有給として集計しません。</p>
              </div>
              <strong>{pendingResolutions.length}件</strong>
            </div>
            <div className="leave-review-list">
              {pendingResolutions.length === 0 ? <p className="admin-empty">未確認の回答はありません</p> : pendingResolutions.map((row) => (
                <article key={row.id}>
                  <div>
                    <strong>{row.work_date} / {RESOLUTION_LABELS[row.resolution_type] || row.resolution_type}</strong>
                    {row.raw_payload?.attendance_issue && (
                      <small className="leave-review-list__deviation">
                        予定 {row.raw_payload.attendance_issue.scheduled_start_time?.slice(0, 5) || "--:--"}
                        -{row.raw_payload.attendance_issue.scheduled_end_time?.slice(0, 5) || "--:--"}
                        {" / "}
                        実績 {row.raw_payload.attendance_issue.actual_start_time || "--:--"}
                        -{row.raw_payload.attendance_issue.actual_end_time || "--:--"}
                        {Number(row.raw_payload.attendance_issue.late_minutes || 0) > 0 && ` / 遅刻${Number(row.raw_payload.attendance_issue.late_minutes)}分`}
                        {Number(row.raw_payload.attendance_issue.early_leave_minutes || 0) > 0 && ` / 早退${Number(row.raw_payload.attendance_issue.early_leave_minutes)}分`}
                      </small>
                    )}
                    <span>{row.employee_memo || "本人メモなし"}</span>
                  </div>
                  <div className="leave-review-list__actions">
                    <button type="button" className="btn-primary" disabled={busy || !payload?.canConfirmSelectedResolution} onClick={() => post({ action: "confirm_resolution", resolution_id: row.id }, "回答を承認しました")}>
                      <Check size={15} /> 承認
                    </button>
                    <button type="button" className="admin-btn-outline" disabled={busy || !payload?.canConfirmSelectedResolution} onClick={() => post({ action: "reopen_resolution", resolution_id: row.id }, "本人へ差し戻しました")}>
                      <RotateCcw size={15} /> 差戻し
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="admin-panel">
            <div className="admin-panel__header">
              <div>
                <h4>有給申請の承認・履歴</h4>
                <p>{payload?.canApprovePaidLeave ? "一般スタッフは所属長、管理者本人の申請は佐藤正彦が承認します。" : "申請履歴を表示しています。"}</p>
              </div>
              <CalendarDays size={19} />
            </div>
            <div className="leave-history-list">
              {dashboard.requests.length === 0 ? <p className="admin-empty">有給履歴はありません</p> : dashboard.requests.slice(0, 30).map((row) => (
                <article key={row.id}>
                  <div>
                    <strong>{row.leave_date} / {row.leave_unit === "full_day" ? "全休" : "半休"}</strong>
                    <span>
                      {REQUEST_STATUS_LABELS[row.request_status] || row.request_status}
                      {" / "}
                      {REQUEST_SOURCE_LABELS[row.request_source] || row.request_source}
                    </span>
                  </div>
                  {row.paid_wage_amount !== null && <em>{formatMoney(Number(row.paid_wage_amount))}</em>}
                  {row.request_status === "submitted" && payload?.approvableRequestIds.includes(row.id) && (
                    <div className="leave-review-list__actions">
                      <button type="button" className="btn-primary" disabled={busy} onClick={() => post({ action: "approve_request", request_id: row.id }, "有給申請を承認しました")}>承認</button>
                      <button type="button" className="admin-btn-outline" disabled={busy} onClick={() => post({ action: "reject_request", request_id: row.id }, "有給申請を却下しました")}>却下</button>
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        </>
      ) : (
        <section className="admin-panel"><p className="admin-empty">{selectedEmployee ? "有給情報を表示できません" : "スタッフが登録されていません"}</p></section>
      )}
    </div>
  );
}
