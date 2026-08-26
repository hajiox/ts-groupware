"use client";

import Link from "next/link";
import { Bell } from "lucide-react";
import { useEffect, useState } from "react";

export function NotificationShortcut() {
  const [unreadCount, setUnreadCount] = useState(0);

  useEffect(() => {
    let active = true;

    const loadUnread = () => {
      fetch("/api/notifications/center?summary=1", { cache: "no-store" })
        .then((response) => response.ok ? response.json() : { unreadCount: 0 })
        .then((data) => {
          if (active) setUnreadCount(Number(data.unreadCount) || 0);
        })
        .catch(() => {});
    };
    const handleVisibility = () => {
      if (document.visibilityState === "visible") loadUnread();
    };

    loadUnread();
    window.addEventListener("focus", loadUnread);
    window.addEventListener("pageshow", loadUnread);
    window.addEventListener("tsg:notification-refresh", loadUnread);
    document.addEventListener("visibilitychange", handleVisibility);
    const timer = window.setInterval(loadUnread, 30000);

    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", loadUnread);
      window.removeEventListener("pageshow", loadUnread);
      window.removeEventListener("tsg:notification-refresh", loadUnread);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, []);

  const badgeLabel = unreadCount > 99 ? "99+" : String(unreadCount);

  return (
    <Link
      href="/notifications"
      className="calendar-shortcut notification-shortcut"
      aria-label={unreadCount > 0 ? `通知を開く、未読${unreadCount}件` : "通知を開く"}
      title="通知"
    >
      <Bell size={19} strokeWidth={2.1} aria-hidden="true" />
      {unreadCount > 0 && (
        <span className="notification-shortcut__badge" aria-hidden="true">{badgeLabel}</span>
      )}
    </Link>
  );
}
