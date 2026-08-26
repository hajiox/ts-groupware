"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useState, useEffect, useRef } from "react";
import { Check, X } from "lucide-react";
import { CalendarShortcut } from "@/components/calendar-shortcut";
import { HomeCompanyMessages } from "@/components/home-company-messages";
import { ShiftShortcut } from "@/components/shift-shortcut";
import { shiftDeadlineInfo } from "@/lib/shift-deadline";
import { getDeviceHeaders } from "@/lib/device-id";
import { normalizeLinePictureUrl } from "@/lib/line-picture";
import { pledgeReminderInfo, pledgeReminderRank } from "@/lib/pledge-reminders";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://v0-line-blush.vercel.app";
const registrationUrl = `${siteUrl}/login`;
const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=96x96&margin=8&data=${encodeURIComponent(registrationUrl)}`;

type User = {
  id: string;
  display_name: string;
  picture_url: string | null;
};

type ManagementPermissions = {
  canManageAttendance: boolean;
  canApprovePaidLeave: boolean;
};

type Group = {
  id: string;
  name: string;
  type: "board" | "chat";
  icon: string;
  description: string | null;
  lastMessage: string;
  lastMessageAt: string;
  unread: number;
};

type PresentStaff = {
  userId: string;
  displayName: string;
  pictureUrl: string | null;
  department: string;
  clockedInAt: string;
  deviceName: string | null;
  location: string | null;
};

type ShiftHomePeriod = {
  id: string;
  department: string;
  title: string;
  start_date: string;
  end_date: string;
  request_deadline: string | null;
  status: string;
};

type ShiftHomeSubmission = {
  id: string;
  period_id: string;
  submitted_at: string;
};

type ShiftConfirmationAlert = {
  id: string;
  period_id: string;
  department: string;
  period_title: string;
  start_date: string;
  end_date: string;
  created_at: string;
};

type PendingPledge = {
  id: string;
  delivery: {
    title_snapshot: string;
    is_test: boolean;
    sent_at: string;
  };
};

type PaidLeaveHomeStatus = {
  managed: boolean;
  balance: {
    availableDays: number;
  };
  unresolved: {
    assignmentId: string;
    workDate: string;
    issueKind: string;
    lateMinutes: number;
    earlyLeaveMinutes: number;
  }[];
};

type PendingLeaveApproval = {
  id: string;
  approval_kind: "paid_leave_request" | "workday_resolution";
  request_id: string;
  resolution_id: string | null;
  employee_id: string;
  employee_name: string;
  department: string | null;
  leave_date: string;
  leave_unit: string;
  requested_days: number | string;
  employee_memo: string | null;
  requested_at: string;
};

const EDITABLE_SHIFT_REQUEST_STATUSES = new Set(["collecting", "generated", "editing"]);

function isAllStaffGroupName(name: string) {
  const normalized = name.replace(/\s+/g, "");
  return normalized.includes("オールスタッフ") || normalized.includes("全スタッフ");
}

function AvatarPlaceholder({
  initials,
  color,
  size = 36,
}: {
  initials: string;
  color: string;
  size?: number;
}) {
  return (
    <div
      className="avatar-placeholder"
      style={{ width: size, height: size, background: color, fontSize: size * 0.42 }}
      aria-hidden="true"
    >
      {initials}
    </div>
  );
}

function SafePicture({
  src,
  alt,
  className,
  width,
  height,
  fallback,
}: {
  src?: string | null;
  alt: string;
  className?: string;
  width?: number;
  height?: number;
  fallback: ReactNode;
}) {
  const normalizedSrc = normalizeLinePictureUrl(src);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  if (normalizedSrc && failedSrc !== normalizedSrc) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={normalizedSrc}
        alt={alt}
        className={className}
        width={width}
        height={height}
        onError={() => setFailedSrc(normalizedSrc)}
      />
    );
  }

  return <>{fallback}</>;
}

function CreateGroupModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<"board" | "chat">("board");
  const [icon, setIcon] = useState("📢");
  const [addAllMembers, setAddAllMembers] = useState(false);
  const [loading, setLoading] = useState(false);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setLoading(true);

    const res = await fetch("/api/groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name.trim(), type, icon, add_all_members: addAllMembers }),
    });

    if (res.ok) {
      setName("");
      setType("board");
      setIcon("📢");
      setAddAllMembers(false);
      onClose();
      onCreated();
    } else {
      alert("グループの作成に失敗しました");
    }
    setLoading(false);
  }

  const icons = ["📢", "💻", "💬", "📋", "🎯", "🏠", "📦", "🔧", "📊", "🎨"];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <h2 className="modal-title">グループ作成</h2>
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label className="form-label">グループ名</label>
            <input
              type="text"
              className="form-input"
              value={name}
              onChange={(e) => {
                const nextName = e.target.value;
                setName(nextName);
                if (isAllStaffGroupName(nextName)) setAddAllMembers(true);
              }}
              placeholder="例: 全社アナウンス"
              autoFocus
            />
          </div>

          <div className="form-group">
            <label className="form-label">タイプ</label>
            <div className="type-selector">
              <button
                type="button"
                className={`type-btn ${type === "board" ? "type-btn--active" : ""}`}
                onClick={() => { setType("board"); setIcon("📢"); }}
              >
                📋 掲示板
              </button>
              <button
                type="button"
                className={`type-btn ${type === "chat" ? "type-btn--active" : ""}`}
                onClick={() => { setType("chat"); setIcon("💬"); }}
              >
                💬 チャット
              </button>
            </div>
          </div>

          {type === "board" && (
          <div className="form-group">
            <label className="form-label">アイコン</label>
            <div className="icon-grid">
              {icons.map((ic) => (
                <button
                  key={ic}
                  type="button"
                  className={`icon-select-btn ${icon === ic ? "icon-select-btn--active" : ""}`}
                  onClick={() => setIcon(ic)}
                >
                  {ic}
                </button>
              ))}
            </div>
          </div>
          )}

          <label className="form-check">
            <input
              type="checkbox"
              checked={addAllMembers}
              onChange={(e) => setAddAllMembers(e.target.checked)}
            />
            <span>承認済みスタッフ全員をメンバーに追加</span>
          </label>

          <div className="modal-actions">
            <button type="button" className="btn-cancel" onClick={onClose}>
              キャンセル
            </button>
            <button type="submit" className="btn-primary" disabled={loading || !name.trim()}>
              {loading ? "作成中..." : "作成"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function formatTime(dateStr: string) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

function staffInitials(name: string) {
  return name.trim().slice(0, 2) || "?";
}

function shiftPeriodTitle(period: ShiftHomePeriod) {
  return `${period.department} ${period.start_date}〜${period.end_date}`;
}

export default function GroupsPage() {
  const groupsListRef = useRef<HTMLElement | null>(null);
  const groupsRequestRef = useRef(0);
  const [user, setUser] = useState<User | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [clearingUnread, setClearingUnread] = useState(false);
  const [lineUrlCopyStatus, setLineUrlCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const [openTaskCount, setOpenTaskCount] = useState(0);
  const [presentStaff, setPresentStaff] = useState<PresentStaff[]>([]);
  const [shiftPeriods, setShiftPeriods] = useState<ShiftHomePeriod[]>([]);
  const [shiftSubmissions, setShiftSubmissions] = useState<ShiftHomeSubmission[]>([]);
  const [shiftConfirmationAlerts, setShiftConfirmationAlerts] = useState<ShiftConfirmationAlert[]>([]);
  const [openingShiftAlertId, setOpeningShiftAlertId] = useState("");
  const [showPresentDetails, setShowPresentDetails] = useState(false);
  const [pendingPledges, setPendingPledges] = useState<PendingPledge[]>([]);
  const [paidLeaveStatus, setPaidLeaveStatus] = useState<PaidLeaveHomeStatus | null>(null);
  const [permissions, setPermissions] = useState<ManagementPermissions | null>(null);
  const [pendingLeaveApprovals, setPendingLeaveApprovals] = useState<PendingLeaveApproval[]>([]);
  const [leaveApprovalBusyId, setLeaveApprovalBusyId] = useState("");
  const [leaveApprovalMessage, setLeaveApprovalMessage] = useState("");

  function loadPresentStaff() {
    fetch("/api/attendance/present", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { present: [] }))
      .then((data) => setPresentStaff(data.present || []))
      .catch(() => {});
  }

  function loadPendingPledges() {
    fetch("/api/pledges", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { assignments: [] }))
      .then((data) => setPendingPledges(data.assignments || []))
      .catch(() => {});
  }

  function loadShiftConfirmationAlerts() {
    fetch("/api/shifts/alerts", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { alerts: [] }))
      .then((data) => setShiftConfirmationAlerts(data.alerts || []))
      .catch(() => {});
  }

  function loadPaidLeaveStatus() {
    fetch("/api/paid-leave", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => setPaidLeaveStatus(data))
      .catch(() => {});
  }

  function loadPendingLeaveApprovals() {
    fetch("/api/admin/paid-leave/pending", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { requests: [] }))
      .then((data) => setPendingLeaveApprovals(data.requests || []))
      .catch(() => {});
  }

  function loadGroups() {
    const requestId = ++groupsRequestRef.current;
    return fetch("/api/groups", {
      cache: "no-store",
      headers: getDeviceHeaders(),
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`グループ一覧の取得に失敗しました (${response.status})`);
        }
        return response.json();
      })
      .then((data) => {
        if (requestId !== groupsRequestRef.current) return;
        setGroups(data.groups || []);
      })
      .catch((error) => {
        console.error("[Groups refresh error]", error);
      })
      .finally(() => {
        if (requestId === groupsRequestRef.current) setLoading(false);
      });
  }

  function loadData() {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        setUser(data.user);
        setPermissions(data.permissions || null);
      })
      .catch(() => {});

    void loadGroups();

    fetch("/api/tasks?summary=1", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { openCount: 0 }))
      .then((data) => setOpenTaskCount(data.openCount || 0))
      .catch(() => {});

    fetch("/api/shifts/requests", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { periods: [], submissions: [] }))
      .then((data) => {
        setShiftPeriods(data.periods || []);
        setShiftSubmissions(data.submissions || []);
      })
      .catch(() => {});

    loadPendingPledges();
    loadShiftConfirmationAlerts();
    loadPaidLeaveStatus();
    loadPendingLeaveApprovals();

    loadPresentStaff();
  }

  useEffect(() => {
    loadData();
    const resetHomeScroll = () => {
      const list = groupsListRef.current;
      if (!list) return;
      list.scrollTop = 0;
      list.scrollLeft = 0;
    };
    requestAnimationFrame(resetHomeScroll);
    const resetTimer = window.setTimeout(resetHomeScroll, 180);
    const timer = window.setInterval(() => {
      void loadGroups();
      loadPresentStaff();
      loadPendingPledges();
      loadShiftConfirmationAlerts();
      loadPaidLeaveStatus();
      loadPendingLeaveApprovals();
    }, 60000);
    const handleFocus = () => {
      void loadGroups();
      loadPresentStaff();
      loadPendingPledges();
      loadShiftConfirmationAlerts();
      loadPaidLeaveStatus();
      loadPendingLeaveApprovals();
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void loadGroups();
        loadPresentStaff();
        loadPendingPledges();
        loadShiftConfirmationAlerts();
        loadPaidLeaveStatus();
        loadPendingLeaveApprovals();
      }
    };
    const handlePageShow = () => {
      void loadGroups();
    };
    const handleUnreadRefresh = () => {
      void loadGroups();
    };
    window.addEventListener("focus", handleFocus);
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("tsg:unread-refresh", handleUnreadRefresh);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearTimeout(resetTimer);
      window.clearInterval(timer);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("tsg:unread-refresh", handleUnreadRefresh);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  async function handleClearUnread() {
    if (clearingUnread) return;

    setClearingUnread(true);
    try {
      const res = await fetch("/api/unread/clear", {
        method: "POST",
        headers: getDeviceHeaders(),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        alert(data.error || "未読の一括消去に失敗しました");
        return;
      }

      setGroups((currentGroups) => currentGroups.map((group) => ({ ...group, unread: 0 })));
      window.dispatchEvent(new Event("tsg:unread-refresh"));
      setShowUserMenu(false);
    } catch {
      alert("未読の一括消去に失敗しました");
    } finally {
      setClearingUnread(false);
    }
  }

  async function handleLeaveApproval(request: PendingLeaveApproval, approved: boolean) {
    if (leaveApprovalBusyId) return;
    const isWorkdayResolution = request.approval_kind === "workday_resolution";
    if (!approved && !window.confirm(isWorkdayResolution ? "この有給回答を差し戻しますか？" : "この有給申請を却下しますか？")) return;

    setLeaveApprovalBusyId(request.id);
    setLeaveApprovalMessage("");
    try {
      const response = await fetch("/api/admin/paid-leave", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: isWorkdayResolution
            ? (approved ? "confirm_resolution" : "reopen_resolution")
            : (approved ? "approve_request" : "reject_request"),
          ...(isWorkdayResolution
            ? { resolution_id: request.resolution_id }
            : { request_id: request.request_id }),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "有給申請を更新できませんでした");
      setLeaveApprovalMessage(approved ? "有給申請を承認しました" : isWorkdayResolution ? "有給回答を差し戻しました" : "有給申請を却下しました");
      loadPendingLeaveApprovals();
      loadPaidLeaveStatus();
    } catch (error) {
      setLeaveApprovalMessage(error instanceof Error ? error.message : "有給申請を更新できませんでした");
    } finally {
      setLeaveApprovalBusyId("");
    }
  }

  async function handleOpenConfirmedShift(alert: ShiftConfirmationAlert) {
    if (openingShiftAlertId) return;
    setOpeningShiftAlertId(alert.id);
    try {
      const response = await fetch("/api/shifts/alerts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ alert_id: alert.id }),
      });
      if (response.ok) {
        setShiftConfirmationAlerts((current) => current.filter((item) => item.id !== alert.id));
      }
    } finally {
      window.location.href = `/shifts?period_id=${encodeURIComponent(alert.period_id)}`;
    }
  }

  async function handleCopyLineLoginUrl() {
    try {
      await navigator.clipboard.writeText(registrationUrl);
      setLineUrlCopyStatus("copied");
      window.setTimeout(() => setLineUrlCopyStatus("idle"), 1800);
    } catch {
      setLineUrlCopyStatus("failed");
      window.setTimeout(() => setLineUrlCopyStatus("idle"), 2200);
    }
  }

  function togglePresentDetails() {
    if (presentStaff.length === 0) return;
    setShowPresentDetails((current) => !current);
  }

  function handlePresentKeyDown(e: React.KeyboardEvent<HTMLElement>) {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    togglePresentDetails();
  }

  const submittedShiftPeriodIds = new Set(shiftSubmissions.map((submission) => submission.period_id));
  const editableShiftPeriods = shiftPeriods.filter((period) => EDITABLE_SHIFT_REQUEST_STATUSES.has(period.status));
  const pendingShiftPeriod = editableShiftPeriods.find((period) => !submittedShiftPeriodIds.has(period.id));
  const latestShiftPeriod = pendingShiftPeriod || editableShiftPeriods[0];
  const latestShiftDeadline = shiftDeadlineInfo(latestShiftPeriod?.request_deadline);
  const prioritizedPendingPledges = [...pendingPledges].sort((a, b) => {
    const aReminder = pledgeReminderInfo(a.delivery.sent_at, a.delivery.is_test);
    const bReminder = pledgeReminderInfo(b.delivery.sent_at, b.delivery.is_test);
    return pledgeReminderRank(bReminder.level) - pledgeReminderRank(aReminder.level)
      || Date.parse(a.delivery.sent_at) - Date.parse(b.delivery.sent_at);
  });
  const activePendingPledge = prioritizedPendingPledges[0] || null;
  const activePledgeReminder = activePendingPledge
    ? pledgeReminderInfo(activePendingPledge.delivery.sent_at, activePendingPledge.delivery.is_test)
    : null;

  return (
    <div className="groups-page">
      {/* Header */}
      <header className="groups-header" role="banner">
        <span className="groups-header__logo">TS Groupware</span>
        <div className="groups-header__actions">
          <CalendarShortcut />
          <ShiftShortcut />
          <div className="groups-header__user-wrap">
            <button
              type="button"
              className="groups-header__user"
              onClick={() => setShowUserMenu((current) => !current)}
              aria-expanded={showUserMenu}
              aria-haspopup="menu"
            >
              <span style={{ fontSize: 14, color: "var(--text-sub)" }}>
                {user?.display_name || ""}
              </span>
              <SafePicture
                src={user?.picture_url}
                alt={user?.display_name || ""}
                className="avatar"
                width={34}
                height={34}
                fallback={(
                  <AvatarPlaceholder
                    initials={user?.display_name?.charAt(0) || "?"}
                    color="#3b82f6"
                    size={34}
                  />
                )}
              />
            </button>
            {showUserMenu && (
              <div className="user-menu" role="menu">
              <div className="user-menu__qr" aria-label="LINEログインQR">
                <div className="user-menu__qr-text">
                  <span>LINEログインQR</span>
                  <small>新規登録・再ログイン用</small>
                </div>
                <a href={registrationUrl} className="user-menu__qr-code" aria-label="LINEログイン画面へ進むQR">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qrUrl} alt="LINEログイン画面へ進むQRコード" width={72} height={72} />
                </a>
                <div className="user-menu__qr-copy">
                  <code>{registrationUrl.replace(/^https?:\/\//, "")}</code>
                  <button
                    type="button"
                    className="user-menu__copy-btn"
                    onClick={handleCopyLineLoginUrl}
                    aria-label="LINEログインURLをコピー"
                  >
                    {lineUrlCopyStatus === "copied" ? "コピー済み" : lineUrlCopyStatus === "failed" ? "コピー失敗" : "URLコピー"}
                  </button>
                </div>
              </div>
              <button
                type="button"
                className="user-menu__item"
                role="menuitem"
                onClick={handleClearUnread}
                disabled={clearingUnread}
              >
                {clearingUnread ? "未読を消去中..." : "このアカウントの未読をすべて消す"}
              </button>
              <button
                type="button"
                className="user-menu__item user-menu__item--danger"
                role="menuitem"
                onClick={() => {
                  window.location.href = "/api/auth/logout";
                }}
              >
                ログアウト
              </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Group list */}
      <section
        ref={groupsListRef}
        className="groups-list page-content"
        aria-label="グループ一覧"
      >
        {permissions?.canApprovePaidLeave && pendingLeaveApprovals.length > 0 && (
          <section className="leave-approval-home" aria-label="有給申請の承認待ち">
            <div className="leave-approval-home__header">
              <div>
                <span>管理者確認</span>
                <strong>有給申請が{pendingLeaveApprovals.length}件あります</strong>
              </div>
              <Link href="/admin">管理で確認</Link>
            </div>
            {leaveApprovalMessage && <p className="leave-approval-home__message">{leaveApprovalMessage}</p>}
            <div className="leave-approval-home__list">
              {pendingLeaveApprovals.map((request) => (
                <article key={request.id}>
                  <div>
                    <strong>{request.employee_name}</strong>
                    <span>
                      {request.leave_date} / {request.leave_unit === "full_day" ? "全休" : "半休"}
                      {request.department ? ` / ${request.department}` : ""}
                      {request.approval_kind === "workday_resolution" ? " / 打刻確認" : ""}
                    </span>
                    {request.employee_memo && <small>{request.employee_memo}</small>}
                  </div>
                  <div className="leave-approval-home__actions">
                    <button
                      type="button"
                      className="leave-approval-home__approve"
                      disabled={Boolean(leaveApprovalBusyId)}
                      onClick={() => void handleLeaveApproval(request, true)}
                    >
                      <Check size={16} /> 承認
                    </button>
                    <button
                      type="button"
                      className="leave-approval-home__reject"
                      disabled={Boolean(leaveApprovalBusyId)}
                      onClick={() => void handleLeaveApproval(request, false)}
                      aria-label={`${request.employee_name}さんの${request.approval_kind === "workday_resolution" ? "有給回答を差し戻す" : "有給申請を却下"}`}
                    >
                      <X size={16} />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        <HomeCompanyMessages mode="inbox" />

        {paidLeaveStatus?.managed && !!paidLeaveStatus.unresolved.length && (
          <Link href="/leave" className="leave-home-alert">
            <span>勤怠の確認が必要です</span>
            <strong>打刻なし・遅刻・早退の確認が{paidLeaveStatus.unresolved.length}件あります</strong>
            <small>欠勤・有給半休・管理者への連絡から回答してください</small>
            <em>確認する</em>
          </Link>
        )}

        {shiftConfirmationAlerts.map((alert) => (
          <button
            key={alert.id}
            type="button"
            className="shift-alert-banner shift-alert-banner--published shift-confirmation-alert"
            disabled={Boolean(openingShiftAlertId)}
            onClick={() => void handleOpenConfirmedShift(alert)}
          >
            <span>シフトが確定しました</span>
            <strong>{alert.period_title || `${alert.department}シフト`}</strong>
            <small className="shift-alert-banner__deadline">
              {alert.start_date}〜{alert.end_date}
            </small>
            <em>{openingShiftAlertId === alert.id ? "開いています" : "シフトを見る"}</em>
          </button>
        ))}

        {activePendingPledge && activePledgeReminder && (
          <Link
            href={`/pledges/${activePendingPledge.id}`}
            className={`pledge-alert-banner pledge-alert-banner--${activePledgeReminder.level}`}
          >
            <span>{activePledgeReminder.eyebrow}</span>
            <strong>{activePledgeReminder.headline}</strong>
            <em>{activePendingPledge.delivery.title_snapshot}</em>
            <p>{activePledgeReminder.detail}</p>
            {pendingPledges.length > 1 && <small>未提出 {pendingPledges.length}件</small>}
          </Link>
        )}

        {latestShiftPeriod && (
          <Link
            href={`/shifts?period_id=${encodeURIComponent(latestShiftPeriod.id)}`}
            className={pendingShiftPeriod
              ? `shift-alert-banner shift-alert-banner--${latestShiftDeadline.tone}`
              : "shift-alert-banner shift-alert-banner--done"}
          >
            <span>シフト希望回収</span>
            <strong>{shiftPeriodTitle(latestShiftPeriod)}</strong>
            <small className="shift-alert-banner__deadline">{latestShiftDeadline.label}</small>
            <em>{pendingShiftPeriod ? "未提出" : "修正可"}</em>
          </Link>
        )}

        <section
          className={`home-present ${showPresentDetails ? "home-present--open" : ""}`}
          aria-label="本日出勤"
          aria-expanded={showPresentDetails}
          role="button"
          tabIndex={0}
          onClick={togglePresentDetails}
          onKeyDown={handlePresentKeyDown}
        >
          <div className="home-present__header">
            <div>
              <span className="home-present__title">本日出勤</span>
              <strong>{presentStaff.length}人</strong>
            </div>
            {presentStaff.length > 0 && (
              <span className="home-present__toggle" aria-hidden="true">
                {showPresentDetails ? "閉じる" : "詳細"}
              </span>
            )}
          </div>
          {presentStaff.length > 0 ? (
            <>
              <div className="home-present__people">
                {presentStaff.map((staff) => (
                  <div
                    key={staff.userId}
                    className="home-present__person"
                    title={`${staff.displayName} ${staff.department} ${formatTime(staff.clockedInAt)} 出勤`}
                    aria-label={`${staff.displayName} ${staff.department}`}
                  >
                    <div className="home-present__avatar">
                      <SafePicture
                        src={staff.pictureUrl}
                        alt={staff.displayName}
                        fallback={<span>{staffInitials(staff.displayName)}</span>}
                      />
                    </div>
                  </div>
                ))}
              </div>
              {showPresentDetails && (
                <div className="home-present__details">
                  {presentStaff.map((staff) => (
                    <div key={`${staff.userId}-detail`} className="home-present__detail">
                      <div className="home-present__detail-avatar">
                        <SafePicture
                          src={staff.pictureUrl}
                          alt={staff.displayName}
                          fallback={<span>{staffInitials(staff.displayName)}</span>}
                        />
                      </div>
                      <div className="home-present__detail-body">
                        <strong>{staff.displayName}</strong>
                        <span>所属: {staff.department || "未設定"} / {formatTime(staff.clockedInAt)} 出勤</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : (
            <p className="home-present__empty">現在出勤中のスタッフはいません</p>
          )}
        </section>

        {openTaskCount > 0 && (
          <Link href="/tasks" className="task-alert-banner">
            <span>未完了のタスクがあります</span>
            <strong>{openTaskCount}件</strong>
          </Link>
        )}

        {loading ? (
          <p style={{ textAlign: "center", color: "var(--text-sub)", padding: "40px 0" }}>
            読み込み中...
          </p>
        ) : groups.length === 0 ? (
          <p style={{ textAlign: "center", color: "var(--text-sub)", padding: "40px 0" }}>
            グループがありません。右下の＋ボタンで作成しましょう！
          </p>
        ) : (
          groups.map((group) => {
            const href =
              group.type === "board" ? `/board/${group.id}` : `/chat/${group.id}`;
            return (
              <Link key={group.id} href={href} aria-label={`${group.name}を開く`}>
                <article className={`group-card group-card--${group.type}`}>
                  <div
                    className={`group-card__icon group-card__icon--${group.type}`}
                    aria-hidden="true"
                  >
                    {group.icon}
                  </div>

                  <div className="group-card__info">
                    <div className="group-card__name">{group.name}</div>
                    <div className="group-card__meta">
                      <span
                        className={`group-card__type-tag group-card__type-tag--${group.type}`}
                      >
                        {group.type === "board" ? "掲示板" : "チャット"}
                      </span>
                      {group.lastMessage}
                    </div>
                  </div>

                  <div className="group-card__right">
                    <span className="group-card__time">
                      {formatTime(group.lastMessageAt)}
                    </span>
                    {group.unread > 0 && (
                      <span className="badge" aria-label={`未読${group.unread}件`}>
                        {group.unread > 99 ? "99+" : group.unread}
                      </span>
                    )}
                  </div>
                </article>
              </Link>
            );
          })
        )}
      </section>
    </div>
  );
}
