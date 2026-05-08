"use client";

import { useState, useEffect } from "react";

type User = {
  id: string;
  display_name: string;
  picture_url: string | null;
  role: string;
};

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

const PUBLIC_VAPID_KEY = "BKGxnPaH_MlzJqV-YpTCO6S3cemGfxnbgUWURzBd6asH7gHRoMTPpksMP_gb86xVIczFy2B-wM6QHAgO-PQMaTg";

export default function SettingsPage() {
  const [user, setUser] = useState<User | null>(null);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [loadingPush, setLoadingPush] = useState(true);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setUser(data.user))
      .catch(() => {});
      
    checkPushStatus();
  }, []);

  async function checkPushStatus() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      setLoadingPush(false);
      return;
    }
    try {
      const registration = await navigator.serviceWorker.register('/sw.js');
      const subscription = await registration.pushManager.getSubscription();
      setPushEnabled(!!subscription);
    } catch (err) {
      console.error("Push status check failed", err);
    }
    setLoadingPush(false);
  }

  async function togglePush(checked: boolean) {
    if (!('serviceWorker' in navigator)) return;
    setLoadingPush(true);

    try {
      const registration = await navigator.serviceWorker.ready;
      
      if (checked) {
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
          body: JSON.stringify({ subscription }),
        });
        setPushEnabled(true);
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
      }
    } catch (err) {
      console.error("Failed to toggle push", err);
      alert("設定の変更に失敗しました");
    }
    setLoadingPush(false);
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
                新しい投稿やメッセージを通知
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
