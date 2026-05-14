"use client";

import { useState, useEffect, useCallback } from "react";
import { getDeviceHeaders } from "@/lib/device-id";

type User = {
  id: string;
  display_name: string;
  picture_url: string | null;
  role: string;
};

type DeviceType = "iphone" | "android" | "pc";

/**
 * iOS判定: iPhone / iPad / iPod のほか、
 * iPadOS の「Mac風UA」も maxTouchPoints で判定する。
 */
function isIOSDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua)
    || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
}

/**
 * iOS PWA (standalone) 判定:
 * - navigator.standalone === true（Safari PWA）
 * - display-mode: standalone メディアクエリ
 */
function isStandaloneMode(): boolean {
  if (typeof window === "undefined") return false;
  const nav = window.navigator as unknown as { standalone?: boolean };
  return nav.standalone === true
    || window.matchMedia("(display-mode: standalone)").matches;
}

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

const PUBLIC_VAPID_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";

function detectDevice(): DeviceType {
  if (typeof navigator === "undefined") return "pc";
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua)
    || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  if (isIOS) return "iphone";
  if (/Android/.test(ua)) return "android";
  return "pc";
}

/**
 * Push通知の有効化可否を判定する状態:
 * - loading: チェック中
 * - ready: 通知ON/OFFが操作可能
 * - ios-need-safari-pwa: iOSだがSafari PWAではない → ホーム画面追加を案内
 * - unsupported: ブラウザがPush APIに非対応
 * - denied: ブラウザ設定で通知ブロック済み
 */
type PushCapability = "loading" | "ready" | "ios-need-safari-pwa" | "unsupported" | "denied";

export default function SettingsPage() {
  const [user, setUser] = useState<User | null>(null);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [loadingPush, setLoadingPush] = useState(true);
  const [pushMessage, setPushMessage] = useState("");
  const [pushCapability, setPushCapability] = useState<PushCapability>("loading");
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideDevice, setGuideDevice] = useState<DeviceType>("pc");
  const [deviceLoginUrl, setDeviceLoginUrl] = useState("");
  const [creatingDeviceLoginUrl, setCreatingDeviceLoginUrl] = useState(false);
  const [theme, setTheme] = useState<"dark" | "light">("dark");

  // deviceLogin=1 パラメータで来た場合はSafari/PWAから開いたことを自動案内
  const [fromDeviceLogin, setFromDeviceLogin] = useState(false);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setUser(data.user))
      .catch(() => {});

    // URLパラメータチェック
    const params = new URLSearchParams(window.location.search);
    if (params.get("deviceLogin") === "1") {
      setFromDeviceLogin(true);
    }

    // テーマ初期値読み込み
    const saved = localStorage.getItem("tsg-theme");
    if (saved === "light" || saved === "dark") setTheme(saved);

    determinePushCapability();
    setGuideDevice(detectDevice());
  }, []);

  /**
   * Push通知が使える状態かを判定する。
   * 内職管理システムと同じ方式: iOS → standalone判定を最優先。
   */
  const determinePushCapability = useCallback(async () => {
    // Step 1: iOS判定
    if (isIOSDevice()) {
      if (!isStandaloneMode()) {
        // iOSだがSafari PWA（ホーム画面追加）ではない
        setPushCapability("ios-need-safari-pwa");
        setLoadingPush(false);
        return;
      }
      // iOS + standalone → Push APIが使えるかチェックに進む
    }

    // Step 2: Push API存在チェック
    if (!PUBLIC_VAPID_KEY || !('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      setPushCapability("unsupported");
      setLoadingPush(false);
      return;
    }

    // Step 3: ブラウザの通知パーミッション確認
    if (Notification.permission === "denied") {
      setPushCapability("denied");
      setLoadingPush(false);
      return;
    }

    setPushCapability("ready");

    // Step 4: 既存の購読状態チェック
    try {
      const registration = await navigator.serviceWorker.getRegistration('/sw.js');
      const subscription = registration ? await registration.pushManager.getSubscription() : null;
      if (!subscription) {
        setPushEnabled(false);
      } else {
        const response = await fetch("/api/push/status", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...getDeviceHeaders() },
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        const data = response.ok ? await response.json() : { subscribed: false };
        setPushEnabled(!!data.subscribed);
      }
    } catch (err) {
      console.error("Push status check failed", err);
    }
    setLoadingPush(false);
  }, []);

  async function togglePush(checked: boolean) {
    setLoadingPush(true);
    setPushMessage("");

    try {
      if (pushCapability !== "ready") {
        setPushMessage("この環境では通知を有効にできません。設定ガイドを確認してください。");
        setLoadingPush(false);
        return;
      }

      const registration = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      
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
          headers: { 'Content-Type': 'application/json', ...getDeviceHeaders() },
          body: JSON.stringify({ subscription: subscription.toJSON() }),
        });
        setPushEnabled(true);
        setPushMessage("✅ 通知を有効にしました！「テスト通知」で確認してください。");
      } else {
        // 解除する
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          await fetch('/api/push/subscribe', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', ...getDeviceHeaders() },
            body: JSON.stringify({ endpoint: subscription.endpoint }),
          });
          await subscription.unsubscribe();
        }
        setPushEnabled(false);
        setPushMessage("通知を解除しました");
      }
    } catch (err) {
      console.error("Failed to toggle push", err);
      const msg = err instanceof Error ? err.message : "不明なエラー";
      alert("通知設定の変更に失敗しました: " + msg);
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

  async function createNotificationLoginUrl() {
    setCreatingDeviceLoginUrl(true);
    try {
      const res = await fetch("/api/auth/device-login", { method: "POST" });
      const data = res.ok ? await res.json() : null;
      if (!data?.url) {
        setPushMessage("通知設定用リンクの作成に失敗しました。もう一度ログインしてから試してください。");
        return;
      }
      setDeviceLoginUrl(data.url);
      setPushMessage("通知設定用リンクを作成しました。Safariで開いて通知をONにしてください。");
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(data.url).catch(() => {});
      }
    } finally {
      setCreatingDeviceLoginUrl(false);
    }
  }

  function handleLogout() {
    window.location.href = "/api/auth/logout";
  }

  // --- Push通知の状態別UI ---
  function renderPushSection() {
    // iOSでSafari PWAではない場合
    if (pushCapability === "ios-need-safari-pwa") {
      return (
        <section className="settings-section" aria-label="通知設定">
          <h2 className="settings-section__title">通知</h2>
          <div className="settings-row settings-row--stack">
            <div className="ios-pwa-guide">
              <div className="ios-pwa-guide__icon">📱</div>
              <div className="ios-pwa-guide__content">
                <div className="ios-pwa-guide__title">iPhoneで通知を受け取るには</div>
                <div className="ios-pwa-guide__desc">
                  <strong>Safari</strong>でログイン画面を開き、<strong>先にホーム画面に追加</strong>してからログインしてください。
                </div>
                <ol className="ios-pwa-guide__steps">
                  <li><strong>Safari</strong>で <code>v0-line-blush.vercel.app</code> を開く</li>
                  <li>ログイン画面のまま、下部の共有ボタン（□に↑）をタップ</li>
                  <li>「<strong>ホーム画面に追加</strong>」をタップ</li>
                  <li>ホーム画面のTSGアイコンからアプリを開く</li>
                  <li>LINEでログインする</li>
                  <li>設定画面で通知をONにする</li>
                </ol>
                <div className="ios-pwa-guide__warn">
                  ⚠️ iPhoneではChrome・LINE内ブラウザでは通知を受け取れません。必ずSafariから操作してください。
                </div>
              </div>
            </div>
            {/* 別ブラウザ（Chrome）から来た場合向けのdevice-loginリンク */}
            <div className="settings-actions" style={{ marginTop: 12 }}>
              <button
                type="button"
                className="settings-action-btn"
                disabled={creatingDeviceLoginUrl}
                onClick={createNotificationLoginUrl}
              >
                📋 Safari用ログインリンクを作成
              </button>
            </div>
            {deviceLoginUrl && (
              <div className="settings-copy-box">
                <input value={deviceLoginUrl} readOnly aria-label="Safari用ログインリンク" />
                <button
                  type="button"
                  className="settings-action-btn"
                  onClick={() => navigator.clipboard?.writeText(deviceLoginUrl)}
                >
                  コピー
                </button>
              </div>
            )}
            {pushMessage && <div className="settings-row__sub">{pushMessage}</div>}
          </div>
        </section>
      );
    }

    // 非対応ブラウザ
    if (pushCapability === "unsupported") {
      return (
        <section className="settings-section" aria-label="通知設定">
          <h2 className="settings-section__title">通知</h2>
          <div className="settings-row settings-row--stack">
            <div className="ios-pwa-guide__warn">
              🔕 このブラウザではWeb Push通知に対応していません。
              PCの場合はChrome / Edge / Firefoxをお試しください。
            </div>
          </div>
        </section>
      );
    }

    // ブラウザ設定でブロック済み
    if (pushCapability === "denied") {
      return (
        <section className="settings-section" aria-label="通知設定">
          <h2 className="settings-section__title">通知</h2>
          <div className="settings-row settings-row--stack">
            <div className="ios-pwa-guide__warn">
              🔕 通知がブラウザ設定でブロックされています。<br />
              アドレスバー左の鍵/情報アイコン → サイト設定 → 通知 → 「許可」に変更してください。
            </div>
          </div>
        </section>
      );
    }

    // ready: 通知ON/OFF操作可能
    return (
      <section className="settings-section" aria-label="通知設定">
        <h2 className="settings-section__title">通知</h2>

        {fromDeviceLogin && !pushEnabled && (
          <div className="ios-pwa-guide__success" style={{ marginBottom: 12 }}>
            ✅ Safari/PWAからのログインに成功しました！下の通知トグルをONにしてください。
          </div>
        )}

        <div className="settings-row">
          <div>
            <div className="settings-row__label">Web Push 通知</div>
            <div className="settings-row__sub">
              投稿・リアクションを通知
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
    );
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

        {/* Theme toggle */}
        <section className="settings-section" aria-label="テーマ設定">
          <h2 className="settings-section__title">テーマ</h2>
          <div className="settings-row">
            <div>
              <div className="settings-row__label">{theme === "dark" ? "🌙 ダークモード" : "☀️ ライトモード"}</div>
              <div className="settings-row__sub">タップで切り替え</div>
            </div>
            <label className="toggle">
              <input
                type="checkbox"
                checked={theme === "light"}
                onChange={(e) => {
                  const next = e.target.checked ? "light" : "dark";
                  setTheme(next);
                  localStorage.setItem("tsg-theme", next);
                  document.documentElement.setAttribute("data-theme", next);
                  document.documentElement.style.background = next === "light" ? "#f1f5f9" : "#0f172a";
                }}
              />
              <span className="toggle__track" />
            </label>
          </div>
        </section>

        {/* Notification settings - 状態別レンダリング */}
        {renderPushSection()}

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
                    <div className="notification-guide__note" style={{ background: "rgba(239, 68, 68, 0.12)", color: "#f87171" }}>
                      ⚠️ iPhoneでは <strong>Safari</strong> からホーム画面に追加したアプリ（PWA）でのみ通知が使えます。Chrome等の他ブラウザでは通知を受け取れません。
                    </div>
                    <p style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>手順:</p>
                    <ol>
                      <li><strong>Safari</strong>で <code style={{ background: "rgba(255,255,255,0.1)", padding: "2px 6px", borderRadius: 4, fontSize: 12 }}>v0-line-blush.vercel.app</code> を開く</li>
                      <li>下部の共有ボタン（□に↑）をタップ</li>
                      <li>「<strong>ホーム画面に追加</strong>」をタップ</li>
                      <li>ホーム画面のTSGアイコンからアプリを開く</li>
                      <li>LINEでログインする</li>
                      <li>設定画面で「Web Push 通知」をONにする</li>
                      <li>「通知を許可しますか？」→「<strong>許可</strong>」をタップ</li>
                    </ol>
                    <div className="notification-guide__note" style={{ marginTop: 12 }}>
                      💡 iPhone設定 → 通知 → TSG で「通知を許可」「ロック画面」「バナー」「サウンド」がONか確認してください。
                    </div>
                  </>
                )}
                {guideDevice === "android" && (
                  <ol>
                    <li>Chromeでこのサイトを開く</li>
                    <li>LINEでログインする</li>
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
          .settings-copy-box {
            display: flex;
            gap: 8px;
            margin-top: 8px;
            width: 100%;
          }
          .settings-copy-box input {
            min-width: 0;
            flex: 1;
            border: 1px solid var(--border);
            border-radius: var(--radius-sm);
            background: var(--bg);
            color: var(--text-sub);
            font-size: 12px;
            padding: 8px 10px;
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
          .notification-guide__body code {
            background: rgba(255,255,255,0.1);
            padding: 2px 6px;
            border-radius: 4px;
            font-size: 12px;
          }
          .notification-guide__note {
            background: rgba(245, 158, 11, 0.12);
            border-radius: var(--radius-sm);
            color: #fbbf24;
            margin-bottom: 12px;
            padding: 10px 12px;
            font-size: 13px;
            line-height: 1.6;
          }
          /* iOS PWA案内 */
          .ios-pwa-guide {
            display: flex;
            gap: 12px;
            padding: 14px;
            background: rgba(59, 130, 246, 0.08);
            border-radius: var(--radius);
            border: 1px solid rgba(59, 130, 246, 0.2);
          }
          .ios-pwa-guide__icon {
            font-size: 28px;
            flex-shrink: 0;
          }
          .ios-pwa-guide__content {
            flex: 1;
          }
          .ios-pwa-guide__title {
            font-weight: 700;
            font-size: 14px;
            margin-bottom: 6px;
            color: var(--text);
          }
          .ios-pwa-guide__desc {
            font-size: 13px;
            color: var(--text-sub);
            margin-bottom: 10px;
            line-height: 1.6;
          }
          .ios-pwa-guide__steps {
            margin: 0 0 10px 18px;
            padding: 0;
            font-size: 13px;
            color: var(--text-sub);
            line-height: 1.8;
          }
          .ios-pwa-guide__steps code {
            background: rgba(255,255,255,0.1);
            padding: 1px 5px;
            border-radius: 3px;
            font-size: 11px;
            color: #93c5fd;
          }
          .ios-pwa-guide__warn {
            font-size: 12px;
            color: #f87171;
            padding: 8px 10px;
            background: rgba(239, 68, 68, 0.08);
            border-radius: var(--radius-sm);
            line-height: 1.5;
          }
          .ios-pwa-guide__success {
            font-size: 13px;
            color: #4ade80;
            padding: 10px 12px;
            background: rgba(34, 197, 94, 0.1);
            border-radius: var(--radius-sm);
            font-weight: 600;
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
