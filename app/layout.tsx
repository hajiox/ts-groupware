"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { PullToRefresh } from "@/components/pull-to-refresh";
import { getDeviceHeaders } from "@/lib/device-id";
import { isManagementUser } from "@/lib/user-roles";
import "./globals.css";

const TSG_TITLE = "TS Groupware";
const TSG_DESCRIPTION = "テクニカルスタッフ社内グループウェア";
const TSG_SITE_URL = (process.env.NEXT_PUBLIC_SITE_URL || "https://ts-groupware.vercel.app").replace(/\/$/, "");
const TSG_OG_IMAGE = `${TSG_SITE_URL}/og-image.png`;

function ServiceWorkerUpdater() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    navigator.serviceWorker
      .register("/sw.js")
      .then(registration => registration.update().catch(() => {}))
      .catch(() => {});
  }, []);

  return null;
}

// ─── Bottom Navigation ────────────────────────────────────────────────────────
function BottomNav() {
  const pathname = usePathname();
  const [canUseAdmin, setCanUseAdmin] = useState(false);
  const [dmUnread, setDmUnread] = useState(0);
  const [taskUnread, setTaskUnread] = useState(0);
  const hide = pathname === "/login" || pathname === "/" || pathname.startsWith("/calendar") || pathname.startsWith("/time-clock") || pathname.startsWith("/admin/shifts/print") || pathname.startsWith("/pledges/pdf/");

  useEffect(() => {
    if (hide) {
      setCanUseAdmin(false);
      return;
    }
    let active = true;
    fetch("/api/auth/me")
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (active) setCanUseAdmin(data?.permissions?.canUseAdmin || isManagementUser(data?.user));
      })
      .catch(() => {
        if (active) setCanUseAdmin(false);
      });
    return () => { active = false; };
  }, [hide]);

  // 全体未読カウントのポーリング（30秒間隔）
  useEffect(() => {
    if (hide) return;
    let active = true;
    let requestId = 0;

    const fetchUnread = () => {
      const currentRequestId = ++requestId;
      Promise.all([
        fetch("/api/unread", { cache: "no-store", headers: getDeviceHeaders() })
          .then(r => r.ok ? r.json() : { dmUnread: 0, groupUnread: 0, totalUnread: 0 }),
        fetch("/api/tasks?summary=1", { cache: "no-store" })
          .then(r => r.ok ? r.json() : { openCount: 0 }),
      ])
        .then(([data, taskData]) => {
          if (active && currentRequestId === requestId) {
            setDmUnread(data.dmUnread || 0);
            setTaskUnread(taskData.openCount || 0);
            
            // PWA用 App Badgeの更新（iPhoneホーム画面アイコンの赤丸）
            if ("setAppBadge" in navigator && "clearAppBadge" in navigator) {
              const total = data.totalUnread || 0;
              if (total > 0) {
                navigator.setAppBadge(total).catch(() => {});
              } else {
                navigator.clearAppBadge().catch(() => {});
              }
            }
          }
        })
        .catch(() => {});
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") fetchUnread();
    };

    fetchUnread();
    window.addEventListener("tsg:unread-refresh", fetchUnread);
    window.addEventListener("focus", fetchUnread);
    window.addEventListener("pageshow", fetchUnread);
    document.addEventListener("visibilitychange", handleVisibility);
    const timer = setInterval(fetchUnread, 30000);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("tsg:unread-refresh", fetchUnread);
      window.removeEventListener("focus", fetchUnread);
      window.removeEventListener("pageshow", fetchUnread);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [hide, pathname]);

  if (hide) return null;

  const items = [
    { href: "/groups", label: "ホーム", icon: "🏠", badge: 0 },
    { href: "/tasks", label: "タスク", icon: "✓", badge: taskUnread },
    { href: "/members", label: "DM", icon: "💬", badge: dmUnread },
    ...(canUseAdmin ? [{ href: "/admin", label: "管理", icon: "🛡️", badge: 0 }] : []),
    { href: "/settings", label: "設定", icon: "⚙️", badge: 0 },
  ];

  return (
    <nav className="bottom-nav" aria-label="メインナビゲーション">
      {items.map((item) => {
        const isActive =
          item.href === "/groups"
            ? pathname.startsWith("/groups") ||
              pathname.startsWith("/board") ||
              pathname.startsWith("/notifications")
            : item.href === "/members"
            ? pathname.startsWith("/members") ||
              pathname.startsWith("/chat")
            : pathname.startsWith(item.href);

        return (
          <Link
            key={item.label}
            href={item.href}
            className={`bottom-nav__item${isActive ? " bottom-nav__item--active" : ""}`}
            aria-current={isActive ? "page" : undefined}
          >
            <span className="nav-icon-wrap">
              <span className="bottom-nav__icon" aria-hidden="true">
                {item.icon}
              </span>
              {item.badge > 0 && (
                <span className="nav-badge" aria-label={`未読${item.badge}件`}>
                  {item.badge > 99 ? "99+" : item.badge}
                </span>
              )}
            </span>
            <span>{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

// ─── Root Layout ─────────────────────────────────────────────────────────────
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#0f172a" />
        <meta name="description" content={TSG_DESCRIPTION} />
        <meta name="application-name" content="TS Groupware" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="TSG" />
        <meta property="og:type" content="website" />
        <meta property="og:locale" content="ja_JP" />
        <meta property="og:site_name" content={TSG_TITLE} />
        <meta property="og:title" content={TSG_TITLE} />
        <meta property="og:description" content={TSG_DESCRIPTION} />
        <meta property="og:url" content={TSG_SITE_URL} />
        <meta property="og:image" content={TSG_OG_IMAGE} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta property="og:image:alt" content={TSG_TITLE} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={TSG_TITLE} />
        <meta name="twitter:description" content={TSG_DESCRIPTION} />
        <meta name="twitter:image" content={TSG_OG_IMAGE} />
        <title>{TSG_TITLE}</title>
        <link rel="manifest" href="/manifest.json?v=20260819-landscape" />
        <link rel="icon" href="/favicon.png?v=20260618-tsg" sizes="64x64" type="image/png" />
        <link rel="icon" href="/icon-192.png?v=20260618-tsg" sizes="192x192" type="image/png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png?v=20260618-tsg" sizes="180x180" />
        <script dangerouslySetInnerHTML={{ __html: `
          (function(){
            try {
              var t = localStorage.getItem('tsg-theme') || 'dark';
              var f = localStorage.getItem('tsg-font-size') === 'large' ? 'large' : 'normal';
              localStorage.setItem('tsg-font-size', f);
              document.documentElement.setAttribute('data-theme', t);
              document.documentElement.setAttribute('data-font-size', f);
              document.documentElement.style.background = t === 'light' ? '#f1f5f9' : '#0f172a';
            } catch(e){}
          })();
        `}} />
      </head>
      <body>
        <ServiceWorkerUpdater />
        <PullToRefresh />
        <div className="app-shell">
          <main style={{ flex: 1 }}>{children}</main>
          <BottomNav />
        </div>
      </body>
    </html>
  );
}
