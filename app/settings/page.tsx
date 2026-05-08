"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CURRENT_USER } from "@/lib/mock-data";

export default function SettingsPage() {
  const router = useRouter();
  const [pushEnabled, setPushEnabled] = useState(true);
  const [mentionEnabled, setMentionEnabled] = useState(true);
  const [soundEnabled, setSoundEnabled] = useState(false);

  function handleLogout() {
    router.push("/login");
  }

  return (
    <div className="page-content">
      <div className="settings-page">
        {/* Profile */}
        <section className="settings-profile" aria-label="プロフィール">
          <div
            className="avatar-placeholder"
            style={{
              width: 72,
              height: 72,
              background: CURRENT_USER.color,
              fontSize: 28,
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              color: "#fff",
            }}
            aria-hidden="true"
          >
            {CURRENT_USER.initials}
          </div>
          <div className="settings-profile__name">{CURRENT_USER.name}</div>
          <div className="settings-profile__sub">LINEアカウント連携済み</div>
          <div
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              background: "#0d3f2a",
              color: "#06C755",
              fontSize: 12,
              fontWeight: 600,
              padding: "4px 12px",
              borderRadius: 999,
            }}
          >
            <span aria-hidden="true">✓</span> LINE連携
          </div>
        </section>

        {/* Notification settings */}
        <section className="settings-section" aria-labelledby="notif-title">
          <div className="settings-section__title" id="notif-title">
            通知設定
          </div>

          <div className="settings-row">
            <div>
              <div className="settings-row__label">Web プッシュ通知</div>
              <div className="settings-row__sub">ブラウザ通知を受け取る</div>
            </div>
            <label className="toggle" aria-label="Webプッシュ通知">
              <input
                type="checkbox"
                checked={pushEnabled}
                onChange={(e) => setPushEnabled(e.target.checked)}
                role="switch"
                aria-checked={pushEnabled}
              />
              <span className="toggle__track" />
            </label>
          </div>

          <div className="settings-row">
            <div>
              <div className="settings-row__label">メンション通知</div>
              <div className="settings-row__sub">自分宛のメンションのみ</div>
            </div>
            <label className="toggle" aria-label="メンション通知">
              <input
                type="checkbox"
                checked={mentionEnabled}
                onChange={(e) => setMentionEnabled(e.target.checked)}
                role="switch"
                aria-checked={mentionEnabled}
              />
              <span className="toggle__track" />
            </label>
          </div>

          <div className="settings-row">
            <div>
              <div className="settings-row__label">通知音</div>
              <div className="settings-row__sub">メッセージ受信時にサウンドを鳴らす</div>
            </div>
            <label className="toggle" aria-label="通知音">
              <input
                type="checkbox"
                checked={soundEnabled}
                onChange={(e) => setSoundEnabled(e.target.checked)}
                role="switch"
                aria-checked={soundEnabled}
              />
              <span className="toggle__track" />
            </label>
          </div>
        </section>

        {/* Account section */}
        <section className="settings-section" aria-labelledby="account-title">
          <div className="settings-section__title" id="account-title">
            アカウント
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">アプリバージョン</div>
            </div>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>v1.0.0</span>
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">利用規約</div>
            </div>
            <span style={{ fontSize: 18, color: "var(--text-muted)" }}>›</span>
          </div>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">プライバシーポリシー</div>
            </div>
            <span style={{ fontSize: 18, color: "var(--text-muted)" }}>›</span>
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
    </div>
  );
}
