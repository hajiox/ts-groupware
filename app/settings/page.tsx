"use client";

import { useState, useEffect } from "react";

type User = {
  id: string;
  display_name: string;
  picture_url: string | null;
  role: string;
};

type DeviceType = "iphone" | "android" | "pc";

// --- Push通知用ユーティリティ ---
function urlB64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/\-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

const PUBLIC_VAPID_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "BKGxnPaH_MlzJqV-YpTCO6S3cemGfxnbgUWURzBd6asH7gHRoMTPpksMP_gb86xVIczFy2B-wM6QHAgO-PQMaTg";

function detectDevice(): DeviceType {
  if (typeof navigator === "undefined") return "pc";
  const ua = navigator.userAgent;
  if (/iPad|iPhone|iPod/.test(ua)) return "iphone";
  if (/Android/.test(ua)) return "android";
  return "pc";
}

function isIOSStandalone() {
  if (typeof window === "undefined") return false;
  return (window.navigator as unknown as { standalone?: boolean }).standalone === true
    || window.matchMedia("(display-mode: standalone)").matches;
}

export default function SettingsPage() {
  const [user, setUser] = useState<User | null>(null);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [loadingPush, setLoadingPush] = useState(true);
  const [pushMessage, setPushMessage] = useState("");
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideDevice, setGuideDevice] = useState<DeviceType>("pc");

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setUser(data.user))
      .catch(() => {});
      
    checkPushStatus();
    setGuideDevice(detectDevice());
  }, []);

  async function checkPushStatus() {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPushMessage("この環境はWeb Push通知に対応していません");
      setLoadingPush(false);
      return;
    }
    if (detectDevice() === "iphone" && !isIOSStandalone()) {
      setPushMessage("iPhoneはSafariでホーム画面に追加したアプリから通知を有効にしてください");
    }
    try {
      const registration = await navigator.serviceWorker.getRegistration('/sw.js');
      const subscription = registration ? await registration.pushManager.getSubscription() : null;
      if (!subscription) {
        setPushEnabled(false);
      } else {
        const response = await fetch("/api/push/status", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        const data = response.ok ? await response.json() : { subscribed: false };
        setPushEnabled(!!data.subscribed);
      }
    } catch (err) {
      console.error("Push status check failed", err);
    }
    setLoadingPush(false);
  }

  async function togglePush(checked: boolean) {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    setLoadingPush(true);
    setPushMessage("");

    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      
      if (checked) {
        if (detectDevice() === "iphone" && !isIOSStandalone()) {
          setPushMessage("iPhoneはSafariでホーム画面に追加後、そのアイコンから開いて通知を有効にしてください");
          setLoadingPush(false);
          return;
        }
        // 購読する
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          alert('通知が許可されていません。ブラウザの設定を確認してください。');
          setLoadingPush(false);
          return;
        }

        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlB64ToUint8Array(PUBLIC_VAPID_KEY)
        });

        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: subscription.toJSON() }),
        });
        setPushEnabled(true);
        setPushMessage("通知を有効にしました");
      } else {
        // 解除する
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          await fetch('/api/push/subscribe', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: subscription.endpoint }),
          });
          await subscription.unsubscribe();
        }
        setPushEnabled(false);
        setPushMessage("通知を解除しました");
      }
    } catch (err) {
      console.error("Failed to toggle push", err);
      alert("設定の変更に失敗しました");
    }
    setLoadingPush(false);
  }

  async function sendTestNotification() {
    setLoadingPush(true);
    try {
      const res = await fetch("/api/push/test", { method: "POST" });
      if (res.ok) {
        setPushMessage("テスト通知を送信しました");
      } else {
        const data = await res.json().catch(() => null);
        setPushMessage(data?.error || "テスト通知に失敗しました");
      }
    } finally {
      setLoadingPush(false);
    }
  }

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
                投稿・編集・削除・リアクションを通知
              </div>
            </div>
            <label className="toggle">
              <input 
                type="checkbox" 
                checked={pushEnabled} 
                disabled={loadingPush}
                onChange={(e) => togglePush(e.target.checked)} 
              />
              <span className="toggle__track" />
            </label>
          </div>
          <div className="settings-row settings-row--stack">
            {pushMessage && <div className="settings-row__sub">{pushMessage}</div>}
            <div className="settings-actions">
              <button
                type="button"
                className="settings-action-btn"
                onClick={() => setGuideOpen(true)}
              >
                設定ガイド
              </button>
              <button
                type="button"
                className="settings-action-btn"
                disabled={!pushEnabled || loadingPush}
                onClick={sendTestNotification}
              >
                テスト通知
              </button>
            </div>
          </div>
        </section>

        {guideOpen && (
          <div className="modal-overlay" onClick={() => setGuideOpen(false)}>
            <div className="modal-content notification-guide" onClick={(e) => e.stopPropagation()}>
              <div className="notification-guide__header">
                <h3 className="modal-title">通知設定ガイド</h3>
                <button type="button" className="notification-guide__close" onClick={() => setGuideOpen(false)}>
                  ×
                </button>
              </div>
              <div className="notification-guide__tabs">
                {(["iphone", "android", "pc"] as const).map(device => (
                  <button
                    key={device}
                    type="button"
                    className={`notification-guide__tab${guideDevice === device ? " notification-guide__tab--active" : ""}`}
                    onClick={() => setGuideDevice(device)}
                  >
                    {device === "iphone" ? "iPhone" : device === "android" ? "Android" : "PC"}
                  </button>
                ))}
              </div>
              <div className="notification-guide__body">
                {guideDevice === "iphone" && (
                  <>
                    <p className="notification-guide__note">iPhoneはSafariでホーム画面に追加したアプリから通知を有効にします。</p>
                    <ol>
                      <li>Safariでこのサイトを開く</li>
                      <li>共有ボタンから「ホーム画面に追加」を選ぶ</li>
                      <li>ホーム画面のアイコンから開いてログインする</li>
                      <li>設定画面で「Web Push 通知」をONにして許可する</li>
                    </ol>
                  </>
                )}
                {guideDevice === "android" && (
                  <ol>
                    <li>Chromeでこのサイトを開く</li>
                    <li>設定画面で「Web Push 通知」をONにする</li>
                    <li>ブラウザの通知許可で「許可」を選ぶ</li>
                    <li>「テスト通知」で届くか確認する</li>
                  </ol>
                )}
                {guideDevice === "pc" && (
                  <ol>
                    <li>Chrome / Edge / Firefoxで設定画面を開く</li>
                    <li>「Web Push 通知」をONにする</li>
                    <li>ブラウザの通知許可で「許可」を選ぶ</li>
                    <li>通知をブロックした場合は、アドレスバー左のサイト設定から通知を許可する</li>
                  </ol>
                )}
              </div>
            </div>
          </div>
        )}

        <style jsx>{`
          .settings-row--stack {
            align-items: stretch;
            flex-direction: column;
          }
          .settings-actions {
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
          }
          .settings-action-btn {
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            color: var(--accent);
            font-size: 13px;
            font-weight: 700;
            padding: 7px 12px;
          }
          .settings-action-btn:disabled {
            color: var(--text-muted);
            cursor: not-allowed;
            opacity: 0.6;
          }
          .notification-guide {
            max-width: 520px;
          }
          .notification-guide__header {
            align-items: center;
            display: flex;
            justify-content: space-between;
            gap: 12px;
          }
          .notification-guide__close {
            color: var(--text-sub);
            font-size: 24px;
            line-height: 1;
          }
          .notification-guide__tabs {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 6px;
            margin-bottom: 16px;
          }
          .notification-guide__tab {
            background: var(--bg);
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            color: var(--text-sub);
            padding: 8px;
          }
          .notification-guide__tab--active {
            background: var(--accent);
            border-color: var(--accent);
            color: #fff;
            font-weight: 700;
          }
          .notification-guide__body {
            color: var(--text);
            font-size: 14px;
            line-height: 1.7;
          }
          .notification-guide__body ol {
            margin-left: 20px;
          }
          .notification-guide__note {
            background: rgba(245, 158, 11, 0.12);
            border-radius: var(--radius-sm);
            color: #fbbf24;
            margin-bottom: 12px;
            padding: 10px 12px;
          }
        `}</style>

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
