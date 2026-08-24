"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { Check, Clock3, LogIn, LogOut, RotateCcw, Siren } from "lucide-react";
import { SafeLineAvatar } from "@/components/safe-line-avatar";

type PunchType = "clock_in" | "clock_out";

type Punch = {
  id: string;
  punch_type: PunchType;
  punched_at: string;
  work_date: string;
};

type Staff = {
  id: string;
  display_name: string;
  picture_url: string | null;
  department: string;
  state: {
    isClockedIn: boolean;
    lastPunch: Punch | null;
  };
};

type Device = {
  id: string;
  code: string;
  name: string;
  location: string;
};

type TimeClockPayload = {
  device?: Device;
  users?: Staff[];
  workDate?: string;
  serverNow?: string;
  error?: string;
};

function isRoadsideStationDevice(device?: Device | null) {
  const marker = `${device?.code || ""} ${device?.name || ""} ${device?.location || ""}`;
  return marker.includes("michinoeki") || marker.includes("道の駅");
}

function formatTime(value?: string | null) {
  if (!value) return "--:--";
  return new Date(value).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(value?: string) {
  if (!value) return "";
  const [, month, day] = value.split("-");
  return `${Number(month)}月${Number(day)}日`;
}

function nextPunchLabel(staff: Staff) {
  return staff.state.isClockedIn ? "退勤" : "出勤";
}

function departmentButtonClass(department: string) {
  if (department === "フロア") return "time-clock-user--floor";
  if (department === "製造") return "time-clock-user--factory";
  if (department === "道の駅") return "time-clock-user--roadside";
  return "time-clock-user--unknown";
}

export default function TimeClockPage() {
  const params = useParams<{ deviceKey: string }>();
  const deviceKey = params.deviceKey;
  const [data, setData] = useState<TimeClockPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedStaff, setSelectedStaff] = useState<Staff | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState("");
  const [privateVehiclePlace, setPrivateVehiclePlace] = useState("");
  const [privateVehicleDistanceKm, setPrivateVehicleDistanceKm] = useState("");
  const [clockOutMemo, setClockOutMemo] = useState("");
  const [useThirtyMinuteBreak, setUseThirtyMinuteBreak] = useState(false);
  const [sosSending, setSosSending] = useState(false);

  const users = useMemo(() => data?.users || [], [data?.users]);
  const filteredUsers = useMemo(() => {
    const keyword = filter.trim();
    if (!keyword) return users;
    return users.filter((user) => user.display_name.includes(keyword) || user.department.includes(keyword));
  }, [filter, users]);

  async function loadData(keepSelection = false) {
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`/api/time-clock/${deviceKey}`, { cache: "no-store" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setData(payload);
        setMessage(payload.error || "タイムレコーダーを読み込めません");
        return;
      }

      setData(payload);
      if (keepSelection && selectedStaff) {
        const nextSelected = (payload.users || []).find((user: Staff) => user.id === selectedStaff.id) || null;
        setSelectedStaff(nextSelected);
      }
    } catch {
      setMessage("タイムレコーダーを読み込めません");
    } finally {
      setLoading(false);
    }
  }

  async function punch() {
    if (!selectedStaff || submitting) return;
    const willClockOut = selectedStaff.state.isClockedIn;
    const showClockOutExtras = !isRoadsideStationDevice(data?.device);
    setSubmitting(true);
    setMessage("");

    try {
      const res = await fetch(`/api/time-clock/${deviceKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: selectedStaff.id,
          private_vehicle_place: willClockOut && showClockOutExtras ? privateVehiclePlace : "",
          private_vehicle_distance_km: willClockOut && showClockOutExtras ? privateVehicleDistanceKm : null,
          memo: willClockOut ? clockOutMemo : "",
          break_override_minutes: willClockOut && showClockOutExtras && useThirtyMinuteBreak ? 30 : null,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(payload.error || "打刻に失敗しました");
        return;
      }

      const label = payload.punch?.punch_type === "clock_out" ? "退勤" : "出勤";
      const successMessage = `${payload.user?.display_name || selectedStaff.display_name} さんの${label}を記録しました`;
      setSelectedStaff(null);
      setPrivateVehiclePlace("");
      setPrivateVehicleDistanceKm("");
      setClockOutMemo("");
      setUseThirtyMinuteBreak(false);
      await loadData(false);
      setMessage(successMessage);
      window.setTimeout(() => setMessage(""), 2200);
    } catch {
      setMessage("打刻に失敗しました");
    } finally {
      setSubmitting(false);
    }
  }

  async function sendSos() {
    if (sosSending || loading || !isRoadsideStationDevice(data?.device)) return;
    setSosSending(true);
    setMessage("");

    try {
      const res = await fetch(`/api/time-clock/${deviceKey}/sos`, { method: "POST" });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage(payload.error || "SOS通知に失敗しました");
        return;
      }

      setMessage("SOS通知を送信しました");
      window.setTimeout(() => setMessage(""), 3000);
    } catch {
      setMessage("SOS通知に失敗しました");
    } finally {
      setSosSending(false);
    }
  }

  useEffect(() => {
    loadData();
    const timer = window.setInterval(() => loadData(true), 60000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceKey]);

  const grouped = useMemo(() => {
    return filteredUsers.reduce<Record<string, Staff[]>>((groups, user) => {
      const key = user.department || "未設定";
      groups[key] = groups[key] || [];
      groups[key].push(user);
      return groups;
    }, {});
  }, [filteredUsers]);

  const actionLabel = selectedStaff ? nextPunchLabel(selectedStaff) : "出勤";
  const isClockOut = selectedStaff?.state.isClockedIn;
  const terminalError = Boolean(data?.error && !data?.device);
  const isRoadsideDevice = isRoadsideStationDevice(data?.device);
  const showClockOutExtras = !isRoadsideDevice;
  const isOkMessage = message.includes("險倬鹸縺励∪縺励◆") || message.startsWith("SOS");

  function selectStaff(user: Staff) {
    setSelectedStaff(user);
    setPrivateVehiclePlace("");
    setPrivateVehicleDistanceKm("");
    setClockOutMemo("");
    setUseThirtyMinuteBreak(false);
  }

  return (
    <div className="time-clock-page">
      <header className="time-clock-header">
        <div>
          <div className="time-clock-header__eyebrow">{formatDate(data?.workDate)}</div>
          <h1>{data?.device?.name || "TSG タイムレコーダー"}</h1>
          <span>{data?.device?.location || ""}</span>
        </div>
        <div className="time-clock-header__actions">
          {isRoadsideDevice && (
            <button
              type="button"
              className="time-clock-sos"
              onClick={sendSos}
              disabled={sosSending || loading}
              aria-label="SOS通知"
            >
              <Siren size={16} aria-hidden="true" />
              <span>{sosSending ? "送信中" : "SOS"}</span>
            </button>
          )}
          <button type="button" className="time-clock-refresh" onClick={() => loadData(true)} disabled={loading}>
          <RotateCcw size={22} aria-hidden="true" />
          更新
        </button>
        </div>
      </header>

      {message && (
        <div className={`time-clock-message${message.includes("記録しました") ? " time-clock-message--ok" : ""}`}>
          {message.includes("記録しました") && <Check size={20} aria-hidden="true" />}
          <span>{message}</span>
        </div>
      )}

      {terminalError ? (
        <main className="time-clock-main">
          <section className="time-clock-recovery" role="alert">
            <strong>タイムレコーダーを表示できません</strong>
            <span>{data?.error || message || "端末情報を確認してください"}</span>
            <div className="time-clock-recovery__actions">
              <button type="button" className="time-clock-back" onClick={() => loadData(false)} disabled={loading}>
                再読み込み
              </button>
              <Link href="/" className="time-clock-home-link">
                TSGホームへ
              </Link>
            </div>
          </section>
        </main>
      ) : selectedStaff ? (
        <main className="time-clock-confirm">
          <section className="time-clock-confirm-card">
            <div className="time-clock-avatar">
              <SafeLineAvatar
                name={selectedStaff.display_name}
                pictureUrl={selectedStaff.picture_url}
                size={72}
                className="time-clock-avatar__image"
                background="transparent"
              />
            </div>
            <div className="time-clock-confirm-card__name">{selectedStaff.display_name}</div>
            <div className="time-clock-confirm-card__meta">
              {selectedStaff.department} / 最終打刻 {formatTime(selectedStaff.state.lastPunch?.punched_at)}
            </div>
            <button
              type="button"
              className={`time-clock-submit${isClockOut ? " time-clock-submit--out" : ""}`}
              onClick={punch}
              disabled={submitting}
            >
              {isClockOut ? <LogOut size={28} aria-hidden="true" /> : <LogIn size={28} aria-hidden="true" />}
              <span>{submitting ? "記録中..." : actionLabel}</span>
            </button>
            {isClockOut && (
              <div className="time-clock-options">
                {showClockOutExtras && (
                  <>
                    <label className="time-clock-field">
                      <span>場所</span>
                      <input
                        type="text"
                        value={privateVehiclePlace}
                        onChange={(event) => setPrivateVehiclePlace(event.target.value)}
                        placeholder="例: 郵便局、銀行"
                      />
                    </label>
                    <label className="time-clock-field">
                      <span>距離</span>
                      <div className="time-clock-field__input-row">
                        <input
                          type="number"
                          inputMode="decimal"
                          min="0"
                          step="0.1"
                          value={privateVehicleDistanceKm}
                          onChange={(event) => setPrivateVehicleDistanceKm(event.target.value)}
                          placeholder="0.0"
                        />
                        <small>km</small>
                      </div>
                    </label>
                  </>
                )}
                <label className="time-clock-field time-clock-field--wide">
                  <span>備考</span>
                  <textarea
                    value={clockOutMemo}
                    onChange={(event) => setClockOutMemo(event.target.value)}
                    placeholder="備考があれば入力"
                    rows={2}
                  />
                </label>
                {showClockOutExtras && (
                  <button
                    type="button"
                    className={`time-clock-break-toggle${useThirtyMinuteBreak ? " time-clock-break-toggle--active" : ""}`}
                    onClick={() => setUseThirtyMinuteBreak((current) => !current)}
                    disabled={submitting}
                  >
                    30分休憩
                  </button>
                )}
              </div>
            )}
            <button type="button" className="time-clock-back" onClick={() => setSelectedStaff(null)} disabled={submitting}>
              名前一覧に戻る
            </button>
          </section>
        </main>
      ) : (
        <main className="time-clock-main">
          <div className="time-clock-toolbar">
            <div className="time-clock-toolbar__status">
              <Clock3 size={20} aria-hidden="true" />
              自分の名前を押してください
            </div>
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="名前を検索"
              aria-label="名前を検索"
            />
          </div>

          {loading ? (
            <p className="time-clock-empty">読み込み中...</p>
          ) : users.length === 0 ? (
            <p className="time-clock-empty">表示できるスタッフがいません</p>
          ) : (
            Object.entries(grouped).map(([department, members]) => (
              <section key={department} className="time-clock-group">
                <h2>{department}</h2>
                <div className="time-clock-grid">
                  {members.map((user) => (
                    <button
                      key={user.id}
                      type="button"
                      className={`time-clock-user ${departmentButtonClass(user.department)}${user.state.isClockedIn ? " time-clock-user--working" : ""}`}
                      onClick={() => selectStaff(user)}
                    >
                      <span className="time-clock-user__name">{user.display_name}</span>
                      <span className="time-clock-user__state">
                        {user.state.isClockedIn ? "勤務中" : "未出勤"}
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            ))
          )}
        </main>
      )}
    </div>
  );
}
