"use client";

import Link from "next/link";
import { useState, useEffect } from "react";
import { getDeviceHeaders } from "@/lib/device-id";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim() || "https://v0-line-blush.vercel.app";
const lineLoginUrl = `${siteUrl}/api/auth/line`;
const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=96x96&margin=8&data=${encodeURIComponent(lineLoginUrl)}`;

type User = {
  id: string;
  display_name: string;
  picture_url: string | null;
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

export default function GroupsPage() {
  const [user, setUser] = useState<User | null>(null);
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [openTaskCount, setOpenTaskCount] = useState(0);

  function loadData() {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setUser(data.user))
      .catch(() => {});

    fetch("/api/groups", { headers: getDeviceHeaders() })
      .then((r) => (r.ok ? r.json() : { groups: [] }))
      .then((data) => {
        const fetchedGroups = data.groups || [];
        setGroups(fetchedGroups);
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    fetch("/api/tasks?summary=1", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { openCount: 0 }))
      .then((data) => setOpenTaskCount(data.openCount || 0))
      .catch(() => {});
  }

  useEffect(() => {
    loadData();
  }, []);

  return (
    <>
      {/* Header */}
      <header className="groups-header" role="banner">
        <span className="groups-header__logo">TS Groupware</span>
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
            {user?.picture_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={user.picture_url}
                alt={user.display_name}
                className="avatar"
                width={34}
                height={34}
              />
            ) : (
              <AvatarPlaceholder
                initials={user?.display_name?.charAt(0) || "?"}
                color="#3b82f6"
                size={34}
              />
            )}
          </button>
          {showUserMenu && (
            <div className="user-menu" role="menu">
              <div className="user-menu__qr" aria-label="LINEログインQR">
                <div className="user-menu__qr-text">
                  <span>LINEログインQR</span>
                  <small>別端末で開く</small>
                </div>
                <a href={lineLoginUrl} className="user-menu__qr-code" aria-label="LINEログインへ進むQR">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={qrUrl} alt="LINEログインへ進むQRコード" width={72} height={72} />
                </a>
              </div>
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
      </header>

      {/* Group list */}
      <section
        className="groups-list page-content"
        aria-label="グループ一覧"
        style={{ paddingTop: 16 }}
      >
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
                        {group.unread}
                      </span>
                    )}
                  </div>
                </article>
              </Link>
            );
          })
        )}
      </section>
    </>
  );
}
