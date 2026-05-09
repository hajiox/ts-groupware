"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import "./globals.css";

// ─── Bottom Navigation ────────────────────────────────────────────────────────
function BottomNav() {
  const pathname = usePathname();
  const [isAdmin, setIsAdmin] = useState(false);
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

  if (hide) return null;

  const items = [
    { href: "/groups", label: "ホーム", icon: "🏠" },
    ...(isAdmin ? [{ href: "/admin", label: "管理", icon: "🛡️" }] : []),
    { href: "/settings", label: "設定", icon: "⚙️" },
  ];

  return (
    <nav className="bottom-nav" aria-label="メインナビゲーション">
      {items.map((item) => {
        const isActive =
          item.href === "/groups"
            ? pathname.startsWith("/groups") ||
              pathname.startsWith("/board") ||
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
    <html lang="ja" style={{ background: "#0f172a" }}>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
        <meta name="theme-color" content="#0f172a" />
        <meta name="description" content="TS Groupware — 社内グループウェア" />
        <title>TS Groupware</title>
        <link rel="manifest" href="/manifest.json" />
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
