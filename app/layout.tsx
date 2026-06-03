"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { getDeviceHeaders } from "@/lib/device-id";
import "./globals.css";

// ─── Bottom Navigation ────────────────────────────────────────────────────────
function BottomNav() {
  const pathname = usePathname();
  const [isAdmin, setIsAdmin] = useState(false);
  const [dmUnread, setDmUnread] = useState(0);
  const hide = pathname === "/login" || pathname === "/";

  useEffect(() => {
    if (hide) return;
    fetch("/api/auth/me")
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.user?.role === "admin") setIsAdmin(true);
      })
      .catch(() => {});
  }, [hide]);

  // 全体未読カウントのポーリング（DB負荷を避けるため低頻度）
  useEffect(() => {
    if (hide) return;
    let active = true;
    let failures = 0;

    const fetchUnread = () => {
      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 6000);

      fetch("/api/unread", { headers: getDeviceHeaders(), signal: controller.signal })
        .then(r => r.ok ? r.json() : { dmUnread: 0, groupUnread: 0, totalUnread: 0 })
        .then(data => {
          failures = 0;
          if (active) {
            setDmUnread(data.dmUnread || 0);
            
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
        .catch(() => {
          failures += 1;
        })
        .finally(() => {
          window.clearTimeout(timeoutId);
        });
    };

    fetchUnread();
    const timer = setInterval(() => {
      if (failures >= 3) return;
      fetchUnread();
    }, 5 * 60 * 1000);
    return () => { active = false; clearInterval(timer); };
  }, [hide, pathname]);

  if (hide) return null;

  const items = [
    { href: "/groups", label: "ホーム", icon: "🏠", badge: 0 },
    { href: "/members", label: "DM", icon: "💬", badge: dmUnread },
    ...(isAdmin ? [{ href: "/admin", label: "管理", icon: "🛡️", badge: 0 }] : []),
    { href: "/settings", label: "設定", icon: "⚙️", badge: 0 },
  ];

  return (
    <nav className="bottom-nav" aria-label="メインナビゲーション">
      {items.map((item) => {
        const isActive =
          item.href === "/groups"
            ? pathname.startsWith("/groups") ||
              pathname.startsWith("/board")
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

function useAppViewportHeight() {
  useEffect(() => {
    const setHeight = () => {
      const viewportHeight = window.visualViewport?.height || window.innerHeight;
      document.documentElement.style.setProperty("--app-height", `${Math.round(viewportHeight)}px`);
    };

    setHeight();
    window.addEventListener("resize", setHeight);
    window.addEventListener("orientationchange", setHeight);
    window.visualViewport?.addEventListener("resize", setHeight);
    window.visualViewport?.addEventListener("scroll", setHeight);

    return () => {
      window.removeEventListener("resize", setHeight);
      window.removeEventListener("orientationchange", setHeight);
      window.visualViewport?.removeEventListener("resize", setHeight);
      window.visualViewport?.removeEventListener("scroll", setHeight);
    };
  }, []);
}

// ─── Root Layout ─────────────────────────────────────────────────────────────
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isFixedScreen = pathname.startsWith("/chat") || pathname.startsWith("/board");
  useAppViewportHeight();

  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#0f172a" />
        <meta name="description" content="TS Groupware — 社内グループウェア" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="TSG" />
        <title>TS Groupware</title>
        <link rel="manifest" href="/manifest.json" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <script dangerouslySetInnerHTML={{ __html: `
          (function(){
            try {
              var t = localStorage.getItem('tsg-theme') || 'dark';
              document.documentElement.setAttribute('data-theme', t);
              document.documentElement.style.background = t === 'light' ? '#f1f5f9' : '#0f172a';
            } catch(e){}
          })();
        `}} />
      </head>
      <body>
        <div className="app-shell">
          <main className={`app-main${isFixedScreen ? " app-main--fixed-screen" : ""}`}>{children}</main>
          <BottomNav />
        </div>
      </body>
    </html>
  );
}
