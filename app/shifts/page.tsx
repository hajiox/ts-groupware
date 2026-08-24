"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarCheck2, CalendarClock, ClipboardPenLine, TriangleAlert } from "lucide-react";
import { ConfirmedShiftView, type ConfirmedShiftPayload } from "@/components/confirmed-shift-view";
import { resolveShiftConstraints, shiftWorkStyleLabel } from "@/lib/shift-constraints";
import { isShiftRequestDeadlineOpen, shiftDeadlineInfo } from "@/lib/shift-deadline";

type ShiftPeriod = {
  id: string;
  department: string;
  title: string;
  start_date: string;
  end_date: string;
  request_deadline: string | null;
  status: string;
  notes: string | null;
  is_test_mode: boolean;
};

type ShiftRequest = {
  id: string;
  period_id: string;
  work_date: string;
  request_type: RequestType;
  priority: Priority;
  start_time: string | null;
  end_time: string | null;
  memo: string | null;
};

type ShiftRequestSubmission = {
  id: string;
  period_id: string;
  user_id: string;
  employee_id: string | null;
  submitted_at: string;
  request_comment: string | null;
  max_work_days: number | null;
  target_work_days: number | null;
  min_days_off: number | null;
  max_consecutive_days: number | null;
};

type ShiftEmployee = {
  work_style: string | null;
};

type ShiftAssignment = {
  id: string;
  period_id: string;
  work_date: string;
  shift_label: string | null;
  start_time: string | null;
  end_time: string | null;
  note: string | null;
};

type ShiftRequirement = {
  id: string;
  period_id: string;
  work_date: string;
  workplace_label: string | null;
  notes: string | null;
  notes2: string | null;
  notes3: string | null;
  production_plan: string | null;
};

type ShiftPayload = {
  department: string;
  employee: ShiftEmployee | null;
  periods: ShiftPeriod[];
  requests: ShiftRequest[];
  submissions: ShiftRequestSubmission[];
  assignments: ShiftAssignment[];
  requirements: ShiftRequirement[];
};

type ConstraintDraft = {
  maxWorkDays: string;
  targetWorkDays: string;
  minDaysOff: string;
  maxConsecutiveDays: string;
};

type RequestType = "" | "day_off" | "unavailable" | "paid_leave_full" | "paid_leave_half" | "available" | "time_preference" | "note";
type Priority = "must" | "prefer" | "ok";
type CalendarRequestMode = "unavailable" | "paid_leave_full" | "paid_leave_half";

type Draft = {
  request_type: RequestType;
  priority: Priority;
  start_time: string;
  end_time: string;
  memo: string;
};

const EDITABLE_SHIFT_REQUEST_STATUSES = new Set(["collecting", "generated", "editing"]);

function addDays(dateText: string, days: number) {
  const [year, month, day] = dateText.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function eachDate(startDate: string, endDate: string) {
  const dates: string[] = [];
  let current = startDate;
  while (current <= endDate) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

function weekday(dateText: string) {
  const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const [year, month, day] = dateText.split("-").map(Number);
  return weekdays[new Date(Date.UTC(year, month - 1, day, 15)).getUTCDay()] || "";
}

function formatDate(dateText: string) {
  return `${dateText.slice(5).replace("-", "/")}（${weekday(dateText)}）`;
}

function formatDayNumber(dateText: string) {
  return String(Number(dateText.slice(8, 10)));
}

function dateWeekdayIndex(dateText: string) {
  const [year, month, day] = dateText.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day, 15)).getUTCDay();
}

function periodTitle(period: Pick<ShiftPeriod, "department" | "start_date" | "end_date">) {
  return `${period.department} ${period.start_date}〜${period.end_date}`;
}

function initialDraft(request?: ShiftRequest): Draft {
  return {
    request_type: request?.request_type || "",
    priority: request?.priority || "must",
    start_time: request?.start_time?.slice(0, 5) || "",
    end_time: request?.end_time?.slice(0, 5) || "",
    memo: request?.memo || "",
  };
}

function canEditShiftRequest(period: ShiftPeriod | null) {
  return !!period
    && EDITABLE_SHIFT_REQUEST_STATUSES.has(period.status)
    && isShiftRequestDeadlineOpen(period.request_deadline);
}

function canEditPaidLeaveRequest(period: ShiftPeriod | null) {
  return !!period && EDITABLE_SHIFT_REQUEST_STATUSES.has(period.status);
}

export default function ShiftsPage() {
  const router = useRouter();
  const [viewMode, setViewMode] = useState<"schedule" | "requests">("schedule");
  const [confirmedPayload, setConfirmedPayload] = useState<ConfirmedShiftPayload | null>(null);
  const [confirmedLoading, setConfirmedLoading] = useState(true);
  const [confirmedError, setConfirmedError] = useState("");
  const [payload, setPayload] = useState<ShiftPayload | null>(null);
  const [periodId, setPeriodId] = useState("");
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [calendarRequestMode, setCalendarRequestMode] = useState<CalendarRequestMode>("unavailable");
  const [requestComment, setRequestComment] = useState("");
  const [constraintDraft, setConstraintDraft] = useState<ConstraintDraft>({
    maxWorkDays: "",
    targetWorkDays: "",
    minDaysOff: "",
    maxConsecutiveDays: "",
  });

  async function load() {
    setIsLoading(true);
    const response = await fetch("/api/shifts/requests", { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      setMessage(data?.error || "シフト情報を読み込めませんでした");
      setIsLoading(false);
      return;
    }
    setPayload(data);
    const urlPeriodId = typeof window !== "undefined" ? new URLSearchParams(window.location.search).get("period_id") || "" : "";
    const periods = data.periods || [];
    const currentPeriodId = periodId && periods.some((period: ShiftPeriod) => period.id === periodId) ? periodId : "";
    const linkedPeriodId = urlPeriodId && periods.some((period: ShiftPeriod) => period.id === urlPeriodId) ? urlPeriodId : "";
    if (linkedPeriodId) setViewMode("requests");
    const nextPeriodId = currentPeriodId || linkedPeriodId || periods[0]?.id || "";
    setPeriodId(nextPeriodId);
    setIsLoading(false);
  }

  async function loadConfirmed() {
    setConfirmedLoading(true);
    setConfirmedError("");
    const response = await fetch("/api/shifts/confirmed", { cache: "no-store" });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      setConfirmedError(data?.error || "確定シフトを読み込めませんでした");
      setConfirmedLoading(false);
      return;
    }
    setConfirmedPayload(data);
    const linkedPeriodId = typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("period_id")
      : null;
    if (!linkedPeriodId && !(data.periods || []).length) setViewMode("requests");
    setConfirmedLoading(false);
  }

  useEffect(() => {
    load().catch(() => {
      setMessage("シフト情報を読み込めませんでした");
      setIsLoading(false);
    });
    loadConfirmed().catch(() => {
      setConfirmedError("確定シフトを読み込めませんでした");
      setConfirmedLoading(false);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedPeriod = useMemo(
    () => payload?.periods.find((period) => period.id === periodId) || payload?.periods[0] || null,
    [payload?.periods, periodId],
  );
  const dates = useMemo(
    () => selectedPeriod ? eachDate(selectedPeriod.start_date, selectedPeriod.end_date) : [],
    [selectedPeriod],
  );
  const requestMap = useMemo(() => {
    const map = new Map<string, ShiftRequest>();
    for (const request of payload?.requests || []) {
      if (request.period_id === selectedPeriod?.id) map.set(request.work_date, request);
    }
    return map;
  }, [payload?.requests, selectedPeriod?.id]);
  const selectedSubmission = useMemo(
    () => payload?.submissions.find((submission) => submission.period_id === selectedPeriod?.id) || null,
    [payload?.submissions, selectedPeriod?.id],
  );
  const assignmentMap = useMemo(() => {
    const map = new Map<string, ShiftAssignment>();
    for (const assignment of payload?.assignments || []) {
      if (assignment.period_id === selectedPeriod?.id) map.set(assignment.work_date, assignment);
    }
    return map;
  }, [payload?.assignments, selectedPeriod?.id]);
  useEffect(() => {
    if (!selectedPeriod) return;
    const nextDrafts: Record<string, Draft> = {};
    for (const date of eachDate(selectedPeriod.start_date, selectedPeriod.end_date)) {
      nextDrafts[date] = initialDraft(requestMap.get(date));
    }
    setDrafts(nextDrafts);
    setRequestComment(selectedSubmission?.request_comment || "");
    setConstraintDraft({
      maxWorkDays: selectedSubmission?.max_work_days == null ? "" : String(selectedSubmission.max_work_days),
      targetWorkDays: selectedSubmission?.target_work_days == null ? "" : String(selectedSubmission.target_work_days),
      minDaysOff: selectedSubmission?.min_days_off == null ? "" : String(selectedSubmission.min_days_off),
      maxConsecutiveDays: selectedSubmission?.max_consecutive_days == null ? "" : String(selectedSubmission.max_consecutive_days),
    });
  }, [payload?.employee?.work_style, selectedPeriod?.id, requestMap, selectedPeriod, selectedSubmission]);

  function updateDraft(date: string, patch: Partial<Draft>) {
    setDrafts((current) => ({
      ...current,
      [date]: {
        ...(current[date] || initialDraft()),
        ...patch,
      },
    }));
  }

  function calendarRequestType(date: string) {
    const draft = drafts[date] || initialDraft(requestMap.get(date));
    if (draft.request_type === "day_off") return "unavailable";
    if (draft.request_type === "unavailable" || draft.request_type === "paid_leave_full" || draft.request_type === "paid_leave_half") {
      return draft.request_type;
    }
    return "";
  }

  function toggleCalendarRequest(date: string) {
    const canEditSelectedMode = calendarRequestMode === "unavailable"
      ? canEditShiftRequest(selectedPeriod)
      : canEditPaidLeaveRequest(selectedPeriod);
    if (!canEditSelectedMode) return;
    const selected = calendarRequestType(date) === calendarRequestMode;
    updateDraft(date, selected
      ? { request_type: "", priority: "must", start_time: "", end_time: "", memo: "" }
      : { request_type: calendarRequestMode, priority: "must", start_time: "", end_time: "", memo: "" });
  }

  async function saveRequests() {
    if (!selectedPeriod) return;
    const deadlineOpen = canEditShiftRequest(selectedPeriod);
    if (!canEditPaidLeaveRequest(selectedPeriod)) {
      setMessage("このシフト期間は希望修正できません");
      return;
    }
    const optionalInteger = (value: string) => value.trim() === "" ? null : Number(value);
    const maxWorkDays = optionalInteger(constraintDraft.maxWorkDays);
    const targetWorkDays = optionalInteger(constraintDraft.targetWorkDays);
    const minDaysOff = optionalInteger(constraintDraft.minDaysOff);
    const maxConsecutiveDays = optionalInteger(constraintDraft.maxConsecutiveDays);
    const submittedNumbers = [maxWorkDays, targetWorkDays, minDaysOff];
    if (deadlineOpen && submittedNumbers.some((value) => value !== null && (!Number.isInteger(value) || value < 0 || value > dates.length))) {
      setMessage(`日数は0〜${dates.length}日の範囲で入力してください`);
      return;
    }
    if (deadlineOpen && maxConsecutiveDays !== null && (!Number.isInteger(maxConsecutiveDays) || maxConsecutiveDays < 1 || maxConsecutiveDays > dates.length)) {
      setMessage(`最大連続勤務日数は1〜${dates.length}日の範囲で入力してください`);
      return;
    }
    const resolvedConstraints = resolveShiftConstraints(payload?.employee?.work_style, dates.length, {
      maxWorkDays,
      targetWorkDays,
      minDaysOff,
      maxConsecutiveDays,
    });
    if (deadlineOpen && targetWorkDays !== null && targetWorkDays > resolvedConstraints.effectiveMaxWorkDays) {
      setMessage(`希望出勤日数は${resolvedConstraints.effectiveMaxWorkDays}日以内にしてください（最大出勤日数と最低休日数から算出）`);
      return;
    }
    setIsSaving(true);
    setMessage("");
    const rows = dates.map((date) => {
      const draft = drafts[date] || initialDraft(requestMap.get(date));
      return {
        work_date: date,
        request_type: calendarRequestType(date),
        priority: "must",
        start_time: draft.start_time,
        end_time: draft.end_time,
        memo: draft.memo,
      };
    });
    const response = await fetch("/api/shifts/requests", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        period_id: selectedPeriod.id,
        requests: rows,
        request_comment: requestComment,
        max_work_days: constraintDraft.maxWorkDays,
        target_work_days: constraintDraft.targetWorkDays,
        min_days_off: constraintDraft.minDaysOff,
        max_consecutive_days: constraintDraft.maxConsecutiveDays,
      }),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      setMessage(data?.error || "保存できませんでした");
      setIsSaving(false);
      return;
    }
    setPayload(data);
    setMessage(selectedPeriod.is_test_mode
      ? "テスト希望を保存しました"
      : deadlineOpen ? "シフト希望を保存しました" : "有給希望を保存しました");
    setIsSaving(false);
  }

  const calendarCells = selectedPeriod
    ? [...Array(dateWeekdayIndex(selectedPeriod.start_date)).fill(null), ...dates]
    : [];
  const requestCounts = {
    unavailable: dates.filter((date) => calendarRequestType(date) === "unavailable").length,
    paid_leave_full: dates.filter((date) => calendarRequestType(date) === "paid_leave_full").length,
    paid_leave_half: dates.filter((date) => calendarRequestType(date) === "paid_leave_half").length,
  };
  const calendarWeekdays = ["日", "月", "火", "水", "木", "金", "土"];
  const deadline = shiftDeadlineInfo(selectedPeriod?.request_deadline);
  const automaticConstraints = resolveShiftConstraints(payload?.employee?.work_style, Math.max(1, dates.length));

  return (
    <>
      <header className="top-header" role="banner">
        <button type="button" className="top-header__back" onClick={() => router.push("/groups")} aria-label="戻る">‹</button>
        <h1 className="top-header__title">シフト</h1>
        <button
          type="button"
          className="top-header__icon"
          onClick={() => {
            void load();
            void loadConfirmed();
          }}
          aria-label="更新"
        >
          ↻
        </button>
      </header>

      <main className="shift-page page-content">
        <nav className="shift-view-tabs" aria-label="シフト画面を切り替える">
          <button
            type="button"
            className={viewMode === "schedule" ? "active" : ""}
            onClick={() => setViewMode("schedule")}
          >
            <CalendarCheck2 size={17} />
            確定シフト
          </button>
          <button
            type="button"
            className={viewMode === "requests" ? "active" : ""}
            onClick={() => setViewMode("requests")}
          >
            <ClipboardPenLine size={17} />
            希望提出
          </button>
        </nav>

        {viewMode === "schedule" && (
          <ConfirmedShiftView
            payload={confirmedPayload}
            loading={confirmedLoading}
            error={confirmedError}
          />
        )}

        {viewMode === "requests" && (
          <>
        <section className="shift-page__summary">
          <div>
            <span>{selectedPeriod?.department || payload?.department || ""}</span>
            <h2>シフト希望</h2>
          </div>
          {selectedPeriod && (
            <div className="shift-page__summary-status">
              <strong>{periodTitle(selectedPeriod)}</strong>
              {selectedSubmission && <span>提出済み {selectedSubmission.submitted_at.slice(0, 10)}</span>}
            </div>
          )}
        </section>

        {message && <div className="admin-message">{message}</div>}
        {isLoading && <div className="loading">読み込み中...</div>}

        {selectedPeriod?.is_test_mode && (
          <div className="shift-test-banner shift-test-banner--staff">
            <strong>希望回収テスト</strong>
            <span>管理者向けの動作確認です。ここで保存した内容は通常のシフト希望には使用されません。</span>
          </div>
        )}

        {!isLoading && !selectedPeriod && (
          <section className="shift-page__empty">
            現在提出できるシフト期間はありません。
          </section>
        )}

        {selectedPeriod && (
          <>
            <section className={`shift-deadline-banner shift-deadline-banner--${deadline.tone}`} aria-label="シフト希望の提出期限">
              {deadline.tone === "today" || deadline.tone === "overdue"
                ? <TriangleAlert size={22} aria-hidden="true" />
                : <CalendarClock size={22} aria-hidden="true" />}
              <div>
                <span>希望提出期限</span>
                <strong>{deadline.label}</strong>
                {selectedSubmission && (
                  <small>
                    {canEditShiftRequest(selectedPeriod)
                      ? "提出済みです。締切日までは内容を修正できます。"
                      : canEditPaidLeaveRequest(selectedPeriod)
                        ? "提出済みです。締切後も有給（全休・半休）は修正できます。"
                        : "提出済みです。この期間は確定済みです。"}
                  </small>
                )}
              </div>
            </section>
            {!canEditShiftRequest(selectedPeriod) && (
              <div className="admin-message">
                {canEditPaidLeaveRequest(selectedPeriod)
                  ? "希望提出期限後は、休み希望・勤務条件・備考は変更できません。有給（全休・半休）は引き続き設定できます。"
                  : "この期間は確定済みです。確定後の有給申請は管理の「有給・欠勤」から行ってください。"}
              </div>
            )}
            <div className="shift-period-tabs">
              {(payload?.periods || []).map((period) => (
                <button
                  key={period.id}
                  type="button"
                  className={period.id === selectedPeriod.id ? "active" : ""}
                  onClick={() => setPeriodId(period.id)}
                >
                  {periodTitle(period)}
                  {period.is_test_mode && <small>テスト</small>}
                </button>
              ))}
            </div>

            <section className="shift-page__requests shift-page__requests--simple">
              <div className="shift-page__requests-header">
                <div>
                  <h3>休み・有給希望</h3>
                  {selectedSubmission && <span className="shift-submitted-badge">希望回収済み</span>}
                </div>
                <strong className="shift-unavailable-count">
                  休み{requestCounts.unavailable} / 有給{requestCounts.paid_leave_full} / 半休{requestCounts.paid_leave_half}
                </strong>
                <button className="btn-primary" type="button" onClick={saveRequests} disabled={isSaving || !canEditPaidLeaveRequest(selectedPeriod)}>
                  保存
                </button>
              </div>

              <div className="shift-leave-mode" role="group" aria-label="カレンダーに設定する希望">
                <button
                  type="button"
                  className={calendarRequestMode === "unavailable" ? "active" : ""}
                  onClick={() => setCalendarRequestMode("unavailable")}
                  disabled={!canEditShiftRequest(selectedPeriod)}
                >
                  休み希望
                </button>
                <button
                  type="button"
                  className={calendarRequestMode === "paid_leave_full" ? "active" : ""}
                  onClick={() => setCalendarRequestMode("paid_leave_full")}
                >
                  有給（全休）
                </button>
                <button
                  type="button"
                  className={calendarRequestMode === "paid_leave_half" ? "active" : ""}
                  onClick={() => setCalendarRequestMode("paid_leave_half")}
                >
                  有給（半休）
                </button>
              </div>

              <div className="shift-unavailable-calendar" aria-label="出られない日のカレンダー">
                {calendarWeekdays.map((day) => (
                  <span key={day} className="shift-unavailable-calendar__weekday">{day}</span>
                ))}
                {calendarCells.map((date, index) => {
                  if (!date) return <span key={`blank-${index}`} className="shift-unavailable-day shift-unavailable-day--blank" aria-hidden="true" />;
                  const selectedType = calendarRequestType(date);
                  const selected = Boolean(selectedType);
                  const assignment = assignmentMap.get(date);
                  return (
                    <button
                      key={date}
                      type="button"
                      className={`shift-unavailable-day${selected ? " shift-unavailable-day--selected" : ""}${selectedType ? ` shift-unavailable-day--${selectedType.replaceAll("_", "-")}` : ""}${assignment?.shift_label ? " shift-unavailable-day--assigned" : ""}`}
                      onClick={() => toggleCalendarRequest(date)}
                      disabled={calendarRequestMode === "unavailable"
                        ? !canEditShiftRequest(selectedPeriod)
                        : !canEditPaidLeaveRequest(selectedPeriod)}
                      aria-pressed={selected}
                      aria-label={`${formatDate(date)} ${selectedType === "paid_leave_full" ? "有給全休" : selectedType === "paid_leave_half" ? "有給半休" : selected ? "休み希望" : "指定なし"}`}
                    >
                      <strong>{formatDayNumber(date)}</strong>
                      {selectedType === "paid_leave_full" && <small>有給</small>}
                      {selectedType === "paid_leave_half" && <small>半休</small>}
                      {assignment?.shift_label && <small>{assignment.shift_label}</small>}
                    </button>
                  );
                })}
              </div>

              <div className="shift-constraint-panel">
                <div className="shift-constraint-panel__heading">
                  <div>
                    <span>勤務条件</span>
                    <strong>{shiftWorkStyleLabel(payload?.employee?.work_style)}</strong>
                  </div>
                  <small>
                    すべて任意です。空欄は勤務形態に合わせてAIが自動設定します。
                    {payload?.employee?.work_style === "part_time_under_29_5h" ? " パートは週29.5時間以内を自動確認します。" : ""}
                    {` 現在の自動値は出勤目安${automaticConstraints.targetWorkDays}日・上限${automaticConstraints.effectiveMaxWorkDays}日・最低休日${automaticConstraints.minDaysOff}日・最大${automaticConstraints.maxConsecutiveDays}連勤です。`}
                  </small>
                </div>
                <div className="shift-constraint-grid">
                  <label>
                    <span>最大出勤可能日数</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min="0"
                      max={dates.length}
                      value={constraintDraft.maxWorkDays}
                      placeholder="自動"
                      onChange={(event) => setConstraintDraft((current) => ({ ...current, maxWorkDays: event.target.value }))}
                      disabled={!canEditShiftRequest(selectedPeriod) || isSaving}
                    />
                  </label>
                  <label>
                    <span>希望出勤日数</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min="0"
                      max={dates.length}
                      value={constraintDraft.targetWorkDays}
                      placeholder="自動"
                      onChange={(event) => setConstraintDraft((current) => ({ ...current, targetWorkDays: event.target.value }))}
                      disabled={!canEditShiftRequest(selectedPeriod) || isSaving}
                    />
                  </label>
                  <label>
                    <span>最低希望休日数</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min="0"
                      max={dates.length}
                      value={constraintDraft.minDaysOff}
                      placeholder="自動"
                      onChange={(event) => setConstraintDraft((current) => ({ ...current, minDaysOff: event.target.value }))}
                      disabled={!canEditShiftRequest(selectedPeriod) || isSaving}
                    />
                  </label>
                  <label>
                    <span>最大連続勤務日数</span>
                    <input
                      type="number"
                      inputMode="numeric"
                      min="1"
                      max={dates.length}
                      value={constraintDraft.maxConsecutiveDays}
                      placeholder="自動"
                      onChange={(event) => setConstraintDraft((current) => ({ ...current, maxConsecutiveDays: event.target.value }))}
                      disabled={!canEditShiftRequest(selectedPeriod) || isSaving}
                    />
                  </label>
                </div>
              </div>

              <label className="shift-request-comment">
                <span>備考・その他の要望</span>
                <textarea
                  value={requestComment}
                  onChange={(event) => setRequestComment(event.target.value)}
                  disabled={!canEditShiftRequest(selectedPeriod) || isSaving}
                  rows={4}
                  maxLength={1000}
                  placeholder="例：この期間は午前中心だと助かります、連休は避けたいです、など"
                />
              </label>
            </section>
          </>
        )}
          </>
        )}
      </main>
    </>
  );
}
