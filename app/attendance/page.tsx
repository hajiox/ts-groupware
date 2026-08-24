"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

type PunchType = "clock_in" | "clock_out";

type AttendancePunch = {
  id: string;
  punch_type: PunchType;
  work_date: string;
  punched_at: string;
  source_type: string | null;
  is_voided: boolean;
  memo: string | null;
  private_vehicle_place?: string | null;
  private_vehicle_distance_km?: number | string | null;
  has_thirty_minute_break?: boolean;
  void_reason?: string | null;
  device: {
    id: string;
    name: string | null;
    location: string | null;
  } | null;
};

type AttendancePayload = {
  month: string;
  user: {
    display_name: string;
    real_name?: string | null;
    department?: string | null;
  };
  punches: AttendancePunch[];
  summary: {
    total: number;
    active: number;
    voided: number;
  };
};

function monthInputValue() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function addMonths(month: string, diff: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const next = new Date(year, monthNumber - 1 + diff, 1);
  return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
}

function formatDateLabel(date: string) {
  const parsed = new Date(`${date}T00:00:00+09:00`);
  const weekday = new Intl.DateTimeFormat("ja-JP", { weekday: "short" }).format(parsed);
  return `${date.slice(5).replace("-", "/")} ${weekday}`;
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function punchTypeLabel(type: PunchType) {
  return type === "clock_in" ? "出勤" : "退勤";
}

function punchTypeClass(type: PunchType) {
  return type === "clock_in" ? "attendance-history-chip--in" : "attendance-history-chip--out";
}

export default function AttendancePage() {
  const [month, setMonth] = useState(monthInputValue());
  const [includeVoided, setIncludeVoided] = useState(false);
  const [payload, setPayload] = useState<AttendancePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  function loadAttendance(nextMonth = month, nextIncludeVoided = includeVoided) {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({
      month: nextMonth,
      include_voided: nextIncludeVoided ? "1" : "0",
    });

    fetch(`/api/attendance/punches?${params.toString()}`, { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "打刻情報を読み込めませんでした");
        return data as AttendancePayload;
      })
      .then((data) => setPayload(data))
      .catch((err) => {
        setPayload(null);
        setError(err instanceof Error ? err.message : "打刻情報を読み込めませんでした");
      })
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    loadAttendance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groupedPunches = useMemo(() => {
    const groups: Record<string, AttendancePunch[]> = {};
    for (const punch of payload?.punches || []) {
      groups[punch.work_date] ||= [];
      groups[punch.work_date].push(punch);
    }
    return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a));
  }, [payload?.punches]);

  function changeMonth(nextMonth: string) {
    setMonth(nextMonth);
    loadAttendance(nextMonth, includeVoided);
  }

  function toggleVoided(nextValue: boolean) {
    setIncludeVoided(nextValue);
    loadAttendance(month, nextValue);
  }

  return (
    <div className="attendance-page">
      <header className="top-header">
        <Link href="/groups" className="back-btn" aria-label="ホームに戻る">‹</Link>
        <div>
          <h1 className="top-header__title">勤怠</h1>
          <small>自分の打刻確認</small>
        </div>
        <button type="button" className="attendance-icon-btn" onClick={() => loadAttendance()} disabled={loading} aria-label="再読み込み">
          ↻
        </button>
      </header>

      <main className="attendance-content attendance-history">
        <section className="attendance-status attendance-history-summary">
          <div className="attendance-status__top">
            <span>{payload?.user.display_name || "ログインユーザー"}</span>
            {payload?.user.department && <span>{payload.user.department}</span>}
          </div>
          <div className="attendance-history-summary__body">
            <div>
              <span>表示月</span>
              <strong>{month.replace("-", "年")}月</strong>
            </div>
            <div>
              <span>打刻</span>
              <strong>{payload?.summary.active ?? 0}件</strong>
            </div>
            {includeVoided && (
              <div>
                <span>無効化</span>
                <strong>{payload?.summary.voided ?? 0}件</strong>
              </div>
            )}
          </div>
        </section>

        <Link href="/leave" className="attendance-leave-link">
          <span>有給・欠勤</span>
          <strong>残日数・次回付与・欠勤回数を確認</strong>
          <em>開く →</em>
        </Link>

        <section className="attendance-log attendance-history-controls">
          <div className="attendance-history-controls__row">
            <button type="button" className="admin-btn-outline" onClick={() => changeMonth(addMonths(month, -1))} disabled={loading}>
              前月
            </button>
            <input
              type="month"
              className="form-input"
              value={month}
              onChange={(event) => changeMonth(event.target.value)}
            />
            <button type="button" className="admin-btn-outline" onClick={() => changeMonth(addMonths(month, 1))} disabled={loading}>
              翌月
            </button>
          </div>
          <label className="attendance-history-toggle">
            <input
              type="checkbox"
              checked={includeVoided}
              onChange={(event) => toggleVoided(event.target.checked)}
            />
            <span>管理者が無効化した打刻も表示</span>
          </label>
        </section>

        {error && (
          <section className="attendance-alert">
            {error === "ログインが必要です" ? (
              <>
                ログインが必要です。<Link href="/login">ログイン画面へ</Link>
              </>
            ) : error}
          </section>
        )}

        <section className="attendance-log attendance-history-list">
          <h2 className="attendance-section-title">打刻履歴</h2>
          {loading ? (
            <p className="attendance-empty">読み込み中...</p>
          ) : groupedPunches.length === 0 ? (
            <p className="attendance-empty">この月の打刻はありません</p>
          ) : (
            groupedPunches.map(([date, punches]) => (
              <div key={date} className="attendance-history-day">
                <div className="attendance-history-day__header">
                  <strong>{formatDateLabel(date)}</strong>
                  <span>{punches.filter((punch) => !punch.is_voided).length}件</span>
                </div>
                {punches.map((punch) => (
                  <article key={punch.id} className={`attendance-history-item${punch.is_voided ? " attendance-history-item--voided" : ""}`}>
                    <div className={`attendance-history-chip ${punchTypeClass(punch.punch_type)}`}>
                      {punchTypeLabel(punch.punch_type)}
                    </div>
                    <div className="attendance-history-item__main">
                      <strong>{formatTime(punch.punched_at)}</strong>
                      <span>
                        {punch.device?.name || "端末情報なし"}
                        {punch.source_type === "admin" ? " / 管理修正" : ""}
                        {punch.is_voided ? " / 無効化済み" : ""}
                      </span>
                      {punch.has_thirty_minute_break && <em>30分休憩</em>}
                      {(punch.private_vehicle_place || (punch.private_vehicle_distance_km !== null && punch.private_vehicle_distance_km !== undefined)) && (
                        <em>
                          自家用車
                          {punch.private_vehicle_place ? ` ${punch.private_vehicle_place}` : ""}
                          {punch.private_vehicle_distance_km !== null && punch.private_vehicle_distance_km !== undefined ? ` ${punch.private_vehicle_distance_km}km` : ""}
                        </em>
                      )}
                      {punch.memo && <em>備考: {punch.memo}</em>}
                      {punch.is_voided && punch.void_reason && <em>無効化理由: {punch.void_reason}</em>}
                    </div>
                  </article>
                ))}
              </div>
            ))
          )}
        </section>
      </main>
    </div>
  );
}
