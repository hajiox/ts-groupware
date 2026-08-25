"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarCheck, Clock3, Send, WalletCards } from "lucide-react";
import { attendanceDeviationLabel, type AttendanceDeviationKind } from "@/lib/attendance-deviations";
import { isRegularEmployeeWorkStyle } from "@/lib/bereavement-leave";

type DashboardPayload = {
  managed: boolean;
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
    notes: string | null;
  } | null;
  balance: {
    availableDays: number;
    allocatedDays: number;
    expiredUnusedDays: number;
    lots: {
      id: string;
      grantDate: string;
      expiresOn: string;
      grantedDays: number;
      remainingDays: number;
      expired: boolean;
    }[];
  };
  grants: {
    id: string;
    grant_date: string;
    expires_on: string;
    granted_days: number | string;
    grant_source: string;
    grant_status: string;
    initial_assumption: boolean;
    notes: string | null;
  }[];
  requests: {
    id: string;
    leave_date: string;
    leave_unit: string;
    requested_days: number | string;
    request_status: string;
    request_source: string;
    paid_wage_amount: number | string | null;
    employee_memo: string | null;
  }[];
  unresolved: {
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
    issueKind: AttendanceDeviationKind;
  }[];
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
    isReferenceOnly: boolean;
    workedDays: number;
    referenceStart: string;
    referenceEnd: string;
    isNetWorkTime: boolean;
    includedInMonthlySalary: boolean;
  };
  viewer: {
    userId: string;
    canViewAs: boolean;
    viewingAs: boolean;
  };
};

type DeviationTotals = {
  lateCount: number;
  earlyLeaveCount: number;
  missingPunchCount: number;
  lateMinutes: number;
  earlyLeaveMinutes: number;
};

const ANSWER_OPTIONS = [
  { value: "punch_missing", label: "打刻忘れ" },
  { value: "paid_leave_full", label: "有給（全休）" },
  { value: "paid_leave_half", label: "有給（半休・0.5日）" },
  { value: "bereavement_leave", label: "忌引き休", regularOnly: true },
  { value: "absence", label: "欠勤" },
  { value: "work_schedule_changed", label: "管理者に連絡" },
] as const;

const REQUEST_STATUS_LABELS: Record<string, string> = {
  draft: "下書き",
  submitted: "承認待ち",
  approved: "承認済み",
  rejected: "却下",
  cancelled: "取消",
  consumed: "取得済み",
  voided: "無効",
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

export default function PaidLeavePage() {
  const [payload, setPayload] = useState<DashboardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [memos, setMemos] = useState<Record<string, string>>({});
  const [subjectUserId, setSubjectUserId] = useState("");
  const [leaveDate, setLeaveDate] = useState("");
  const [leaveUnit, setLeaveUnit] = useState<"full_day" | "half_day">("full_day");
  const [leaveMemo, setLeaveMemo] = useState("");

  async function load(targetUserId = subjectUserId) {
    setLoading(true);
    const params = new URLSearchParams();
    if (targetUserId) params.set("user_id", targetUserId);
    try {
      const response = await fetch(`/api/paid-leave?${params.toString()}`, { cache: "no-store" });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "有給情報を読み込めませんでした");
      setPayload(data);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "有給情報を読み込めませんでした");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const target = new URLSearchParams(window.location.search).get("user_id") || "";
    setSubjectUserId(target);
    void load(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitAnswer(row: DashboardPayload["unresolved"][number]) {
    const resolutionType = answers[row.assignmentId];
    if (!resolutionType) {
      setMessage("回答を選択してください");
      return;
    }
    setBusyId(row.assignmentId);
    setMessage("");
    try {
      const response = await fetch("/api/paid-leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "answer_missing",
          assignment_id: row.assignmentId,
          work_date: row.workDate,
          resolution_type: resolutionType,
          memo: memos[row.assignmentId] || "",
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "回答を保存できませんでした");
      setMessage("回答を送信しました。管理者の確認後に勤怠へ反映されます");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "回答を保存できませんでした");
    } finally {
      setBusyId("");
    }
  }

  async function submitLeaveRequest() {
    if (!leaveDate) {
      setMessage("有給を申請する日を選択してください");
      return;
    }
    setBusyId("new-request");
    setMessage("");
    try {
      const response = await fetch("/api/paid-leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "request_leave",
          leave_date: leaveDate,
          leave_unit: leaveUnit,
          memo: leaveMemo,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "有給申請を送信できませんでした");
      setLeaveDate("");
      setLeaveUnit("full_day");
      setLeaveMemo("");
      await load();
      setMessage("有給申請を送信しました。管理者の承認をお待ちください。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "有給申請を送信できませんでした");
    } finally {
      setBusyId("");
    }
  }

  const activeLots = useMemo(
    () => payload?.balance.lots.filter((lot) => (
      !lot.expired
      && lot.grantDate <= payload.today
      && lot.remainingDays > 0
    )) || [],
    [payload],
  );

  const upcomingGrants = useMemo(
    () => payload?.grants
      .filter((grant) => (
        grant.grant_status === "granted"
        && grant.grant_date > payload.today
      ))
      .sort((left, right) => left.grant_date.localeCompare(right.grant_date)) || [],
    [payload],
  );
  const nextUpcomingGrant = upcomingGrants[0] || null;

  return (
    <div className="leave-page">
      <header className="top-header" role="banner">
        <Link href="/groups" className="back-btn" aria-label="ホームへ戻る">‹</Link>
        <div>
          <h1 className="top-header__title">有給・欠勤</h1>
          <small>{payload?.employee.name || "自分の勤務情報"}</small>
        </div>
        <button type="button" className="attendance-icon-btn" onClick={() => void load()} disabled={loading} aria-label="更新">↻</button>
      </header>

      <main className="leave-page__content page-content">
        {payload?.viewer.viewingAs && (
          <div className="leave-proxy-banner">
            <EyeIcon />
            <div>
              <strong>{payload.employee.name}さんの本人画面を代理表示中</strong>
              <span>閲覧専用です。操作は本人として実行されません。</span>
            </div>
            <Link href="/admin">管理へ戻る</Link>
          </div>
        )}
        {message && <div className="admin-message">{message}</div>}
        {loading && <div className="loading">読み込み中...</div>}

        {payload && !payload.managed && (
          <section className="attendance-log">
            <div className="leave-section-heading">
              <CalendarCheck size={20} />
              <div>
                <span>対象外</span>
                <h2>有給管理の対象外です</h2>
              </div>
            </div>
            <p className="attendance-empty">このアカウントでは有給申請・残日数管理を行いません。</p>
          </section>
        )}

        {payload?.managed && (
          <>
            <section className="attendance-log leave-request-panel leave-request-panel--primary">
              <div className="leave-section-heading">
                <Send size={20} />
                <div>
                  <span>{payload.viewer.viewingAs ? "代理閲覧中" : "本人申請"}</span>
                  <h2>有給申請</h2>
                </div>
              </div>
              <p className="leave-request-panel__help">
                {payload.viewer.viewingAs
                  ? "この欄からスタッフ本人が申請します。代理閲覧中は操作できません。"
                  : "取得日と全休・半休を選んで申請してください。管理者の承認後に確定します。"}
              </p>
              <div className="leave-request-form">
                <label>
                  <span>取得日</span>
                  <input
                    type="date"
                    className="form-input"
                    value={leaveDate}
                    disabled={payload.viewer.viewingAs}
                    onChange={(event) => setLeaveDate(event.target.value)}
                  />
                </label>
                <label>
                  <span>区分</span>
                  <select
                    className="admin-select"
                    value={leaveUnit}
                    disabled={payload.viewer.viewingAs}
                    onChange={(event) => setLeaveUnit(event.target.value as "full_day" | "half_day")}
                  >
                    <option value="full_day">有給（全休）</option>
                    <option value="half_day">有給（半休）</option>
                  </select>
                </label>
                <label className="leave-request-form__memo">
                  <span>理由・補足（任意）</span>
                  <input
                    className="form-input"
                    value={leaveMemo}
                    disabled={payload.viewer.viewingAs}
                    onChange={(event) => setLeaveMemo(event.target.value)}
                    placeholder="管理者への連絡"
                  />
                </label>
                <button
                  type="button"
                  className="btn-primary leave-request-form__submit"
                  disabled={payload.viewer.viewingAs || busyId === "new-request" || !leaveDate}
                  onClick={() => void submitLeaveRequest()}
                >
                  <Send size={16} />
                  {payload.viewer.viewingAs
                    ? "本人のみ申請できます"
                    : busyId === "new-request"
                      ? "申請中..."
                      : "申請する"}
                </button>
              </div>
            </section>

            {payload.unresolved.length > 0 && !payload.viewer.viewingAs && (
              <section className="leave-missing">
                <div className="leave-section-heading">
                  <AlertTriangle size={21} />
                  <div>
                    <span>確認が必要です</span>
                    <h2>勤務予定と打刻の確認</h2>
                  </div>
                </div>
                <p>欠勤・有給半休・管理者への連絡から内容を選び、管理者へ送信してください。</p>
                {payload.unresolved.map((row) => (
                  <article key={row.assignmentId} className="leave-missing__item">
                    <div className="leave-missing__date">
                      <strong>{row.workDate.slice(5).replace("-", "/")}</strong>
                      <span>{attendanceDeviationLabel(row)}</span>
                      <small>{row.startTime?.slice(0, 5) || "--:--"} - {row.endTime?.slice(0, 5) || "--:--"}</small>
                      <small>実績 {row.actualStartTime || "--:--"} - {row.actualEndTime || "--:--"}</small>
                    </div>
                    <div className="leave-missing__form">
                      <div className="leave-answer-options">
                        {ANSWER_OPTIONS
                          .filter((option) => !("regularOnly" in option)
                            || isRegularEmployeeWorkStyle(payload.employee.workStyle))
                          .filter((option) => row.issueKind.startsWith("missing_")
                            || ["paid_leave_half", "absence", "work_schedule_changed"].includes(option.value))
                          .map((option) => (
                            <button
                              key={option.value}
                              type="button"
                              className={answers[row.assignmentId] === option.value ? "active" : ""}
                              onClick={() => setAnswers((current) => ({ ...current, [row.assignmentId]: option.value }))}
                            >
                              {option.label}
                            </button>
                          ))}
                      </div>
                      {answers[row.assignmentId] === "paid_leave_half" && (
                        <small className="leave-answer-note">有給残日数から0.5日を使用します。</small>
                      )}
                      {answers[row.assignmentId] === "work_schedule_changed" && (
                        <small className="leave-answer-note">遅出・退勤時刻変更など、管理者へ伝える内容を下へ入力してください。</small>
                      )}
                      <input
                        className="form-input"
                        value={memos[row.assignmentId] || ""}
                        onChange={(event) => setMemos((current) => ({ ...current, [row.assignmentId]: event.target.value }))}
                        placeholder={answers[row.assignmentId] === "work_schedule_changed" ? "変更理由・変更後の勤務時間" : "補足があれば入力"}
                      />
                      <button type="button" className="btn-primary" disabled={busyId === row.assignmentId} onClick={() => void submitAnswer(row)}>
                        {busyId === row.assignmentId ? "送信中..." : "回答する"}
                      </button>
                    </div>
                  </article>
                ))}
              </section>
            )}

            <section className="leave-overview">
              <article className="leave-overview__balance">
                <WalletCards size={22} />
                <span>有給残日数</span>
                <strong>{payload.balance.availableDays}<small>日</small></strong>
                {payload.grants.some((grant) => grant.initial_assumption) && <em>初期移行のみなし付与を含みます</em>}
              </article>
              <article>
                <CalendarCheck size={20} />
                <span>{nextUpcomingGrant ? "直近の付与予定" : "次回法定付与"}</span>
                <strong>{nextUpcomingGrant?.grant_date || payload.profile?.next_grant_date || "未設定"}</strong>
                <small>
                  {nextUpcomingGrant
                    ? `${Number(nextUpcomingGrant.granted_days)}日予定`
                    : `${payload.profile?.projected_grant_days || 0}日見込`}
                </small>
              </article>
              <article>
                <Clock3 size={20} />
                <span>{payload.attendance.isMeasuring ? "出勤率" : "直近3か月の参考出勤率"}</span>
                <strong>
                  {payload.attendance.isMeasuring
                    ? "計測中"
                    : payload.attendance.rate === null
                      ? "集計前"
                      : `${(payload.attendance.rate * 100).toFixed(1)}%`}
                </strong>
                <small>
                  {payload.attendance.isMeasuring
                    ? `${formatPeriod(payload.attendance.referenceStart, payload.attendance.referenceEnd)}を集計中`
                    : `${formatPeriod(payload.attendance.referenceStart, payload.attendance.referenceEnd)} / ${payload.attendance.numeratorDays}/${payload.attendance.denominatorDays}日`}
                </small>
              </article>
            </section>
            <p className="leave-attendance-note">
              {payload.attendance.isMeasuring
                ? `${payload.attendance.measurementReadyDate.replaceAll("-", "/")}から直近3か月の参考出勤率を表示します。`
                : "この3か月値は日常確認用です。法定付与の80%判定は、各付与日前の6か月または1年間で別に計算します。"}
            </p>

            <section className="leave-stat-strip">
              <div><span>今月の欠勤</span><strong>{payload.absences.month}回</strong></div>
              <div><span>今年の欠勤</span><strong>{payload.absences.year}回</strong></div>
              <div><span>入社後の欠勤</span><strong>{payload.absences.tenure}回</strong></div>
            </section>

            <section className="leave-stat-strip leave-stat-strip--attendance">
              <div>
                <span>今月の遅刻</span>
                <strong>{payload.attendanceDeviations.month.lateCount}回</strong>
                <small>
                  計 {payload.attendanceDeviations.month.lateMinutes}分 / 年{payload.attendanceDeviations.year.lateCount}回
                </small>
              </div>
              <div>
                <span>今月の早退</span>
                <strong>{payload.attendanceDeviations.month.earlyLeaveCount}回</strong>
                <small>
                  計 {payload.attendanceDeviations.month.earlyLeaveMinutes}分 / 年{payload.attendanceDeviations.year.earlyLeaveCount}回
                </small>
              </div>
              <div>
                <span>今月の不完全打刻</span>
                <strong>{payload.attendanceDeviations.month.missingPunchCount}回</strong>
                <small>管理者承認済みの勤務変更は除外</small>
              </div>
            </section>

            <section className="attendance-log leave-reference">
              <div className="leave-section-heading">
                <Clock3 size={20} />
                <div>
                  <span>直近3か月の実績</span>
                  <h2>休憩控除後の勤務と有給賃金</h2>
                </div>
              </div>
              <div className="leave-reference__grid">
                <div>
                  <span>1日平均実勤務</span>
                  <strong>{formatMinutes(payload.average.averageMinutesPerDay)}</strong>
                  <small>
                    集計{payload.average.workedDays}日
                    {" / "}
                    {formatPeriod(payload.average.referenceStart, payload.average.referenceEnd)}
                  </small>
                </div>
                <div>
                  <span>{payload.average.includedInMonthlySalary ? "有給日の賃金扱い" : "1日参考賃金"}</span>
                  <strong>
                    {payload.average.includedInMonthlySalary
                      ? "月給に含む"
                      : formatMoney(payload.average.averageWagePerDay)}
                  </strong>
                  {!payload.average.includedInMonthlySalary && payload.average.hourlyRate !== null && (
                    <small>時給 {formatMoney(payload.average.hourlyRate)}</small>
                  )}
                </div>
              </div>
              <p>
                {payload.average.includedInMonthlySalary
                  ? "勤務時間は打刻を15分単位で丸め、5時間超30分・6時間超45分・8時間超60分の休憩を差し引いた実績です。正社員の有給賃金は月給に含まれます。"
                  : "勤務時間は打刻を15分単位で丸め、5時間超30分・6時間超45分・8時間超60分の休憩を差し引いた実績です。有給賃金は確定シフトの所定時間×時給を基本に計算します。"}
              </p>
            </section>

            <section className="attendance-log">
              <div className="leave-section-heading">
                <WalletCards size={20} />
                <div>
                  <span>付与ロット</span>
                  <h2>有効な有給</h2>
                </div>
              </div>
              <div className="leave-lot-list">
                {activeLots.length === 0 ? <p className="attendance-empty">有効な付与残はありません</p> : activeLots.map((lot) => (
                  <article key={lot.id}>
                    <div><strong>{lot.grantDate}</strong><span>{lot.expiresOn}まで</span></div>
                    <em>{lot.remainingDays} / {lot.grantedDays}日</em>
                  </article>
                ))}
              </div>
            </section>

            {upcomingGrants.length > 0 && (
              <section className="attendance-log">
                <div className="leave-section-heading">
                  <CalendarCheck size={20} />
                  <div>
                    <span>付与前</span>
                    <h2>今後の付与予定</h2>
                  </div>
                </div>
                <div className="leave-lot-list">
                  {upcomingGrants.map((grant) => (
                    <article key={grant.id}>
                      <div>
                        <strong>{grant.grant_date}</strong>
                        <span>{grant.notes || "付与日になると残日数へ加算されます"}</span>
                      </div>
                      <em>+{Number(grant.granted_days)}日</em>
                    </article>
                  ))}
                </div>
              </section>
            )}

            <section className="attendance-log">
              <div className="leave-section-heading">
                <CalendarCheck size={20} />
                <div>
                  <span>取得履歴</span>
                  <h2>有給申請</h2>
                </div>
              </div>
              <div className="leave-lot-list">
                {payload.requests.length === 0 ? <p className="attendance-empty">有給申請はありません</p> : payload.requests.slice(0, 30).map((request) => (
                  <article key={request.id}>
                    <div>
                      <strong>{request.leave_date} / {request.leave_unit === "full_day" ? "全休" : "半休"}</strong>
                      <span className={`leave-request-status leave-request-status--${request.request_status}`}>
                        {REQUEST_STATUS_LABELS[request.request_status] || request.request_status}
                      </span>
                      {request.employee_memo && <small>{request.employee_memo}</small>}
                    </div>
                    <em>{Number(request.requested_days)}日</em>
                  </article>
                ))}
              </div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function EyeIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="2.8" stroke="currentColor" strokeWidth="1.8" />
    </svg>
  );
}
