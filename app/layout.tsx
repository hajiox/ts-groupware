"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
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

  // DM未読カウントのポーリング（30秒間隔）
  useEffect(() => {
    if (hide) return;
    let active = true;

    const fetchUnread = () => {
      fetch("/api/dm/unread")
        .then(r => r.ok ? r.json() : { count: 0 })
        .then(data => { if (active) setDmUnread(data.count || 0); })
        .catch(() => {});
    };

    fetchUnread();
    const timer = setInterval(fetchUnread, 30000);
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

// ─── Root Layout ─────────────────────────────────────────────────────────────
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
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
          <main style={{ flex: 1 }}>{children}</main>
          <BottomNav />
        </div>
      </body>
    </html>
  );
}
