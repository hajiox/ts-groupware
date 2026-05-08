"use client";

import { useState, useEffect } from "react";

type User = {
  id: string;
  display_name: string;
  picture_url: string | null;
  role: string;
};

/**
 * 設定ページ
 *
 * プロフィール表示 + 通知設定 + ログアウト
 */
export default function SettingsPage() {
  const [user, setUser] = useState<User | null>(null);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setUser(data.user))
      .catch(() => {});
  }, []);

  function handleLogout() {
    window.location.href = "/api/auth/logout";
  }

  return (
    <>
      <header className="top-header" role="banner">
        <h1 className="top-header__title">設定</h1>
      </header>

      <div className="settings-page page-content">
        {/* Profile */}
        <section className="settings-profile" aria-label="プロフィール">
          {user?.picture_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={user.picture_url}
              alt={user.display_name}
              className="avatar"
              width={72}
              height={72}
            />
          ) : (
            <div
              className="avatar-placeholder"
              style={{ width: 72, height: 72, fontSize: 30, background: "#3b82f6" }}
            >
              {user?.display_name?.charAt(0) || "?"}
            </div>
          )}
          <div className="settings-profile__name">
            {user?.display_name || "読み込み中..."}
          </div>
          <div className="settings-profile__sub">
            {user?.role === "admin" ? "管理者" : "メンバー"}
          </div>
        </section>

        {/* Notification settings */}
        <section className="settings-section" aria-label="通知設定">
          <h2 className="settings-section__title">通知</h2>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">Web Push 通知</div>
              <div className="settings-row__sub">
                新しい投稿やメッセージを通知
              </div>
            </div>
            <label className="toggle">
              <input type="checkbox" defaultChecked />
              <span className="toggle__track" />
            </label>
          </div>
        </section>

        {/* Logout */}
        <button
          type="button"
          className="btn-logout"
          onClick={handleLogout}
          aria-label="ログアウト"
        >
          ログアウト
        </button>
      </div>
    </>
  );
}
